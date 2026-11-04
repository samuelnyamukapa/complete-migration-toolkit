// Data files: CSV options and edge files, Excel from cmtk's own writer, fixed-width and EBCDIC records from a copybook,
// and semantic comparison. Golden values pin the bytes: the same recipe gives the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    compareTables, csvBytes, csvEdges, csvTable, decodeFile, decodeRecord, decodeText, describeComparison, encodePacked, encodeRecord, encodeText, FORMULA_LEADS, fixedEdges, loadManifest, loadRecipe,
    makeData, makeRows, parseCopybook, parseCsv, planRecipe, readTables, readXlsx, recordsTable, schemaOfLayout, scrubber, validate, writeXlsx, xlsxEdges, xlsxTables,
} from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "..", "cli", "dist", "main.js");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const SCHEMA = {
    type: "object", additionalProperties: false, required: ["code", "name", "price"],
    properties: { code: { type: "string", pattern: "^[A-Z]{3}$" }, name: { type: "string", minLength: 1, maxLength: 20 }, price: { type: "number", minimum: 0, maximum: 100, multipleOf: 0.01 }, kind: { type: "string", enum: ["Mug", "Cap"] } },
};
const COPYBOOK = `      * A CardDemo-style account record.
       01  ACCOUNT-RECORD.
           05  ACCT-ID                 PIC 9(11).
           05  ACCT-STATUS             PIC X(1).
           05  ACCT-NAME               PIC X(20).
           05  ACCT-BALANCE            PIC S9(10)V99 COMP-3.
           05  ACCT-LIMIT              PIC S9(7)V99.
           05  ACCT-OLD-LIMIT REDEFINES ACCT-LIMIT PIC X(9).
           05  ACCT-BIG                PIC S9(16)V99 COMP-3.
           05  ACCT-CYCLES             PIC 9(4) COMP.
           05  ACCT-TXN-COUNT          PIC 9(2).
           05  ACCT-TXN OCCURS 1 TO 3 TIMES DEPENDING ON ACCT-TXN-COUNT.
               10  TXN-CODE            PIC X(2).
               10  TXN-AMT             PIC S9(5)V99 COMP-3.
           05  FILLER                  PIC X(5).
`;

function project(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-files-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    fs.writeFileSync(path.join(dir, "item.json"), JSON.stringify(SCHEMA));
    fs.writeFileSync(path.join(dir, "ACCT.cpy"), COPYBOOK);
    for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")) };
}
const NOW = "2026-11-04T00:00:00Z";

// ---------------------------------------------------------------- CSV

test("CSV options in the recipe decide the bytes of every CSV: delimiter, header, BOM, line ending, quoting", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "item.json", id: "semi", csv: { delimiter: ";", bom: false, line_ending: "lf", quoted: true } });
    const { recipe } = loadRecipe(p.m(), "semi");
    assert.deepEqual(recipe.csv, { delimiter: ";", bom: false, line_ending: "lf", quoted: true });
    await makeData(p.m(), "semi", { formats: ["csv"], now: NOW });
    const text = fs.readFileSync(path.join(p.dir, "cmtk", "data", "semi", "rows.csv"));
    assert.notEqual(text[0], 0xef, "no BOM");
    const s = text.toString("utf8");
    assert.ok(s.startsWith('"row";"expect_valid";'), s.slice(0, 40));
    assert.ok(!s.includes("\r\n"));
    const none = csvBytes(["a", "b"], [{ a: 1, b: "x" }], { header: false, bom: false }).toString();
    assert.equal(none, "1,x\r\n");
    assert.deepEqual([...csvBytes(["a"], [], {})].slice(0, 3), [0xef, 0xbb, 0xbf], "a BOM by default, as before");
});

