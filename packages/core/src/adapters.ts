// Adapters drive one kind of boundary. The HTTP adapter (REST, GraphQL, SOAP) is built in.
// Any other adapter is a program in any language that answers one JSON request per line on
// stdin with one JSON reply per line on stdout:
//   {"op":"describe"}                         → {"name":"queue","kinds":["queue"],"settings":[...]}
//   {"op":"run","case":{...},"target":{...}}  → an Observation
//   {"op":"reset","target":{...}}             → {"ok":true}
// See docs/ADAPTERS.md. `cmtk adapter new` writes a working template.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import zlib from "node:zlib";

import type { Case, InputFile, Observation, Target } from "./types.js";

export const MAX_BODY = 5 * 1024 * 1024;

export interface Adapter {
    run(c: Case, target: Target, extraHeaders: Record<string, string>): Promise<Observation>;
    reset?(target: Target): Promise<void>;
    describe?(): Promise<unknown>;
    close?(): Promise<void>;
}

export interface AdapterSpec {
    command: string;
    args?: string[];
    /** Longest wait for one answer, in seconds. Default 300. */
    timeout_s?: number;
}

export function httpAdapter(opts: { timeoutS: number; insecureTls: boolean; root?: string }): Adapter {
    return {
        run: (c, target, extra) => (target.base_url ? send(target.base_url, c, extra, opts)
            : Promise.resolve({ error: `target ${target.name} has no base_url, so HTTP cases cannot run on it` })),
    };
}

/** The same boundary on every run, so two systems get byte-identical multipart bodies and the evidence is reproducible. */
export const MULTIPART_BOUNDARY = "----cmtk-boundary-7d2a1c9e4f";

const CONTENT_TYPES: Record<string, string> = {
    ".json": "application/json", ".xml": "application/xml", ".csv": "text/csv", ".txt": "text/plain", ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".zip": "application/zip",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
};
const typeOf = (file: string) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

const fingerprint = (rel: string, bytes: Buffer): InputFile => ({ path: rel.split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });

/**
 * The body a case sends, from `body`, `body_file` or `files`, with the files it sent fingerprinted.
 * Files are read from `root` (the project folder); a missing file is an error, never an empty body.
 */
export function requestBody(c: Case, root: string | undefined, headers: Record<string, string>): { body?: Buffer; inputs: InputFile[] } | { error: string } {
    const req = c.request;
    const hasType = () => Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
    const readFile = (rel: string) => {
        const full = path.resolve(root ?? process.cwd(), rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`input file ${rel} does not exist`);
        return fs.readFileSync(full);
    };
    try {
        if (req.files?.length) {
            const inputs: InputFile[] = [];
            const parts: Buffer[] = [];
            for (const f of req.files) {
                const bytes = readFile(f.path);
                const filename = f.filename ?? path.basename(f.path);
                const type = f.content_type ?? typeOf(filename);
                parts.push(Buffer.from(`--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`, "utf8"), bytes, Buffer.from("\r\n", "utf8"));
                inputs.push({ ...fingerprint(f.path, bytes), field: f.field, filename, content_type: type });
            }
            parts.push(Buffer.from(`--${MULTIPART_BOUNDARY}--\r\n`, "utf8"));
            headers["content-type"] = `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`;
            return { body: Buffer.concat(parts), inputs };
        }
        if (req.body_file) {
            const bytes = readFile(req.body_file);
            if (!hasType()) headers["content-type"] = typeOf(req.body_file);
            return { body: bytes, inputs: [fingerprint(req.body_file, bytes)] };
        }
    } catch (err) {
        return { error: (err as Error).message };
    }
    if (typeof req.body === "string") return { body: Buffer.from(req.body, "utf8"), inputs: [] };
    if (req.body !== null && req.body !== undefined) {
        if (!hasType()) headers["content-type"] = "application/json";
        return { body: Buffer.from(JSON.stringify(req.body), "utf8"), inputs: [] };
    }
    return { inputs: [] };
}

