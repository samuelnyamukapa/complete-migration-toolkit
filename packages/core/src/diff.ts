// Compare two answers to the same case. Everything that differs is listed with a `where` a
// person can read and a drift entry can name.
import { DOMParser } from "@xmldom/xmldom";

import { entriesOf, isJsonObject, JsonNumber, JsonObject, parseJsonExact } from "./json.js";
import { matches, parsePath, render, type Location, type Token } from "./jsonpath.js";
import type { Difference, MatchLevel, Manifest, Observation } from "./types.js";

export { JsonNumber, JsonObject } from "./json.js";
export const SCRUBBED = "<scrubbed>";

export interface Scrubber {
    jsonPaths: Token[][];
    xmlIgnore: Set<string>;
    regex: { rx: RegExp; replace: string }[];
}

export class ConfigError extends Error {}

export function scrubberOf(manifest: Pick<Manifest, "scrub">): Scrubber {
    const s = manifest.scrub;
    const regex = (s.regex ?? []).map((r) => {
        try {
            return { rx: new RegExp(r.pattern, "g"), replace: r.replace ?? SCRUBBED };
        } catch (err) {
            throw new ConfigError(`scrub.regex ${JSON.stringify(r.pattern)} is not a valid regular expression: ${(err as Error).message}`);
        }
    });
    return { jsonPaths: (s.json_paths ?? []).map(parsePath), xmlIgnore: new Set(s.xml_ignore ?? []), regex };
}

export const scrubText = (text: string, sc: Scrubber) => sc.regex.reduce((t, r) => t.replace(r.rx, r.replace), text);

/** A copy with the scrubbed values replaced. Keeps key order and number formats. */
export function scrubJson(value: unknown, sc: Scrubber, at: Location = []): unknown {
    if (at.length > 0 && sc.jsonPaths.some((p) => matches(p, at))) return SCRUBBED;
    if (value instanceof JsonNumber) return value;
    if (Array.isArray(value)) return value.map((v, i) => scrubJson(v, sc, [...at, i]));
    if (value instanceof JsonObject) return new JsonObject(entriesOf(value).map(([k, v]) => [k, scrubJson(v, sc, [...at, k])]));
    if (isJsonObject(value)) return Object.fromEntries(entriesOf(value).map(([k, v]) => [k, scrubJson(v, sc, [...at, k])]));
    return typeof value === "string" ? scrubText(value, sc) : value;
}

/** A value as JSON text, cut to the limit. */
export function short(v: unknown, limit = 80): string {
    return clip(v === undefined ? "(missing)" : JSON.stringify(v) ?? String(v), limit);
}

/** Text cut to the limit. */
export const clip = (s: string, limit = 80) => (s.length <= limit ? s : `${s.slice(0, limit - 1)}…`);

/**
 * Two values for a report. When they agree for longer than the limit, both show the part
 * around the first difference, so a long string that differs near its end still reads as different.
 */
export function shortPair(a: string, b: string, limit = 80): [string, string] {
    if ((a.length <= limit && b.length <= limit) || a === b) return [clip(a, limit), clip(b, limit)];
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    if (n < limit - 20) return [clip(a, limit), clip(b, limit)];
    const from = n - 20;
    const cut = (s: string) => `…${s.slice(from, from + limit - 2)}${s.length > from + limit - 2 ? "…" : ""}`;
    return [cut(a), cut(b)];
}

const show = (v: unknown) => (v === undefined ? "(missing)" : v instanceof JsonNumber ? v.source : JSON.stringify(v) ?? String(v));

/** Kept for compatibility: the strict reader that keeps number text and key order. */
export const parseJsonKeepingNumbers = parseJsonExact;

