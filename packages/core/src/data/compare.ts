// Comparing the files two systems produce, by what they mean. Never a byte comparison: a CSV is parsed and its rows
// matched by key, a workbook is read to cells per sheet, and fixed-width records are decoded first. In a CSV, null,
// empty and absent are one thing, because the format can't tell them apart.
import fs from "node:fs";

import { ManifestError } from "../manifest.js";
import { decodeFile, parseCopybook, type RecordEncoding } from "./copybook.js";
import { readXlsx, type Cell } from "./xlsx.js";

export interface CsvRead { header: string[]; rows: string[][] }

/** RFC 4180: quotes, doubled quotes, delimiters and line breaks inside quotes, CRLF or LF, and a leading BOM. */
export function parseCsv(text: string, delimiter = ","): CsvRead {
    const s = text.replace(/^﻿/, "");
    const all: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let wasQuoted = false;
    let i = 0;
    const endCell = () => { row.push(cell); cell = ""; wasQuoted = false; };
    const endRow = () => { endCell(); if (row.length > 1 || row[0] !== "") all.push(row); row = []; };
    while (i < s.length) {
        const c = s[i]!;
        if (quoted) {
            if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
            cell += c; i++; continue;
        }
        if (c === '"' && cell === "" && !wasQuoted) { quoted = true; wasQuoted = true; i++; continue; }
        if (s.startsWith(delimiter, i)) { endCell(); i += delimiter.length; continue; }
        if (c === "\r" && s[i + 1] === "\n") { endRow(); i += 2; continue; }
        if (c === "\n" || c === "\r") { endRow(); i++; continue; }
        cell += c; i++;
    }
    if (cell !== "" || row.length || wasQuoted) endRow();
    return { header: all[0] ?? [], rows: all.slice(1) };
}

// ---------------------------------------------------------------- scrubbing

const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;

export type Scrubbing = "dates" | "guids";

/**
 * Dates and GUIDs replaced by counters: the first date seen is DATE_1, and the same date again is DATE_1 again.
 * So two runs at different times compare equal, but a row that points at the wrong row still shows.
 * Rows are scrubbed in key order, so the counters don't depend on the order a system wrote them.
 */
export function scrubber(what: Scrubbing[]): (s: string) => string {
    const dates = new Map<string, string>(), guids = new Map<string, string>();
    const token = (m: Map<string, string>, v: string, name: string) => { if (!m.has(v)) m.set(v, `${name}_${m.size + 1}`); return m.get(v)!; };
    return (s) => {
        let out = s;
        if (what.includes("guids")) out = out.replace(GUID, (g) => token(guids, g.toLowerCase(), "GUID"));
        if (what.includes("dates")) out = out.replace(DATE, (d) => token(dates, d, "DATE"));
        return out;
    };
}

// ---------------------------------------------------------------- tables

export interface Table { name: string; columns: string[]; rows: Record<string, string | null>[]; problems?: string[] }

export interface CompareOptions {
    /** The columns that identify a row. Required: without one, order would decide what a difference is. */
    key: string[];
    /** Two numbers this close are equal. */
    epsilon?: number;
    scrub?: Scrubbing[];
    /** Null, empty and absent are one thing. On by default, because a CSV can't tell them apart. Off: they differ. */
    fold_empty?: boolean;
    /** Columns left out of the comparison. */
    ignore?: string[];
}

export interface CellDifference { table: string; key: string; column: string; a: string | null; b: string | null }

export interface TableComparison {
    same: boolean;
    tables: string[];
    rows_compared: number;
    differences: CellDifference[];
    only_in_a: { table: string; key: string }[];
    only_in_b: { table: string; key: string }[];
    duplicate_keys: { table: string; side: "a" | "b"; key: string }[];
    columns_only_in_a: { table: string; column: string }[];
    columns_only_in_b: { table: string; column: string }[];
    tables_only_in_a: string[];
    tables_only_in_b: string[];
    /** A file that could not be read properly: nothing about it can be called the same. */
    problems: string[];
}

const NUMERIC = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$|^[+-]?\.\d+$/;

/** Is this text a number? "007" isn't: a leading zero means an identifier. */
const asNumber = (s: string) => (NUMERIC.test(s.trim()) ? Number(s) : undefined);