test("CSV edge files: every size, ending and encoding, and each OWASP injection character as a labelled negative", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "item.json", id: "item", csv: { max_rows: 5 } });
    const { manifest } = await makeData(p.m(), "item", { formats: ["edge-csv"], now: NOW });
    const names = manifest.edge_files.map((e) => e.file.split("/").pop());
    for (const n of ["empty.csv", "header_only.csv", "one_row.csv", "max_rows.csv", "max_rows_plus_one.csv", "crlf.csv", "lf.csv", "utf8_bom.csv", "utf8_no_bom.csv", "latin1.csv", "semicolons.csv"]) assert.ok(names.includes(n), n);
    const read = (n) => fs.readFileSync(path.join(p.dir, "cmtk", "data", "item", "edge", "csv", n));
    assert.equal(read("empty.csv").length, 0);
    assert.equal(parseCsv(read("header_only.csv").toString()).rows.length, 0);
    assert.ok(parseCsv(read("header_only.csv").toString()).header.length >= 3);
    assert.equal(parseCsv(read("one_row.csv").toString()).rows.length, 1);
    assert.equal(parseCsv(read("max_rows.csv").toString()).rows.length, 5);
    assert.equal(parseCsv(read("max_rows_plus_one.csv").toString()).rows.length, 6);
    assert.ok(read("crlf.csv").includes("\r\n"));
    assert.ok(!read("lf.csv").includes("\r\n"));
    assert.deepEqual([...read("utf8_bom.csv")].slice(0, 3), [0xef, 0xbb, 0xbf]);
    assert.notEqual(read("utf8_no_bom.csv")[0], 0xef);
    assert.ok(read("utf8_no_bom.csv").toString("utf8").includes("Ñandú"));
    assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(read("latin1.csv")), "Latin-1 is not UTF-8");
    assert.ok(read("latin1.csv").includes(0xd1), "the Latin-1 byte for Ñ");
    const edges = manifest.edge_files.filter((e) => e.kind === "csv-injection");
    assert.equal(edges.length, FORMULA_LEADS.length);
    for (const e of edges) assert.equal(e.expect_valid, false);
    for (const lead of ["=", "+", "-", "@", "\t", "\r", "\n"]) {
        assert.ok(edges.some((e) => { const rows = parseCsv(fs.readFileSync(path.join(p.dir, "cmtk", "data", "item", e.file), "utf8")); return rows.rows[0].some((c) => c.startsWith(lead)); }), JSON.stringify(lead));
    }
    assert.match(fs.readFileSync(path.join(p.dir, "cmtk", "data", "item", "DATA.md"), "utf8"), /## Edge files[\s\S]*injection_equals\.csv \| csv-injection \| no/);
});

test("golden: the same recipe gives the same CSV bytes, every time", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "item.json", id: "item", seed: 1, clock: "2026-01-15T09:30:00Z" });
    const a = await makeData(p.m(), "item", { formats: ["csv", "edge-csv"], now: NOW });
    const first = a.manifest.files;
    const b = await makeData(p.m(), "item", { formats: ["csv", "edge-csv"], now: "2027-01-01T00:00:00Z" });
    assert.deepEqual(b.manifest.files, first);
    assert.equal(first["rows.csv"], sha(fs.readFileSync(path.join(p.dir, "cmtk", "data", "item", "rows.csv"))));
});

test("golden files: these exact bytes, pinned, for CSV and for fixed-width records", async () => {
    const p = project({ "R.cpy": "01 R.\n   05 ID PIC 9(4).\n   05 NAME PIC X(6).\n   05 AMT PIC S9(5)V99 COMP-3.\n" });
    // Faker's version is pinned exactly in package.json: a new one may change these, and the test says so.
    planRecipe(p.m(), { schema: "item.json", id: "item", seed: 1, clock: "2026-01-15T09:30:00Z" });
    planRecipe(p.m(), { schema: "R.cpy", id: "r", seed: 1, clock: "2026-01-15T09:30:00Z" });
    assert.equal((await makeData(p.m(), "item", { formats: ["csv"], now: NOW })).manifest.files["rows.csv"], "ca267079298ffbe611016122ecaa52867f3fefc411445f5a9a0b57183f27cb56");
    assert.equal((await makeData(p.m(), "r", { formats: ["fixed"], now: NOW })).manifest.files["records.dat"], "9c28282959a208eb5131d811ee40161e1da0b8dc8ed7661f6b13cb594cb4fe3f");
    assert.equal(csvBytes(["a", "b"], [{ a: 1, b: "x,y" }]).toString("hex"), Buffer.from('\uFEFFa,b\r\n1,"x,y"\r\n', "utf8").toString("hex"));
    assert.equal(encodeRecord(parseCopybook("01 R.\n   05 ID PIC 9(4).\n   05 NAME PIC X(2).\n   05 AMT PIC S9(3)V99 COMP-3.\n"), { ID: 7, NAME: "AB", AMT: -1.5 }, "cp037").toString("hex"), "f0f0f0f7c1c200150d");
});

