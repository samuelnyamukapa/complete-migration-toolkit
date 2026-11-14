// The live half of seeding: the script loads into a real SQL Server, twice, and the control totals match. It needs a
// server and sqlcmd, so it is skipped unless a CI job gives them:
//   service image   mcr.microsoft.com/mssql/server:2022-latest (ACCEPT_EULA=Y, MSSQL_SA_PASSWORD)
//   env             CMTK_TEST_MSSQL_SERVER (such as localhost,1433) and CMTK_TEST_MSSQL_PASSWORD
//   tool            sqlcmd on PATH (mssql-tools18)
// It has not run yet. The password is passed through the environment, as sqlcmd's SQLCMDPASSWORD, and never printed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSeed, compareTables, csvTable, parseDdl, applyVirtualKeys } from "../dist/index.js";

const server = process.env.CMTK_TEST_MSSQL_SERVER;
const password = process.env.CMTK_TEST_MSSQL_PASSWORD;

const DDL = `
CREATE TABLE dbo.Brand (Id int IDENTITY(1,1) NOT NULL PRIMARY KEY, Code varchar(6) NOT NULL UNIQUE, Name nvarchar(50) NOT NULL);
CREATE TABLE dbo.Item (Id int NOT NULL PRIMARY KEY, Sku varchar(10) NOT NULL UNIQUE, BrandCode varchar(6) NOT NULL, Price decimal(9,2) NOT NULL CHECK (Price >= 0), Note nvarchar(200) NULL, Added datetime2(0) NOT NULL, Active bit NOT NULL, Token uniqueidentifier NOT NULL, Total AS (Price * 2));
CREATE TABLE dbo.Customer (Id int IDENTITY(1,1) NOT NULL PRIMARY KEY, Name nvarchar(30) NOT NULL, MainAccountId int NULL, ReferredBy int NULL);
CREATE TABLE dbo.Account (Id int IDENTITY(1,1) NOT NULL PRIMARY KEY, CustomerId int NOT NULL REFERENCES dbo.Customer (Id), Balance money NOT NULL);
ALTER TABLE dbo.Customer ADD CONSTRAINT FK_Customer_Account FOREIGN KEY (MainAccountId) REFERENCES dbo.Account (Id);
ALTER TABLE dbo.Customer ADD CONSTRAINT FK_Customer_Self FOREIGN KEY (ReferredBy) REFERENCES dbo.Customer (Id);
`;

function sqlcmd(database, file) {
    const r = spawnSync("sqlcmd", ["-S", server, "-U", "sa", "-C", "-b", "-d", database, "-i", file, "-s", ",", "-W", "-w", "4000"], { encoding: "utf8", env: { ...process.env, SQLCMDPASSWORD: password }, windowsHide: true });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(0, 2000));
    return r.stdout;
}

test("a real SQL Server: a schema with a cycle and an undeclared key loads on two databases, and the control totals match", { skip: !server || !password ? "needs CMTK_TEST_MSSQL_SERVER and CMTK_TEST_MSSQL_PASSWORD" : false }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mssql-"));
    const write = (n, s) => { const f = path.join(dir, n); fs.writeFileSync(f, s); return f; };
    const c = parseDdl(DDL);
    applyVirtualKeys(c, [{ table: "dbo.Item", columns: ["BrandCode"], references: { table: "dbo.Brand", columns: ["Code"] }, reason: "joined in code" }]);
    const seed = buildSeed(c, { seed: 7, rows: 50 });
    const stamp = Date.now();
    const out = [];
    for (const side of ["legacy", "candidate"]) {
        const db = `cmtk_${side}_${stamp}`;
        sqlcmd("master", write(`create-${side}.sql`, `CREATE DATABASE ${db};`));
        try {
            sqlcmd(db, write("ddl.sql", DDL));
            sqlcmd(db, write("seed.sql", seed.script));
            const raw = sqlcmd(db, write("totals.sql", seed.totals));
            out.push([csvTable(raw.split(/\r?\n/).filter((l) => l && !/^-+,/.test(l) && !/rows affected/.test(l)).join("\n"))]);
        } finally {
            sqlcmd("master", write(`drop-${side}.sql`, `DROP DATABASE ${db};`));
        }
    }
    const r = compareTables(out[0], out[1], { key: ["table", "column", "measure"] });
    assert.equal(r.same, true, JSON.stringify(r).slice(0, 2000));
    assert.ok(r.rows_compared > 10);
});
