// Turn a HAR recording (browser developer tools, Fiddler, mitmproxy) into case files.
// Credentials, static files and duplicates never make it into a case.
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
                if (DROPPED_HEADERS.has(name.toLowerCase())) { dropped.add(name.toLowerCase()); continue; }
                headers[name] = String(h.value ?? "");
            }
            const method = String(r.method ?? "GET").toUpperCase();
            const p = u.pathname + u.search;
            const c: Case = { id: `${prefix}-${String(n).padStart(3, "0")}`, name: `${method} ${p}`.slice(0, 120), request: { method, path: p, headers, body: r.postData?.text || null }, source: `har:${file}` };
            const k = key(c);
            if (seen.has(k)) { skipped++; continue; }
            seen.add(k);
            cases.push(c);
            n++;
        }
    }
    return { cases, skipped, droppedHeaders: [...dropped].sort() };
}

export function casesToYaml(cases: Case[], header = "Imported from HAR recordings. Add `requirement:` and `expect:` to turn them into tests."): string {
    const plain = cases.map(({ file: _f, ...c }) => c);
    return `# ${header}\n` + YAML.stringify({ cases: plain }, { lineWidth: 0 });
}