function equalCells(a: string | null, b: string | null, o: CompareOptions): boolean {
    const fold = o.fold_empty !== false;
    if (a === b) return true;
    if (a === null || b === null) return fold && (a ?? "") === (b ?? "");
    const x = asNumber(a), y = asNumber(b);
    if (x !== undefined && y !== undefined) return Math.abs(x - y) <= (o.epsilon ?? 0) + Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(y));
    return false;
}

function keyed(t: Table, o: CompareOptions, side: "a" | "b", dupes: TableComparison["duplicate_keys"]) {
    // A file with no columns at all has no rows to match: every row of the other side is then "only in" it.
    for (const k of o.key) if (t.columns.length && !t.columns.includes(k)) throw new ManifestError(`The key column ${k} is not in ${t.name} (columns: ${t.columns.join(", ") || "none"}).`);
    const rows = new Map<string, Record<string, string | null>>();
    for (const r of t.rows) {
        const key = o.key.map((k) => r[k] ?? "").join(" | ");
        if (rows.has(key)) dupes.push({ table: t.name, side, key });
        else rows.set(key, r);
    }
    return rows;
}

/** Compare sets of tables by name, each by key. An empty `key` is refused. */
export function compareTables(as: Table[], bs: Table[], o: CompareOptions): TableComparison {
    if (!o.key?.length) throw new ManifestError("Name the key column with --key: without one, the order of the rows would decide what a difference is.");
    const out: TableComparison = {
        same: true, tables: [], rows_compared: 0, differences: [], only_in_a: [], only_in_b: [], duplicate_keys: [], columns_only_in_a: [], columns_only_in_b: [],
        tables_only_in_a: as.filter((t) => !bs.some((x) => x.name === t.name)).map((t) => t.name), tables_only_in_b: bs.filter((t) => !as.some((x) => x.name === t.name)).map((t) => t.name), problems: [],
    };
    const ignore = new Set(o.ignore ?? []);
    for (const t of [...as, ...bs]) out.problems.push(...(t.problems ?? []).map((p) => `${t.name}: ${p}`));
    for (const a of as) {
        const b = bs.find((x) => x.name === a.name);
        if (!b) continue;
        out.tables.push(a.name);
        const ra = keyed(a, o, "a", out.duplicate_keys), rb = keyed(b, o, "b", out.duplicate_keys);
        const fold = o.fold_empty !== false;
        // A column only one side has matters only if it holds something, when empty folds.
        const hasValue = (t: Table, c: string) => t.rows.some((r) => (r[c] ?? "") !== "");
        for (const c of a.columns.filter((c) => !b.columns.includes(c) && !ignore.has(c))) if (!fold || hasValue(a, c)) out.columns_only_in_a.push({ table: a.name, column: c });
        for (const c of b.columns.filter((c) => !a.columns.includes(c) && !ignore.has(c))) if (!fold || hasValue(b, c)) out.columns_only_in_b.push({ table: a.name, column: c });
        const shared = a.columns.filter((c) => b.columns.includes(c) && !ignore.has(c) && !o.key.includes(c));
        const scrubA = scrubber(o.scrub ?? []), scrubB = scrubber(o.scrub ?? []);
        const keys = [...new Set([...ra.keys(), ...rb.keys()])].sort();
        for (const key of keys) {
            const x = ra.get(key), y = rb.get(key);
            if (!x) { out.only_in_b.push({ table: a.name, key }); continue; }
            if (!y) { out.only_in_a.push({ table: a.name, key }); continue; }
            out.rows_compared++;
            for (const c of shared) {
                const p = x[c] ?? null, q = y[c] ?? null;
                const sp = p === null ? null : scrubA(p), sq = q === null ? null : scrubB(q);
                if (!equalCells(sp, sq, o)) out.differences.push({ table: a.name, key, column: c, a: p, b: q });
            }
        }
    }
    out.same = !out.differences.length && !out.only_in_a.length && !out.only_in_b.length && !out.duplicate_keys.length && !out.columns_only_in_a.length && !out.columns_only_in_b.length && !out.tables_only_in_a.length && !out.tables_only_in_b.length && !out.problems.length;
    return out;
}

// ---------------------------------------------------------------- reading files into tables

export function csvTable(text: string, name = "csv", delimiter = ","): Table {
    const { header, rows } = parseCsv(text, delimiter);
    return { name, columns: header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null]))) };
}

