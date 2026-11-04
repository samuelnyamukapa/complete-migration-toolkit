// Seed both systems from one artefact: a SQL Server catalogue read from a DDL script, a file of the foreign keys a
// legacy schema doesn't declare, a load order with cycles broken by deferring a nullable key, one SQL script and a
// manifest, and control totals both sides can be reconciled against.
//
// cmtk only writes these files. It never connects to a database and never runs the script: a person or a CI job
// loads it, into disposable test databases.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { inside, ManifestError } from "../manifest.js";
import type { Manifest } from "../types.js";
import { csvBytes } from "./files.js";
import { recipeFolder } from "./recipe.js";

export interface Column {
    name: string;
    /** Lower case: varchar, decimal, int. */
    type: string;
    /** Characters or bytes; -1 for max. */
    length?: number;
    precision?: number;
    scale?: number;
    nullable: boolean;
    identity: boolean;
    computed: boolean;
    has_default: boolean;
}

export interface ForeignKey {
    name?: string;
    columns: string[];
    ref_table: string;
    ref_columns: string[];
    /** From the virtual keys file: the schema does not declare it. */
    virtual?: string;
}

export interface Table {
    /** schema.name, such as dbo.Item. */
    name: string;
    columns: Column[];
    primary_key: string[];
    uniques: string[][];
    checks: string[];
    foreign_keys: ForeignKey[];
}

export interface Catalogue { tables: Table[]; notes: string[] }

// ---------------------------------------------------------------- reading a DDL script

/** Comments out, and everything else kept: strings and bracketed names can hold what looks like a comment. */
function stripComments(sql: string): string {
    return sql.replace(/'(?:[^']|'')*'|\[[^\]]*\]|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("--") || m.startsWith("/*") ? " " : m));
}

/** Statements, split on ; and on GO lines, outside strings and brackets. */
function statements(sql: string): string[] {
    const out: string[] = [];
    let cur = "";
    const clean = stripComments(sql).replace(/^\s*GO\s*\d*\s*$/gim, ";");
    for (const m of clean.matchAll(/'(?:[^']|'')*'|\[[^\]]*\]|"[^"]*"|;|[^'"[;]+|['"[]/g)) {
        if (m[0] === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; }
        else cur += m[0];
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

const NAME = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_#@][\w#@$]*)`;
const QNAME = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;
const unq = (n: string) => n.trim().replace(/^[["]|[\]"]$/g, "");

/** dbo.Item, however it was written. A name with no schema is in dbo. */
function tableName(q: string): string {
    const parts = [...q.matchAll(new RegExp(NAME, "g"))].map((m) => unq(m[0]));
    const last = parts.slice(-2);
    return last.length === 1 ? `dbo.${last[0]}` : `${last[0]}.${last[1]}`;
}

/** Split on commas at the top level of the parentheses. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const m of s.matchAll(/'(?:[^']|'')*'|\[[^\]]*\]|"[^"]*"|[(),]|[^'"[(),]+|['"[]/g)) {
        const t = m[0];
        if (t === "(") depth++;
        if (t === ")") depth--;
        if (t === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += t;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** The text inside the parentheses that open at `open`, and where they close. */
function group(s: string, open: number): { inner: string; end: number } {
    let depth = 0, inStr = false, inBr = false;
    for (let i = open; i < s.length; i++) {
        const c = s[i]!;
        if (inStr) { if (c === "'") inStr = false; continue; }
        if (inBr) { if (c === "]") inBr = false; continue; }
        if (c === "'") inStr = true;
        else if (c === "[") inBr = true;
        else if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) return { inner: s.slice(open + 1, i), end: i }; }
    }
    throw new ManifestError(`An opening parenthesis in the DDL is never closed: ${s.slice(open, open + 60)}`);
}

const nameList = (s: string) => splitTop(s).map((x) => unq(new RegExp(`^\\s*(${NAME})`).exec(x)?.[1] ?? x));

