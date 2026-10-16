// Compare two answers to the same case. Everything that differs is listed with a `where` a
// person can read and a drift entry can name.
import { DOMParser } from "@xmldom/xmldom";

import { matches, parsePath, render, type Location, type Token } from "./jsonpath.js";
import type { Difference, MatchLevel, Manifest, Observation } from "./types.js";

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

export function scrubJson(value: unknown, sc: Scrubber, at: Location = []): unknown {
    if (at.length > 0 && sc.jsonPaths.some((p) => matches(p, at))) return SCRUBBED;
    if (value instanceof JsonNumber) return value;
    if (Array.isArray(value)) return value.map((v, i) => scrubJson(v, sc, [...at, i]));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubJson(v, sc, [...at, k])]));
    }
    return typeof value === "string" ? scrubText(value, sc) : value;
}

export function short(v: unknown, limit = 80): string {
    const s = v === undefined ? "(missing)" : JSON.stringify(v) ?? String(v);
    return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`;
}

/**
 * JSON values as JavaScript parses them lose `10` vs `10.0`. Keep the source text of every
 * number so the exact level can see a change in number format.
 */
export function parseJsonKeepingNumbers(text: string): unknown {
    // Mark each number token with its source text; JSON.parse's reviver then sees the marker.
    const marked = text.replace(/("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str: string | undefined, num: string | undefined) =>
        str !== undefined ? str : `{"\\u0000n":${JSON.stringify(num)}}`,
    );
    return JSON.parse(marked, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) && "\u0000n" in v ? new JsonNumber(v["\u0000n"]) : v));
}

export class JsonNumber {
    constructor(readonly source: string) {}
    get value() {
        return Number(this.source);
    }
    toJSON() {
        return this.value;
    }
}

export function diffJson(a: unknown, b: unknown, semantic: boolean, at: Location = [], out: Difference[] = []): Difference[] {
    if (a instanceof JsonNumber && b instanceof JsonNumber) {
        const same = semantic ? a.value === b.value : a.source === b.source;
        if (!same) out.push({ where: render(at), reference: a.source, candidate: b.source });
        return out;
    }
    if (isObject(a) && isObject(b)) {
        for (const k of Object.keys(a)) if (!(k in b)) out.push({ where: render([...at, k]), reference: short(a[k]), candidate: "(missing)" });
        for (const k of Object.keys(b)) if (!(k in a)) out.push({ where: render([...at, k]), reference: "(missing)", candidate: short(b[k]) });
        for (const k of Object.keys(a)) if (k in b) diffJson(a[k], b[k], semantic, [...at, k], out);
        const ka = Object.keys(a), kb = Object.keys(b);
        if (!semantic && ka.join("\u0000") !== kb.join("\u0000") && ka.length === kb.length && ka.every((k) => k in b)) {
            out.push({ where: render(at), reference: `key order ${ka.join(",").slice(0, 60)}`, candidate: `key order ${kb.join(",").slice(0, 60)}` });
        }
        return out;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (i >= a.length) out.push({ where: render([...at, i]), reference: "(missing)", candidate: short(b[i]) });
            else if (i >= b.length) out.push({ where: render([...at, i]), reference: short(a[i]), candidate: "(missing)" });
            else diffJson(a[i], b[i], semantic, [...at, i], out);
        }
        return out;
    }
    const same = kindOf(a) === kindOf(b) && JSON.stringify(a) === JSON.stringify(b);
    if (!same) out.push({ where: render(at), reference: short(a), candidate: short(b) });
    return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNumber);
const kindOf = (v: unknown) => (v === null ? "null" : v instanceof JsonNumber ? "number" : Array.isArray(v) ? "array" : typeof v);

// ---------------------------------------------------------------- XML

interface XNode {
    ns: string;
    local: string;
    attrs: Map<string, string>;
    text: string;
    children: XNode[];
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
    let text = "";
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 1) children.push(toNode(n as Element));
        else if (n.nodeType === 3 || n.nodeType === 4) text += n.nodeValue ?? "";
    }
    return { ns: el.namespaceURI ?? "", local: el.localName ?? el.nodeName, attrs, text: text.trim(), children };
}

export function diffXml(a: XNode, b: XNode, sc: Scrubber, at = "", out: Difference[] = []): Difference[] {
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
    const ta = scrubText(a.text, sc), tb = scrubText(b.text, sc);
    if (ta !== tb) out.push({ where: `${here}/text()`, reference: short(ta), candidate: short(tb) });
    for (let i = 0; i < Math.max(a.children.length, b.children.length); i++) {
        const ca = a.children[i], cb = b.children[i];
        if (!ca && cb) out.push({ where: `${here}/${cb.local}[${i + 1}]`, reference: "(missing)", candidate: "(element)" });
        else if (ca && !cb) out.push({ where: `${here}/${ca.local}[${i + 1}]`, reference: "(element)", candidate: "(missing)" });
        else if (ca && cb) diffXml(ca, cb, sc, here, out);
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
    const ra = ref.body ?? "", rb = cand.body ?? "";
    let kind = bodyKind(ref.headers?.["content-type"], ra);
    if (kind === "json") {
        try {
            const ja = scrubJson(parseJsonKeepingNumbers(ra), sc), jb = scrubJson(parseJsonKeepingNumbers(rb), sc);
            return out.concat(diffJson(ja, jb, !exact));
        } catch {
            kind = "text";
        }
    }
    if (kind === "xml") {
        try {
            return out.concat(diffXml(parseXml(ra), parseXml(rb), sc));
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
        out.push({ where: `body line ${n + 1}`, reference: short(la[n] ?? "(end)"), candidate: short(lb[n] ?? "(end)") });
    }
    return out;
}
