// A contract on a class library's public surface, read through REA without running it: the members a
// consumer can call, compared across two builds after a namespace map. REA's own comparison matches by
// exact declared type, so a namespace move reads as everything removed; this one maps the names first.
//
// One limit shapes the code. REA writes a signature's types as build-local numbers ("class:41<class:8>").
// A number that points at a type in the assembly can be named from REA's type list. A number that points
// at a referenced type (IList`1) can't, because REA does not list TypeRefs. But REA also gives
// `resolved_sha256`, a digest of the signature with each type's name in it, so a guess at a name can be
// proved. A name is used only when its digest matches. A signature that stays unproved is a finding for a
// person, never "unchanged".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runRea } from "./discover.js";
import { inside, ManifestError } from "./manifest.js";
import type { AssemblyContract, Contract, ContractFinding, ContractOutcome, Manifest } from "./types.js";

interface Signature {
    kind?: string;
    parse_status?: string;
    calling_convention?: string | null;
    generic_parameter_count?: number | null;
    parameter_count?: number | null;
    return_type?: string | null;
    parameter_types?: string[];
    field_type?: string | null;
    raw_sha256?: string;
    resolved_sha256?: string | null;
}
interface Member { token?: string; declaring_type?: string | null; name: string; flags?: number; signature?: Signature }
interface RawType { token?: string; full_name?: string; namespace?: string; name?: string; flags?: number; name_sha256?: string | null }

export interface Inventory {
    assembly: string;
    types: RawType[];
    methods: Member[];
    fields: Member[];
    complete: boolean;
    /** TypeDef row to its name digest and name, from REA's type list. */
    defs: Map<number, RawType>;
    /** TypeRef row to the name proved or read for it. */
    refs: Map<number, string>;
    /** Names REA's member references show, tried first when a TypeRef needs a name. */
    seen: Set<string>;
}

/** Read `rea inspect-managed-members <dll> --json`, saved or fresh. */
export function readInventory(raw: unknown, what: string): Inventory {
    const j = raw as any;
    const n = j?.normalized_result ?? j;
    if (!Array.isArray(n?.methods) || !Array.isArray(n?.types)) throw new ManifestError(`${what} is not the output of \`rea inspect-managed-members <dll> --json\`: it has no types and methods.`);
    const types = n.types as RawType[];
    const defs = new Map<number, RawType>();
    for (const t of types) { const r = rowOf(t.token); if (r) defs.set(r, t); }
    const refs = new Map<number, string>();
    const seen = new Set<string>();
    for (const r of (n.member_refs ?? []) as { parent_token?: string | null; parent_name?: string | null }[]) {
        if (!r.parent_name) continue;
        seen.add(r.parent_name);
        const row = rowOf(r.parent_token ?? undefined);
        if (row && String(r.parent_token).toLowerCase().startsWith("0x01")) refs.set(row, r.parent_name);
    }
    return { assembly: path.basename(String(j?.subject?.name ?? what)), types, methods: n.methods, fields: n.fields ?? [], complete: (n.coverage?.state ?? "complete") === "complete", defs, refs, seen };
}

const rowOf = (token: string | undefined) => (token ? parseInt(token.slice(4), 16) || undefined : undefined);

// ---------------------------------------------------------------- proving a type's name from REA's digests

