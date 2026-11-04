// Edge files: the input files a system's import has to cope with, generated from a recipe's own valid rows. Each is
// labelled with what it exercises and whether it should be accepted, and nothing here decides what the system should
// answer: a file's label says what the format allows, and the requirement or the legacy system says the rest.
import { stringify } from "csv-stringify/sync";

import { writeXlsx, type Cell, type Sheet, type WriteOptions } from "./xlsx.js";

export interface CsvOptions {
    /** Default ",". */
    delimiter?: string;
    /** Default '"'. */
    quote?: string;
    /** Quote every cell, not only those that need it. */
    quoted?: boolean;
    /** Write a header row. Default true. */
    header?: boolean;
    /** Write a byte order mark. Default true. */
    bom?: boolean;
    /** "crlf" (the default) or "lf". */
    line_ending?: "crlf" | "lf";
    /** The most rows the import takes, for the max_rows edge file. Default 1000. */
    max_rows?: number;
}

export interface XlsxOptions {
    /** A cell whose text starts with = : "value" (the default) writes it as text, as a hostile value; "formula" writes a formula. */
    formulas?: "value" | "formula";
}

export interface EdgeInfo { file: string; kind: string; expect_valid: boolean; why: string }
export interface Edge extends EdgeInfo { bytes: Buffer }

export function csvBytes(columns: string[], records: Record<string, unknown>[], o: CsvOptions = {}): Buffer {
    const text = stringify(records, {
        header: o.header !== false, columns,
        bom: false, delimiter: o.delimiter ?? ",", quote: o.quote ?? '"', quoted: o.quoted ?? false, quoted_match: /[\r\n]/,
        record_delimiter: o.line_ending === "lf" ? "\n" : "\r\n",
        cast: { boolean: (b: boolean) => (b ? "true" : "false") },
    });
    return Buffer.from((o.bom === false ? "" : "﻿") + text, "utf8");
}

/** The OWASP CSV-injection lead characters: a spreadsheet may run a cell that starts with one. */
export const FORMULA_LEADS: { name: string; value: string }[] = [
    { name: "equals", value: "=1+1" }, { name: "plus", value: "+1+1" }, { name: "minus", value: "-1+1" }, { name: "at", value: "@SUM(1,1)" },
    { name: "tab", value: "\t=1+1" }, { name: "cr", value: "\r=1+1" }, { name: "lf", value: "\n=1+1" },
];

/** The first text column, for the values an edge file plants. */
const textColumn = (columns: string[], rows: Record<string, unknown>[]) => columns.find((c) => rows.some((r) => typeof r[c] === "string")) ?? columns[0]!;

/** CSV edge files, from the recipe's valid rows. `rows` holds data columns only. */
export function csvEdges(columns: string[], rows: Record<string, unknown>[], o: CsvOptions = {}): Edge[] {
    const opts: CsvOptions = { ...o, bom: o.bom ?? true };
    const first = rows[0] ?? {};
    const max = o.max_rows ?? 1000;
    const text = textColumn(columns, rows);
    const out: Edge[] = [
        { file: "empty.csv", kind: "size", expect_valid: false, why: "no bytes at all, not even a header", bytes: Buffer.alloc(0) },
        { file: "header_only.csv", kind: "size", expect_valid: true, why: "a header and no rows", bytes: csvBytes(columns, [], { ...opts, header: true }) },
        { file: "one_row.csv", kind: "size", expect_valid: true, why: "one row", bytes: csvBytes(columns, [first], opts) },
        { file: "max_rows.csv", kind: "size", expect_valid: true, why: `${max} rows, the most the recipe says the import takes (csv.max_rows); the valid rows repeat`, bytes: csvBytes(columns, Array.from({ length: max }, (_, i) => rows[i % Math.max(1, rows.length)] ?? first), opts) },
        { file: "max_rows_plus_one.csv", kind: "size", expect_valid: false, why: `${max + 1} rows, one above the most (csv.max_rows)`, bytes: csvBytes(columns, Array.from({ length: max + 1 }, (_, i) => rows[i % Math.max(1, rows.length)] ?? first), opts) },
        { file: "crlf.csv", kind: "line-ending", expect_valid: true, why: "lines end in CRLF", bytes: csvBytes(columns, rows, { ...opts, line_ending: "crlf" }) },
        { file: "lf.csv", kind: "line-ending", expect_valid: true, why: "lines end in LF", bytes: csvBytes(columns, rows, { ...opts, line_ending: "lf" }) },
        { file: "utf8_bom.csv", kind: "encoding", expect_valid: true, why: "UTF-8 with a byte order mark", bytes: csvBytes(columns, [{ ...first, [text]: "Ñandú café" }], { ...opts, bom: true }) },
        { file: "utf8_no_bom.csv", kind: "encoding", expect_valid: true, why: "UTF-8 without a byte order mark", bytes: csvBytes(columns, [{ ...first, [text]: "Ñandú café" }], { ...opts, bom: false }) },
        { file: "latin1.csv", kind: "encoding", expect_valid: false, why: "not UTF-8: Latin-1 bytes, which a UTF-8 reader either refuses or turns into replacement characters", bytes: Buffer.from(csvBytes(columns, [{ ...first, [text]: "Ñandú café" }], { ...opts, bom: false }).toString("utf8"), "latin1") },
        { file: "semicolons.csv", kind: "delimiter", expect_valid: false, why: "semicolons, as Excel writes in most European locales, where the recipe says commas", bytes: csvBytes(columns, rows, { ...opts, delimiter: o.delimiter === ";" ? "," : ";" }) },
        { file: "quoted_line_break.csv", kind: "quoting", expect_valid: true, why: "a line break inside a quoted cell", bytes: csvBytes(columns, [{ ...first, [text]: "two\nlines" }], opts) },
    ];
    for (const f of FORMULA_LEADS) {
        out.push({ file: `injection_${f.name}.csv`, kind: "csv-injection", expect_valid: false, why: `OWASP CSV injection: a cell in ${text} starts with ${JSON.stringify(f.value[0])}, which a spreadsheet may run`, bytes: csvBytes(columns, [{ ...first, [text]: f.value }], opts) });
    }
    return out;
}