export function diffJson(a: unknown, b: unknown, semantic: boolean, at: Location = [], out: Difference[] = []): Difference[] {
    if (a instanceof JsonNumber && b instanceof JsonNumber) {
        const same = semantic ? a.canonical === b.canonical : a.source === b.source;
        if (!same) out.push({ where: render(at), reference: a.source, candidate: b.source });
        return out;
    }
    if (isJsonObject(a) && isJsonObject(b)) {
        const ea = entriesOf(a), eb = entriesOf(b);
        const ma = new Map(ea), mb = new Map(eb);
        for (const [k, v] of ea) if (!mb.has(k)) out.push({ where: render([...at, k]), reference: clip(show(v)), candidate: "(missing)" });
        for (const [k, v] of eb) if (!ma.has(k)) out.push({ where: render([...at, k]), reference: "(missing)", candidate: clip(show(v)) });
        for (const [k, v] of ea) if (mb.has(k)) diffJson(v, mb.get(k), semantic, [...at, k], out);
        const ka = ea.map(([k]) => k), kb = eb.map(([k]) => k);
        if (!semantic && ka.length === kb.length && ka.every((k) => mb.has(k)) && ka.some((k, i) => k !== kb[i])) {
            const [ra, rb] = shortPair(`key order ${ka.join(",")}`, `key order ${kb.join(",")}`);
            out.push({ where: render(at), reference: ra, candidate: rb });
        }
        return out;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (i >= a.length) out.push({ where: render([...at, i]), reference: "(missing)", candidate: clip(show(b[i])) });
            else if (i >= b.length) out.push({ where: render([...at, i]), reference: clip(show(a[i])), candidate: "(missing)" });
            else diffJson(a[i], b[i], semantic, [...at, i], out);
        }
        return out;
    }
    const sa = show(a), sb = show(b);
    if (kindOf(a) !== kindOf(b) || sa !== sb) {
        const [ra, rb] = shortPair(sa, sb);
        out.push({ where: render(at), reference: ra, candidate: rb });
    }
    return out;
}

const kindOf = (v: unknown) => (v === null ? "null" : v instanceof JsonNumber ? "number" : Array.isArray(v) ? "array" : isJsonObject(v) ? "object" : typeof v);

// ---------------------------------------------------------------- XML

export interface XNode {
    ns: string;
    local: string;
    attrs: Map<string, string>;
    children: XNode[];
    /** texts[i] is the text before children[i]; the last one follows the last child. */
    texts: string[];
}

export function parseXml(text: string): XNode {
    const errors: string[] = [];
    const doc = new DOMParser({ onError: (level, msg) => { if (level !== "warning") errors.push(String(msg)); } }).parseFromString(text, "text/xml");
    const root = doc.documentElement;
    if (!root || errors.length) throw new Error(errors[0] ?? "no root element");
    return toNode(root as unknown as Element);
}

function toNode(el: Element): XNode {
    const attrs = new Map<string, string>();
    for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes.item(i);
        if (!a || a.name === "xmlns" || a.name.startsWith("xmlns:")) continue; // prefixes are not data
        attrs.set(`${a.namespaceURI ? `{${a.namespaceURI}}` : ""}${a.localName ?? a.name}`, a.value);
    }
    const children: XNode[] = [];
    const texts = [""];
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) { children.push(toNode(n as Element)); texts.push(""); }
        else if (n.nodeType === 3 || n.nodeType === 4) texts[texts.length - 1] += n.nodeValue ?? "";
    }
    return { ns: el.namespaceURI ?? "", local: el.localName ?? el.nodeName, attrs, children, texts };
}

/**
 * Element by element. A leaf's text is compared as sent at `exact` and trimmed at `semantic`.
 * Around child elements, whitespace-only text (indentation) is ignored at every level, but any
 * other text is compared in its position, so moved mixed content is a difference.
 */
export function diffXml(a: XNode, b: XNode, sc: Scrubber, exact = true, at = "", out: Difference[] = []): Difference[] {
    const here = `${at}/${a.local}`;
    if (a.ns !== b.ns || a.local !== b.local) {
        out.push({ where: here, reference: `{${a.ns}}${a.local}`, candidate: `{${b.ns}}${b.local}` });
        return out;
    }
    if (sc.xmlIgnore.has(a.local)) return out;
    for (const k of new Set([...a.attrs.keys(), ...b.attrs.keys()])) {
        const va = a.attrs.has(k) ? scrubText(a.attrs.get(k)!, sc) : "(missing)";
        const vb = b.attrs.has(k) ? scrubText(b.attrs.get(k)!, sc) : "(missing)";
        if (va !== vb) out.push({ where: `${here}/@${k.replace(/^\{[^}]*\}/, "")}`, reference: va, candidate: vb });
    }
    const leaf = a.children.length === 0 && b.children.length === 0;
    const segments = Math.max(a.texts.length, b.texts.length);
    for (let i = 0; i < segments; i++) {
        let ta = scrubText(a.texts[i] ?? "", sc), tb = scrubText(b.texts[i] ?? "", sc);
        if (!leaf || !exact) { ta = ta.trim(); tb = tb.trim(); }
        if (ta !== tb) {
            const [ra, rb] = shortPair(JSON.stringify(ta), JSON.stringify(tb));
            out.push({ where: leaf ? `${here}/text()` : `${here}/text()[${i + 1}]`, reference: ra, candidate: rb });
        }
    }
    for (let i = 0; i < Math.max(a.children.length, b.children.length); i++) {
        const ca = a.children[i], cb = b.children[i];
        if (!ca && cb) out.push({ where: `${here}/${cb.local}[${i + 1}]`, reference: "(missing)", candidate: "(element)" });
        else if (ca && !cb) out.push({ where: `${here}/${ca.local}[${i + 1}]`, reference: "(element)", candidate: "(missing)" });
        else if (ca && cb) diffXml(ca, cb, sc, exact, here, out);
    }
    return out;
}

