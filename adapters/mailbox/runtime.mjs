// The part every Node adapter here needs. It is the same file in each adapter's folder, so one
// folder can be copied on its own: the JSON-lines loop, requests that only go straight to an
// address in the settings, and answers that cannot carry a secret. No dependencies.
import { spawnSync } from "node:child_process";
import readline from "node:readline";

// Node's fetch uses HTTP_PROXY when NODE_USE_ENV_PROXY or --use-env-proxy is on, and that can only
// be turned off before Node starts. So start again without it: adapters never use a proxy.
const NODE_OPTIONS = process.env.NODE_OPTIONS ?? "";
const proxySwitchOn = (process.env.NODE_USE_ENV_PROXY ?? "") !== "" || NODE_OPTIONS.includes("--use-env-proxy") || process.execArgv.includes("--use-env-proxy");
if (proxySwitchOn && !process.env.CMTK_ADAPTER_RESTARTED) {
    const env = { ...process.env, CMTK_ADAPTER_RESTARTED: "1", NODE_OPTIONS: NODE_OPTIONS.replaceAll("--use-env-proxy", "").trim() };
    delete env.NODE_USE_ENV_PROXY;
    const args = [...process.execArgv.filter((a) => a !== "--use-env-proxy"), ...process.argv.slice(1)];
    process.exit(spawnSync(process.execPath, args, { stdio: "inherit", env }).status ?? 1);
}

/** A refusal or failure whose message is safe to show. */
export class Refusal extends Error {}

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REQUEST_TIMEOUT_MS = 30_000;

/** An http(s) address from the target's settings, without a trailing slash. It may not hold a user name or password. */
export function address(target, key) {
    const value = target?.[key];
    if (typeof value !== "string" || value === "") throw new Refusal(`target ${target?.name} has no ${key} in its settings`);
    let u;
    try { u = new URL(value); } catch { throw new Refusal(`target ${target.name}: ${key} is not an address`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Refusal(`target ${target.name}: ${key} must be http or https`);
    if (u.username || u.password) throw new Refusal(`target ${target.name}: ${key} must not hold a user name or password`);
    return value.replace(/\/+$/, "");
}

/** True when a credential may be sent to this address: https, or plain http to this machine. */
export function safeForCredentials(url) {
    const u = new URL(url);
    return u.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

/** A number of milliseconds from the settings. */
export function millis(target, key, fallback) {
    const v = target?.[key];
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < 0) throw new Refusal(`target ${target.name}: ${key} must be a whole number of milliseconds`);
    return v;
}

/** The path added to an address. A case holds a path, never a host. */
export function under(base, path) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Refusal("the path must start with a single '/'");
    const url = new URL(base + path);
    if (url.origin !== new URL(base).origin) throw new Refusal("the path leaves the address in the settings");
    return url.href;
}

/** fetch to an address from the settings: redirects are never followed, proxies never used, and errors never quote a value. */
export async function direct(url, init, label) {
    try {
        return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
        if (err?.name === "TimeoutError") throw new Refusal(`ETIMEDOUT: ${label} did not answer in time`);
        const code = err?.cause?.code;
        // fetch quotes a bad header value in its message, so its message is never passed on.
        throw new Refusal(code ? `${code}: cannot reach ${label}` : `the request to ${label} could not be sent`);
    }
}

/** JSON from an answer that must be 2xx. Never quotes the answer: a provider's error text can hold part of a key. */
export async function jsonFrom(res, label) {
    if (res.status >= 300 && res.status < 400) throw new Refusal(`${label} answered a redirect (${res.status}), which is not followed`);
    if (!res.ok) throw new Refusal(`${label} answered ${res.status}`);
    try { return await res.json(); } catch { throw new Refusal(`${label} did not answer with JSON`); }
}

/** Waits until `read()` gives the same answer for `quietMs`. Still changing after `maxMs` is an error: part of an answer is not an answer. */
export async function settle(read, quietMs, maxMs, what) {
    const started = Date.now();
    let last = await read();
    let lastKey = JSON.stringify(last);
    let changed = Date.now();
    while (Date.now() - changed < quietMs) {
        if (Date.now() - started >= maxMs) throw new Refusal(`${what} still changing after ${maxMs} ms`);
        await new Promise((r) => setTimeout(r, Math.max(10, Math.min(200, quietMs / 4))));
        const next = await read();
        const key = JSON.stringify(next);
        if (key !== lastKey) { last = next; lastKey = key; changed = Date.now(); }
    }
    return last;
}

/** Answers an error rather than sending a case without something it asked for. */
export function refuseUnsupported(c) {
    if (!c?.request || typeof c.request.method !== "string") throw new Refusal("the case has no request");
    for (const k of ["body_file", "files", "before"]) if (c.request[k] !== undefined) throw new Refusal(`this adapter does not support request.${k}`);
    if (typeof c.request.body_form === "string") throw new Refusal("this adapter does not support request.body_form as a file; write its fields in the case");
}

/** Sends the case's request to the system. Only called for methods that may change something. The answer's status is all it keeps. */
export async function sendToSystem(c, target, headers) {
    const base = address(target, "base_url");
    const h = { ...(c.request.headers ?? {}), ...(headers ?? {}) };
    const hasType = Object.keys(h).some((k) => k.toLowerCase() === "content-type");
    const { body, body_form: form } = c.request;
    let payload;
    if (form !== undefined && form !== null) {
        const fields = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) for (const one of Array.isArray(v) ? v : [v]) fields.append(k, one === null ? "" : String(one));
        payload = fields.toString();
        h["content-type"] = "application/x-www-form-urlencoded";
    } else if (typeof body === "string") payload = body;
    else if (body !== null && body !== undefined) {
        payload = JSON.stringify(body);
        if (!hasType) h["content-type"] = "application/json";
    }
    const res = await direct(under(base, c.request.path), { method: c.request.method, headers: h, body: payload }, `target ${target.name}`);
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
}

/** Takes every listed secret, and anything shaped like a known kind of key, out of text about to be printed. */
export function scrubber(moreSecrets = () => []) {
    return (text, secrets) => {
        let out = text;
        for (const s of [...secrets, ...moreSecrets()]) {
            if (typeof s !== "string" || s.length < 4) continue;
            out = out.split(JSON.stringify(s).slice(1, -1)).join("<masked>");
        }
        return out.replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_*]+|\bwhsec_[A-Za-z0-9_+/=-]+/g, "<masked>");
    };
}

/** One JSON request per line in, one JSON answer per line out. */
export async function serve({ describe, run, reset }, scrub = scrubber()) {
    for await (const line of readline.createInterface({ input: process.stdin })) {
        let msg, reply;
        try {
            // JSON.parse quotes its input in its message, so that message is never passed on.
            try { msg = JSON.parse(line); } catch { throw new Refusal("the request is not JSON"); }
            if (msg.op === "describe") reply = describe();
            else if (msg.op === "run") reply = await run(msg.case, msg.target, msg.headers ?? {});
            else if (msg.op === "reset") reply = await reset(msg.target);
            else throw new Refusal("unknown op");
        } catch (err) {
            const error = err instanceof Refusal ? err.message : `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}`;
            reply = msg?.op === "reset" ? { ok: false, error } : { error };
        }
        process.stdout.write(scrub(JSON.stringify(reply), Object.values(msg?.headers ?? {})) + "\n");
    }
}
