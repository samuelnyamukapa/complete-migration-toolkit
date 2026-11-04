// `cmtk shadow`: replay read-only requests from a log or a mirror file against both systems, to find the
// differences nobody thought to test. cmtk reads a file the client already has. It is not a proxy and never sits
// in the path of live traffic. The order matters: each line is cleaned first, the clean request is written to the
// capture file, and only what the capture file holds is ever sent. The source file is never copied.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { httpAdapter } from "./adapters.js";
import { cleanUrl } from "./defects.js";
import { compareObservations, scrubberOf } from "./diff.js";
import { coveringDrift } from "./drift.js";
import { evidenceDir, envHeaders, matchFor, SAFE_METHODS, settingsOf, STOP_AFTER_NO_ANSWER } from "./engine.js";
import { DROPPED_HEADERS, looksSecret, REDACTED } from "./har.js";
import { loadDrift, ManifestError } from "./manifest.js";
import { OVERRIDE_HEADERS, overrideIn } from "./methods.js";
import { noiseKind } from "./report.js";
import { scrubRules } from "./trend.js";
import type { Case, Difference, Manifest, ReportSettings, Target } from "./types.js";

export type ShadowVerdict = "NO UNEXPLAINED DIFFERENCES" | "UNEXPLAINED DIFFERENCES" | "INCOMPLETE" | "NO EVIDENCE";
export const SHADOW_FORMATS = ["auto", "clf", "w3c", "jsonl"] as const;
export type ShadowFormat = (typeof SHADOW_FORMATS)[number];

export interface ShadowOptions {
    /** The log or mirror files to read. They are only read, and only their file names are recorded. */
    from: string[];
    format?: ShadowFormat;
    /** The share of eligible requests to replay, above 0 and up to 1. Default 1. */
    sample?: number;
    /** Decides which requests the sample keeps. The same seed and file keep the same requests. Default 1. */
    seed?: number;
    /** Requests per second to each system. Requests are sent one at a time. Default 5. */
    rate?: number;
    /** The most requests to replay. Default 1000. */
    max?: number;
    /** Regular expressions on the cleaned path. */
    include?: string;
    exclude?: string;
    /** Request headers to keep besides Accept and Accept-Language. Credential headers are refused. */
    keepHeaders?: string[];
    /** Regular expressions for values of your own to redact, such as a customer number. */
    redact?: string[];
    /** Store differing values, with personal data redacted, instead of withholding them. For test data only. */
    keepValues?: boolean;
    /** Write the capture file and send nothing, so a person can read it first. */
    captureOnly?: boolean;
    /** Also keep this run in a dated folder. */
    dated?: boolean;
    date?: string;
    note?: (line: string) => void;
    /** For tests. */
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/** One request as the capture file holds it: cleaned, and all that is ever sent. */
export interface CapturedRequest {
    n: number;
    method: string;
    path: string;
    headers?: Record<string, string>;
    /** What was replaced with REDACTED, by kind. The value itself is gone. */
    redacted?: string[];
}

export interface ShadowDifference {
    where: string;
    requests: number;
    /** The drift ledger entry that approves it, if any. */
    drift?: string;
    /** The capture file's number of the first request that showed it. */
    first_request: number;
    reference: string;
    candidate: string;
}

export interface ShadowEndpoint {
    endpoint: string;
    requests: number;
    matched: number;
    drift: number;
    /** Requests with at least one difference no drift entry explains. */
    unexplained: number;
    errors: number;
    /** Requests whose answer was over 5 MB, so only the first 5 MB were compared. */
    truncated?: number;
    differences: ShadowDifference[];
    /** Differences beyond the 200 places kept for this endpoint. */
    more_differences?: number;
    first_error?: string;
}

export interface ShadowReport {
    tool: "cmtk";
    mode: "shadow";
    system: string;
    date: string;
    verdict: ShadowVerdict;
    targets: Record<string, string>;
    sources: string[];
    capture: {
        lines: number;
        unreadable: number;
        /** Requests never sent because they could change data, by method. */
        dropped: Record<string, number>;
        dropped_total: number;
        filtered: number;
        sampled_out: number;
        over_limit: number;
        kept: number;
        redacted_requests: number;
        redactions: Record<string, number>;
        credential_headers_stripped: number;
        sample: number;
        seed: number;
        max: number;
        rate_per_second: number;
    };
    replay: { sent: number; matched: number; drift: number; different: number; errors: number; not_sent: number; /** Requests with an answer over 5 MB, of which only the first 5 MB were compared. */ truncated: number };
    endpoints: ShadowEndpoint[];
    /** "withheld": differing values are not stored. "redacted": stored with personal data redacted. */
    values: "withheld" | "redacted";
    capture_only: boolean;
    unused_drift: string[];
    suggested_scrubs: { where: string; cases: number; why: string }[];
    settings: ReportSettings;
    /** How many times each scrub rule changed something, including the ones that never did. */
    scrub_fired?: Record<string, number>;
    reason: string;
    next: string;
}

const DEFAULT_HEADERS = new Set(["accept", "accept-language"]);
const NO_ANSWER = /^(ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b/;
const MAX_PATH = 8000;
const MAX_PLACES = 200;

/** Query and field names that usually hold personal data. */
export function looksPersonal(name: string): boolean {
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    return /^(name|forename|givenname|familyname|displayname|username|user|login|mail|telephone|tel|msisdn|address|addressline\d?|street|postalcode|zip|zipcode|dob|birthdate|birthday|ssn|nino|licencenumber|licensenumber|iban|sortcode|accountnumber|cardholder|ip|ipaddress|clientip|contact)$/.test(n)
        || /(email|phone|mobile|surname|lastname|firstname|fullname|postcode|dateofbirth|passport|nationalinsurance)/.test(n);
}

const luhn = (digits: string) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
    }
    return sum % 10 === 0;
};