function readColumn(def: string, t: Table) {
    const m = new RegExp(`^(${NAME})\\s+`).exec(def);
    if (!m) throw new ManifestError(`${t.name}: this column is not understood: ${def.slice(0, 80)}`);
    const name = unq(m[1]!);
    const rest = def.slice(m[0].length);
    if (/^AS\b/i.test(rest)) { t.columns.push({ name, type: "computed", nullable: true, identity: false, computed: true, has_default: false }); return; }
    const ty = new RegExp(`^(${QNAME})\\s*(\\(\\s*(?:max|\\d+)(?:\\s*,\\s*\\d+)?\\s*\\))?`, "i").exec(rest);
    if (!ty) throw new ManifestError(`${t.name}.${name}: the type is not understood: ${rest.slice(0, 60)}`);
    const type = unq(ty[1]!.split(".").pop()!).toLowerCase();
    const col: Column = { name, type, nullable: true, identity: false, computed: false, has_default: false };
    const p = ty[2]?.replace(/[()\s]/g, "").split(",");
    if (p) {
        if (["decimal", "numeric"].includes(type)) { col.precision = Number(p[0]); col.scale = Number(p[1] ?? 0); }
        else if (!["datetime2", "time", "datetimeoffset", "float"].includes(type)) col.length = p[0]!.toLowerCase() === "max" ? -1 : Number(p[0]);
    }
    const tail = rest.slice(ty[0].length);
    if (/\bNOT\s+NULL\b/i.test(tail)) col.nullable = false;
    if (/\bIDENTITY\b/i.test(tail)) { col.identity = true; col.nullable = false; }
    if (/\bDEFAULT\b/i.test(tail)) col.has_default = true;
    if (/\bPRIMARY\s+KEY\b/i.test(tail)) { t.primary_key = [name]; col.nullable = false; }
    if (/\bUNIQUE\b/i.test(tail)) t.uniques.push([name]);
    for (const c of tail.matchAll(/\bCHECK\s*\(/gi)) t.checks.push(group(tail, c.index! + c[0].length - 1).inner);
    const ref = new RegExp(`\\bREFERENCES\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, "i").exec(tail);
    if (ref) t.foreign_keys.push({ columns: [name], ref_table: tableName(ref[1]!), ref_columns: ref[2] ? nameList(ref[2]) : [] });
    t.columns.push(col);
}

function readConstraint(def: string, t: Table): boolean {
    const m = new RegExp(`^(?:CONSTRAINT\\s+(${NAME})\\s+)?(PRIMARY\\s+KEY|UNIQUE|FOREIGN\\s+KEY|CHECK)\\b`, "i").exec(def);
    if (!m) return false;
    const kind = m[2]!.toUpperCase().replace(/\s+/g, " ");
    const open = def.indexOf("(", m[0].length);
    if (open < 0) return true;
    const { inner, end } = group(def, open);
    if (kind === "PRIMARY KEY") t.primary_key = nameList(inner);
    else if (kind === "UNIQUE") t.uniques.push(nameList(inner));
    else if (kind === "CHECK") t.checks.push(inner);
    else {
        const ref = new RegExp(`\\bREFERENCES\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, "i").exec(def.slice(end));
        if (!ref) throw new ManifestError(`${t.name}: a foreign key with no REFERENCES: ${def.slice(0, 80)}`);
        t.foreign_keys.push({ ...(m[1] ? { name: unq(m[1]) } : {}), columns: nameList(inner), ref_table: tableName(ref[1]!), ref_columns: ref[2] ? nameList(ref[2]) : [] });
    }
    return true;
}

/** The catalogue from a T-SQL script: tables, columns, widths, nullability, identity and computed columns, keys, checks and unique indexes. */
export function parseDdl(sql: string): Catalogue {
    const tables = new Map<string, Table>();
    const notes: string[] = [];
    for (const st of statements(sql)) {
        const create = new RegExp(`^CREATE\\s+TABLE\\s+(${QNAME})\\s*\\(`, "i").exec(st);
        if (create) {
            const t: Table = { name: tableName(create[1]!), columns: [], primary_key: [], uniques: [], checks: [], foreign_keys: [] };
            for (const def of splitTop(group(st, create[0].length - 1).inner)) if (!readConstraint(def, t)) readColumn(def, t);
            for (const k of t.primary_key) { const c = t.columns.find((x) => x.name === k); if (c) c.nullable = false; }
            tables.set(t.name, t);
            continue;
        }
        const alter = new RegExp(`^ALTER\\s+TABLE\\s+(${QNAME})\\s+(?:WITH\\s+(?:NO)?CHECK\\s+)?ADD\\s+`, "i").exec(st);
        if (alter) {
            const t = tables.get(tableName(alter[1]!));
            const rest = st.slice(alter[0].length);
            if (!t) { notes.push(`An ALTER TABLE on ${tableName(alter[1]!)}, which the script does not create, was left out.`); continue; }
            if (/^(?:CONSTRAINT\s+\S+\s+)?DEFAULT\b/i.test(rest)) {
                const on = new RegExp(`\\bFOR\\s+(${NAME})`, "i").exec(rest);
                const c = on ? t.columns.find((x) => x.name === unq(on[1]!)) : undefined;
                if (c) c.has_default = true;
                continue;
            }
            if (!readConstraint(rest, t)) notes.push(`${t.name}: this was not understood, so it is not honoured: ${rest.slice(0, 80)}`);
            continue;
        }
        const index = new RegExp(`^CREATE\\s+UNIQUE\\s+(?:CLUSTERED\\s+|NONCLUSTERED\\s+)?INDEX\\s+${NAME}\\s+ON\\s+(${QNAME})\\s*\\(`, "i").exec(st);
        if (index) {
            const t = tables.get(tableName(index[1]!));
            const g = group(st, index[0].length - 1);
            if (t) {
                t.uniques.push(nameList(g.inner));
                if (/\bWHERE\b/i.test(st.slice(g.end))) notes.push(`${t.name}: a filtered unique index on ${g.inner.trim()} is treated as unique for every row.`);
            }
        }
    }
    if (!tables.size) throw new ManifestError("The script holds no CREATE TABLE.");
    for (const t of tables.values()) for (const f of t.foreign_keys) {
        const target = tables.get(f.ref_table);
        if (!target) { notes.push(`${t.name}: its key to ${f.ref_table} points at a table the script does not create, so it was left out.`); continue; }
        if (!f.ref_columns.length) f.ref_columns = [...target.primary_key];
    }
    for (const t of tables.values()) t.foreign_keys = t.foreign_keys.filter((f) => tables.has(f.ref_table));
    return { tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)), notes };
}

