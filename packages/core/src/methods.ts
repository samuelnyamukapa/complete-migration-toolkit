// What counts as a write. One answer, used by `cmtk run`, `cmtk compare`, `cmtk shadow`, `cmtk probe` and exploration,
// so a request can't be a write to one of them and a read to another.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { looksLikeAgent } from "./people.js";
import type { Case, Request } from "./types.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const OVERRIDE_HEADERS = new Set(["x-http-method-override", "x-http-method", "x-method-override", "x-original-method"]);
/** Names that only ever mean "treat this as another method", in any spelling: _method, _HttpMethod, X-HTTP-Method-Override, $method. */
const OVERRIDE_NAMES = new Set(["httpmethod", "xhttpmethod", "xhttpmethodoverride", "httpmethodoverride", "methodoverride", "xmethodoverride"]);
/** Plain `method` can mean anything (?method=sum), so it only counts when its value is a method that writes. */
const WRITING_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE", "MERGE"]);

const decoded = (s: string) => {
    try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
};

/**
 * The method a request asks to be treated as, if it asks to be treated as one that is not a read: by a header some
 * frameworks honour, or by a query or path parameter, whether written with & or ; . Undefined for an ordinary read.
 */
export function overrideIn(target: string, headers: Record<string, string> = {}): string | undefined {
    for (const [k, v] of Object.entries(headers)) {
        if (OVERRIDE_HEADERS.has(k.toLowerCase()) && !SAFE_METHODS.has(String(v).trim().toUpperCase())) return String(v).trim().toUpperCase();
    }
    const hash = target.indexOf("#");
    for (const pair of (hash < 0 ? target : target.slice(0, hash)).split(/[?&;]/).slice(1)) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const raw = decoded(pair.slice(0, eq));
        const name = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
        const value = decoded(pair.slice(eq + 1)).trim().toUpperCase();
        if (OVERRIDE_NAMES.has(name) || /^[_$]method$/i.test(raw)) { if (!SAFE_METHODS.has(value)) return value; }
        else if (name === "method" && WRITING_VERBS.has(value)) return value;
    }
    return undefined;
}

const hasBody = (r: Partial<Request>) => (r.body !== null && r.body !== undefined && r.body !== "") || r.body_file !== undefined || r.body_form !== undefined || !!r.files?.length;

/** Does this case ask for more than a read? Its method, an override, or (over HTTP, where a server may act on it) a body on a read. */
export function writes(c: Pick<Case, "request" | "surface">): boolean {
    const r = c.request;
    if (!SAFE_METHODS.has(r.method)) return true;
    if (overrideIn(r.path, r.headers) !== undefined) return true;
    if (r.before && overrideIn(r.before.get, r.headers) !== undefined) return true;
    return (c.surface ?? "http") === "http" && hasBody(r);
}

/** Fields that say nothing about what a case does to a system: how it is checked, named and traced. */
const NOT_WHAT_IT_DOES = new Set(["id", "name", "requirement", "expect", "expect_draft", "expect_confirmed_by", "expect_confirmed_on", "expect_changed_by", "expect_changed_on", "match", "source", "file", "draft", "draft_note", "note", "accepted_by", "accepted_on", "safe_confirmed_by", "safe_confirmed_on", "safe_print"]);

const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]));
    return v;
};

/**
 * A fingerprint of what the case would do: every field that shapes the request, and the bytes of any file it
 * sends or plays. Change any of them and the person's confirmation no longer applies.
 */
export function safePrint(c: Case, root: string): string {
    const what = Object.fromEntries(Object.entries(c).filter(([k]) => !NOT_WHAT_IT_DOES.has(k)));
    const r = c.request;
    const files = [r.body_file, typeof r.body_form === "string" ? r.body_form : undefined, ...(r.files ?? []).map((f) => f.path), typeof c.journey?.script === "string" ? c.journey.script : undefined].filter((f): f is string => !!f);
    const h = crypto.createHash("sha256").update(JSON.stringify(canonical(what)));
    for (const f of files.sort()) {
        let bytes: Buffer | string = "(no such file)";
        try { bytes = fs.readFileSync(path.resolve(root, f)); } catch { /* the case will say so when it runs */ }
        h.update("\0").update(f).update("\0").update(bytes);
    }
    return `sha256:${h.digest("hex")}`;
}

/** `safe: true` counts only when `cmtk review` recorded a person who saw exactly this case. */
export function safeConfirmed(c: Case, root: string): boolean {
    return c.safe === true && typeof c.safe_confirmed_by === "string" && !!c.safe_confirmed_by.trim() && !looksLikeAgent(c.safe_confirmed_by) && c.safe_print === safePrint(c, root);
}
