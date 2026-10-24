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

import { formValueProblem } from "./manifest.js";
import type { Before, BeforeOutcome, Case, FormValue, InputFile, Observation, Target } from "./types.js";

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

/** A form value as the text a browser would send: booleans as true/false, null as an empty value. */
const formText = (v: string | number | boolean | null) => (v === null ? "" : typeof v === "boolean" ? (v ? "true" : "false") : String(v));

/**
 * The form fields of a case, in order, as name and text pairs: from `body_form` (a file or a mapping),
 * then the values a `before` page gave, which replace a field of the same name.
 */
function formFields(c: Case, readFile: (rel: string) => Buffer, taken: Record<string, string>): { pairs: [string, string][]; inputs: InputFile[] } {
    const req = c.request;
    let fields: Record<string, FormValue> = {};
    const inputs: InputFile[] = [];
    if (typeof req.body_form === "string") {
        const bytes = readFile(req.body_form);
        inputs.push({ ...fingerprint(req.body_form, bytes), as: "form" });
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`body_form: ${req.body_form} is not JSON`); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`body_form: ${req.body_form} holds ${Array.isArray(parsed) ? "a list" : "a value"}, not an object; a form is named fields`);
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            const bad = formValueProblem(v);
            if (bad) throw new Error(`body_form: ${req.body_form}: ${k} ${bad}`);
        }
        fields = parsed as Record<string, FormValue>;
    } else if (req.body_form) fields = req.body_form;
    const pairs: [string, string][] = [];
    for (const [k, v] of Object.entries(fields)) {
        if (k in taken) continue;
        if (/[\r\n"]/.test(k)) throw new Error(`body_form: the field name ${JSON.stringify(k)} holds a quote or a line break`);
        for (const one of Array.isArray(v) ? v : [v]) pairs.push([k, formText(one)]);
    }
    for (const [k, v] of Object.entries(taken)) pairs.push([k, v]);
    return { pairs, inputs };
}

/**
 * The body a case sends, from `body`, `body_file`, `body_form` or `files`, with the files it sent fingerprinted.
 * Files are read from `root` (the project folder); a missing file is an error, never an empty body.
 * `taken` holds the values a `before` page gave, which go into the form.
 */
export function requestBody(c: Case, root: string | undefined, headers: Record<string, string>, taken: Record<string, string> = {}): { body?: Buffer; inputs: InputFile[] } | { error: string } {
    const req = c.request;
    const hasType = () => Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
    const readFile = (rel: string) => {
        const full = path.resolve(root ?? process.cwd(), rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`input file ${rel} does not exist`);
        return fs.readFileSync(full);
    };
    try {
        if (req.files?.length) {
            const form = formFields(c, readFile, taken);
            const inputs: InputFile[] = [...form.inputs];
            const parts: Buffer[] = [];
            for (const [name, value] of form.pairs) parts.push(Buffer.from(`--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
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
        if (req.body_form !== undefined) {
            const form = formFields(c, readFile, taken);
            const encoded = new URLSearchParams(form.pairs).toString();
            headers["content-type"] = "application/x-www-form-urlencoded";
            return { body: Buffer.from(encoded, "utf8"), inputs: form.inputs };
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const unescapeHtml = (s: string) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10)) : (ENTITIES[e] ?? m));

/**
 * One value from a page: `input[name=x]` gives that input's `value`, `meta[name=x]` its `content`,
 * `tag[attr=x]@attr` any attribute, `regex:<pattern>` the pattern's first group. Undefined when nothing matches.
 */
export function takeFromPage(html: string, selector: string): string | undefined {
    if (selector.startsWith("regex:")) {
        const m = new RegExp(selector.slice(6)).exec(html);
        return m ? (m[1] ?? m[0]) : undefined;
    }
    const s = /^([a-zA-Z][\w-]*)\[([\w:-]+)=(?:"([^"]*)"|'([^']*)'|([^\]]*))\](?:@([\w:-]+))?$/.exec(selector.trim());
    if (!s) throw new Error(`the selector ${JSON.stringify(selector)} is not tag[attr=value], tag[attr=value]@attr, regex:<pattern> or cookie:<name>`);
    const [, tag, attr, q1, q2, bare, at] = s;
    const want = (q1 ?? q2 ?? bare ?? "").trim();
    const take = (at ?? (tag!.toLowerCase() === "meta" ? "content" : "value")).toLowerCase();
    const tags = new RegExp(`<${tag}\\b([^>]*)>`, "gi");
    for (let t = tags.exec(html); t; t = tags.exec(html)) {
        const attrs: Record<string, string> = {};
        const a = /([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
        for (let m = a.exec(t[1]!); m; m = a.exec(t[1]!)) attrs[m[1]!.toLowerCase()] = unescapeHtml(m[2] ?? m[3] ?? m[4] ?? "");
        if (attrs[attr!.toLowerCase()] === want && take in attrs) return attrs[take];
    }
    return undefined;
}

/** Cookies from Set-Cookie headers, name to value, attributes dropped: they go back to the same target. */
export function cookiesOf(setCookie: string[]): Record<string, string> {
    const jar: Record<string, string> = {};
    for (const line of setCookie) {
        const first = line.split(";")[0]!;
        const eq = first.indexOf("=");
        if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
    return jar;
}

/**
 * The `before` step: one GET to the same target, for the values its page carries and the cookies it sets.
 * The values are returned for the request and never written anywhere; the evidence gets their names.
 */
async function prepare(baseUrl: string, c: Case, before: Before, extra: Record<string, string>, opts: { timeoutS: number; insecureTls: boolean; root?: string }): Promise<{ taken: Record<string, string>; cookies: Record<string, string>; outcome: BeforeOutcome } | { error: string }> {
    const label = `before: GET ${before.get}`;
    const headers = Object.fromEntries(Object.entries(c.request.headers ?? {}).filter(([k]) => !["content-type", "content-length"].includes(k.toLowerCase())));
    const page = await transfer(baseUrl, { id: c.id, request: { method: "GET", path: before.get, headers } }, extra, opts);
    if (page.obs.error) return { error: `${label}: ${page.obs.error}` };
    if (!page.obs.status || page.obs.status < 200 || page.obs.status >= 300) return { error: `${label} answered ${page.obs.status}; the page a value is taken from must answer 2xx` };
    const cookies = cookiesOf(page.setCookie);
    const taken: Record<string, string> = {};
    for (const [field, selector] of Object.entries(before.take ?? {})) {
        let value: string | undefined;
        try {
            value = selector.startsWith("cookie:") ? cookies[selector.slice(7).trim()] : takeFromPage(page.obs.body ?? "", selector);
        } catch (err) {
            return { error: `${label}: ${(err as Error).message}` };
        }
        if (value === undefined) return { error: `${label}: nothing on the page matches ${selector} for ${field}` };
        taken[field] = value;
    }
    return { taken, cookies, outcome: { request: `GET ${before.get}`, status: page.obs.status, took: Object.keys(taken), cookies: Object.keys(cookies) } };
}

/**
 * One request to one target. Redirects are answers, never followed; proxies are never used.
 * The whole answer must arrive within the timeout, and reading stops at 5 MB (after decompression).
 * With `before`, a page is read first and its cookies and the values taken from it go on the request.
 */
export async function send(baseUrl: string, c: Case, extra: Record<string, string>, opts: { timeoutS: number; insecureTls: boolean; root?: string }): Promise<Observation> {
    const req = c.request;
    if (!req.path.startsWith("/") || req.path.startsWith("//")) return { error: "the path must start with a single '/'" };
    if (!req.before) return (await transfer(baseUrl, c, extra, opts)).obs;
    const prep = await prepare(baseUrl, c, req.before, extra, opts);
    if ("error" in prep) return { error: prep.error };
    const jar = Object.entries(prep.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const own = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === "cookie");
    const headers = { ...(req.headers ?? {}) };
    if (jar) {
        if (own) delete headers[own[0]];
        headers["cookie"] = own && own[1] ? `${own[1]}; ${jar}` : jar;
    }
    const { obs } = await transfer(baseUrl, { ...c, request: { ...req, headers } }, extra, opts, prep.taken);
    return { ...obs, before: prep.outcome };
}

/** The request itself. `setCookie` is the answer's Set-Cookie lines, kept apart because joining them loses their boundaries. */
function transfer(baseUrl: string, c: Case, extra: Record<string, string>, opts: { timeoutS: number; insecureTls: boolean; root?: string }, taken: Record<string, string> = {}): Promise<{ obs: Observation; setCookie: string[] }> {
    const req = c.request;
    const url = new URL(baseUrl + req.path);
    const secure = url.protocol === "https:";
    const headers: Record<string, string> = { ...(req.headers ?? {}), ...extra, "accept-encoding": "identity" };
    const made = requestBody(c, opts.root, headers, taken);
    if ("error" in made) return Promise.resolve({ obs: { error: made.error }, setCookie: [] });
    const { body, inputs } = made;
    if (body) headers["content-length"] = String(body.length);
    const withInputs = (o: Observation): Observation => (inputs.length ? { ...o, inputs } : o);

    return new Promise((resolve) => {
        let done = false;
        let r: http.ClientRequest | undefined;
        let setCookie: string[] = [];
        const finish = (o: Observation) => {
            if (done) return;
            done = true;
            clearTimeout(deadline);
            r?.destroy();
            resolve({ obs: withInputs(o), setCookie });
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
                setCookie = res.headers["set-cookie"] ?? [];
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
