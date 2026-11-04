// The SELECT check must hold by itself: function calls are allowed from a list, quoted names are read as names, and
// the T-SQL forms with no semicolon are refused without the wrapping a person's query gets. Where a claim is about what
// PostgreSQL does, PGlite (real PostgreSQL) shows it, so the tests can't pass on a mistaken idea of the server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { postgresDriver } from "../drivers.mjs";
import { createAdapter } from "../index.mjs";
import { assertSelectOnly } from "../sql-guard.mjs";
import { fakePg, makeDatabase } from "./support/stand-ins.mjs";

const refused = (sql, dialect, options) => assert.throws(() => assertSelectOnly(sql, dialect, options), { code: "SQL_REFUSED" }, `${dialect}: ${sql}`);
const passes = (sql, dialect, options) => assert.equal(assertSelectOnly(sql, dialect, options), sql, `${dialect}: ${sql}`);

let db;
before(async () => {
    db = await makeDatabase();
    await db.exec(`
        CREATE SCHEMA my_schema;
        CREATE SEQUENCE s;
        CREATE FUNCTION my_schema.delete_all_orders() RETURNS int LANGUAGE sql AS 'DELETE FROM orders WHERE order_no = ''GONE'' RETURNING 1';
        CREATE FUNCTION public.note(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        CREATE FUNCTION public.filter(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        CREATE FUNCTION public.over(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        CREATE FUNCTION public.top(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        CREATE FUNCTION public.like(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        CREATE FUNCTION public.cube(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        CREATE FUNCTION public."Lower"(t text) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (t) RETURNING note';
        GRANT USAGE ON SCHEMA my_schema TO reader;
    `);
});
after(async () => { await db.close(); });