// ---------------------------------------------------------------- Excel

test("xlsx metadata is pinned to synthetic values, the 1900 date system is stated, and bytes repeat", () => {
    const w = { creator: "cmtk", created: "2026-01-15T09:30:00Z" };
    const a = writeXlsx([{ name: "s", rows: [["a"], [1]] }], w);
    const r = readXlsx(a);
    assert.equal(r.creator, "cmtk");
    assert.equal(r.modifiedBy, "cmtk");
    assert.equal(r.created, "2026-01-15T09:30:00Z");
    assert.equal(r.modified, "2026-01-15T09:30:00Z");
    assert.equal(r.date1904, false);
    assert.ok(a.equals(writeXlsx([{ name: "s", rows: [["a"], [1]] }], w)));
    assert.ok(!a.toString("latin1").includes(os.userInfo().username + "@"), "no user name");
});

test("the formula-versus-value choice: on writing, and on reading", () => {
    const hostile = writeXlsx([{ name: "s", rows: [["=1+1"]] }]);
    assert.equal(readXlsx(hostile).sheets[0].rows[0][0], "=1+1");
    assert.equal(readXlsx(hostile, { formulas: "formula" }).sheets[0].rows[0][0], "=1+1", "as text: stored as text");
    assert.match(hostile.toString("latin1"), /PK/);
    const live = writeXlsx([{ name: "s", rows: [["=1+1"]] }], { formulas: "formula" });
    assert.equal(readXlsx(live).sheets[0].rows[0][0], undefined, "no stored value, so no value to read");
    assert.equal(readXlsx(live, { formulas: "formula" }).sheets[0].rows[0][0], "=1+1");
    const cached = writeXlsx([{ name: "s", rows: [[{ formula: "B1*2", value: 4 }]] }]);
    assert.equal(readXlsx(cached).sheets[0].rows[0][0], 4);
    assert.equal(readXlsx(cached, { formulas: "formula" }).sheets[0].rows[0][0], "=B1*2");
});

test("Excel edge files: merged cells, formulas, wrong extension, corrupted", async () => {
    const edges = xlsxEdges(["a", "n"], [{ a: "x", n: 1 }, { a: "y", n: 2 }], { creator: "cmtk", created: "2026-01-15T09:30:00Z" });
    const by = (f) => edges.find((e) => e.file === f);
    assert.deepEqual(readXlsx(by("merged_cells.xlsx").bytes).sheets[0].merges, ["A1:B1"]);
    assert.equal(readXlsx(by("formulas.xlsx").bytes).sheets[0].rows[1][1], 2);
    assert.equal(readXlsx(by("formulas.xlsx").bytes, { formulas: "formula" }).sheets[0].rows[1][1], "=B3");
    assert.equal(readXlsx(by("formula_no_value.xlsx").bytes).sheets[0].rows[1][1], undefined);
    assert.equal(by("wrong_extension.csv").expect_valid, false);
    assert.equal(readXlsx(by("wrong_extension.csv").bytes).sheets[0].rows.length, 3, "still a workbook inside");
    assert.throws(() => readXlsx(by("not_a_workbook.xlsx").bytes), /not a zip/);
    assert.throws(() => readXlsx(by("corrupted.xlsx").bytes));
    const p = project();
    planRecipe(p.m(), { schema: "item.json", id: "item" });
    const { manifest } = await makeData(p.m(), "item", { formats: ["edge-xlsx", "xlsx"], now: NOW });
    assert.ok(manifest.edge_files.some((e) => e.file === "edge/xlsx/corrupted.xlsx" && !e.expect_valid));
});

test("the npm xlsx package is never used", () => {
    const root = path.join(HERE, "..", "..", "..");
    for (const f of ["packages/core/package.json", "packages/cli/package.json", "packages/mcp/package.json"]) {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
        assert.equal(pkg.dependencies?.xlsx, undefined, f);
    }
});

// ---------------------------------------------------------------- copybooks