// ---------------------------------------------------------------- virtual keys

export interface VirtualKey { table: string; columns: string[]; references: { table: string; columns: string[] }; reason: string }

/** Add the keys a legacy schema doesn't declare. Each must name real columns, and say why. */
export function applyVirtualKeys(c: Catalogue, keys: VirtualKey[]): void {
    const find = (n: unknown, what: string): Table => {
        const name = tableName(String(n));
        const t = c.tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!t) throw new ManifestError(`${what}: there is no table ${String(n)}.`);
        return t;
    };
    for (const [i, k] of keys.entries()) {
        const at = `virtual_keys[${i}]`;
        if (!k?.table || !Array.isArray(k.columns) || !k.columns.length || !k.references?.table || !Array.isArray(k.references.columns)) throw new ManifestError(`${at} needs table, columns, and references: { table, columns }.`);
        if (typeof k.reason !== "string" || !k.reason.trim()) throw new ManifestError(`${at} needs a reason: why this is a key though the schema does not say so.`);
        if (k.columns.length !== k.references.columns.length) throw new ManifestError(`${at}: ${k.columns.length} columns can't refer to ${k.references.columns.length}.`);
        const t = find(k.table, at), r = find(k.references.table, at);
        for (const col of k.columns) if (!t.columns.some((x) => x.name === col)) throw new ManifestError(`${at}: ${t.name} has no column ${col}.`);
        for (const col of k.references.columns) if (!r.columns.some((x) => x.name === col)) throw new ManifestError(`${at}: ${r.name} has no column ${col}.`);
        t.foreign_keys.push({ columns: k.columns, ref_table: r.name, ref_columns: k.references.columns, virtual: k.reason });
    }
}

export function readVirtualKeys(file: string): VirtualKey[] {
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as { virtual_keys?: VirtualKey[] } | null;
    if (!Array.isArray(doc?.virtual_keys)) throw new ManifestError(`${path.basename(file)} needs a list under virtual_keys.`);
    return doc!.virtual_keys;
}

// ---------------------------------------------------------------- load order

export interface LoadOrder {
    order: string[];
    /** Keys left null on insert and set by an UPDATE once every table is loaded: how a cycle is broken. */
    deferred: { table: string; key: ForeignKey }[];
}

const keyLabel = (t: string, k: ForeignKey) => `${t}(${k.columns.join(",")}) -> ${k.ref_table}(${k.ref_columns.join(",")})`;

/**
 * Parents before children. A self-reference, or a cycle, is broken by deferring a nullable key, in Jailer's way.
 * A cycle with no nullable key can't be loaded at all, and is refused rather than guessed at. The choice is by
 * name, so the same catalogue gives the same order.
 */
export function loadOrder(c: Catalogue): LoadOrder {
    const byName = new Map(c.tables.map((t) => [t.name, t]));
    const nullable = (t: Table, k: ForeignKey) => k.columns.every((n) => t.columns.find((x) => x.name === n)?.nullable);
    const deferred: LoadOrder["deferred"] = [];
    const isDeferred = (t: Table, k: ForeignKey) => deferred.some((d) => d.table === t.name && d.key === k);
    for (const t of c.tables) for (const k of t.foreign_keys) {
        if (k.ref_table !== t.name) continue;
        if (!nullable(t, k)) throw new ManifestError(`${keyLabel(t.name, k)} refers to its own table and can't be null, so the first row can't be loaded.`);
        deferred.push({ table: t.name, key: k });
    }
    const order: string[] = [];
    const done = new Set<string>();
    while (done.size < c.tables.length) {
        const ready = c.tables.filter((t) => !done.has(t.name) && t.foreign_keys.every((k) => done.has(k.ref_table) || isDeferred(t, k) || !byName.has(k.ref_table))).map((t) => t.name).sort();
        if (ready.length) {
            for (const n of ready) { order.push(n); done.add(n); }
            continue;
        }
        const stuck = c.tables.filter((t) => !done.has(t.name));
        const stuckNames = new Set(stuck.map((t) => t.name));
        const open = stuck.flatMap((t) => t.foreign_keys.filter((k) => stuckNames.has(k.ref_table) && !isDeferred(t, k) && nullable(t, k)).map((key) => ({ table: t.name, key })));
        if (!open.length) throw new ManifestError(`These tables refer to each other and no key among them can be null, so they can't be loaded in any order: ${[...stuckNames].sort().join(", ")}. Make a key nullable in the catalogue, or have a person decide how to load them.`);
        open.sort((a, b) => keyLabel(a.table, a.key).localeCompare(keyLabel(b.table, b.key)));
        deferred.push(open[0]!);
    }
    return { order, deferred };
}

