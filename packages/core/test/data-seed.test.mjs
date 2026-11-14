// Seeding both systems from one artefact, offline: the catalogue from a DDL script, virtual keys, load order with
// cycle deferral, one script, and control totals. The script really is loaded here, into two SQLite databases with
// foreign keys on, as a stand-in for SQL Server: that proves the order and the rows, not T-SQL. See seed-mssql.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { applyVirtualKeys, buildSeed, compareTables, csvTable, expectedTotals, loadManifest, loadOrder, parseDdl, parseCsv, writeSeed } from "../dist/index.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "dist", "main.js");

// A schema with a cycle (Customer and Account refer to each other), a self-reference, and an undeclared key.
export const DDL = `
-- A legacy schema, as SSMS scripts one.
SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Brand](
    [Id] [int] IDENTITY(1,1) NOT NULL,
    [Code] [varchar](6) NOT NULL,
    [Name] [nvarchar](50) NOT NULL,
    CONSTRAINT [PK_Brand] PRIMARY KEY CLUSTERED ([Id] ASC)
) ON [PRIMARY]
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_Brand_Code] ON [dbo].[Brand] ([Code] ASC)
GO
CREATE TABLE dbo.Item (
    Id int NOT NULL PRIMARY KEY,
    Sku varchar(10) NOT NULL UNIQUE,
    BrandCode varchar(6) NOT NULL, /* joins to Brand.Code, but nobody ever declared it */
    Price decimal(9,2) NOT NULL CHECK (Price >= 0),
    Stock smallint NOT NULL,
    MaxStock smallint NOT NULL,
    Kind varchar(10) NOT NULL,
    Note nvarchar(200) NULL,
    Added datetime2(0) NOT NULL,
    Total AS (Price * Stock),
    Stamp rowversion,
    Active bit NOT NULL,
    Token uniqueidentifier NOT NULL,
    CONSTRAINT CK_Item_Kind CHECK (Kind IN ('Mug', 'Cap', 'O''Neill')),
    CONSTRAINT CK_Item_Stock CHECK (Stock >= 0 AND Stock <= 500),
    CONSTRAINT CK_Item_Max CHECK (MaxStock >= Stock)
);
GO
CREATE TABLE dbo.Customer (
    Id int IDENTITY(1,1) NOT NULL,
    Name nvarchar(30) NOT NULL,
    MainAccountId int NULL,
    ReferredBy int NULL,
    CONSTRAINT PK_Customer PRIMARY KEY (Id)
);
CREATE TABLE dbo.Account (
    Id int IDENTITY(1,1) NOT NULL,
    CustomerId int NOT NULL,
    Balance money NOT NULL,
    CONSTRAINT PK_Account PRIMARY KEY (Id),
    CONSTRAINT FK_Account_Customer FOREIGN KEY (CustomerId) REFERENCES dbo.Customer (Id)
);
GO
ALTER TABLE [dbo].[Customer] WITH CHECK ADD CONSTRAINT [FK_Customer_Account] FOREIGN KEY([MainAccountId]) REFERENCES [dbo].[Account] ([Id])
GO
ALTER TABLE dbo.Customer ADD CONSTRAINT FK_Customer_Self FOREIGN KEY (ReferredBy) REFERENCES dbo.Customer (Id);
ALTER TABLE dbo.Customer CHECK CONSTRAINT FK_Customer_Account;
GO
CREATE TABLE dbo.OrderLine (
    OrderNo int NOT NULL,
    LineNo smallint NOT NULL,
    ItemId int NOT NULL REFERENCES dbo.Item(Id),
    CONSTRAINT PK_OrderLine PRIMARY KEY (OrderNo, LineNo)
);
`;
// The same tables for SQLite, with the same keys enforced.
const SQLITE = `
CREATE TABLE "dbo.Brand" (Id INTEGER PRIMARY KEY, Code TEXT NOT NULL UNIQUE, Name TEXT NOT NULL);
CREATE TABLE "dbo.Item" (Id INTEGER PRIMARY KEY, Sku TEXT NOT NULL UNIQUE, BrandCode TEXT NOT NULL REFERENCES "dbo.Brand"(Code), Price NUMERIC NOT NULL CHECK (Price >= 0), Stock INTEGER NOT NULL CHECK (Stock >= 0 AND Stock <= 500), MaxStock INTEGER NOT NULL, Kind TEXT NOT NULL CHECK (Kind IN ('Mug','Cap','O''Neill')), Note TEXT, Added TEXT NOT NULL, Active INTEGER NOT NULL, Token TEXT NOT NULL, CHECK (MaxStock >= Stock));
CREATE TABLE "dbo.Customer" (Id INTEGER PRIMARY KEY, Name TEXT NOT NULL, MainAccountId INTEGER REFERENCES "dbo.Account"(Id), ReferredBy INTEGER REFERENCES "dbo.Customer"(Id));
CREATE TABLE "dbo.Account" (Id INTEGER PRIMARY KEY, CustomerId INTEGER NOT NULL REFERENCES "dbo.Customer"(Id), Balance NUMERIC NOT NULL);
CREATE TABLE "dbo.OrderLine" (OrderNo INTEGER NOT NULL, LineNo INTEGER NOT NULL, ItemId INTEGER NOT NULL REFERENCES "dbo.Item"(Id), PRIMARY KEY (OrderNo, LineNo));
`;
const VIRTUAL = `virtual_keys:\n  - { table: dbo.Item, columns: [BrandCode], references: { table: dbo.Brand, columns: [Code] }, reason: "the application joins on it" }\n`;

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-seed-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    fs.writeFileSync(path.join(dir, "schema.sql"), DDL);
    fs.writeFileSync(path.join(dir, "keys.yaml"), VIRTUAL);
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")) };
}