test("a copybook reads to a layout: sizes by usage, OCCURS DEPENDING ON, FILLER, and a note for REDEFINES", () => {
    const l = parseCopybook(COPYBOOK, "ACCT.cpy");
    assert.equal(l.name, "ACCOUNT-RECORD");
    // 11 + 1 + 20 + 7 (COMP-3 of 12 digits) + 9 + 10 (COMP-3 of 18) + 2 (COMP) + 2 + 3 * (2 + 4) + 5
    assert.equal(l.record_size, 85);
    assert.deepEqual(l.counters, ["ACCT-TXN-COUNT"]);
    assert.match(l.notes[0], /ACCT-OLD-LIMIT REDEFINES ACCT-LIMIT/);
    assert.ok(!l.items.some((i) => i.name === "ACCT-OLD-LIMIT"));
    const s = schemaOfLayout(l);
    assert.equal(s.properties["ACCT-BIG"].type, "string", "too big for a number: kept as text");
    assert.equal(s.properties["ACCT-BALANCE"].type, "number");
    assert.equal(s.properties["ACCT-ID"].maximum, 99999999999);
    assert.equal(s.properties["ACCT-TXN"].maxItems, 3);
    assert.equal(s.properties["ACCT-TXN-COUNT"], undefined, "a counter is set from the array");
    assert.throws(() => parseCopybook("01 A PIC Z(3)."), /not supported/);
    assert.throws(() => parseCopybook("01 A PIC S9(4) COMP-1."), /floating-point/);
    assert.throws(() => parseCopybook("* nothing\n"), /no data descriptions/);
});

const VALUE = { "ACCT-ID": 42, "ACCT-STATUS": "Y", "ACCT-NAME": "Ann", "ACCT-BALANCE": -1234.5, "ACCT-LIMIT": 500, "ACCT-BIG": "1234567890123456.78", "ACCT-CYCLES": 12, "ACCT-TXN": [{ "TXN-CODE": "AB", "TXN-AMT": 1.25 }, { "TXN-CODE": "CD", "TXN-AMT": -2 }] };

test("records encode and decode in EBCDIC and ASCII, exactly, with money as text", () => {
    const l = parseCopybook(COPYBOOK);
    for (const enc of ["cp037", "ascii"]) {
        const b = encodeRecord(l, VALUE, enc);
        assert.equal(b.length, l.record_size);
        const { value, problems } = decodeRecord(l, b, enc);
        assert.deepEqual(problems, []);
        assert.equal(value["ACCT-ID"], "00000000042".replace(/^0+/, "") || "0");
        assert.equal(value["ACCT-NAME"], "Ann");
        assert.equal(value["ACCT-BALANCE"], "-1234.50");
        assert.equal(value["ACCT-LIMIT"], "500.00");
        assert.equal(value["ACCT-BIG"], "1234567890123456.78", "beyond what a number holds");
        assert.equal(value["ACCT-TXN-COUNT"], "2", "set from the array's length");
        assert.deepEqual(value["ACCT-TXN"], [{ "TXN-CODE": "AB", "TXN-AMT": "1.25" }, { "TXN-CODE": "CD", "TXN-AMT": "-2.00" }]);
    }
});

test("code page 037: known bytes, and a character it can't hold is refused", () => {
    assert.equal(encodeText("HELLO 123", "cp037").toString("hex"), "c8c5d3d3d640f1f2f3");
    assert.equal(decodeText(Buffer.from("c8c5d3d3d640f1f2f3", "hex"), "cp037"), "HELLO 123");
    assert.throws(() => encodeText("😀", "cp037"), /not in code page 037/);
    assert.throws(() => encodeText("é", "ascii"), /not in ASCII/);
});

test("zoned and packed signs, byte for byte", () => {
    assert.equal(encodePacked(-12345n, 5, true).toString("hex"), "12345d");
    assert.equal(encodePacked(12345n, 5, true).toString("hex"), "12345c");
    assert.equal(encodePacked(12345n, 5, false).toString("hex"), "12345f");
    const l = parseCopybook("01 R.\n   05 A PIC S9(3).\n   05 B PIC S9(3) SIGN LEADING SEPARATE.\n");
    assert.equal(encodeRecord(l, { A: -123, B: -7 }, "cp037").toString("hex"), "f1f2d3" + "60f0f0f7");
    assert.equal(encodeRecord(l, { A: 123, B: 7 }, "ascii").toString("latin1"), "12C+007");
    assert.equal(decodeRecord(l, Buffer.from("12L+007", "latin1"), "ascii").value.A, "-123");
});