// ---------------------------------------------------------------- whole answers

export function bodyKind(contentType: string | undefined, body: string): "json" | "xml" | "text" {
    const ct = (contentType ?? "").toLowerCase();
    const head = body.trimStart();
    if (ct.includes("json") || (!ct && (head.startsWith("{") || head.startsWith("[")))) return "json";
    if (ct.includes("xml") || ct.includes("soap") || (!ct && head.startsWith("<?xml"))) return "xml";
    return "text";
}

const mediaType = (v: string | undefined) => (v ?? "").split(";")[0]!.trim().toLowerCase();

export function compareObservations(ref: Observation, cand: Observation, manifest: Pick<Manifest, "scrub" | "compare_headers">, level: MatchLevel): Difference[] {
    const out: Difference[] = [];
    if (ref.status !== cand.status) out.push({ where: "status", reference: String(ref.status ?? "(none)"), candidate: String(cand.status ?? "(none)") });
    if (level === "contract") return out;
    const exact = level === "exact";
    const sc = scrubberOf(manifest);
    for (const name of manifest.compare_headers ?? []) {
        const h = name.toLowerCase();
        let va = ref.headers?.[h], vb = cand.headers?.[h];
        if (h === "content-type" && !exact) { va = mediaType(va); vb = mediaType(vb); }
        if ((va ?? "") !== (vb ?? "")) out.push({ where: `header:${h}`, reference: va || "(missing)", candidate: vb || "(missing)" });
    }
    if (ref.effects !== undefined || cand.effects !== undefined) {
        const ea = scrubJson(ref.effects ?? {}, sc), eb = scrubJson(cand.effects ?? {}, sc);
        for (const d of diffJson(ea, eb, !exact)) out.push({ ...d, where: d.where.replace(/^\$/, "effects:$") });
    }
    // Bytes that are not UTF-8 are read as Latin-1, so no byte is lost; a change of encoding is a difference.
    if (exact && (ref.body_encoding ?? "utf-8") !== (cand.body_encoding ?? "utf-8") && ref.body !== undefined && cand.body !== undefined) {
        out.push({ where: "body encoding", reference: ref.body_encoding ?? "utf-8", candidate: cand.body_encoding ?? "utf-8" });
    }
    const ra = ref.body ?? "", rb = cand.body ?? "";
    let kind = bodyKind(ref.headers?.["content-type"], ra);
    if (kind === "json") {
        try {
            const ja = scrubJson(parseJsonExact(ra), sc), jb = scrubJson(parseJsonExact(rb), sc);
            return out.concat(diffJson(ja, jb, !exact));
        } catch {
            kind = "text";
        }
    }
    if (kind === "xml") {
        try {
            return out.concat(diffXml(parseXml(ra), parseXml(rb), sc, exact));
        } catch {
            kind = "text";
        }
    }
    let ta = scrubText(ra, sc), tb = scrubText(rb, sc);
    if (!exact) {
        const norm = (t: string) => t.trim().split(/\r?\n/).map((l) => l.trimEnd()).join("\n");
        ta = norm(ta);
        tb = norm(tb);
    }
    if (ta !== tb) {
        const la = ta.split("\n"), lb = tb.split("\n");
        let n = 0;
        while (n < Math.min(la.length, lb.length) && la[n] === lb[n]) n++;
        const line = (l: string | undefined) => (l === undefined ? "(end)" : JSON.stringify(l));
        const [x, y] = shortPair(line(la[n]), line(lb[n]));
        out.push({ where: `body line ${n + 1}`, reference: x, candidate: y });
    }
    return out;
}