/** Common names a signature refers to. Each is only ever a guess until its digest matches. */
const LIKELY: Record<string, string[]> = {
    "System": ["Action", "Action`1", "Action`2", "Action`3", "Array", "Boolean", "Byte", "Char", "DateTime", "DateTimeOffset", "Decimal", "Delegate", "Double", "Enum", "EventArgs", "EventHandler", "Exception", "Func`1", "Func`2", "Func`3", "Func`4", "Guid", "IDisposable", "Int16", "Int32", "Int64", "Lazy`1", "Nullable`1", "Object", "Single", "String", "TimeSpan", "Tuple`2", "Tuple`3", "Type", "Uri", "ValueTuple`2", "ValueTuple`3", "Version"],
    "System.Collections": ["ArrayList", "Hashtable", "ICollection", "IDictionary", "IEnumerable", "IEnumerator", "IList"],
    "System.Collections.Generic": ["Dictionary`2", "HashSet`1", "ICollection`1", "IDictionary`2", "IEnumerable`1", "IEnumerator`1", "IList`1", "IReadOnlyCollection`1", "IReadOnlyDictionary`2", "IReadOnlyList`1", "ISet`1", "KeyValuePair`2", "LinkedList`1", "List`1", "Queue`1", "SortedDictionary`2", "Stack`1"],
    "System.Collections.ObjectModel": ["Collection`1", "ObservableCollection`1", "ReadOnlyCollection`1"],
    "System.Data": ["DataSet", "DataTable", "IDataReader", "IDbConnection"],
    "System.IO": ["FileInfo", "MemoryStream", "Stream", "TextReader", "TextWriter"],
    "System.Linq": ["IGrouping`2", "IOrderedQueryable`1", "IQueryable", "IQueryable`1"],
    "System.Linq.Expressions": ["Expression", "Expression`1"],
    "System.Threading": ["CancellationToken"],
    "System.Threading.Tasks": ["Task", "Task`1", "ValueTask", "ValueTask`1"],
    "System.Web.Mvc": ["ActionResult", "JsonResult", "ViewResult"],
    "System.Xml": ["XmlDocument", "XmlElement", "XmlNode"],
    "System.Xml.Linq": ["XDocument", "XElement"],
    "Microsoft.AspNetCore.Mvc": ["ActionResult", "ActionResult`1", "IActionResult"],
};
const likelyNames = () => Object.entries(LIKELY).flatMap(([ns, names]) => names.map((n) => `${ns}.${n}`));

/** REA's digest of a top-level type's name: a zero byte, the namespace, a zero byte, the name. */
export function nameDigest(full: string): Buffer {
    const i = full.lastIndexOf(".");
    return crypto.createHash("sha256").update(Buffer.from([0])).update(i < 0 ? "" : full.slice(0, i)).update(Buffer.from([0])).update(full.slice(i + 1)).digest();
}

const ELEMENTS: Record<string, number> = { void: 1, bool: 2, char: 3, i1: 4, u1: 5, i2: 6, u2: 7, i4: 8, u4: 9, i8: 10, u8: 11, r4: 12, r8: 13, string: 14, "native-int": 0x18, "native-uint": 0x19, object: 0x1c, typedbyref: 0x16 };