const SHAPES: [string, RegExp, ((match: string) => boolean)?][] = [
    ["email", /[^\s@/?&=;,"'<>]+@[^\s@/?&=;,"'<>]+\.[A-Za-z]{2,}/g],
    ["token", /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g],
    ["token", /\b(?:sk|pk|rk)_(?:live|test)_\w+/g],
    ["token", /\b[A-Fa-f0-9]{32,}\b/g],
    ["token", /[A-Za-z0-9+_-]{40,}={0,2}/g],
    ["card number", /\b\d(?:[ -]?\d){12,18}\b/g, (m) => luhn(m.replace(/\D/g, ""))],
    ["national number", /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi],
    ["national number", /\b\d{3}-\d{2}-\d{4}\b/g],
    ["bank account", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
    ["postcode", /\b[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?[ +]?\d[ABD-HJLNP-UW-Z]{2}\b/gi],
    ["phone number", /(?:\+|\b00)\d[\d ()-]{7,16}\d\b/g],
    ["phone number", /\b0\d{9,10}\b/g],
    ["IP address", /\b\d{1,3}(?:\.\d{1,3}){3}\b/g],
];

/** Text with every value shaped like personal data or a credential replaced. Returns the kinds it found. */
export function redactText(text: string, own: RegExp[] = []): { text: string; kinds: string[] } {
    const kinds: string[] = [];
    let out = text;
    for (const rx of own) out = out.replace(rx, () => { kinds.push("your --redact rule"); return REDACTED; });
    for (const [kind, rx, keep] of SHAPES) {
        out = out.replace(rx, (m) => {
            if (keep && !keep(m)) return m;
            kinds.push(kind);
            return REDACTED;
        });
    }
    return { text: out, kinds };
}

const decoded = (s: string) => {
    try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
};

/** Keep the value's exact encoding unless something in it has to go, so a replay sends what the log says. */
function cleanValue(raw: string, name: string, own: RegExp[], kinds: string[]): string {
    if (looksSecret(name)) { kinds.push("credential"); return REDACTED; }
    if (looksPersonal(name)) { kinds.push("personal field"); return REDACTED; }
    const r = redactText(decoded(raw), own);
    if (!r.kinds.length) return raw;
    kinds.push(...r.kinds);
    return REDACTED;
}

/** A path and query with credentials and personal data replaced. Never returns anything from a host or a user. */
export function cleanTarget(target: string, own: RegExp[] = []): { path: string; kinds: string[] } | undefined {
    let t = target.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
        // An absolute request line: keep the path only. A host in a log never decides where a request goes.
        const slash = t.indexOf("/", t.indexOf("://") + 3);
        t = slash < 0 ? "/" : t.slice(slash);
    }
    t = t.split("#")[0]!;
    if (!t.startsWith("/") || t.startsWith("//") || t.length > MAX_PATH || /[\s\u0000-\u001f\u007f]/.test(t)) return undefined;
    const q = t.indexOf("?");
    const pathPart = q < 0 ? t : t.slice(0, q);
    const query = q < 0 ? undefined : t.slice(q + 1);
    const kinds: string[] = [];
    const segments = pathPart.split("/").map((seg) => {
        const [head, ...params] = seg.split(";");
        const r = redactText(decoded(head!), own);
        kinds.push(...r.kinds);
        const cleanParams = params.map((p) => {
            const eq = p.indexOf("=");
            return eq < 0 ? p : `${p.slice(0, eq)}=${cleanValue(p.slice(eq + 1), p.slice(0, eq), own, kinds)}`;
        });
        return [r.kinds.length ? REDACTED : head!, ...cleanParams].join(";");
    });
    let out = segments.join("/");
    if (query !== undefined) {
        out += `?${query.split("&").map((pair) => {
            const eq = pair.indexOf("=");
            if (eq < 0) {
                const r = redactText(decoded(pair), own);
                kinds.push(...r.kinds);
                return r.kinds.length ? REDACTED : pair;
            }
            const name = decoded(pair.slice(0, eq));
            return `${pair.slice(0, eq)}=${cleanValue(pair.slice(eq + 1), name, own, kinds)}`;
        }).join("&")}`;
    }
    return { path: out, kinds };
}

interface RawRequest {
    method: string;
    target: string;
    headers: Record<string, string>;
    hasBody: boolean;
}

const CLF = /"([A-Za-z]+) (\S+)(?: HTTP\/[\d.]+)?"/;

function fromJson(line: string): RawRequest | undefined {
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { return undefined; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
    const text = (...keys: string[]) => { for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string; return undefined; };
    let method = text("method", "request_method", "verb", "httpMethod", "cs-method");
    let target = text("uri", "url", "request_uri", "requestUri", "target", "path", "cs-uri-stem");
    const line1 = text("request");
    if ((!method || !target) && line1) {
        const m = /^([A-Za-z]+) (\S+)/.exec(line1);
        if (m) { method ??= m[1]; target ??= m[2]; }
    }
    if (!method || !target) return undefined;
    const query = text("query", "query_string", "args", "cs-uri-query");
    if (query && query !== "-" && !target.includes("?")) target += `?${query.replace(/^\?/, "")}`;
    const headers: Record<string, string> = {};
    if (o.headers && typeof o.headers === "object" && !Array.isArray(o.headers)) {
        for (const [k, v] of Object.entries(o.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    const body = o.body ?? o.request_body ?? o.postData;
    return { method, target, headers, hasBody: body !== undefined && body !== null && body !== "" && body !== "-" };
}

/** A reader for one file. W3C logs (IIS) name their columns in a #Fields line, so it keeps state. */
function lineReader(format: ShadowFormat) {
    let fields: string[] | undefined;
    return (line: string): RawRequest | "skip" | undefined => {
        if (!line.trim()) return "skip";
        if (line.startsWith("#")) {
            if (line.startsWith("#Fields:")) fields = line.slice(8).trim().split(/\s+/);
            return "skip";
        }
        const kind = format !== "auto" ? format : fields ? "w3c" : line.trimStart().startsWith("{") ? "jsonl" : "clf";
        if (kind === "jsonl") return fromJson(line);
        if (kind === "w3c") {
            const cols = line.trim().split(/\s+/);
            const at = (name: string) => { const i = fields?.indexOf(name) ?? -1; return i >= 0 ? cols[i] : undefined; };
            const method = at("cs-method"), stem = at("cs-uri-stem"), query = at("cs-uri-query");
            if (!method || !stem) return undefined;
            return { method, target: query && query !== "-" ? `${stem}?${query}` : stem, headers: {}, hasBody: false };
        }
        const m = CLF.exec(line);
        return m ? { method: m[1]!, target: m[2]!, headers: {}, hasBody: false } : undefined;
    };
}

/** Why a request must not be sent, in the words the report counts it under. Undefined when it may be. */
function unsafeWhy(method: string, raw: RawRequest): string | undefined {
    if (!SAFE_METHODS.has(method)) return method;
    if (raw.hasBody) return `${method} with a body`;
    return overrideIn(raw.target, raw.headers) === undefined ? undefined : `${method} that overrides its method`;
}

/** Numbers, GUIDs, long hex and redacted values become {id}, so one endpoint is one line of the report. */
export function endpointOf(method: string, p: string): string {
    const clean = p.split("?")[0]!.split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || s === REDACTED ? "{id}" : s)).join("/");
    return `${method} ${clean}`;
}

function regexOf(pattern: string, flag: string, flags = ""): RegExp {
    try {
        return new RegExp(pattern, flags);
    } catch (err) {
        throw new ManifestError(`${flag}: ${JSON.stringify(pattern)} is not a valid regular expression: ${(err as Error).message}`);
    }
}

function numberOption(v: number | undefined, fallback: number, flag: string, ok: (n: number) => boolean, want: string): number {
    if (v === undefined) return fallback;
    if (!Number.isFinite(v) || !ok(v)) throw new ManifestError(`${flag} must be ${want}.`);
    return v;
}

/** Read the source files into clean requests. Nothing raw leaves this function. */
export async function captureRequests(sources: string[], o: { format?: ShadowFormat; sample: number; seed: number; max: number; include?: string; exclude?: string; keepHeaders?: string[]; redact?: string[] }) {
    const inc = o.include ? regexOf(o.include, "--include") : undefined;
    const exc = o.exclude ? regexOf(o.exclude, "--exclude") : undefined;
    const own = (o.redact ?? []).map((r) => regexOf(r, "--redact", "g"));
    const keep = new Set(DEFAULT_HEADERS);
    for (const h of o.keepHeaders ?? []) {
        const n = h.trim().toLowerCase();
        if (!n || DROPPED_HEADERS.has(n) || looksSecret(n, "header") || OVERRIDE_HEADERS.has(n)) throw new ManifestError(`--keep-header ${h}: that header is never kept, because it can hold a credential or change the method. Credentials for a replay come from headers_from_env.`);
        keep.add(n);
    }
    const stats: ShadowReport["capture"] = { lines: 0, unreadable: 0, dropped: {}, dropped_total: 0, filtered: 0, sampled_out: 0, over_limit: 0, kept: 0, redacted_requests: 0, redactions: {}, credential_headers_stripped: 0, sample: o.sample, seed: o.seed, max: o.max, rate_per_second: 0 };
    const requests: CapturedRequest[] = [];
    let eligible = 0;
    for (const file of sources) {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new ManifestError(`${path.basename(file)} does not exist or is not a file.`);
        const read = lineReader(o.format ?? "auto");
        const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
        for await (const line of lines) {
            const raw = read(line);
            if (raw === "skip") continue;
            stats.lines++;
            // A line that cannot be read is counted, never shown: it can hold anything.
            if (!raw) { stats.unreadable++; continue; }
            const method = raw.method.toUpperCase();
            if (!/^[A-Z]{1,20}$/.test(method)) { stats.unreadable++; continue; }
            const unsafe = unsafeWhy(method, raw);
            if (unsafe) { stats.dropped[unsafe] = (stats.dropped[unsafe] ?? 0) + 1; stats.dropped_total++; continue; }
            const clean = cleanTarget(raw.target, own);
            if (!clean) { stats.unreadable++; continue; }
            if ((inc && !inc.test(clean.path)) || (exc && exc.test(clean.path))) { stats.filtered++; continue; }
            const ordinal = eligible++;
            if (o.sample < 1 && crypto.createHash("sha256").update(`${o.seed}:${ordinal}`).digest().readUInt32BE(0) / 2 ** 32 >= o.sample) { stats.sampled_out++; continue; }
            if (requests.length >= o.max) { stats.over_limit++; continue; }
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(raw.headers)) {
                const n = k.toLowerCase();
                if (looksSecret(k, "header") || n === "cookie" || n === "authorization") stats.credential_headers_stripped++;
                else if (keep.has(n) && !/[\r\n]/.test(v)) {
                    const r = redactText(v, own);
                    headers[n] = r.text;
                    clean.kinds.push(...r.kinds);
                }
            }
            const kinds = [...new Set(clean.kinds)].sort();
            for (const k of clean.kinds) stats.redactions[k] = (stats.redactions[k] ?? 0) + 1;
            if (kinds.length) stats.redacted_requests++;
            requests.push({ n: requests.length + 1, method, path: clean.path, ...(Object.keys(headers).length ? { headers } : {}), ...(kinds.length ? { redacted: kinds } : {}) });
        }
    }
    stats.kept = requests.length;
    return { requests, stats };
}

/** The status and the content type are safe to show. Anything else from an answer can hold personal data. */
const OPEN_WHERE = /^(status|header:content-type|body encoding)$/;

function shownValue(v: string, where: string, keepValues: boolean): string {
    if (v === "(missing)" || OPEN_WHERE.test(where)) return v;
    if (!keepValues) return `(withheld: ${noiseKind(v) ?? `${v.length} characters`})`;
    const last = where.split(/[.:/[\]]+/).filter(Boolean).pop() ?? "";
    if (looksSecret(where) || looksSecret(last) || looksPersonal(last)) return REDACTED;
    return redactText(v).text;
}

const say = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function decide(c: ShadowReport["capture"], r: ShadowReport["replay"], captureOnly: boolean) {
    const limit = `This covers only the ${say(r.sent, "read-only request")} replayed, never the whole system.`
        + (c.dropped_total ? ` ${say(c.dropped_total, "request")} that could change data ${c.dropped_total === 1 ? "was" : "were"} dropped and never sent.` : "")
        + (c.sampled_out ? ` ${c.sampled_out} left out by sampling.` : "")
        + (c.over_limit ? ` ${c.over_limit} left out by the limit of ${c.max}.` : "");
    const unexplainedNext = "for each one: scrub it if it is noise, approve it as drift (a named person, in the drift ledger), or fix the candidate. Then replay again.";
    if (captureOnly) return { verdict: "NO EVIDENCE" as ShadowVerdict, reason: `Capture only: ${say(c.kept, "clean request")} written, and nothing sent.`, next: "read capture.jsonl for anything personal the shapes missed. Use --redact for a value of your own, then run again without --capture-only." };
    if (!c.kept) return { verdict: "NO EVIDENCE" as ShadowVerdict, reason: `No request could be replayed: of ${say(c.lines, "line")}, ${c.dropped_total} could change data, ${c.unreadable} could not be read and ${c.filtered + c.sampled_out} were left out.`, next: "check the file holds GET, HEAD or OPTIONS requests in a format cmtk reads, then run again." };
    if (r.different) return { verdict: "UNEXPLAINED DIFFERENCES" as ShadowVerdict, reason: `${say(r.different, "request")} answered differently, with no approved drift to explain ${r.different === 1 ? "it" : "them"}. ${limit}`, next: unexplainedNext };
    if (!r.sent) return { verdict: "NO EVIDENCE" as ShadowVerdict, reason: `No request got an answer from both systems: ${say(r.errors, "error")}, ${r.not_sent} not sent.`, next: "check both systems are up, then run again." };
    if (r.errors || r.not_sent) return { verdict: "INCOMPLETE" as ShadowVerdict, reason: `${say(r.errors, "request")} could not be compared and ${r.not_sent} ${r.not_sent === 1 ? "was" : "were"} not sent. ${limit}`, next: "check both systems are up, then run again." };
    if (r.truncated) return { verdict: "INCOMPLETE" as ShadowVerdict, reason: `${say(r.truncated, "request")} had an answer over 5 MB, and only the first 5 MB were compared. ${limit}`, next: "a person checks those endpoints another way. The report's endpoints say which." };
    return { verdict: "NO UNEXPLAINED DIFFERENCES" as ShadowVerdict, reason: `No unexplained difference. ${limit}`, next: "keep replaying for the agreed period. This is one kind of evidence, and it says nothing about requests that change data, which `cmtk compare` covers." };
}

const cell = (v: unknown) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/`/g, "'");

export function renderShadow(r: ShadowReport): string {
    const c = r.capture, p = r.replay;
    const L = [`# Shadow traffic report: ${r.system}`, "", `**Verdict: ${r.verdict}**`, "", r.reason, "", `Next: ${r.next}`, "", `- Date: ${r.date}`];
    for (const [name, url] of Object.entries(r.targets)) L.push(`- ${name}: \`${url}\``);
    L.push(`- Read from: ${r.sources.map(cell).join(", ")}`, `- Values: ${r.values === "withheld" ? "differing values are not stored (`--keep-values` stores them redacted, for test data only)" : "stored, with personal data redacted where its name or shape shows it"}`, "");
    L.push("## What was read", "", "| | Count |", "| --- | --- |",
        `| Lines read | ${c.lines} |`, `| Could not be read (counted, never shown) | ${c.unreadable} |`,
        `| Dropped and never sent, because they could change data | ${c.dropped_total} |`,
        ...Object.entries(c.dropped).sort().map(([m, n]) => `| - ${cell(m)} | ${n} |`),
        `| Left out by --include or --exclude | ${c.filtered} |`, `| Left out by sampling (${c.sample}, seed ${c.seed}) | ${c.sampled_out} |`, `| Left out by the limit of ${c.max} | ${c.over_limit} |`,
        `| Kept for replay, at ${c.rate_per_second} a second | ${c.kept} |`, `| With something redacted | ${c.redacted_requests} |`, `| Credential headers stripped | ${c.credential_headers_stripped} |`, "");
    const kinds = Object.entries(c.redactions).sort();
    if (kinds.length) L.push(`Redacted: ${kinds.map(([k, n]) => `${cell(k)} (${n})`).join(", ")}. The values are gone, so these requests sent REDACTED to both systems.`, "");
    L.push("## Replay", "", "| Sent | Matched | Approved drift | Unexplained | Errors | Not sent | Over 5 MB |", "| --- | --- | --- | --- | --- | --- | --- |", `| ${p.sent} | ${p.matched} | ${p.drift} | ${p.different} | ${p.errors} | ${p.not_sent} | ${p.truncated} |`, "");
    L.push("## Endpoints", "", "| Endpoint | Requests | Matched | Drift | Unexplained | Errors |", "| --- | --- | --- | --- | --- | --- |");
    for (const e of r.endpoints) L.push(`| \`${cell(e.endpoint)}\` | ${e.requests} | ${e.matched} | ${e.drift} | ${e.unexplained} | ${e.errors} |`);
    if (!r.endpoints.length) L.push("| (none) | 0 | 0 | 0 | 0 | 0 |");
    const open = r.endpoints.flatMap((e) => e.differences.map((d) => [e, d] as const));
    if (open.length) {
        const [a, b] = Object.keys(r.targets);
        L.push("", "## Differences", "", `| Endpoint | Where | Requests | First request | ${a} | ${b} | Approved drift |`, "| --- | --- | --- | --- | --- | --- | --- |");
        for (const [e, d] of open.slice(0, 500)) L.push(`| \`${cell(e.endpoint)}\` | \`${cell(d.where)}\` | ${d.requests} | ${d.first_request} | ${cell(d.reference)} | ${cell(d.candidate)} | ${d.drift ?? "—"} |`);
        if (open.length > 500) L.push("", `${open.length - 500} more are in REPORT.json.`);
    }
    if (r.suggested_scrubs.length) {
        L.push("", "## Probably noise", "", "A person decides whether to scrub these: a scrub hides them from every later run.", "", "| Where | Requests | Why |", "| --- | --- | --- |");
        for (const s of r.suggested_scrubs) L.push(`| \`${cell(s.where)}\` | ${s.cases} | ${s.why} |`);
    }
    if (r.unused_drift.length) L.push("", "## Drift that matched nothing", "", `No request needed these approved differences: ${r.unused_drift.join(", ")}.`);
    L.push("", "The request file is `capture.jsonl` in this folder. It holds only cleaned requests, and it is all that was sent. Answers are not kept. This report and the capture stay in the client's environment.", "");
    return L.join("\n");
}

/** cmtk shadow: read, clean, write the capture, then replay it to both systems at the rate asked for. */
export async function shadow(manifest: Manifest, o: ShadowOptions): Promise<ShadowReport> {
    if (!o.from.length) throw new ManifestError("`cmtk shadow` needs --from <file>: an access log or a mirror file.");
    const ref: Target | undefined = manifest.reference ? manifest.targets[manifest.reference] : undefined;
    const cand: Target | undefined = manifest.candidate ? manifest.targets[manifest.candidate] : undefined;
    if (!ref || !cand) throw new ManifestError("`cmtk shadow` needs a reference and a candidate in cmtk.yaml.");
    if (ref.name === cand.name) throw new ManifestError("The reference and the candidate are the same target; comparing needs two systems.");
    for (const t of [ref, cand]) {
        if (!t.base_url) throw new ManifestError(`Target ${t.name} has no base_url. Shadow traffic is HTTP only.`);
        if (t.surfaces && !t.surfaces.includes("http")) throw new ManifestError(`Target ${t.name} does not list the http surface. Shadow traffic is HTTP only.`);
    }
    const sample = numberOption(o.sample, 1, "--sample", (n) => n > 0 && n <= 1, "above 0 and up to 1, such as 0.1");
    const seed = numberOption(o.seed, 1, "--seed", Number.isInteger, "a whole number");
    const rate = numberOption(o.rate, 5, "--rate", (n) => n > 0 && n <= 1000, "above 0 and up to 1000 requests a second");
    const max = numberOption(o.max, 1000, "--max", (n) => Number.isInteger(n) && n > 0, "a whole number above 0");
    const drift = loadDrift(manifest);
    scrubberOf(manifest); // a bad scrub rule stops here, before anything is read or sent
    const extra = envHeaders(manifest);
    const { requests, stats } = await captureRequests(o.from, { format: o.format, sample, seed, max, include: o.include, exclude: o.exclude, keepHeaders: o.keepHeaders, redact: o.redact });
    stats.rate_per_second = rate;
    const ev = evidenceDir(manifest, "shadow", { dated: o.dated, note: o.note });
    try {
        const dir = ev.dir;
        fs.rmSync(path.join(dir, "answers"), { recursive: true, force: true }); // shadow keeps no answers: they can hold personal data
        const captureFile = path.join(dir, "capture.jsonl");
        fs.writeFileSync(captureFile, requests.map((q) => JSON.stringify(q)).join("\n") + (requests.length ? "\n" : ""), "utf8");
        const replay: ShadowReport["replay"] = { sent: 0, matched: 0, drift: 0, different: 0, errors: 0, not_sent: 0, truncated: 0 };
        const endpoints = new Map<string, ShadowEndpoint & { places: Map<string, ShadowDifference> }>();
        const noise = new Map<string, { kind: string | undefined; count: number }>();
        const used = new Set<string>();
        const fired = new Map<string, number>(scrubRules(manifest.scrub).map((rule) => [rule, 0]));
        const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
        const now = o.now ?? (() => performance.now());
        if (!o.captureOnly) {
            // Only what the capture file holds is sent.
            const toSend = fs.readFileSync(captureFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CapturedRequest);
            const http = httpAdapter({ timeoutS: manifest.timeout_s, insecureTls: manifest.insecure_tls, root: manifest.root });
            const gap = 1000 / rate;
            let next = now();
            let silent = 0;
            for (const q of toSend) {
                if (silent >= STOP_AFTER_NO_ANSWER) { replay.not_sent++; continue; }
                const wait = next - now();
                if (wait > 0) await sleep(wait);
                next = Math.max(next, now()) + gap;
                const name = endpointOf(q.method, q.path);
                const e: ShadowEndpoint & { places: Map<string, ShadowDifference> } = endpoints.get(name) ?? { endpoint: name, requests: 0, matched: 0, drift: 0, unexplained: 0, errors: 0, differences: [], places: new Map() };
                endpoints.set(name, e);
                e.requests++;
                const c: Case = { id: `shadow-${q.n}`, request: { method: q.method, path: q.path, headers: q.headers ?? {}, body: null }, surface: "http" };
                const ra = await http.run(c, ref, extra);
                const rb = await http.run(c, cand, extra);
                silent = [ra, rb].some((a) => a.error && NO_ANSWER.test(a.error)) ? silent + 1 : 0;
                if (ra.error || rb.error) {
                    e.errors++; replay.errors++;
                    e.first_error ??= [ra.error && `reference: ${ra.error}`, rb.error && `candidate: ${rb.error}`].filter(Boolean).join("; ");
                    continue;
                }
                replay.sent++;
                if (ra.truncated || rb.truncated) { e.truncated = (e.truncated ?? 0) + 1; replay.truncated++; }
                const diffs: Difference[] = compareObservations(ra, rb, manifest, matchFor(c, manifest), fired);
                for (const d of diffs) {
                    const hit = coveringDrift(drift, `shadow:${name}`, d.where);
                    if (hit) { d.drift = hit.id; used.add(hit.id); }
                }
                if (diffs.some((d) => !d.drift)) { e.unexplained++; replay.different++; }
                else if (diffs.length) { e.drift++; replay.drift++; }
                else { e.matched++; replay.matched++; }
                for (const d of diffs) {
                    const where = d.where.replace(/\[\d+\]/g, "[*]");
                    const placeKey = `${where}\0${d.drift ?? ""}`;
                    const kept = e.places.get(placeKey);
                    if (kept) kept.requests++;
                    else if (e.places.size >= MAX_PLACES) e.more_differences = (e.more_differences ?? 0) + 1;
                    else e.places.set(placeKey, { where, requests: 1, ...(d.drift ? { drift: d.drift } : {}), first_request: q.n, reference: shownValue(d.reference, d.where, !!o.keepValues), candidate: shownValue(d.candidate, d.where, !!o.keepValues) });
                    if (!d.drift) {
                        const a = noiseKind(d.reference), b = noiseKind(d.candidate);
                        const seen = noise.get(where);
                        noise.set(where, { kind: a && a === b && (!seen || seen.kind === a) ? a : undefined, count: (seen?.count ?? 0) + 1 });
                    }
                }
            }
        }
        const list = [...endpoints.values()].sort((a, b) => b.unexplained - a.unexplained || a.endpoint.localeCompare(b.endpoint)).map(({ places, ...e }) => ({ ...e, differences: [...places.values()] }));
        const { verdict, reason, next } = decide(stats, replay, !!o.captureOnly);
        const relevant = drift.filter((d) => d.case === "*" || d.case.startsWith("shadow:"));
        const report: ShadowReport = {
            tool: "cmtk", mode: "shadow", system: manifest.system, date: o.date ?? new Date().toISOString().slice(0, 10), verdict,
            targets: { [ref.name]: cleanUrl(ref.base_url!), [cand.name]: cleanUrl(cand.base_url!) },
            sources: o.from.map((f) => path.basename(f)), // the file name only: a full path can name a person's folders
            capture: stats, replay, endpoints: list, values: o.keepValues ? "redacted" : "withheld", capture_only: !!o.captureOnly,
            unused_drift: o.captureOnly ? [] : relevant.filter((d) => !used.has(d.id)).map((d) => d.id).sort(),
            suggested_scrubs: [...noise].filter(([, n]) => n.kind).map(([where, n]) => ({ where, cases: n.count, why: `both sides hold ${n.kind} that changes on every call` })).sort((a, b) => a.where.localeCompare(b.where)),
            settings: settingsOf(manifest, drift),
            ...(fired.size && !o.captureOnly ? { scrub_fired: Object.fromEntries(fired) } : {}),
            reason, next,
        };
        fs.writeFileSync(path.join(dir, "REPORT.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
        fs.writeFileSync(path.join(dir, "REPORT.md"), renderShadow(report), "utf8");
        ev.commit();
        return report;
    } finally {
        ev.release();
    }
}