// ---------------------------------------------------------------- simple checks

type Limit = { min?: number; max?: number; minExclusive?: number; maxExclusive?: number; values?: string[]; lenMin?: number; lenMax?: number; atLeast?: string };

/** What a check constraint says, for the common shapes. Anything else is noted, and a person checks the load. */
function readChecks(t: Table): { limits: Map<string, Limit>; unread: string[] } {
    const limits = new Map<string, Limit>();
    const unread: string[] = [];
    const lim = (c: string) => { const k = limits.get(c) ?? {}; limits.set(c, k); return k; };
    const num = (s: string) => Number(s.replace(/[()\s]/g, ""));
    const NUM = String.raw`\(*\s*(-?\d+(?:\.\d+)?)\s*\)*`;
    for (const check of t.checks) {
        // BETWEEN holds an AND of its own: write it as two limits first.
        const flat = check.replace(new RegExp(`(${NAME})\\s+BETWEEN\\s+${NUM}\\s+AND\\s+${NUM}`, "gi"), "$1 >= $2 AND $1 <= $3");
        for (const raw of flat.split(/\bAND\b/i)) {
            const part = raw.trim().replace(/^\(+/, "").replace(/\)+$/, "");
            let m: RegExpExecArray | null;
            if ((m = new RegExp(`^(${NAME})\\s*(>=|>|<=|<|=)\\s*${NUM}$`, "i").exec(part))) {
                const l = lim(unq(m[1]!)), n = num(m[3]!);
                if (m[2] === ">=") l.min = n; else if (m[2] === ">") l.minExclusive = n; else if (m[2] === "<=") l.max = n; else if (m[2] === "<") l.maxExclusive = n; else { l.min = n; l.max = n; }
            } else if ((m = new RegExp(`^(${NAME})\\s*>=\\s*(${NAME})$`, "i").exec(part))) {
                lim(unq(m[1]!)).atLeast = unq(m[2]!);
            } else if ((m = new RegExp(`^(${NAME})\\s+IN\\s*\\((.*)$`, "i").exec(part))) {
                lim(unq(m[1]!)).values = [...m[2]!.matchAll(/N?'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)/g)].map((v) => (v[1] !== undefined ? v[1].replace(/''/g, "'") : v[2]!));
            } else if ((m = new RegExp(`^LEN\\s*\\(\\s*(${NAME})\\s*\\)\\s*(>=|>|<=)\\s*${NUM}$`, "i").exec(part))) {
                const l = lim(unq(m[1]!)), n = num(m[3]!);
                if (m[2] === ">=") l.lenMin = n; else if (m[2] === ">") l.lenMin = n + 1; else l.lenMax = n;
            } else unread.push(part);
        }
    }
    return { limits, unread };
}

// ---------------------------------------------------------------- making the rows

type Val = { sql: string; text: string | null; number?: string };
const NULL: Val = { sql: "NULL", text: null };

const hashTo = (s: string) => crypto.createHash("sha256").update(s).digest();
const pick = (seed: number, key: string, n: number) => hashTo(`${seed}:${key}`).readUInt32BE(0) % n;
const WORDS = ["Alder", "Birch", "Cedar", "Damson", "Elm", "Fir", "Ginkgo", "Hazel", "Ivy", "Juniper", "Larch", "Maple", "Oak", "Pine", "Rowan", "Spruce", "Willow", "Yew"];

const INT_RANGE: Record<string, [bigint, bigint]> = { tinyint: [0n, 255n], smallint: [-32768n, 32767n], int: [-2147483648n, 2147483647n], bigint: [-(2n ** 63n), 2n ** 63n - 1n] };

const decimalText = (n: bigint, scale: number) => { const neg = n < 0n; const d = (neg ? -n : n).toString().padStart(scale + 1, "0"); return `${neg ? "-" : ""}${scale ? `${d.slice(0, -scale)}.${d.slice(-scale)}` : d}`; };
const sqlText = (s: string, unicode: boolean) => `${unicode ? "N" : ""}'${s.replace(/'/g, "''")}'`;

function stringValue(c: Column, l: Limit | undefined, i: number, seed: number, table: string, unique: boolean): Val {
    const unicode = c.type.startsWith("n");
    const width = c.length === undefined ? (c.type.endsWith("char") ? 1 : 200) : c.length === -1 ? 200 : c.length;
    const top = Math.min(width, l?.lenMax ?? width);
    const fixed = c.type === "char" || c.type === "nchar";
    if (l?.values?.length) { const v = l.values[i % l.values.length]!; return { sql: sqlText(v, unicode), text: v }; }
    const word = WORDS[pick(seed, `${table}.${c.name}.${i}`, WORDS.length)]!;
    // A few rows on purpose: filling the column, and letters outside ASCII where it can hold them.
    let v = i === 1 ? "W".repeat(top) : i === 2 && unicode ? "Ñandú café" : word;
    if (unique) { const tag = `${i}`; v = (v + "_" + tag).length > top ? (word.slice(0, Math.max(0, top - tag.length)) + tag).slice(-Math.max(top, 1)) : `${v}_${tag}`; if (i === 1 && top >= tag.length) v = "W".repeat(top - tag.length) + tag; }
    v = v.slice(0, top);
    if ((l?.lenMin ?? 0) > [...v].length) v = v.padEnd(l!.lenMin!, "x");
    if (fixed) v = v.padEnd(width, " ");
    return { sql: sqlText(v, unicode), text: v };
}

function numberValue(c: Column, l: Limit | undefined, i: number, seed: number, table: string, unique: boolean): Val {
    const scale = ["decimal", "numeric"].includes(c.type) ? c.scale ?? 0 : c.type === "money" || c.type === "smallmoney" ? 4 : 0;
    const factor = 10n ** BigInt(scale);
    const toUnits = (n: number) => BigInt(Math.round(n * Number(factor)));
    let lo: bigint, hi: bigint;
    if (INT_RANGE[c.type]) [lo, hi] = INT_RANGE[c.type]!;
    else if (c.type === "money") { lo = -(2n ** 63n); hi = 2n ** 63n - 1n; }
    else if (c.type === "smallmoney") { lo = -(2n ** 31n); hi = 2n ** 31n - 1n; }
    else { const top = 10n ** BigInt(c.precision ?? 18) - 1n; lo = -top; hi = top; }
    if (l?.min !== undefined) lo = toUnits(l.min);
    if (l?.minExclusive !== undefined) lo = toUnits(l.minExclusive) + 1n;
    if (l?.max !== undefined) hi = toUnits(l.max);
    if (l?.maxExclusive !== undefined) hi = toUnits(l.maxExclusive) - 1n;
    if (l?.values?.length) { const v = l.values[i % l.values.length]!; return { sql: v, text: v, number: v }; }
    let n: bigint;
    if (unique) n = (lo > 0n ? lo : 1n * factor) + BigInt(i) * factor;
    else if (i === 3) n = lo; // a row at each edge of the type: a narrower column on the other side shows here
    else if (i === 4) n = hi;
    else {
        const small = 1000n * factor < hi ? 1000n * factor : hi;
        const base = lo > 0n ? lo : 0n;
        n = base + BigInt(pick(seed, `${table}.${c.name}.${i}`, 100000)) % (small - base + 1n > 0n ? small - base + 1n : 1n);
    }
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    const text = decimalText(n, scale);
    return { sql: text, text, number: text };
}

/** Dates near the things that break them: a leap day, the clocks going forward, the end of a year. */
const DATES = ["2024-02-29", "2026-03-29", "2025-12-31", "2026-01-01", "2026-06-15"];

function valueFor(c: Column, l: Limit | undefined, i: number, seed: number, table: string, unique: boolean): Val {
    switch (c.type) {
        case "int": case "bigint": case "smallint": case "tinyint": case "decimal": case "numeric": case "money": case "smallmoney":
            return numberValue(c, l, i, seed, table, unique);
        case "bit": { const b = i % 2; return { sql: String(b), text: String(b), number: String(b) }; }
        case "float": case "real": { const v = (pick(seed, `${table}.${c.name}.${i}`, 100000) / 100).toFixed(2); return { sql: v, text: v, number: v }; }
        case "char": case "nchar": case "varchar": case "nvarchar": case "text": case "ntext": case "sysname":
            return stringValue(c, l, i, seed, table, unique);
        case "date": { const d = DATES[i % DATES.length]!; return { sql: `'${d}'`, text: d }; }
        case "datetime": case "datetime2": case "smalldatetime": case "datetimeoffset": {
            const d = `${DATES[i % DATES.length]!}T${c.type === "smalldatetime" ? "01:30:00" : "01:30:15"}`;
            return { sql: `'${d}'`, text: d };
        }
        case "time": return { sql: "'01:30:15'", text: "01:30:15" };
        case "uniqueidentifier": {
            const h = hashTo(`${seed}:${table}.${c.name}.${i}`).toString("hex");
            const g = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
            return { sql: `'${g}'`, text: g };
        }
        case "binary": case "varbinary": case "image": {
            const size = Math.min(c.length === undefined || c.length === -1 ? 8 : c.length, 32);
            const h = hashTo(`${seed}:${table}.${c.name}.${i}`).toString("hex").slice(0, size * 2);
            return { sql: `0x${h}`, text: h };
        }
        default:
            throw new EncodeUnknown(c.type);
    }
}
class EncodeUnknown extends Error { constructor(readonly type: string) { super(type); } }

export interface SeedOptions {
    seed?: number;
    /** Rows per table. Default 50: the low end of the 50 to 100 golden records the research calls for. */
    rows?: number;
    /** Rows per table, by name. */
    table_rows?: Record<string, number>;
}

export interface SeedResult {
    catalogue: Catalogue;
    order: LoadOrder;
    /** Each table's rows, as column to value. */
    rows: Map<string, Map<string, Val>[]>;
    script: string;
    reset: string;
    totals: string;
    notes: string[];
}

const br = (s: string) => `[${s.replace(/\]/g, "]]")}]`;
const qn = (t: string) => t.split(".").map(br).join(".");

/** The rows and the script, from nothing but the catalogue and the seed. */
export function buildSeed(c: Catalogue, o: SeedOptions = {}): SeedResult {
    const seed = o.seed ?? 20260115;
    const order = loadOrder(c);
    const notes = [...c.notes];
    const byName = new Map(c.tables.map((t) => [t.name, t]));
    const rows = new Map<string, Map<string, Val>[]>();
    const countOf = (n: string) => o.table_rows?.[n] ?? o.rows ?? 50;
    const deferredColumns = (t: string) => new Set(order.deferred.filter((d) => d.table === t).flatMap((d) => d.key.columns));
    const parentValue = (k: ForeignKey, i: number, col: string): Val => {
        const parents = rows.get(k.ref_table);
        if (!parents?.length) return NULL;
        const p = parents[i % parents.length]!;
        const at = k.columns.indexOf(col);
        return p.get(k.ref_columns[at]!) ?? NULL;
    };
    const deferredUpdates: string[] = [];
    for (const name of order.order) {
        const t = byName.get(name)!;
        const { limits, unread } = readChecks(t);
        for (const u of unread) notes.push(`${name}: the check ${u} was not understood, so the rows may break it, and the load would say so. A person checks it.`);
        const deferred = deferredColumns(name);
        const unique = new Set([...t.primary_key.length === 1 ? t.primary_key : [], ...t.uniques.filter((u) => u.length === 1).flat()]);
        // A composite key or unique index: its last column carries the uniqueness.
        for (const u of [t.primary_key, ...t.uniques]) if (u.length > 1 && !u.some((n) => t.foreign_keys.some((k) => k.columns.includes(n)))) unique.add(u[u.length - 1]!);
        const list: Map<string, Val>[] = [];
        const n = countOf(name);
        for (let i = 0; i < n; i++) {
            const row = new Map<string, Val>();
            for (const col of t.columns) {
                if (col.computed || col.type === "timestamp" || col.type === "rowversion") continue;
                const fk = t.foreign_keys.find((k) => k.columns.includes(col.name));
                if (deferred.has(col.name)) { row.set(col.name, NULL); continue; }
                if (fk) {
                    // A nullable key is left null on the last row, where there is more than one: null, empty and absent are a difference worth seeing.
                    row.set(col.name, col.nullable && n > 1 && i === n - 1 ? NULL : parentValue(fk, i, col.name));
                    continue;
                }
                if (col.identity) { const v = String(i + 1); row.set(col.name, { sql: v, text: v, number: v }); continue; }
                if (col.nullable && !unique.has(col.name) && i === n - 1 && n > 1 && !limits.get(col.name)?.values) { row.set(col.name, NULL); continue; }
                try {
                    row.set(col.name, valueFor(col, limits.get(col.name), i, seed, name, unique.has(col.name)));
                } catch (err) {
                    if (!(err instanceof EncodeUnknown)) throw err;
                    if (!col.nullable) throw new ManifestError(`${name}.${col.name}: cmtk can't make a ${err.type}, and the column can't be null. Say what it should hold, or leave this table out.`);
                    notes.push(`${name}.${col.name}: cmtk can't make a ${err.type}, so it is left null.`);
                    row.set(col.name, NULL);
                }
            }
            // A check between two columns of this row: move the one it names.
            for (const [cname, l] of limits) {
                if (!l.atLeast) continue;
                const a = row.get(cname), b = row.get(l.atLeast);
                if (a?.text && b?.text && (a.number !== undefined && b.number !== undefined ? Number(a.number) < Number(b.number) : a.text < b.text)) row.set(cname, b);
            }
            list.push(row);
        }
        rows.set(name, list);
    }
    // Deferred keys: set once every table is loaded. A row points at the row its number names, and the last stays null.
    for (const d of order.deferred) {
        const t = byName.get(d.table)!;
        const list = rows.get(d.table)!;
        const pk = t.primary_key;
        if (!pk.length) throw new ManifestError(`${d.table} has no primary key, so its deferred key can't be set by an UPDATE. Give it one in the catalogue.`);
        const parents = rows.get(d.key.ref_table)!;
        list.forEach((row, i) => {
            if (list.length > 1 && i === list.length - 1) return;
            // On a self-reference a row points at the next one, never itself, so the rows form a chain.
            const p = parents[(d.key.ref_table === d.table ? i + 1 : i) % parents.length];
            if (!p) return;
            const sets = d.key.columns.map((col, at) => { const v = p.get(d.key.ref_columns[at]!) ?? NULL; row.set(col, v); return `${br(col)} = ${v.sql}`; });
            deferredUpdates.push(`UPDATE ${qn(d.table)} SET ${sets.join(", ")} WHERE ${pk.map((k) => `${br(k)} = ${row.get(k)?.sql ?? "NULL"}`).join(" AND ")};`);
        });
    }
    const L: string[] = [
        "-- A test-data seed, written by `cmtk data seed`. For disposable test databases only: cmtk never runs it.",
        `-- Seed ${seed}. The same catalogue and seed give the same bytes.`,
        "SET NOCOUNT ON;", "SET XACT_ABORT ON;", "BEGIN TRANSACTION;", "",
    ];
    for (const name of order.order) {
        const t = byName.get(name)!;
        const list = rows.get(name)!;
        if (!list.length) continue;
        const identity = t.columns.some((c) => c.identity);
        const cols = [...list[0]!.keys()];
        L.push(`-- ${name}: ${list.length} rows`);
        if (identity) L.push(`SET IDENTITY_INSERT ${qn(name)} ON;`);
        const deferred = deferredColumns(name);
        for (const row of list) L.push(`INSERT INTO ${qn(name)} (${cols.map(br).join(", ")}) VALUES (${cols.map((col) => (deferred.has(col) ? "NULL" : row.get(col)!.sql)).join(", ")});`);
        if (identity) L.push(`SET IDENTITY_INSERT ${qn(name)} OFF;`);
        L.push("");
    }
    if (deferredUpdates.length) L.push("-- Deferred keys: these close the cycles, once both ends are loaded.", ...deferredUpdates, "");
    L.push("COMMIT TRANSACTION;", "");
    const reset = [
        "-- Empties the seeded tables, children first, for reloading a disposable test database. cmtk never runs it.", "SET NOCOUNT ON;", "SET XACT_ABORT ON;", "BEGIN TRANSACTION;",
        ...order.deferred.map((d) => `UPDATE ${qn(d.table)} SET ${d.key.columns.map((x) => `${br(x)} = NULL`).join(", ")};`),
        ...[...order.order].reverse().map((n) => `DELETE FROM ${qn(n)};`), "COMMIT TRANSACTION;", "",
    ].join("\n");
    return { catalogue: c, order, rows, script: L.join("\n"), reset, totals: totalsSql(c, order), notes };
}

// ---------------------------------------------------------------- control totals

const NUMERIC = new Set(["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney", "float", "real", "bit"]);

/** One query, one result set: table, column, measure, value. The same shape from both sides, so they can be compared by key. */
function totalsSql(c: Catalogue, order: LoadOrder): string {
    const parts: string[] = [];
    for (const n of order.order) {
        const t = c.tables.find((x) => x.name === n)!;
        parts.push(`SELECT '${n}' AS [table], '*' AS [column], 'count' AS [measure], CAST(COUNT(*) AS varchar(50)) AS [value] FROM ${qn(n)}`);
        for (const col of t.columns.filter((x) => NUMERIC.has(x.type) && !x.computed)) {
            // bit can't be summed or cast by itself in every engine: it counts as 0 and 1.
            const v = col.type === "bit" ? `CASE WHEN ${br(col.name)} = 1 THEN 1 WHEN ${br(col.name)} = 0 THEN 0 END` : br(col.name);
            for (const [m, f] of [["sum", "SUM"], ["min", "MIN"], ["max", "MAX"], ["avg", "AVG"]] as const) {
                parts.push(`SELECT '${n}', '${col.name.replace(/'/g, "''")}', '${m}', CAST(${f}(CAST(${v} AS decimal(38,6))) AS varchar(50)) FROM ${qn(n)}`);
            }
        }
    }
    return `-- Control totals: run this on each side after loading, save the result as CSV with a header, and compare:\n--   cmtk data reconcile <one.csv> <other.csv>\nSET NOCOUNT ON;\n${parts.join("\nUNION ALL ")};\n`;
}

/** What the totals must be, worked out from the rows, exactly. */
export function expectedTotals(s: SeedResult): { table: string; column: string; measure: string; value: string | null }[] {
    const out: { table: string; column: string; measure: string; value: string | null }[] = [];
    const SCALE = 6;
    const units = (x: string) => {
        const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(x)!;
        const n = BigInt(`${m[2] || "0"}${(m[3] ?? "").padEnd(SCALE, "0").slice(0, SCALE)}`);
        return m[1] ? -n : n;
    };
    for (const n of s.order.order) {
        const t = s.catalogue.tables.find((x) => x.name === n)!;
        const rows = s.rows.get(n)!;
        out.push({ table: n, column: "*", measure: "count", value: String(rows.length) });
        for (const col of t.columns.filter((x) => NUMERIC.has(x.type) && !x.computed)) {
            const vals = rows.map((r) => r.get(col.name)?.number).filter((v): v is string => v !== undefined).map(units);
            const has = vals.length > 0;
            const sum = vals.reduce((a, b) => a + b, 0n);
            const text = (v: bigint) => decimalText(v, SCALE);
            const min = vals.reduce((a, b) => (b < a ? b : a), vals[0] ?? 0n), max = vals.reduce((a, b) => (b > a ? b : a), vals[0] ?? 0n);
            out.push({ table: n, column: col.name, measure: "sum", value: has ? text(sum) : null });
            out.push({ table: n, column: col.name, measure: "min", value: has ? text(min) : null });
            out.push({ table: n, column: col.name, measure: "max", value: has ? text(max) : null });
            out.push({ table: n, column: col.name, measure: "avg", value: has ? text(sum / BigInt(vals.length)) : null });
        }
    }
    return out;
}

// ---------------------------------------------------------------- writing it all

export interface SeedManifest {
    id: string;
    source: { ddl: string; ddl_sha256: string; virtual_keys?: string; virtual_keys_sha256?: string };
    seed: number;
    tables: { table: string; rows: number }[];
    load_order: string[];
    deferred_keys: string[];
    virtual_keys: string[];
    notes: string[];
    files: Record<string, string>;
    not_done: string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Write the script, the totals and the golden records, into cmtk/data/seed-<id>/. */
export function writeSeed(m: Manifest, o: SeedOptions & { ddl: string; virtualKeys?: string; id?: string }): { folder: string; manifest: SeedManifest; result: SeedResult } {
    const ddlFile = inside(m, o.ddl);
    if (!fs.existsSync(ddlFile)) throw new ManifestError(`${o.ddl} does not exist.`);
    const id = o.id ?? path.basename(o.ddl).replace(/\.[^.]+$/, "");
    if (!ID.test(id)) throw new ManifestError(`The seed's name ${JSON.stringify(id)} must be letters, digits, '.', '-' and '_'.`);
    const text = fs.readFileSync(ddlFile);
    const catalogue = parseDdl(text.toString("utf8").replace(/^﻿/, ""));
    let vkBytes: Buffer | undefined;
    if (o.virtualKeys) {
        const f = inside(m, o.virtualKeys);
        if (!fs.existsSync(f)) throw new ManifestError(`${o.virtualKeys} does not exist.`);
        vkBytes = fs.readFileSync(f);
        applyVirtualKeys(catalogue, readVirtualKeys(f));
    }
    const result = buildSeed(catalogue, o);
    const dir = inside(m, path.join(path.relative(m.root, recipeFolder(m)), `seed-${id}`));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "golden"), { recursive: true });
    const files: Record<string, string> = {};
    const put = (name: string, bytes: Buffer | string) => {
        const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
        fs.writeFileSync(path.join(dir, name), b);
        files[name.split(path.sep).join("/")] = crypto.createHash("sha256").update(b).digest("hex");
    };
    put("seed.sql", result.script);
    put("reset.sql", result.reset);
    put("control-totals.sql", result.totals);
    put("control-totals.expected.csv", csvBytes(["table", "column", "measure", "value"], expectedTotals(result), { bom: false, line_ending: "lf" }));
    put("catalogue.json", JSON.stringify(catalogue, null, 2) + "\n");
    for (const [name, rows] of result.rows) {
        const t = catalogue.tables.find((x) => x.name === name)!;
        const cols = rows[0] ? [...rows[0].keys()] : t.columns.filter((c) => !c.computed).map((c) => c.name);
        put(path.join("golden", `${name}.csv`), csvBytes(cols, rows.map((r) => Object.fromEntries(cols.map((c) => [c, r.get(c)?.text ?? null]))), { bom: false, line_ending: "lf" }));
    }
    const manifest: SeedManifest = {
        id,
        source: { ddl: path.relative(m.root, ddlFile).split(path.sep).join("/"), ddl_sha256: crypto.createHash("sha256").update(text).digest("hex"), ...(o.virtualKeys && vkBytes ? { virtual_keys: o.virtualKeys, virtual_keys_sha256: crypto.createHash("sha256").update(vkBytes).digest("hex") } : {}) },
        seed: o.seed ?? 20260115,
        tables: result.order.order.map((n) => ({ table: n, rows: result.rows.get(n)!.length })),
        load_order: result.order.order,
        deferred_keys: result.order.deferred.map((d) => keyLabel(d.table, d.key)),
        virtual_keys: catalogue.tables.flatMap((t) => t.foreign_keys.filter((k) => k.virtual).map((k) => `${keyLabel(t.name, k)}: ${k.virtual}`)),
        notes: result.notes,
        files,
        not_done: [
            "Reading the catalogue from a live SQL Server (INFORMATION_SCHEMA and sys.*): use a DDL script for now.",
            "The mapping step for a new side whose schema differs: this script fits the schema it was made from.",
            "A masked profile or a Jailer subset for realism: these rows are synthetic.",
        ],
    };
    fs.writeFileSync(path.join(dir, "SEED-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    return { folder: path.relative(m.root, dir).split(path.sep).join("/"), manifest, result };
}