test("a value that can't fit is refused, never truncated", () => {
    const l = parseCopybook("01 R.\n   05 A PIC X(2).\n   05 B PIC 9(2).\n");
    assert.throws(() => encodeRecord(l, { A: "toolong", B: 1 }, "ascii"), /do not fit/);
    assert.throws(() => encodeRecord(l, { A: "a", B: 100 }, "ascii"), /does not fit/);
    assert.throws(() => encodeRecord(l, { A: "a", B: -1 }, "ascii"), /no sign/);
    assert.throws(() => encodeRecord(l, { A: "a", B: 1.5 }, "ascii"), /decimal places/);
});

test("a recipe from a copybook takes the same boundaries and negatives, and writes records that pass their self-check", async () => {
    const p = project();
    const { recipe } = planRecipe(p.m(), { schema: "ACCT.cpy", id: "acct", seed: 3, recordEncoding: "cp037" });
    assert.equal(recipe.fixed.encoding, "cp037");
    assert.ok(recipe.notes.some((n) => /REDEFINES/.test(n)));
    assert.ok(recipe.notes.some((n) => /A record is 85 bytes/.test(n)));
    assert.ok(recipe.rows.some((r) => r.technique === "BVA-3" && r.name.startsWith("ACCT_BALANCE_maximum")));
    assert.ok(recipe.rows.some((r) => r.name === "ACCT_NAME_hostile_emoji"));
    const { manifest } = await makeData(p.m(), "acct", { formats: ["fixed", "edge-fixed"], now: NOW });
    const dat = fs.readFileSync(path.join(p.dir, "cmtk", "data", "acct", "records.dat"));
    assert.equal(dat.length % 85, 0, "the file length is a multiple of the record size");
    assert.equal(dat.length / 85, manifest.fixed.records);
    assert.ok(manifest.fixed.records > 5);
    assert.ok(manifest.fixed.left_out.some((x) => x.row === "ACCT_NAME_hostile_emoji" && /code page 037/.test(x.why)), "an emoji can't be held, and that is written down");
    const l = parseCopybook(COPYBOOK);
    const back = decodeFile(l, dat, "cp037");
    assert.deepEqual(back.problems, []);
    assert.ok(back.records.every((r) => /^-?\d+\.\d{2}$/.test(r["ACCT-BALANCE"])));
    const again = await makeData(p.m(), "acct", { formats: ["fixed", "edge-fixed"], now: "2030-01-01T00:00:00Z" });
    assert.deepEqual(again.manifest.files, manifest.files, "golden: the same recipe gives the same bytes");
    assert.ok(recipe.rows.some((r) => r.name === "ACCT_TXN_each_TXN_AMT_maximum_above_3bva" && r.invalid_because.path === "$.ACCT-TXN[0].TXN-AMT"), "an element's boundaries are tried on its first element");
    assert.equal(validate({ type: "string" }, "a").length, 0);
});

test("edge records: sign nibbles, OCCURS DEPENDING ON out of range, a truncated file", () => {
    const l = parseCopybook(COPYBOOK);
    const edges = fixedEdges(l, VALUE, "cp037");
    const read = (f) => { const e = edges.find((x) => x.file === f); assert.ok(e, f); return { e, r: decodeFile(l, e.bytes, "cp037") }; };
    assert.deepEqual(read("empty.dat").r, { records: [], problems: [] });
    assert.match(read("truncated.dat").r.problems[0], /not a multiple of the record size 85/);
    assert.equal(read("ACCT-BALANCE_sign_c.dat").r.records[0]["ACCT-BALANCE"], "1234.50");
    assert.equal(read("ACCT-BALANCE_sign_d.dat").r.records[0]["ACCT-BALANCE"], "-1234.50");
    assert.equal(read("ACCT-BALANCE_sign_f.dat").r.records[0]["ACCT-BALANCE"], "1234.50");
    assert.equal(read("ACCT-BALANCE_sign_a.dat").r.problems.length, 0, "an alternate plus is legal");
    assert.match(read("ACCT-BALANCE_sign_invalid.dat").r.problems[0], /sign nibble 0x5/);
    assert.equal(read("ACCT-BALANCE_sign_invalid.dat").e.expect_valid, false);
    assert.match(read("ACCT-LIMIT_sign_invalid.dat").r.problems[0], /sign byte/);
    assert.match(read("ACCT-TXN_depending_above_max.dat").r.problems[0], /OCCURS DEPENDING ON ACCT-TXN-COUNT is 4, outside 1 to 3/);
    assert.match(read("ACCT-TXN_depending_below_min.dat").r.problems[0], /is 0, outside 1 to 3/);
});