/** T-SQL's few differences, for SQLite: what is checked is the order and the rows. */
function asSqlite(sql) {
    return sql.replace(/^SET .*$/gm, "").replace(/BEGIN TRANSACTION;/g, "BEGIN;").replace(/COMMIT TRANSACTION;/g, "COMMIT;")
        .replace(/\bN'/g, "'").replace(/\[dbo\]\.\[(\w+)\]/g, '"dbo.$1"').replace(/\bdecimal\(38,6\)/g, "REAL").replace(/varchar\(50\)/g, "TEXT");
}
function loaded(script) {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SQLITE);
    db.exec(asSqlite(script));
    return db;
}

test("the catalogue from a DDL script: columns, widths, nullability, identity, computed, keys, checks, unique indexes", () => {
    const c = parseDdl(DDL);
    assert.deepEqual(c.tables.map((t) => t.name), ["dbo.Account", "dbo.Brand", "dbo.Customer", "dbo.Item", "dbo.OrderLine"]);
    const t = (n) => c.tables.find((x) => x.name === n);
    const col = (n, k) => t(n).columns.find((x) => x.name === k);
    assert.deepEqual([col("dbo.Brand", "Id").identity, col("dbo.Brand", "Id").nullable], [true, false]);
    assert.equal(col("dbo.Brand", "Code").length, 6);
    assert.deepEqual([col("dbo.Item", "Price").precision, col("dbo.Item", "Price").scale], [9, 2]);
    assert.equal(col("dbo.Item", "Note").nullable, true);
    assert.equal(col("dbo.Item", "Total").computed, true);
    assert.equal(col("dbo.Item", "Added").type, "datetime2");
    assert.deepEqual(t("dbo.Brand").uniques, [["Code"]]);
    assert.deepEqual(t("dbo.Item").uniques, [["Sku"]]);
    assert.deepEqual(t("dbo.OrderLine").primary_key, ["OrderNo", "LineNo"]);
    assert.equal(t("dbo.Item").checks.length, 4);
    assert.deepEqual(t("dbo.Account").foreign_keys[0], { name: "FK_Account_Customer", columns: ["CustomerId"], ref_table: "dbo.Customer", ref_columns: ["Id"] });
    assert.equal(t("dbo.Customer").foreign_keys.length, 2);
    assert.deepEqual(t("dbo.OrderLine").foreign_keys[0].ref_columns, ["Id"]);
    assert.throws(() => parseDdl("SELECT 1"), /no CREATE TABLE/);
});

test("comments and strings don't fool the reader, and a key to a table not in the script is noted", () => {
    const c = parseDdl(`CREATE TABLE a (id int PRIMARY KEY, -- CHECK (nonsense >= 1)\n  [odd;name] varchar(5) NULL, s varchar(9) NOT NULL DEFAULT 'x;y', b int REFERENCES other(id));`);
    const t = c.tables[0];
    assert.deepEqual(t.columns.map((x) => x.name), ["id", "odd;name", "s", "b"]);
    assert.equal(t.columns[2].has_default, true);
    assert.equal(t.checks.length, 0);
    assert.equal(t.foreign_keys.length, 0);
    assert.match(c.notes[0], /dbo\.other/);
    assert.deepEqual(parseDdl("CREATE TABLE sales.t (a int)").tables[0].name, "sales.t");
});