const cellText = (c: Cell): string | null => (c === null || c === undefined ? null : String(c));

/** Each sheet, with its first row as the header. Merged cells hold their value in the top-left one, as Excel keeps them. */
export function xlsxTables(bytes: Buffer, formulas: "value" | "formula" = "value"): Table[] {
    return readXlsx(bytes, { formulas }).sheets.map((s) => {
        const head = (s.rows[0] ?? []).map((c, i) => cellText(c) ?? `column${i + 1}`);
        const rows = s.rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, cellText(r[i])])));
        return { name: s.name, columns: head, rows };
    });
}

/** Records as one table, with nested names flattened: LINES[0].QTY. */
export function recordsTable(records: Record<string, unknown>[], name: string, problems: string[] = []): Table {
    const columns = new Set<string>();
    const flat = (v: unknown, at: string, into: Record<string, string | null>) => {
        if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${at}[${i}]`, into));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) flat(x, at ? `${at}.${k}` : k, into);
        else { into[at] = v === null || v === undefined ? null : String(v); columns.add(at); }
    };
    const rows = records.map((r) => { const o: Record<string, string | null> = {}; flat(r, "", o); return o; });
    return { name, columns: [...columns], rows, problems };
}

export interface ReadOptions {
    as?: "csv" | "xlsx" | "fixed";
    delimiter?: string;
    /** Text encoding of a CSV. */
    encoding?: BufferEncoding;
    copybook?: string;
    record_encoding?: RecordEncoding;
    formulas?: "value" | "formula";
}

/** A file as tables, by its content's kind: never by comparing its bytes. */
export function readTables(file: string, o: ReadOptions = {}): Table[] {
    const bytes = fs.readFileSync(file);
    const as = o.as ?? (/\.xlsx$/i.test(file) ? "xlsx" : /\.csv$/i.test(file) ? "csv" : /\.(dat|ebc|txt)$/i.test(file) && o.copybook ? "fixed" : undefined);
    if (as === "csv") return [csvTable(bytes.toString(o.encoding ?? "utf8"), "csv", o.delimiter)];
    if (as === "xlsx") {
        try { return xlsxTables(bytes, o.formulas); } catch (err) { throw new ManifestError(`${file} can't be read as a workbook: ${(err as Error).message}`); }
    }
    if (as === "fixed") {
        if (!o.copybook) throw new ManifestError(`Reading ${file} as fixed-width records needs --copybook.`);
        const layout = parseCopybook(fs.readFileSync(o.copybook, "utf8"), o.copybook);
        const { records, problems } = decodeFile(layout, bytes, o.record_encoding ?? "cp037");
        return [recordsTable(records, "records", problems)];
    }
    throw new ManifestError(`Say how to read ${file} with --as csv, xlsx or fixed.`);
}

/** The comparison in a few lines, for a person. */
export function describeComparison(c: TableComparison): string[] {
    const L: string[] = [`${c.same ? "The same" : "DIFFERENT"}: ${c.rows_compared} rows compared by key, across ${c.tables.join(", ") || "no tables"}.`];
    for (const p of c.problems) L.push(`  can't be read: ${p}`);
    for (const t of c.tables_only_in_a) L.push(`  only in the first file: sheet ${t}`);
    for (const t of c.tables_only_in_b) L.push(`  only in the second file: sheet ${t}`);
    for (const x of c.columns_only_in_a) L.push(`  column ${x.column} only in the first file (${x.table})`);
    for (const x of c.columns_only_in_b) L.push(`  column ${x.column} only in the second file (${x.table})`);
    for (const x of c.duplicate_keys) L.push(`  key ${x.key} used twice in the ${x.side === "a" ? "first" : "second"} file (${x.table})`);
    for (const x of c.only_in_a) L.push(`  row ${x.key} only in the first file (${x.table})`);
    for (const x of c.only_in_b) L.push(`  row ${x.key} only in the second file (${x.table})`);
    for (const d of c.differences.slice(0, 50)) L.push(`  row ${d.key}, ${d.column}: ${JSON.stringify(d.a)} vs ${JSON.stringify(d.b)} (${d.table})`);
    if (c.differences.length > 50) L.push(`  and ${c.differences.length - 50} more differences`);
    return L;
}