test("a recipe that isn't from a copybook has no fixed-width records", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "item.json", id: "item" });
    await assert.rejects(makeData(p.m(), "item", { formats: ["fixed"], now: NOW }), /did not come from a copybook/);
});

// ---------------------------------------------------------------- semantic comparison

const t = (csv) => [csvTable(csv)];

test("CSV by key: order, quoting, line endings and BOM don't matter; a real difference does", () => {
    const a = "id,name,price\r\n1,Ann,5\r\n2,Bob,6\r\n";
    const b = '﻿"id","name","price"\n"2","Bob","6"\n"1","Ann","5"\n';
    assert.equal(compareTables(t(a), t(b), { key: ["id"] }).same, true);
    const c = compareTables(t(a), t("id,name,price\n1,Ann,5\n2,Rob,6\n"), { key: ["id"] });
    assert.equal(c.same, false);
    assert.deepEqual(c.differences, [{ table: "csv", key: "2", column: "name", a: "Bob", b: "Rob" }]);
    assert.ok(describeComparison(c).some((l) => /row 2, name: "Bob" vs "Rob"/.test(l)));
});

test("in a CSV, null, empty and absent fold into one; a value against any of them is still a difference", () => {
    const withEmpty = "id,note,price\n1,,5\n";
    const absentColumn = "id,price\n1,5\n";
    const shortRow = "id,price,note\n1,5\n";
    assert.equal(compareTables(t(withEmpty), t(absentColumn), { key: ["id"] }).same, true);
    assert.equal(compareTables(t(withEmpty), t(shortRow), { key: ["id"] }).same, true);
    assert.equal(compareTables(t(withEmpty), t("id,note,price\n1,hello,5\n"), { key: ["id"] }).same, false);
    const only = compareTables(t("id,note\n1,hello\n"), t("id\n1\n"), { key: ["id"] });
    assert.deepEqual(only.columns_only_in_a, [{ table: "csv", column: "note" }], "a column that holds something is a difference");
    assert.equal(compareTables(t(withEmpty), t(absentColumn), { key: ["id"], fold_empty: false }).same, false, "and folding can be turned off");
});

test("numbers: 5, 5.0 and 5.00 are equal, an epsilon is honoured, and 007 is an identifier, not 7", () => {
    assert.equal(compareTables(t("id,n\n1,5\n"), t("id,n\n1,5.00\n"), { key: ["id"] }).same, true);
    assert.equal(compareTables(t("id,n\n1,5.001\n"), t("id,n\n1,5.002\n"), { key: ["id"] }).same, false);
    assert.equal(compareTables(t("id,n\n1,5.001\n"), t("id,n\n1,5.002\n"), { key: ["id"], epsilon: 0.01 }).same, true);
    assert.equal(compareTables(t("id,n\n1,007\n"), t("id,n\n1,7\n"), { key: ["id"] }).same, false);
    assert.equal(compareTables(t("id,n\n1,1e3\n"), t("id,n\n1,1000\n"), { key: ["id"] }).same, true);
});

test("rows missing either way and repeated keys are differences; no key is refused", () => {
    const c = compareTables(t("id\n1\n2\n2\n"), t("id\n1\n3\n"), { key: ["id"] });
    assert.deepEqual(c.only_in_a, [{ table: "csv", key: "2" }]);
    assert.deepEqual(c.only_in_b, [{ table: "csv", key: "3" }]);
    assert.deepEqual(c.duplicate_keys, [{ table: "csv", side: "a", key: "2" }]);
    assert.equal(c.same, false);
    assert.throws(() => compareTables(t("id\n1\n"), t("id\n1\n"), { key: [] }), /Name the key column/);
    assert.throws(() => compareTables(t("id\n1\n"), t("id\n1\n"), { key: ["nope"] }), /key column nope is not in/);
});