test("virtual keys: they join the graph, each with its reason, and each names real columns", () => {
    const c = parseDdl(DDL);
    const k = { table: "dbo.Item", columns: ["BrandCode"], references: { table: "dbo.Brand", columns: ["Code"] }, reason: "joined in code" };
    assert.throws(() => applyVirtualKeys(parseDdl(DDL), [{ ...k, reason: "" }]), /needs a reason/);
    assert.throws(() => applyVirtualKeys(parseDdl(DDL), [{ ...k, table: "dbo.Nope" }]), /no table dbo\.Nope/);
    assert.throws(() => applyVirtualKeys(parseDdl(DDL), [{ ...k, columns: ["Nope"] }]), /no column Nope/);
    assert.throws(() => applyVirtualKeys(parseDdl(DDL), [{ ...k, columns: ["BrandCode", "Sku"] }]), /2 columns can't refer to 1/);
    applyVirtualKeys(c, [k]);
    assert.equal(c.tables.find((t) => t.name === "dbo.Item").foreign_keys[0].virtual, "joined in code");
    const o = loadOrder(c);
    assert.ok(o.order.indexOf("dbo.Brand") < o.order.indexOf("dbo.Item"), "the undeclared key still orders the load");
});

test("load order: parents first, a cycle broken by deferring its nullable key, a self-reference deferred", () => {
    const o = loadOrder(parseDdl(DDL));
    assert.ok(o.order.indexOf("dbo.Customer") < o.order.indexOf("dbo.Account"));
    assert.ok(o.order.indexOf("dbo.Item") < o.order.indexOf("dbo.OrderLine"));
    assert.deepEqual(o.deferred.map((d) => `${d.table}.${d.key.columns[0]}`).sort(), ["dbo.Customer.MainAccountId", "dbo.Customer.ReferredBy"]);
    assert.deepEqual(loadOrder(parseDdl(DDL)), o, "the same catalogue gives the same order");
});

test("a cycle with no nullable key is refused, and so is a required self-reference", () => {
    const cycle = "CREATE TABLE a (id int PRIMARY KEY, b int NOT NULL REFERENCES b(id)); CREATE TABLE b (id int PRIMARY KEY, a int NOT NULL REFERENCES a(id));";
    assert.throws(() => loadOrder(parseDdl(cycle)), /no key among them can be null[\s\S]*dbo\.a, dbo\.b/);
    assert.throws(() => loadOrder(parseDdl("CREATE TABLE t (id int PRIMARY KEY, p int NOT NULL REFERENCES t(id));")), /refers to its own table and can't be null/);
});

test("the script really loads, with foreign keys on, on two databases; the cycle closes; and both hold the same rows", () => {
    const p = project();
    const { result, manifest } = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", seed: 7, rows: 12 });
    const a = loaded(result.script), b = loaded(result.script);
    for (const t of manifest.load_order) {
        const q = `SELECT * FROM "${t}" ORDER BY 1, 2`;
        const ra = a.prepare(q).all();
        assert.equal(ra.length, 12, t);
        assert.deepEqual(ra, b.prepare(q).all(), t);
    }
    assert.deepEqual(a.prepare("PRAGMA foreign_key_check").all(), [], "every key resolves, the virtual one included");
    const closed = a.prepare('SELECT COUNT(*) AS n FROM "dbo.Customer" WHERE MainAccountId IS NOT NULL').get().n;
    assert.equal(closed, 11, "the deferred key was set by the UPDATEs; the last row stays null");
    assert.equal(a.prepare('SELECT COUNT(*) AS n FROM "dbo.Customer" WHERE ReferredBy IS NOT NULL').get().n, 11);
    assert.match(result.script, /SET IDENTITY_INSERT \[dbo\]\.\[Brand\] ON;/);
    assert.ok(!/\bTotal\b|\bStamp\b/.test(result.script), "computed and rowversion columns are never written");
    assert.match(result.script, /Deferred keys/);
    assert.ok(result.script.indexOf("COMMIT TRANSACTION") > result.script.indexOf("UPDATE [dbo].[Customer]"));
});

test("constraints hold in the rows: widths, checks, uniqueness, and rows on purpose at the edges", () => {
    const p = project();
    const { result } = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", rows: 8 });
    const rows = (t) => result.rows.get(t);
    for (const r of rows("dbo.Item")) {
        assert.ok(r.get("Sku").text.length <= 10);
        assert.ok(["Mug", "Cap", "O'Neill"].includes(r.get("Kind").text));
        assert.ok(Number(r.get("Stock").text) >= 0 && Number(r.get("Stock").text) <= 500);
        assert.ok(Number(r.get("MaxStock").text) >= Number(r.get("Stock").text));
        assert.ok(Number(r.get("Price").text) >= 0);
        assert.equal(result.rows.get("dbo.Brand").some((b) => b.get("Code").text === r.get("BrandCode").text), true);
    }
    assert.equal(new Set(rows("dbo.Item").map((r) => r.get("Sku").text)).size, 8);
    assert.equal(new Set(rows("dbo.Brand").map((r) => r.get("Code").text)).size, 8);
    assert.ok(rows("dbo.Brand").some((r) => r.get("Name").text === "W".repeat(50)), "one row fills the column, for a truncation on the other side");
    assert.ok(rows("dbo.Brand").some((r) => r.get("Name").text === "Ñandú café"));
    assert.ok(rows("dbo.Item").some((r) => r.get("Price").text === "9999999.99"), "the column's largest value");
    assert.match(result.script, /N'Ñandú café'/);
    assert.match(result.script, /'O''Neill'/, "a quote is doubled");
    assert.ok(rows("dbo.Item").some((r) => r.get("Added").text.startsWith("2024-02-29")), "a leap day");
    assert.equal(rows("dbo.Item")[7].get("Note").text, null, "a nullable column is null on one row");
});

test("the shapes SSMS writes a check in: extra parentheses, BETWEEN, and LEN", () => {
    const c = buildSeed(parseDdl("CREATE TABLE t (id int PRIMARY KEY, a int NOT NULL, b int NOT NULL, s varchar(9) NOT NULL, CONSTRAINT c1 CHECK (([a]>=(10) AND [a]<(20))), CONSTRAINT c2 CHECK (b BETWEEN 3 AND 4), CONSTRAINT c3 CHECK (LEN(s) >= 2));"), { rows: 8 });
    assert.deepEqual(c.notes, []);
    for (const r of c.rows.get("dbo.t")) {
        assert.ok(Number(r.get("a").text) >= 10 && Number(r.get("a").text) < 20, r.get("a").text);
        assert.ok(Number(r.get("b").text) >= 3 && Number(r.get("b").text) <= 4, r.get("b").text);
        assert.ok(r.get("s").text.length >= 2);
    }
});

test("a check it can't read is noted; a type it can't make, on a required column, is refused", () => {
    const c = buildSeed(parseDdl("CREATE TABLE t (id int PRIMARY KEY, a int NOT NULL CHECK (a % 2 = 0));"), { rows: 2 });
    assert.ok(c.notes.some((n) => /the check a % 2 = 0 was not understood/.test(n)));
    assert.throws(() => buildSeed(parseDdl("CREATE TABLE t (id int PRIMARY KEY, g geography NOT NULL);"), { rows: 1 }), /can't make a geography/);
    const ok = buildSeed(parseDdl("CREATE TABLE t (id int PRIMARY KEY, g geography NULL);"), { rows: 1 });
    assert.ok(ok.notes.some((n) => /left null/.test(n)));
    assert.throws(() => buildSeed(parseDdl("CREATE TABLE t (a int NULL, p int NULL REFERENCES t(a));"), { rows: 2 }), /no primary key/);
});

test("golden: the same catalogue and seed give the same bytes; another seed gives other rows", () => {
    const p = project();
    const a = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", seed: 7, rows: 10 }).manifest.files;
    const b = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", seed: 7, rows: 10 }).manifest.files;
    assert.deepEqual(a, b);
    assert.notEqual(writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", seed: 8, rows: 10 }).manifest.files["seed.sql"], a["seed.sql"]);
    const one = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", seed: 7 }).manifest;
    assert.equal(one.tables[0].rows, 50, "50 rows a table by default: the low end of the golden records");
});

test("the manifest says where it came from, the keys it deferred and invented, and what isn't done", () => {
    const p = project();
    const { manifest, folder } = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", id: "catalog", rows: 2 });
    assert.equal(folder, "cmtk/data/seed-catalog");
    assert.equal(manifest.source.ddl, "schema.sql");
    assert.match(manifest.source.ddl_sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.source.virtual_keys, "keys.yaml");
    assert.match(manifest.virtual_keys[0], /dbo\.Item\(BrandCode\) -> dbo\.Brand\(Code\): the application joins on it/);
    assert.equal(manifest.deferred_keys.length, 2);
    assert.ok(manifest.not_done.some((n) => /live SQL Server/.test(n)));
    assert.ok(manifest.not_done.some((n) => /mapping step/.test(n)));
    for (const f of ["seed.sql", "reset.sql", "control-totals.sql", "control-totals.expected.csv", "catalogue.json", "golden/dbo.Item.csv", "SEED-MANIFEST.json"]) assert.ok(fs.existsSync(path.join(p.dir, folder, f)), f);
});

test("reset.sql empties the tables, cycle included, and the script loads again", () => {
    const p = project();
    const { result } = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", rows: 5 });
    const db = loaded(result.script);
    db.exec(asSqlite(result.reset));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "dbo.Customer"').get().n, 0);
    db.exec(asSqlite(result.script));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM "dbo.Customer"').get().n, 5);
});

/** Run the control totals on a database and return them as a table, as a saved CSV would be read. */
function totals(db, sql) {
    const rows = db.prepare(asSqlite(sql).replace(/^--.*$/gm, "").trim().replace(/;$/, "")).all();
    const csv = "table,column,measure,value\n" + rows.map((r) => [r.table, r.column, r.measure, r.value ?? ""].map((v) => (/[,"]/.test(String(v)) ? `"${v}"` : v)).join(",")).join("\n") + "\n";
    return [csvTable(csv)];
}

test("control totals: the query on both sides matches, and matches what they must be; one changed row is caught", () => {
    const p = project();
    const { result, folder } = writeSeed(p.m(), { ddl: "schema.sql", virtualKeys: "keys.yaml", seed: 3, rows: 15 });
    const a = loaded(result.script), b = loaded(result.script);
    const key = { key: ["table", "column", "measure"], epsilon: 0.00001 };
    assert.equal(compareTables(totals(a, result.totals), totals(b, result.totals), key).same, true);
    const expected = [csvTable(fs.readFileSync(path.join(p.dir, folder, "control-totals.expected.csv"), "utf8"))];
    const vs = compareTables(expected, totals(a, result.totals), { ...key, epsilon: 0.01 });
    assert.deepEqual(vs.differences, []);
    assert.equal(vs.same, true, JSON.stringify(vs));
    assert.ok(expectedTotals(result).some((t) => t.table === "dbo.Item" && t.column === "Price" && t.measure === "sum"));
    b.exec(`UPDATE "dbo.Item" SET Price = Price + 1 WHERE Id = 1`);
    const off = compareTables(totals(a, result.totals), totals(b, result.totals), key);
    assert.equal(off.same, false);
    assert.ok(off.differences.some((d) => d.column === "value" && d.key.includes("Price | sum")));
});

test("the real command: cmtk data seed, then reconcile; cmtk says it doesn't run the script", () => {
    const p = project();
    const cmtk = (...a) => spawnSync(process.execPath, [CLI, "data", ...a], { cwd: p.dir, encoding: "utf8" });
    let r = cmtk("seed", "--ddl", "schema.sql", "--virtual-keys", "keys.yaml", "--rows", "3", "--id", "c");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Load order: /);
    assert.match(r.stdout, /Deferred, to break a cycle: dbo\.Customer\(MainAccountId\)/);
    assert.match(r.stdout, /Virtual key: dbo\.Item\(BrandCode\)/);
    assert.match(r.stdout, /cmtk does not run it/);
    const f = "cmtk/data/seed-c/control-totals.expected.csv";
    const text = fs.readFileSync(path.join(p.dir, f), "utf8");
    assert.ok(parseCsv(text).rows.length > 10);
    fs.writeFileSync(path.join(p.dir, "other.csv"), text.replace(/^dbo\.Item,\*,count,3$/m, "dbo.Item,*,count,4"));
    r = cmtk("reconcile", f, f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = cmtk("reconcile", f, "other.csv");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /dbo\.Item \| \* \| count, value: "3" vs "4"/);
    assert.equal(cmtk("seed").status, 3);
});

test("nothing in the seed code can reach a database", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "seed.ts"), "utf8");
    assert.doesNotMatch(src, /from "(mssql|tedious|node:net|node:child_process)"/);
});
