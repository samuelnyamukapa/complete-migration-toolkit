// Turn a HAR recording (browser developer tools, Fiddler, mitmproxy) into case files.
// Credentials, static files and duplicates never make it into a case: credential headers are
// dropped, and credential-like query values and body fields (JSON, forms, XML and SOAP) become REDACTED.
import crypto from "node:crypto";
import fs from "node:fs";
import YAML from "yaml";

import type { Case } from "./types.js";

const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webp|mp4|webm)$/i;
export const DROPPED_HEADERS = new Set([
    "cookie", "authorization", "proxy-authorization", "host", "content-length", "connection", "accept-encoding", "origin", "referer",
    "user-agent", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "sec-ch-ua", "sec-ch-ua-mobile",
    "sec-ch-ua-platform", "upgrade-insecure-requests", "x-xsrf-token", "x-csrf-token", "requestverificationtoken", "if-none-match",
    "if-modified-since", "cache-control", "pragma", "priority",
]);

export interface HarImport {
    cases: Case[];
    skipped: number;
    droppedHeaders: string[];
    /** Cases in which a credential-like query value or body field was replaced with REDACTED. */
    redacted: string[];
}

export const REDACTED = "REDACTED";

/** Names that usually carry a credential: dropped as headers, replaced as query values and body fields. */
export function looksSecret(name: string): boolean {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["key", "code", "sig", "sid", "pin", "otp", "totp", "mfa", "session", "jwt", "pass", "pwd", "secret", "token", "hash", "nonce", "pan"].includes(n)) return true;
    return /token|secret|passw|apikey|subscriptionkey|accesskey|privatekey|signature|sessionid|credential|^x?auth(orization|key|code|header)?$|cookie|csrf|xsrf|bearer|pincode|cvv|cvc|cardnumber/.test(n);
}

function redactJson(v: unknown): [unknown, boolean] {
    if (Array.isArray(v)) {
        let hit = false;
        const out = v.map((x) => { const [y, h] = redactJson(x); hit ||= h; return y; });
        return [out, hit];
    }
    if (v && typeof v === "object") {
        let hit = false;
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
            if (looksSecret(k) && x !== null && typeof x !== "object") { out[k] = REDACTED; hit = true; continue; }
            const [y, h] = redactJson(x);
            out[k] = y;
            hit ||= h;
        }
        return [out, hit];
    }
    return [v, false];
}

/** A request body with every credential-like field replaced: JSON, form fields and XML or SOAP elements. */
export function redactBody(text: string, contentType: string): [string, boolean] {
    const ct = contentType.toLowerCase();
    const trimmed = text.trimStart();
    if (ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const [v, hit] = redactJson(JSON.parse(text));
            return hit ? [JSON.stringify(v), true] : [text, false];
        } catch {
            // not JSON after all; fall through
        }
    }
    if (ct.includes("x-www-form-urlencoded")) {
        const p = new URLSearchParams(text);
        let hit = false;
        for (const k of [...new Set(p.keys())]) if (looksSecret(k)) { p.set(k, REDACTED); hit = true; }
        return hit ? [p.toString(), true] : [text, false];
    }
    if (ct.includes("xml") || ct.includes("soap") || trimmed.startsWith("<")) {
        let hit = false;
        const out = text.replace(/<((?:[\w.-]+:)?([\w.-]+))(\s[^>]*)?>([^<]*)<\/\1>/g, (m, tag: string, local: string, attrs: string | undefined, inner: string) => {
            if (!looksSecret(local) || !inner.trim()) return m;
            hit = true;
            return `<${tag}${attrs ?? ""}>${REDACTED}</${tag}>`;
        });
        return [out, hit];
    }
    // Any other format: keep it only if nothing in it looks like a credential.
    return /passw|token|secret|api[-_]?key/i.test(text) ? [REDACTED, true] : [text, false];
}

const key = (c: Case) => crypto.createHash("sha256").update(JSON.stringify([c.request.method, c.request.path, c.request.body ?? ""])).digest("hex");

export function importHar(files: string[], opts: { include?: string; exclude?: string; prefix?: string; existing?: Case[] } = {}): HarImport {
    const inc = opts.include ? new RegExp(opts.include) : undefined;
    const exc = opts.exclude ? new RegExp(opts.exclude) : undefined;
    const seen = new Set((opts.existing ?? []).map(key));
    const prefix = opts.prefix ?? "HAR";
    let n = 1 + Math.max(0, ...(opts.existing ?? []).map((c) => Number(new RegExp(`^${prefix}-(\\d+)$`).exec(c.id)?.[1] ?? 0)));
    const cases: Case[] = [];
    const dropped = new Set<string>();
    const redacted: string[] = [];
    let skipped = 0;
    for (const file of files) {
        const har = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const e of har?.log?.entries ?? []) {
            const r = e?.request ?? {};
            let u: URL;
            try {
                u = new URL(String(r.url ?? ""));
            } catch {
                skipped++;
                continue;
            }
            const url = u.toString();
            if (STATIC.test(u.pathname) || (inc && !inc.test(url)) || (exc && exc.test(url))) { skipped++; continue; }
            const headers: Record<string, string> = {};
            for (const h of r.headers ?? []) {
                const name = String(h?.name ?? "");
                if (!name || name.startsWith(":")) continue;
                if (DROPPED_HEADERS.has(name.toLowerCase()) || looksSecret(name)) { dropped.add(name.toLowerCase()); continue; }
                headers[name] = String(h.value ?? "");
            }
            const method = String(r.method ?? "GET").toUpperCase();
            let hidden = false;
            for (const k of [...new Set(u.searchParams.keys())]) if (looksSecret(k)) { u.searchParams.set(k, REDACTED); hidden = true; }
            const p = u.pathname + u.search;
            let body: string | null = r.postData?.text || null;
            if (body) {
                const ct = String(r.postData?.mimeType ?? Object.entries(headers).find(([h]) => h.toLowerCase() === "content-type")?.[1] ?? "");
                const [b, hit] = redactBody(body, ct);
                body = b;
                hidden ||= hit;
            }
            const id = `${prefix}-${String(n).padStart(3, "0")}`;
            const c: Case = { id, name: `${method} ${p}`.slice(0, 120), request: { method, path: p, headers, body }, source: `har:${file}` };
            const k = key(c);
            if (seen.has(k)) { skipped++; continue; }
            seen.add(k);
            if (hidden) redacted.push(id);
            cases.push(c);
            n++;
        }
    }
    return { cases, skipped, droppedHeaders: [...dropped].sort(), redacted };
}

export function casesToYaml(cases: Case[], header = "Imported from HAR recordings. Add `requirement:` and `expect:` to turn them into tests."): string {
    const plain = cases.map(({ file: _f, ...c }) => c);
    return `# ${header}\n` + YAML.stringify({ cases: plain }, { lineWidth: 0 });
}
