// Adapters drive one kind of boundary. The HTTP adapter (REST, GraphQL, SOAP) is built in.
// Any other adapter is a program in any language that answers one JSON request per line on
// stdin with one JSON reply per line on stdout:
//   {"op":"describe"}                         → {"kinds":["queue"], "settings":[...]}
//   {"op":"run","case":{...},"target":{...}}  → an Observation
//   {"op":"reset","target":{...}}             → {"ok":true}
// See docs/ADAPTERS.md. `cmtk adapter new` writes a working template.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import readline from "node:readline";
import zlib from "node:zlib";

import type { Case, Observation, Target } from "./types.js";

export const MAX_BODY = 5 * 1024 * 1024;

export interface Adapter {
    run(c: Case, target: Target, extraHeaders: Record<string, string>): Promise<Observation>;
    reset?(target: Target): Promise<void>;
    close?(): Promise<void>;
}

export interface AdapterSpec {
    command: string;
    args?: string[];
}

export function httpAdapter(opts: { timeoutS: number; insecureTls: boolean }): Adapter {
    return {
        run: (c, target, extra) => send(target.base_url, c, extra, opts),
    };
}

/** One request to one target. Redirects are answers, never followed; proxies are never used. */
export function send(baseUrl: string, c: Case, extra: Record<string, string>, opts: { timeoutS: number; insecureTls: boolean }): Promise<Observation> {
    const req = c.request;
    if (!req.path.startsWith("/") || req.path.startsWith("//")) return Promise.resolve({ error: "the path must start with a single '/'" });
    const url = new URL(baseUrl + req.path);
    const lib = url.protocol === "https:" ? https : http;
    const body = typeof req.body === "string" ? Buffer.from(req.body, "utf8") : undefined;
    const headers: Record<string, string> = { ...(req.headers ?? {}), ...extra, "accept-encoding": "identity" };
    if (body) headers["content-length"] = String(body.length);
    return new Promise((resolve) => {
        const r = lib.request(
            url,
            { method: req.method, headers, timeout: opts.timeoutS * 1000, ...(url.protocol === "https:" && opts.insecureTls ? { rejectUnauthorized: false } : {}) },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                let truncated = false;
                res.on("data", (d: Buffer) => {
                    if (size >= MAX_BODY) { truncated = true; return; }
                    chunks.push(d);
                    size += d.length;
                });
                res.on("end", () => {
                    let raw = Buffer.concat(chunks);
                    if (raw.length > MAX_BODY) { raw = raw.subarray(0, MAX_BODY); truncated = true; }
                    const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
                    try {
                        if (enc === "gzip") raw = zlib.gunzipSync(raw);
                        else if (enc === "deflate") raw = zlib.inflateSync(raw);
                        else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
                    } catch {
                        // keep the bytes as they came
                    }
                    const h: Record<string, string> = {};
                    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
                    resolve({ status: res.statusCode, headers: h, body: raw.toString("utf8"), sha256: crypto.createHash("sha256").update(raw).digest("hex"), ...(truncated ? { truncated } : {}) });
                });
                res.on("error", (err) => resolve({ error: `${err.name}: ${err.message}` }));
            },
        );
        r.on("timeout", () => r.destroy(new Error(`no answer within ${opts.timeoutS}s`)));
        r.on("error", (err) => resolve({ error: `${(err as NodeJS.ErrnoException).code ?? err.name}: ${err.message}` }));
        if (body) r.write(body);
        r.end();
    });
}

/** An adapter in its own process, speaking JSON lines. */
export function processAdapter(name: string, spec: AdapterSpec, cwd: string): Adapter {
    let child: ChildProcessWithoutNullStreams | undefined;
    let lines: AsyncIterator<string> | undefined;
    const start = () => {
        if (child) return;
        child = spawn(spec.command, spec.args ?? [], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
        lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    };
    const call = async (msg: unknown): Promise<any> => {
        start();
        child!.stdin.write(JSON.stringify(msg) + "\n");
        const next = await lines!.next();
        if (next.done) throw new Error(`adapter ${name} stopped answering`);
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
                return reply && typeof reply === "object" ? (reply as Observation) : { error: `adapter ${name} gave no observation` };
            } catch (err) {
                return { error: (err as Error).message };
            }
        },
        async reset(target) {
            await call({ op: "reset", target });
        },
        async close() {
            if (child) child.stdin.end();
            child = undefined;
        },
    };
}