test("the scrubber: dates and GUIDs become counters, so a repeat still has to repeat", () => {
    const s = scrubber(["dates", "guids"]);
    assert.equal(s("at 2026-11-04T10:00:00Z and 2026-11-05"), "at DATE_1 and DATE_2");
    assert.equal(s("again 2026-11-04T10:00:00Z"), "again DATE_1");
    assert.equal(s("3f2504e0-4f89-11d3-9a0c-0305e82c3301 3F2504E0-4F89-11D3-9A0C-0305E82C3301"), "GUID_1 GUID_1");
    assert.equal(scrubber(["guids"])("2026-11-04"), "2026-11-04");
    const a = "id,when,parent\n1,2026-01-01,3f2504e0-4f89-11d3-9a0c-0305e82c3301\n2,2026-01-01,3f2504e0-4f89-11d3-9a0c-0305e82c3301\n";
    const later = "id,when,parent\n1,2027-05-05,aaaaaaaa-4f89-11d3-9a0c-0305e82c3301\n2,2027-05-05,aaaaaaaa-4f89-11d3-9a0c-0305e82c3301\n";
    const crossed = "id,when,parent\n1,2027-05-05,aaaaaaaa-4f89-11d3-9a0c-0305e82c3301\n2,2027-05-06,bbbbbbbb-4f89-11d3-9a0c-0305e82c3301\n";
    assert.equal(compareTables(t(a), t(later), { key: ["id"] }).same, false, "unscrubbed they differ");
    assert.equal(compareTables(t(a), t(later), { key: ["id"], scrub: ["dates", "guids"] }).same, true);
    assert.equal(compareTables(t(a), t(crossed), { key: ["id"], scrub: ["dates", "guids"] }).same, false, "row 2 no longer repeats row 1's values");
});

test("xlsx per sheet by key, with a numeric epsilon and a formula-or-value choice", () => {
    const wb = (rows, extra = []) => writeXlsx([{ name: "lines", rows }, ...extra]);
    const a = xlsxTables(wb([["id", "amt"], [1, 2.5], [2, 3]]));
    assert.equal(compareTables(a, xlsxTables(wb([["id", "amt"], [2, 3.0], [1, 2.50001]])), { key: ["id"], epsilon: 0.001 }).same, true);
    assert.equal(compareTables(a, xlsxTables(wb([["id", "amt"], [2, 3], [1, 2.6]])), { key: ["id"], epsilon: 0.001 }).same, false);
    const extra = compareTables(a, xlsxTables(wb([["id", "amt"], [1, 2.5], [2, 3]], [{ name: "more", rows: [["id"], [1]] }])), { key: ["id"] });
    assert.deepEqual(extra.tables_only_in_b, ["more"]);
    assert.equal(extra.same, false);
    const f1 = writeXlsx([{ name: "s", rows: [["id", "v"], [1, { formula: "1+1", value: 2 }]] }]);
    const v1 = writeXlsx([{ name: "s", rows: [["id", "v"], [1, 2]] }]);
    assert.equal(compareTables(xlsxTables(f1), xlsxTables(v1), { key: ["id"] }).same, true, "by value they agree");
    assert.equal(compareTables(xlsxTables(f1, "formula"), xlsxTables(v1, "formula"), { key: ["id"] }).same, false, "by formula they don't");
});

test("fixed-width by decoded records: different encodings of the same data compare the same; a problem record never does", () => {
    const l = parseCopybook(COPYBOOK);
    const rec = (over, enc) => encodeRecord(l, { ...VALUE, ...over }, enc);
    const tab = (b, enc) => { const d = decodeFile(l, b, enc); return [recordsTable(d.records, "records", d.problems)]; };
    const ebc = Buffer.concat([rec({ "ACCT-ID": 1 }, "cp037"), rec({ "ACCT-ID": 2 }, "cp037")]);
    const asc = Buffer.concat([rec({ "ACCT-ID": 2 }, "ascii"), rec({ "ACCT-ID": 1 }, "ascii")]);
    assert.ok(!ebc.equals(asc));
    assert.equal(compareTables(tab(ebc, "cp037"), tab(asc, "ascii"), { key: ["ACCT-ID"] }).same, true);
    const off = Buffer.concat([rec({ "ACCT-ID": 1 }, "ascii"), rec({ "ACCT-ID": 2, "ACCT-BALANCE": -1234.51 }, "ascii")]);
    assert.deepEqual(compareTables(tab(ebc, "cp037"), tab(off, "ascii"), { key: ["ACCT-ID"] }).differences.map((d) => [d.column, d.a, d.b]), [["ACCT-BALANCE", "-1234.50", "-1234.51"]]);
    const bad = compareTables(tab(ebc, "cp037"), tab(ebc.subarray(0, 100), "cp037"), { key: ["ACCT-ID"] });
    assert.equal(bad.same, false);
    assert.match(bad.problems[0], /not a multiple/);
});