// Agents of our own: the global agent may be set to use a proxy (NODE_USE_ENV_PROXY), and a
// comparison must reach the target directly.
const AGENTS = {
    http: new http.Agent({ keepAlive: false }),
    https: new https.Agent({ keepAlive: false }),
    httpsInsecure: new https.Agent({ keepAlive: false, rejectUnauthorized: false }),
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bytes as text. UTF-8 when they are valid UTF-8 (allowing a character cut off by the size cap), otherwise Latin-1, which keeps every byte. */
export function decodeBody(raw: Buffer, truncated: boolean): { body: string; encoding?: string } {
    for (let cut = 0; cut <= (truncated ? 3 : 0) && cut <= raw.length; cut++) {
        try {
            return { body: UTF8.decode(raw.subarray(0, raw.length - cut)) };
        } catch {
            // try the next cut, then fall back to Latin-1
        }
    }
    return { body: raw.toString("latin1"), encoding: "latin1" };
}

/**
 * One request to one target. Redirects are answers, never followed; proxies are never used.
 * The whole answer must arrive within the timeout, and reading stops at 5 MB (after decompression).
 */
export function send(baseUrl: string, c: Case, extra: Record<string, string>, opts: { timeoutS: number; insecureTls: boolean; root?: string }): Promise<Observation> {
    const req = c.request;
    if (!req.path.startsWith("/") || req.path.startsWith("//")) return Promise.resolve({ error: "the path must start with a single '/'" });
    const url = new URL(baseUrl + req.path);
    const secure = url.protocol === "https:";
    const headers: Record<string, string> = { ...(req.headers ?? {}), ...extra, "accept-encoding": "identity" };
    const made = requestBody(c, opts.root, headers);
    if ("error" in made) return Promise.resolve({ error: made.error });
    const { body, inputs } = made;
    if (body) headers["content-length"] = String(body.length);
    const withInputs = (o: Observation): Observation => (inputs.length ? { ...o, inputs } : o);

    return new Promise((resolve) => {
        let done = false;
        let r: http.ClientRequest | undefined;
        const finish = (o: Observation) => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            r?.destroy();
            resolve(withInputs(o));
        };
        const deadline = setTimeout(() => finish({ error: `ETIMEDOUT: no complete answer within ${opts.timeoutS}s` }), opts.timeoutS * 1000);
        try {
            r = (secure ? https : http).request(url, {
                method: req.method,
                headers,
                agent: secure ? (opts.insecureTls ? AGENTS.httpsInsecure : AGENTS.https) : AGENTS.http,
            }, (res) => {
                const h: Record<string, string> = {};
                for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
                const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
                const flush = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
                const stream: Readable = enc === "gzip" || enc === "x-gzip" ? res.pipe(zlib.createGunzip(flush))
                    : enc === "deflate" ? res.pipe(zlib.createInflate(flush))
                    : enc === "br" ? res.pipe(zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }))
                    : res;
                const chunks: Buffer[] = [];
                let size = 0;
                const complete = (truncated: boolean) => {
                    let raw = Buffer.concat(chunks);
                    if (raw.length > MAX_BODY) { raw = raw.subarray(0, MAX_BODY); truncated = true; }
                    const { body: text, encoding } = decodeBody(raw, truncated);
                    finish({
                        status: res.statusCode, headers: h, body: text, ...(encoding ? { body_encoding: encoding } : {}),
                        sha256: crypto.createHash("sha256").update(raw).digest("hex"), ...(truncated ? { truncated } : {}),
                    });
                };
                stream.on("data", (d: Buffer) => {
                    chunks.push(d);
                    size += d.length;
                    if (size >= MAX_BODY) { complete(true); if (stream !== res) stream.destroy(); res.destroy(); }
                });
                stream.on("end", () => complete(false));
                stream.on("error", (err) => finish({ error: enc && stream !== res ? `content-encoding ${enc}: the answer could not be decoded (${err.message})` : `${err.name}: ${err.message}` }));
                res.on("error", (err) => finish({ error: `${err.name}: ${err.message}` }));
            });
            r.on("error", (err) => finish({ error: `${(err as NodeJS.ErrnoException).code ?? err.name}: ${err.message}` }));
            if (body) r.write(body);
            r.end();
        } catch (err) {
            // An invalid method or header value: Node names the header, never its value.
            finish({ error: `${(err as NodeJS.ErrnoException).code ?? "Error"}: ${(err as Error).message}` });
        }
    });
}

/** An adapter in its own process, speaking JSON lines. Its standard error is passed on, a line at a time, marked with its name. */
export function processAdapter(name: string, spec: AdapterSpec, cwd: string): Adapter {
    let child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
    let lines: AsyncIterator<string> | undefined;
    let startError: Error | undefined;
    const timeoutMs = (spec.timeout_s ?? 300) * 1000;
    const stop = () => {
        child?.kill();
        child = undefined;
        lines = undefined;
    };
    const start = () => {
        if (child) return;
        startError = undefined;
        const c = spawn(spec.command, spec.args ?? [], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
        c.on("error", (err) => { startError = err; });
        readline.createInterface({ input: c.stderr }).on("line", (line) => process.stderr.write(`[adapter ${name}] ${line}\n`));
        c.stdin.on("error", () => { /* the process ended; the next read reports it */ });
        child = c;
        lines = readline.createInterface({ input: c.stdout })[Symbol.asyncIterator]();
    };
    const call = async (msg: unknown): Promise<any> => {
        start();
        const it = lines!;
        child!.stdin.write(JSON.stringify(msg) + "\n");
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
        const next = await Promise.race([it.next(), timeout]).finally(() => clearTimeout(timer));
        if (next === "timeout") {
            stop();
            throw new Error(`adapter ${name} gave no answer within ${timeoutMs / 1000}s`);
        }
        if (next.done) {
            const why = startError ? `could not start ${spec.command}: ${(startError as NodeJS.ErrnoException).code ?? startError.message}` : "stopped answering";
            stop();
            throw new Error(`adapter ${name} ${why}`);
        }
        try {
            return JSON.parse(next.value);
        } catch {
            throw new Error(`adapter ${name} answered something that is not JSON: ${next.value.slice(0, 120)}`);
        }
    };
    return {
        async run(c, target, extra) {
            try {
                const reply = await call({ op: "run", case: c, target, headers: extra });
                if (!reply || typeof reply !== "object" || Array.isArray(reply)) return { error: `adapter ${name} gave no observation` };
                if (reply.error !== undefined && typeof reply.error !== "string") return { error: `adapter ${name} gave an error that is not text` };
                return reply as Observation;
            } catch (err) {
                return { error: (err as Error).message };
            }
        },
        async reset(target) {
            const reply = await call({ op: "reset", target });
            if (!reply || reply.ok !== true) {
                throw new Error(`adapter ${name} could not reset ${target.name}: ${typeof reply?.error === "string" ? reply.error : 'it did not answer {"ok":true}'}`);
            }
        },
        async describe() {
            return call({ op: "describe" });
        },
        async close() {
            if (child) child.stdin.end();
            child = undefined;
            lines = undefined;
        },
    };
}