/** The sheet for a workbook: one header row, then the data. */
export function dataSheet(columns: string[], records: Record<string, unknown>[], name = "data"): Sheet {
    const cell = (v: unknown): Cell => (v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean));
    return { name, rows: [columns, ...records.map((r) => columns.map((c) => cell(r[c])))] };
}

/** Excel edge files. `workbook` is the same pinned writer the recipe's own file uses. */
export function xlsxEdges(columns: string[], rows: Record<string, unknown>[], w: WriteOptions): Edge[] {
    const sheet = dataSheet(columns, rows);
    const good = writeXlsx([sheet], w);
    const n = columns.length;
    const lastColumn = String.fromCharCode(64 + Math.min(n, 26));
    const numeric = columns.findIndex((c) => rows.some((r) => typeof r[c] === "number"));
    const out: Edge[] = [
        { file: "values.xlsx", kind: "plain", expect_valid: true, why: "plain values, the 1900 date system stated in the workbook", bytes: good },
        { file: "merged_cells.xlsx", kind: "merged", expect_valid: true, why: `the header row's cells merged across ${n} columns; the value stays in the first cell`, bytes: writeXlsx([{ name: "data", rows: [[`${columns[0]}`], ...sheet.rows], merges: [`A1:${lastColumn}1`] }], w) },
        { file: "wrong_extension.csv", kind: "extension", expect_valid: false, why: "a workbook named .csv", bytes: good },
        { file: "not_a_workbook.xlsx", kind: "extension", expect_valid: false, why: "CSV bytes named .xlsx", bytes: csvBytes(columns, rows, { bom: false }) },
        { file: "corrupted.xlsx", kind: "corrupted", expect_valid: false, why: "a workbook cut short: its zip directory is gone", bytes: good.subarray(0, Math.floor(good.length / 2)) },
    ];
    if (numeric >= 0) {
        const col = String.fromCharCode(65 + numeric);
        const withFormula = sheet.rows.map((r, i) => (i === 1 ? r.map((c, k) => (k === numeric ? { formula: `${col}3`, value: (sheet.rows[2]?.[numeric] ?? 0) as number } : c)) : r));
        out.push({ file: "formulas.xlsx", kind: "formula", expect_valid: true, why: `a formula in ${columns[numeric]}, with its worked-out value stored: a reader must choose formula or value`, bytes: writeXlsx([{ name: "data", rows: withFormula }], w) });
        out.push({ file: "formula_no_value.xlsx", kind: "formula", expect_valid: false, why: `a formula in ${columns[numeric]} with no stored value, as a generator writes it: nothing has worked it out`, bytes: writeXlsx([{ name: "data", rows: sheet.rows.map((r, i) => (i === 1 ? r.map((c, k) => (k === numeric ? { formula: `${col}3` } : c)) : r)) }], w) });
    }
    return out;
}