const compressed = (n: number): number[] => n < 0x80 ? [n] : n < 0x4000 ? [0x80 | (n >> 8), n & 0xff] : [0xc0 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A signature's bytes, rebuilt from REA's text: numbers are bytes, and `{ operand }` is a type number. */
type Part = number | { operand: number };

function encodeType(text: string): Part[] {
    let i = 0;
    const one = (): Part[] => {
        let body: Part[];
        const m = /^(class|valuetype|var|mvar):(\d+)/.exec(text.slice(i));
        if (m) {
            i += m[0].length;
            const n = Number(m[2]);
            if (m[1] === "var" || m[1] === "mvar") body = [m[1] === "var" ? 0x13 : 0x1e, ...compressed(n)];
            else {
                const lead = m[1] === "class" ? 0x12 : 0x11;
                if (text[i] === "<") {
                    i++;
                    const args: Part[][] = [one()];
                    while (text[i] === ",") { i++; args.push(one()); }
                    if (text[i] !== ">") throw new Error("unexpected type text");
                    i++;
                    body = [0x15, lead, { operand: n }, ...compressed(args.length), ...args.flat()];
                } else body = [lead, { operand: n }];
            }
        } else {
            const e = /^[a-z0-9-]+/.exec(text.slice(i));
            if (!e || ELEMENTS[e[0]] === undefined) throw new Error("type text not understood");
            i += e[0].length;
            body = [ELEMENTS[e[0]]!];
        }
        for (;;) {
            if (text.startsWith("[]", i)) { i += 2; body = [0x1d, ...body]; }
            else if (text[i] === "&") { i++; body = [0x10, ...body]; }
            else if (text[i] === "*") { i++; body = [0x0f, ...body]; }
            else return body;
        }
    };
    const out = one();
    if (i !== text.length) throw new Error("type text not understood");
    return out;
}

function encodeSignature(s: Signature): Part[] | undefined {
    try {
        if (s.parse_status !== "decoded") return undefined;
        if (s.kind === "field") return [6, ...encodeType(s.field_type ?? "")];
        const cc = s.calling_convention ?? "";
        const words = cc.split(" ");
        if (words[0] !== "default") return undefined;
        const first = (words.includes("has-this") ? 0x20 : 0) | (words.includes("explicit-this") ? 0x40 : 0) | (words.includes("generic") ? 0x10 : 0);
        return [first, ...(words.includes("generic") ? compressed(s.generic_parameter_count ?? 0) : []), ...compressed(s.parameter_count ?? 0), ...encodeType(s.return_type ?? ""), ...(s.parameter_types ?? []).flatMap(encodeType)];
    } catch {
        return undefined; // arrays with bounds, function pointers, modifiers: left unproved, and reported
    }
}

const operandsOf = (text: string) => [...text.matchAll(/(?:class|valuetype):(\d+)/g)].map((m) => Number(m[1]));
const allTypes = (s: Signature) => [s.return_type ?? "", s.field_type ?? "", ...(s.parameter_types ?? [])];

/** The digest REA would give this signature if `digest` named each of its types. */
function resolvedDigest(parts: Part[], digest: (operand: number) => Buffer | undefined): string | undefined {
    const h = crypto.createHash("sha256");
    let run: number[] = [];
    for (const p of parts) {
        if (typeof p === "number") { run.push(p); continue; }
        const d = digest(p.operand);
        if (!d) return undefined;
        h.update(Buffer.from(run)); run = [];
        h.update(Buffer.from([0xff])); h.update(d);
    }
    h.update(Buffer.from(run));
    return h.digest("hex");
}

/**
 * Name the referenced types a contract's signatures use, by proof: a guessed name is kept only when it
 * makes the signature's digest come out as REA's. The rebuilt bytes are checked against raw_sha256 first,
 * so a change in how REA writes signatures leaves names unproved rather than wrong.
 */
export function proveTypeNames(inv: Inventory, members: Member[], extra: string[] = []): void {
    const guesses = [...new Set([...extra, ...inv.seen, ...likelyNames()])].filter((g) => !/[<>]/.test(g));
    const digests = new Map(guesses.map((g) => [g, nameDigest(g)]));
    let budget = 400_000;
    const known = (operand: number): Buffer | undefined => {
        const row = operand >> 2;
        if ((operand & 3) === 0) { const d = inv.defs.get(row)?.name_sha256; return d ? Buffer.from(d, "hex") : undefined; }
        if ((operand & 3) === 1 && inv.refs.has(row)) return digests.get(inv.refs.get(row)!) ?? nameDigest(inv.refs.get(row)!);
        return undefined;
    };
    const work = members.flatMap((m) => {
        const s = m.signature;
        if (!s?.resolved_sha256 || !s.raw_sha256) return [];
        const parts = encodeSignature(s);
        if (!parts) return [];
        const raw = Buffer.from(parts.flatMap((p) => (typeof p === "number" ? [p] : compressed(p.operand))));
        if (crypto.createHash("sha256").update(raw).digest("hex") !== s.raw_sha256) return [];
        return [{ s, parts }];
    });
    for (let progress = true; progress;) {
        progress = false;
        for (const { s, parts } of work) {
            const open = [...new Set(allTypes(s).flatMap(operandsOf))].filter((o) => (o & 3) === 1 && !inv.refs.has(o >> 2));
            if (!open.length || open.length > 2) continue;
            const tryNames = (i: number, chosen: Map<number, Buffer>, names: Map<number, string>): boolean => {
                if (i === open.length) {
                    if (budget-- <= 0) return false;
                    if (resolvedDigest(parts, (o) => chosen.get(o) ?? known(o)) !== s.resolved_sha256) return false;
                    for (const [o, n] of names) inv.refs.set(o >> 2, n);
                    return true;
                }
                for (const g of guesses) {
                    chosen.set(open[i]!, digests.get(g)!); names.set(open[i]!, g);
                    if (tryNames(i + 1, chosen, names)) return true;
                }
                chosen.delete(open[i]!); names.delete(open[i]!);
                return false;
            };
            if (tryNames(0, new Map(), new Map())) progress = true;
        }
    }
}

// ---------------------------------------------------------------- comparing

const WORDS: Record<string, string> = { i4: "int", i8: "long", i2: "short", i1: "sbyte", u1: "byte", u2: "ushort", u4: "uint", u8: "ulong", r4: "float", r8: "double", "native-int": "nint", "native-uint": "nuint" };

/** A namespace map's longest match wins, on a namespace boundary. */
export function mapName(full: string, map: Record<string, string>): string {
    const from = Object.keys(map).filter((k) => full === k || full.startsWith(`${k}.`)).sort((a, b) => b.length - a.length)[0];
    return from === undefined ? full : map[from] + full.slice(from.length);
}

function renderType(text: string, inv: Inventory, map: Record<string, string>): string {
    return text.replace(/(?:class|valuetype):(\d+)/g, (_, n: string) => {
        const v = Number(n), row = v >> 2;
        if ((v & 3) === 0) { const t = inv.defs.get(row)?.full_name; return t ? mapName(t, map) : `?def:${row}`; }
        if ((v & 3) === 1) { const t = inv.refs.get(row); return t ? mapName(t, map) : `?ref:${row}`; }
        return `?spec:${row}`;
    }).replace(/\b(i[1248]|u[1248]|r[48]|native-u?int)\b/g, (w) => WORDS[w] ?? w);
}

interface Shown { key: string; name: string; text: string; shape: string; proved: boolean; digest?: string; decoded: boolean }

const SURFACE = (flags: number | undefined) => { const a = (flags ?? 0) & 7; return a === 4 || a === 5 || a === 6; };
const STATIC = 0x10;

function show(m: Member, inv: Inventory, map: Record<string, string>, isField: boolean): Shown {
    const s = m.signature ?? {};
    const r = (t: string | null | undefined) => renderType(t ?? "", inv, map);
    const stat = ((m.flags ?? 0) & STATIC) !== 0 ? "static " : "";
    const generic = s.generic_parameter_count ? `<${s.generic_parameter_count}>` : "";
    const text = isField ? `${stat}${r(s.field_type)} ${m.name}` : `${stat}${r(s.return_type)} ${m.name}${generic}(${(s.parameter_types ?? []).map(r).join(", ")})`;
    return {
        key: m.name, name: m.name, text, shape: text.replace(/\?(ref|spec|def):\d+/g, "?"),
        proved: !text.includes("?") && s.parse_status === "decoded", digest: s.resolved_sha256 ?? undefined, decoded: s.parse_status === "decoded",
    };
}

/** Two signatures that agree everywhere except where one of them has an unnamed type. */
function fits(a: string, b: string): boolean {
    const parts = (s: string) => s.split(/([,<>()\s]+)/);
    const [x, y] = [parts(a), parts(b)];
    return x.length === y.length && x.every((t, i) => t === y[i] || t === "?" || y[i] === "?");
}

function compareMembers(type: string, kind: string, a: Shown[], b: Shown[], f: ContractFinding[]) {
    const rest = new Set(b);
    const left: Shown[] = [];
    for (const x of a) {
        // The same names after the map; or the same shape and the same digest from REA, which needs no names at all.
        const same = [...rest].find((y) => y.key === x.key && ((x.proved && y.proved && x.text === y.text) || (x.shape === y.shape && x.decoded && y.decoded && x.digest && x.digest === y.digest)));
        if (same) rest.delete(same);
        else left.push(x);
    }
    const leftAfter: Shown[] = [];
    for (const x of left) {
        const maybe = [...rest].find((y) => y.key === x.key && fits(x.shape, y.shape) && !(x.proved && y.proved));
        if (maybe) {
            rest.delete(maybe);
            f.push({ breaking: null, what: `${type}.${x.name}: can't be proved unchanged, because REA names a type only by number: ${x.text} and ${maybe.text}. A person checks it` });
        } else leftAfter.push(x);
    }
    const byName = new Map<string, Shown[]>();
    for (const y of rest) byName.set(y.key, [...(byName.get(y.key) ?? []), y]);
    for (const x of leftAfter) {
        const pool = byName.get(x.key);
        const y = pool?.shift();
        if (y) { rest.delete(y); f.push({ breaking: true, what: `${type}: signature changed: ${x.text} → ${y.text}` }); }
        else f.push({ breaking: true, what: `${type}: ${kind} removed: ${x.text}` });
    }
    for (const y of [...rest].sort((p, q) => p.text.localeCompare(q.text))) f.push({ breaking: false, what: `${type}: ${kind} added: ${y.text}` });
}

const hidden = (name: string) => name.includes("<");

/** Which types a contract's `types` list picks: exact names, or `Namespace.*`. */
const picks = (patterns: string[], t: string) => patterns.some((p) => (p.endsWith(".*") ? t.startsWith(p.slice(0, -1)) : t === p));

export function diffAssemblies(legacy: Inventory, candidate: Inventory, c: Pick<AssemblyContract, "types" | "namespace_map" | "known_types">): { findings: ContractFinding[]; note: string } {
    const map = c.namespace_map ?? {};
    const f: ContractFinding[] = [];
    if (!legacy.complete) f.push({ breaking: null, what: `REA read only part of ${legacy.assembly}, so something may be missing from this comparison` });
    if (!candidate.complete) f.push({ breaking: null, what: `REA read only part of ${candidate.assembly}, so something may be missing from this comparison` });
    const names = (inv: Inventory) => inv.types.map((t) => t.full_name ?? "").filter((n) => n && !hidden(n));
    const typesA = names(legacy).filter((t) => picks(c.types, t)).sort();
    const mappedPatterns = c.types.map((p) => (p.endsWith(".*") ? `${mapName(p.slice(0, -2), map)}.*` : mapName(p, map)));
    for (const p of c.types) if (!p.endsWith(".*") && !typesA.includes(p)) f.push({ breaking: null, what: `the contract lists ${p}, but ${legacy.assembly} has no such type` });
    const members = (inv: Inventory, type: string) => ({
        methods: inv.methods.filter((m) => m.declaring_type === type && SURFACE(m.flags) && !hidden(m.name)),
        fields: inv.fields.filter((m) => m.declaring_type === type && SURFACE(m.flags) && !hidden(m.name)),
    });
    const inScope = (inv: Inventory, types: string[]) => types.flatMap((t) => { const x = members(inv, t); return [...x.methods, ...x.fields]; });
    const typesB = names(candidate).filter((t) => picks(mappedPatterns, t)).sort();
    proveTypeNames(legacy, inScope(legacy, typesA), c.known_types);
    proveTypeNames(candidate, inScope(candidate, typesB), c.known_types);
    const seen = new Set<string>();
    let compared = 0;
    for (const t of typesA) {
        const to = mapName(t, map);
        seen.add(to);
        if (!names(candidate).includes(to)) { f.push({ breaking: true, what: `type removed: ${t} (expected ${to})` }); continue; }
        const a = members(legacy, t), b = members(candidate, to);
        compared += a.methods.length + a.fields.length;
        compareMembers(to, "method", a.methods.map((m) => show(m, legacy, map, false)), b.methods.map((m) => show(m, candidate, {}, false)), f);
        compareMembers(to, "field", a.fields.map((m) => show(m, legacy, map, true)), b.fields.map((m) => show(m, candidate, {}, true)), f);
    }
    for (const t of typesB) if (!seen.has(t)) f.push({ breaking: false, what: `type added: ${t}` });
    if (!typesA.length) f.push({ breaking: null, what: `no type in ${legacy.assembly} matches ${c.types.join(", ")}, so nothing was compared` });
    return { findings: f, note: `${compared} public member${compared === 1 ? "" : "s"} of ${typesA.length} type${typesA.length === 1 ? "" : "s"} compared` };
}

function inventoryOf(m: Manifest, file: string, what: string): Inventory {
    const full = inside(m, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ManifestError(`${what} ${file} does not exist.`);
    return readInventory(/\.json$/i.test(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : runRea(full), file);
}

/** Read both builds and compare them. Any failure is an ERROR outcome, so the report can't read as parity. */
export function checkAssemblyContract(m: Manifest, c: Contract): ContractOutcome {
    const base = { name: c.name, kind: c.kind };
    const a = c.assembly;
    if (!a) return { ...base, result: "ERROR", findings: [{ breaking: false, what: "the contract has no assembly settings" }] };
    let out: { findings: ContractFinding[]; note: string };
    try {
        out = diffAssemblies(inventoryOf(m, a.legacy, "The legacy assembly"), inventoryOf(m, a.candidate, "The candidate assembly"), a);
    } catch (err) {
        return { ...base, result: "ERROR", findings: [{ breaking: false, what: (err as Error).message }] };
    }
    for (const x of out.findings) x.where = `contract:${c.name}: ${x.what}`;
    const result = out.findings.some((x) => x.breaking === true) ? "BREAKING" : out.findings.some((x) => x.breaking === null) ? "REVIEW" : out.findings.length ? "COMPATIBLE" : "EQUIVALENT";
    return { ...base, result, findings: out.findings, note: out.note };
}