test("the real command: cmtk data diff by key, on CSV and xlsx; exit 0 the same, 1 different, never by bytes", () => {
    const p = project({ "a.csv": "id,n\n1,5\n", "b.csv": '"id","n"\r\n"1","5.0"\r\n', "c.csv": "id,n\n1,6\n" });
    fs.writeFileSync(path.join(p.dir, "a.xlsx"), writeXlsx([{ name: "s", rows: [["id"], [1]] }]));
    fs.writeFileSync(path.join(p.dir, "b.xlsx"), writeXlsx([{ name: "s", rows: [["id"], [1]] }], { created: "2030-01-01T00:00:00Z" }));
    const cmtk = (...a) => spawnSync(process.execPath, [CLI, "data", "diff", ...a], { cwd: p.dir, encoding: "utf8" });
    let r = cmtk("a.csv", "b.csv", "--key", "id");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /The same: 1 rows compared by key/);
    r = cmtk("a.csv", "c.csv", "--key", "id");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /row 1, n: "5" vs "6"/);
    assert.equal(cmtk("a.xlsx", "b.xlsx", "--key", "id").status, 0);
    r = cmtk("a.csv", "b.csv");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Name the key column/);
    assert.equal(cmtk("a.csv", "a.txt", "--key", "id").status, 3);
});

test("the real command: plan and make from a copybook, then diff the records against themselves", () => {
    const p = project();
    const cmtk = (...a) => spawnSync(process.execPath, [CLI, "data", ...a], { cwd: p.dir, encoding: "utf8" });
    let r = cmtk("plan", "--schema", "ACCT.cpy", "--id", "acct", "--record-encoding", "ascii");
    assert.equal(r.status, 0, r.stderr);
    r = cmtk("make", "acct", "--format", "json,fixed");
    assert.match(r.stdout, /fixed-width records of 85 bytes in ascii/);
    r = cmtk("diff", "cmtk/data/acct/records.dat", "cmtk/data/acct/records.dat", "--as", "fixed", "--copybook", "ACCT.cpy", "--record-encoding", "ascii", "--key", "ACCT-ID,ACCT-NAME,ACCT-BALANCE,ACCT-LIMIT,ACCT-BIG,ACCT-CYCLES,ACCT-STATUS");
    assert.ok(r.stdout.startsWith("The same") || /used twice/.test(r.stdout), r.stdout + r.stderr);
    assert.equal(readTables(path.join(p.dir, "cmtk/data/acct/records.dat"), { copybook: path.join(p.dir, "ACCT.cpy"), record_encoding: "ascii" }).length, 1);
    assert.equal(csvEdges(["a"], [{ a: "x" }]).length > 10, true);
});

test("eShop's customisation-row schema makes a CSV import file, and its edge files, from a recipe", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-files-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    fs.copyFileSync(path.join(HERE, "..", "..", "..", "examples", "eshop-pilot", "tester", "cmtk", "data", "schemas", "customisation-row.json"), path.join(dir, "row.json"));
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    planRecipe(m, { schema: "row.json", id: "items", csv: { max_rows: 10 } });
    const rows = makeRows(m, loadRecipe(m, "items").recipe);
    assert.ok(rows.length > 20);
    const { manifest } = await makeData(m, "items", { formats: ["csv", "edge-csv"], now: NOW });
    assert.ok(manifest.edge_files.length > 15);
    const one = parseCsv(fs.readFileSync(path.join(dir, "cmtk", "data", "items", "edge", "csv", "one_row.csv"), "utf8"));
    assert.ok(one.header.includes("catalogtypename") && one.header.includes("pictureFileName"));
});