test("PostgreSQL really does call a quoted name, so these forms are real", async () => {
    await db.exec("RESET ROLE; SET default_transaction_read_only = on");
    assert.equal((await db.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only, "on");
    await db.query(`SELECT "set_config"('default_transaction_read_only', 'off', false)`);
    assert.equal((await db.query(`SHOW default_transaction_read_only`)).rows[0].default_transaction_read_only, "off", "the quoted call turned read-only off");
    const first = (await db.query(`SELECT "nextval"('s') AS n`)).rows[0].n;
    assert.equal(Number((await db.query(`SELECT "nextval"('s') AS n`)).rows[0].n), Number(first) + 1, "the quoted call moved the sequence");
    const before = (await db.query("SELECT count(*)::int AS n FROM audit")).rows[0].n;
    for (const sql of [`SELECT filter('a')`, `SELECT over('a')`, `SELECT top('a')`, `SELECT public.like('a')`, `SELECT cube('a')`, `SELECT "Lower"('a')`]) await db.query(sql);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM audit")).rows[0].n, before + 6, "words that look like keywords are user functions here");
});

test("quoted names are refused the same as plain ones", () => {
    for (const sql of [
        `SELECT "pg_read_file"('/etc/passwd')`,
        `SELECT "set_config"('default_transaction_read_only','off',false)`,
        `SELECT "dblink_exec"('host=x', 'DROP TABLE t')`,
        `SELECT "nextval"('s')`,
        `SELECT pg_catalog."pg_read_file"('/etc/passwd')`,
        `SELECT "pg_catalog"."set_config"('a','b',false)`,
        `SELECT "pg_read_file" /* a comment */ ('/etc/passwd')`,
        `SELECT "pg_read_file"\n(\n'/etc/passwd')`,
        `SELECT PG_READ_FILE('/etc/passwd')`,
    ]) refused(sql, "postgres");
    for (const sql of [`SELECT [xp_cmdshell]('dir')`, `SELECT "xp_cmdshell"('dir')`, `SELECT master.dbo.[xp_cmdshell]('dir')`, `SELECT [fn_varbintohexstr](1)`]) refused(sql, "mssql");
});

test("a function not on the list is refused, however it is written", () => {
    for (const sql of [
        `SELECT my_schema.delete_all_orders()`,
        `SELECT delete_all_orders()`,
        `SELECT "my_schema"."delete_all_orders"()`,
        `SELECT * FROM my_schema.delete_all_orders()`,
        `SELECT * FROM delete_all_orders()`,
        `SELECT a FROM t WHERE delete_all_orders() = 1`,
        `SELECT count(delete_all_orders()) FROM t`,
        `SELECT my_schema.lower('a')`,
        `SELECT public.lower('a')`,
        `SELECT "Lower"('a')`,
        `SELECT query_to_xml('delete from t', true, true, '')`,
        `SELECT current_setting('data_directory')`,
        `SELECT ts_stat('delete from t')`,
        `SELECT filter('a')`,
        `SELECT over('a')`,
        `SELECT top('a')`,
        `SELECT cube('a')`,
        `SELECT by('a')`,
        `SELECT like('a')`,
        `SELECT public.like('a')`,
        `SELECT a, like('a')`,
        `SELECT 1 WHERE like('a') = 'a'`,
        `SELECT "in"(1)`,
        `SELECT "select"(1)`,
        `SELECT a.in(1) FROM a`,
        `SELECT OPERATOR(public.+)`,
    ]) refused(sql, "postgres");
    for (const sql of [`SELECT dbo.delete_all_orders()`, `SELECT [dbo].[delete_all_orders]()`, `SELECT * FROM dbo.fn_rows(1)`, `SELECT {fn delete_all_orders()}`, `SELECT evil.sys.objects()`]) refused(sql, "mssql");
});

test("the T-SQL forms with no semicolon are refused by the check alone", () => {
    for (const sql of [
        "SELECT 1 DISABLE TRIGGER t ON x",
        "SELECT 1 ENABLE TRIGGER t ON x",
        "SELECT 1 RECEIVE TOP(1) * FROM q",
        "SELECT 1 SEND ON CONVERSATION @h",
        "SELECT 1 MOVE CONVERSATION @h TO @g",
        "SELECT 1 GET CONVERSATION GROUP @g FROM q",
        "SELECT 1 IF 1=1 SELECT 2",
        "SELECT 1 WHILE 1=1 PRINT 'x'",
        "SELECT 1 PRINT 'x'",
        "SELECT 1 RAISERROR('x', 16, 1)",
        "SELECT 1 THROW 50000, 'x', 1",
        "SELECT 1 RETURN",
        "SELECT 1 CHECKPOINT",
        "SELECT 1 OPEN c",
        "SELECT 1 GOTO a",
        "SELECT 1 SAVE TRAN x",
        "SELECT 1 SETUSER 'x'",
        "SELECT 1 REVERT",
        "SELECT 1 ADD SIGNATURE TO x BY CERTIFICATE y",
        "SELECT 1 CONTINUE",
        "SELECT 1 BREAK",
    ]) refused(sql, "mssql");
});

test("what a person writes every day still passes", () => {
    for (const sql of [
        "SELECT count(*) FROM t",
        "SELECT COUNT(*), SUM(total), AVG(total), MIN(a), MAX(a) FROM t GROUP BY b HAVING (count(*) > 1)",
        "SELECT coalesce(a, 'x'), nullif(a, ''), lower(b), upper(b), length(b), trim(b), substring(b, 1, 2), concat(a, b) FROM t",
        "SELECT round(a, 2), abs(a), floor(a), ceil(a) FROM t WHERE a IN (1, 2, 3) AND (b > 1 OR NOT (c = 2))",
        "SELECT CAST(a AS numeric(10, 2)), a::varchar(10), b::timestamp(3), extract(year from c) FROM t",
        "SELECT row_number() OVER (PARTITION BY a ORDER BY b), sum(c) FILTER (WHERE d) OVER (ORDER BY (b)) FROM t",
        "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a) FROM t",
        "SELECT CASE WHEN (a > 1) THEN (b) ELSE (c) END FROM t",
        "SELECT a FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.a = t.a) AND a = ANY (ARRAY(SELECT a FROM v)) AND a BETWEEN (1) AND (2)",
        "SELECT a FROM t WHERE b LIKE ('x%') OR c NOT LIKE ('y') OR d ILIKE ('z') OR e SIMILAR TO ('w')",
        "SELECT a FROM t JOIN (SELECT 1) AS q ON (t.a = q.a) LEFT JOIN LATERAL (SELECT 2) AS r ON (true) JOIN u USING (a)",
        "SELECT * FROM (VALUES (1), (2)) AS v",
        "SELECT a FROM t UNION (SELECT b FROM u) ORDER BY (a) LIMIT (5) OFFSET (1)",
        "SELECT pg_catalog.lower('A')",
        "SELECT date_trunc('day', now()), to_char(now(), 'YYYY'), current_database()",
        "SELECT a FROM t GROUP BY ROLLUP (a)",
        "SELECT a FROM t GROUP BY GROUPING SETS ((a), (b))",
    ]) passes(sql, "postgres");
    for (const sql of [
        "SELECT TOP (5) a FROM t WITH (NOLOCK) ORDER BY a",
        "SELECT GETDATE(), ISNULL(a, 0), LEN(b), DATEADD(day, 1, c), DATEDIFF(day, c, d), CONVERT(varchar(10), e), TRY_CAST(f AS int) FROM t",
        "SELECT ROW_NUMBER() OVER (ORDER BY a), IIF(a > 1, 'x', 'y') FROM t OPTION (RECOMPILE)",
        "SELECT a FROM t CROSS APPLY (SELECT 1 AS b) AS q",
        "SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE')",
        "SELECT IS_SRVROLEMEMBER('sysadmin'), IS_ROLEMEMBER('db_owner'), HAS_PERMS_BY_NAME('a', 'OBJECT', 'INSERT'), DB_NAME()",
    ]) passes(sql, "mssql");
});

test("a person can list a function in settings, by its exact name, but never one of the dangerous ones", () => {
    const allowFunctions = ["my_schema.safe_total", "plain_total"];
    passes("SELECT my_schema.safe_total(a) FROM t", "postgres", { allowFunctions });
    passes(`SELECT "my_schema"."safe_total"(a) FROM t`, "postgres", { allowFunctions });
    passes("SELECT plain_total(a) FROM t", "postgres", { allowFunctions });
    passes("SELECT PLAIN_TOTAL(a) FROM t", "postgres", { allowFunctions });
    refused("SELECT safe_total(a) FROM t", "postgres", { allowFunctions });
    refused("SELECT other.safe_total(a) FROM t", "postgres", { allowFunctions });
    refused("SELECT other.plain_total(a) FROM t", "postgres", { allowFunctions });
    for (const [name, sql] of [["pg_read_file", "SELECT pg_read_file('x')"], ["set_config", "SELECT set_config('a','b',false)"], ["nextval", "SELECT nextval('s')"], ["public.pg_sleep", "SELECT public.pg_sleep(1)"], ["dblink_exec", `SELECT "dblink_exec"('a','b')`]]) {
        refused(sql, "postgres", { allowFunctions: [name] });
    }
    refused("SELECT xp_cmdshell('dir')", "mssql", { allowFunctions: ["xp_cmdshell"] });
    refused("SELECT sp_who()", "mssql", { allowFunctions: ["sp_who"] });
});

const rig = (extra, seen = []) => createAdapter({
    drivers: { postgres: postgresDriver(async () => fakePg(() => db, seen)) },
    env: { CONN: "postgres://reader:s3cret-pw@main/x" },
    settings: { sys: { driver: "postgres", connection_env: "CONN", test_database: "postgres", ...extra } },
});
const GET = { id: "R", request: { method: "GET", path: "/rows" } };

test("PostgreSQL (real): the adapter's own statements still pass the list, and a person's query with an unlisted function never reaches the server", async () => {
    const seen = [];
    const a = rig({ tables: [{ name: "orders", keys: ["order_no"], query: "SELECT order_no, my_schema.delete_all_orders() AS gone FROM orders" }] }, seen);
    await assert.rejects(a.run(GET, { name: "sys" }, {}), { code: "SQL_REFUSED" });
    assert.ok(!seen.some((s) => typeof s === "string" && s.includes("delete_all_orders")), "it never reached the server");
    await a.close();
    const fine = rig({ tables: [{ name: "orders", keys: ["order_no"], query: "SELECT order_no, lower(status) AS s FROM orders" }] });
    const o = await fine.run(GET, { name: "sys" }, {});
    assert.equal(o.error, undefined);
    assert.equal(o.effects.tables.orders.rows.length, 3);
    await fine.close();
    await db.exec("RESET ROLE");
});

test("PostgreSQL (real): a function listed in settings reaches the server; its setting must be a list of plain names", async () => {
    await db.exec(`RESET ROLE; CREATE FUNCTION public.status_word(t text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT upper(t)'`);
    const query = "SELECT order_no, status_word(status) AS s FROM orders";
    const refusedRig = rig({ tables: [{ name: "orders", keys: ["order_no"], query }] });
    await assert.rejects(refusedRig.run(GET, { name: "sys" }, {}), /status_word .*allow_functions/);
    await refusedRig.close();
    const a = rig({ allow_functions: ["status_word"], tables: [{ name: "orders", keys: ["order_no"], query }] });
    const o = await a.run(GET, { name: "sys" }, {});
    assert.equal(o.error, undefined);
    assert.equal(o.effects.tables.orders.rows[0].s, "NEW");
    await a.close();
    for (const bad of ["status_word", [1], ["a; drop"], ['a"b'], ["a.b.c"]]) {
        await assert.rejects(rig({ allow_functions: bad, tables: [{ name: "orders", keys: ["order_no"] }] }).run(GET, { name: "sys" }, {}), /allow_functions/, JSON.stringify(bad));
    }
    await db.exec("RESET ROLE");
});

test("PostgreSQL (real): a function called with no brackets gets past the check, and the read-only lock is what stops it", async () => {
    // The limit the README states. Attribute notation looks like a column, so a check that reads only the SQL can't see it.
    await db.exec(`RESET ROLE; CREATE FUNCTION public.scrub(o orders) RETURNS text LANGUAGE sql AS 'INSERT INTO audit (note) VALUES (''scrubbed'') RETURNING note'`);
    const sql = "SELECT o.scrub FROM orders o";
    assert.equal(assertSelectOnly(sql, "postgres"), sql, "the check alone does not stop this");
    await db.exec("SET default_transaction_read_only = on");
    await assert.rejects(db.query(sql), /read-only transaction/);
    await db.exec("SET default_transaction_read_only = off");
});
