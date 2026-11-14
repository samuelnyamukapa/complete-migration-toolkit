// Against real servers, in CI only: each test is skipped unless its environment variable is set.
// Each sets up its own table and a read-only login, then proves that login is accepted and the
// administrator login is refused. The T-SQL in drivers.mjs is only ever proved here.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAdapter } from "../index.mjs";

const GET = { id: "REAL", request: { method: "GET", path: "/rows" } };
const READER_PASSWORD = "Cmtk-reader-1!";

async function proves(driver, table, adminConnection, readerConnection) {
    const settings = { "*": { driver, connection_env: "CONN", test_database: undefined, tables: [{ name: table, as: "orders", keys: ["order_no"] }] } };
    const reader = createAdapter({ env: { CONN: readerConnection }, settings });
    const o = await reader.run(GET, { name: "sys" }, {});
    assert.equal(o.error, undefined, o.error);
    assert.deepEqual(o.effects.tables.orders.rows.map((r) => r.order_no), ["A-1", "A-2"]);
    await reader.close();
    const admin = createAdapter({ env: { CONN: adminConnection }, settings });
    await assert.rejects(admin.run(GET, { name: "sys" }, {}), /this login can write/);
    await admin.close();
}

const PG = process.env.CMTK_TEST_PG_ADMIN_URL;
test("real PostgreSQL: a read-only login reads; the administrator is refused", { skip: PG ? false : "set CMTK_TEST_PG_ADMIN_URL (database cmtk_test)" }, async () => {
    const pg = await import("pg");
    const client = new (pg.default ?? pg).Client({ connectionString: PG });
    await client.connect();
    await client.query(`
        DROP TABLE IF EXISTS cmtk_orders;
        CREATE TABLE cmtk_orders (order_no text PRIMARY KEY, total numeric(8,2));
        INSERT INTO cmtk_orders VALUES ('A-2', 2), ('A-1', 1);
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        DROP ROLE IF EXISTS cmtk_reader;
        CREATE ROLE cmtk_reader LOGIN PASSWORD '${READER_PASSWORD}';
        GRANT USAGE ON SCHEMA public TO cmtk_reader;
        GRANT SELECT ON cmtk_orders TO cmtk_reader;
    `);
    await client.end();
    const u = new URL(PG);
    u.username = "cmtk_reader";
    u.password = READER_PASSWORD;
    await proves("postgres", "public.cmtk_orders", PG, u.href);
});

const MS = process.env.CMTK_TEST_MSSQL_ADMIN;
test("real SQL Server: a read-only login reads; the administrator is refused", { skip: MS ? false : "set CMTK_TEST_MSSQL_ADMIN (connects to master)" }, async () => {
    const sql = await import("mssql");
    const { ConnectionPool } = sql.default ?? sql;
    const master = await new ConnectionPool(MS).connect();
    await master.request().query("IF DB_ID('cmtk_test') IS NULL CREATE DATABASE cmtk_test");
    await master.request().query(`IF SUSER_ID('cmtk_reader') IS NULL CREATE LOGIN cmtk_reader WITH PASSWORD = '${READER_PASSWORD}'`);
    await master.close();
    const inTest = MS.replace(/Database=[^;]*;?/i, "").replace(/;?$/, ";Database=cmtk_test;");
    const db = await new ConnectionPool(inTest).connect();
    await db.request().query("IF OBJECT_ID('dbo.cmtk_orders') IS NOT NULL DROP TABLE dbo.cmtk_orders; CREATE TABLE dbo.cmtk_orders (order_no varchar(10) PRIMARY KEY, total decimal(8,2)); INSERT INTO dbo.cmtk_orders VALUES ('A-2', 2), ('A-1', 1)");
    await db.request().query("IF USER_ID('cmtk_reader') IS NULL CREATE USER cmtk_reader FOR LOGIN cmtk_reader; ALTER ROLE db_datareader ADD MEMBER cmtk_reader");
    await db.close();
    const reader = inTest.replace(/User Id=[^;]*/i, "User Id=cmtk_reader").replace(/Password=[^;]*/i, `Password=${READER_PASSWORD}`);
    await proves("mssql", "dbo.cmtk_orders", inTest, reader);
});
