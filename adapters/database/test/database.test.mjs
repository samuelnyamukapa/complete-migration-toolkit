// The database adapter: the SELECT check, the login check against real PostgreSQL catalogues
// (PGlite), SQL Server's logic over canned answers, the real conformance kit and a real
// `cmtk compare`. No network. Real servers are covered by real-server.test.mjs, in CI.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdapter, looksLikeTest } from "../index.mjs";
import { mssqlDriver, postgresDriver } from "../drivers.mjs";
import { assertSelectOnly } from "../sql-guard.mjs";
import { asSystem, fakeMssql, fakePg, makeDatabase } from "./support/stand-ins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..");
const CLI = path.join(ADAPTER, "..", "..", "packages", "cli", "dist", "main.js");
const STANDIN = path.join(HERE, "support", "standin.mjs");
const GET = { id: "R", request: { method: "GET", path: "/rows" } };
const ORDERS = [{ name: "orders", keys: ["order_no"], ignore: ["updated_at"] }];

test("the SELECT check passes one SELECT and what only looks dangerous", () => {
    for (const [sql, d] of [
        ["SELECT 1", "postgres"],
        ["  select id, total from orders where id = $1 ;  ", "postgres"],
        ["SELECT 'DROP TABLE x; DELETE' AS note FROM t", "postgres"],
        ["SELECT \"delete\" FROM t -- DROP TABLE t\n", "postgres"],
        ["SELECT 1 /* ; DELETE FROM t; /* nested */ */", "postgres"],
        ["SELECT $tag$; DROP TABLE t;$tag$", "postgres"],
        ["SELECT E'it\\'s; DROP' AS x", "postgres"],
        ["SELECT a FROM t UNION ALL SELECT a FROM u", "postgres"],
        ["SELECT * FROM (SELECT a FROM t) AS q ORDER BY a LIMIT 3", "postgres"],
        ["SELECT TOP (5) [update], [drop;table] FROM [dbo].[orders] ORDER BY [id]", "mssql"],
        ["SELECT N'x''; DELETE' AS a", "mssql"],
        ["SELECT a FROM t EXCEPT SELECT a FROM u", "mssql"],
        ["SELECT * FROM (SELECT a FROM t) AS q", "mssql"],
    ]) assert.equal(assertSelectOnly(sql, d), sql, sql);
});

test("the SELECT check refuses everything else, multiple statements included", () => {
    for (const [sql, d] of [
        ["", "postgres"],
        ["   -- only a comment", "postgres"],
        ["DELETE FROM t", "postgres"],
        ["UPDATE t SET a = 1", "mssql"],
        ["INSERT INTO t VALUES (1)", "postgres"],
        ["DROP TABLE t", "mssql"],
        ["TRUNCATE t", "postgres"],
        ["EXEC sp_who", "mssql"],
        ["exec('drop table t')", "mssql"],
        ["WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "postgres"],
        ["(SELECT 1)", "postgres"],
        ["SELECT 1; SELECT 2", "postgres"],
        ["SELECT 1; DROP TABLE t", "mssql"],
        ["SELECT 1;;", "postgres"],
        ["SELECT 1 SELECT 2", "mssql"],
        ["SELECT 1 DELETE FROM t", "mssql"],
        ["SELECT 1 /* x */ ; /* y */ DROP TABLE t", "postgres"],
        ["SELECT * INTO copy FROM t", "mssql"],
        ["SELECT * FROM t FOR UPDATE", "postgres"],
        ["SELECT * FROM t FOR SHARE", "postgres"],
        ["SELECT nextval('s')", "postgres"],
        ["SELECT setval('s', 1)", "postgres"],
        ["SELECT pg_terminate_backend(1)", "postgres"],
        ["SELECT pg_read_file('/etc/passwd')", "postgres"],
        ["SELECT lo_unlink(1)", "postgres"],
        ["SELECT xp_cmdshell('dir')", "mssql"],
        ["SELECT * FROM OPENROWSET('x', 'y')", "mssql"],
        ["SELECT @@VERSION", "mssql"],
        ["SELECT * FROM #temp", "mssql"],
        ["SELECT 'never closed", "postgres"],
        ["SELECT 1 /* never closed", "postgres"],
        ["SELECT \"never closed", "postgres"],
        ["SELECT [never closed", "mssql"],
        ["SELECT $a$ never closed", "postgres"],
        ["SELECT (1", "postgres"],
        ["SELECT 1)", "postgres"],
        ["SELECT U&'d\\0061t' FROM t", "postgres"],
        // A backslash ends nothing in a plain string, so what follows is really a second statement.
        ["SELECT 'a\\'; DROP TABLE t; --'", "postgres"],
        ["SELECT 'a\\'; DROP TABLE t; --'", "mssql"],
    ]) assert.throws(() => assertSelectOnly(sql, d), { code: "SQL_REFUSED" }, sql);
});

test("database names: only test ones pass, unless settings name that exact one", () => {
    for (const ok of ["cmtk_test", "orders-qa", "test"]) assert.equal(looksLikeTest(ok), true, ok);
    for (const bad of ["orders", "postgres", "prod_test", "latest"]) assert.equal(looksLikeTest(bad), false, bad);
});

test("database names: one holding a production marker is never test, and part of a word is not a marker", () => {
    for (const bad of ["prod2_test", "customers_prod01_dev", "prod-test", "test-production", "qa_prd1", "live2-test", "ordersLive_test", "products_test", "reproduce_dev"]) assert.equal(looksLikeTest(bad), false, bad);
    for (const ok of ["delivery-test", "olive_qa", "orders_test"]) assert.equal(looksLikeTest(ok), true, ok);
});

test("the host counts: a production host, or a production name in the connection, is refused before anything connects", async () => {
    const refusing = (opened) => ({ postgres: postgresDriver(async () => { opened.push("pg"); throw new Error("must not load"); }), mssql: mssqlDriver(async () => { opened.push("mssql"); throw new Error("must not load"); }) });
    for (const [driver, connection] of [
        ["postgres", "postgres://reader:s3cret-pw@db.prod.acme.com/cmtk_test"],
        ["postgres", "postgres://reader:s3cret-pw@prod2-db.acme.com:5432/cmtk_test"],
        ["postgres", "postgres://reader:s3cret-pw@test-db/cmtk_test?host=prod-db.acme.com"],
        ["postgres", "postgres://reader:s3cret-pw@test-db/prod2_test"],
        ["mssql", "Server=prod-sql,1433;Database=cmtk_test;User Id=r;Password=s3cret-pw"],
        ["mssql", "Data Source=sql.live.acme.com;Database=cmtk_test;User Id=r;Password=s3cret-pw"],
        ["mssql", "Server=test-sql;Database=prod2_test;User Id=r;Password=s3cret-pw"],
        ["mssql", "Server=test-sql;Initial Catalog=orders_prod;User Id=r;Password=s3cret-pw"],
    ]) {
        const opened = [];
        const a = createAdapter({ drivers: refusing(opened), env: { CONN: connection }, settings: { sys: { driver, connection_env: "CONN", test_database: "prod2_test", tables: ORDERS } } });
        await assert.rejects(a.run(GET, { name: "sys" }, {}), (e) => /production/.test(e.message) && !e.message.includes("s3cret"), connection);
        assert.deepEqual(opened, [], connection);
    }
});

test("database names: naming one with a production marker in test_database does not help; one that only holds `prod` can be named", async () => {
    const server = (name) => ({ dialect: "postgres", secretsOf: () => [], hostsOf: () => [], open: async () => ({ query: async () => [], close: async () => {} }), databaseName: async () => name, whoCanWrite: async () => [], selectAll: () => "SELECT 1" });
    const run = (name) => createAdapter({ drivers: { postgres: server(name) }, env: { CONN: "x" }, settings: { sys: { driver: "postgres", connection_env: "CONN", test_database: name, tables: ORDERS } } }).run(GET, { name: "sys" }, {});
    await assert.rejects(run("customers_prod01_dev"), /production/);
    const fine = await run("products_test");
    assert.equal(fine.error, undefined);
});

const pgRig = (dbs, role, extra = {}, seen = []) => createAdapter({
    drivers: { postgres: postgresDriver(async () => fakePg((h) => dbs[h], seen)) },
    env: { CONN: `postgres://${role}:s3cret-pw@main/x` },
    settings: { sys: { driver: "postgres", connection_env: "CONN", test_database: "postgres", tables: ORDERS, ...extra } },
});

let db;
before(async () => { db = await makeDatabase(); });
after(async () => { await db.close(); });

test("PostgreSQL (real, through PGlite): a read-only login reads rows sorted by key, without the left-out columns", async () => {
    const seen = [];
    const a = pgRig({ main: db }, "reader", {}, seen);
    const o = await a.run(GET, { name: "sys" }, {});
    assert.equal(o.error, undefined);
    assert.deepEqual(o.effects.tables.orders.rows.map((r) => r.order_no), ["A-1", "A-2", "A-3"]);
    assert.deepEqual(o.effects.tables.orders.rows[0], { order_no: "A-1", status: "new", total: "10.00" });
    assert.deepEqual(await a.reset({ name: "sys" }), { ok: true });
    assert.equal(seen[0].options, "-c default_transaction_read_only=on", "the connection itself asks for read-only");
    for (const sql of seen.slice(1)) assert.match(sql, /^SELECT\b/, "only SELECT reaches the server");
    await a.close();
});

test("PostgreSQL (real): a login that can write is refused, by asking the server, before any row is read", async () => {
    for (const [role, why] of [
        ["writer", /can write: it can write to public\.audit/],
        ["postgres", /can write: it is a superuser/],
        ["owner_of_schema", /can write: it can create objects in schema public/],
    ]) {
        const seen = [];
        const a = pgRig({ main: db }, role, {}, seen);
        await assert.rejects(a.run(GET, { name: "sys" }, {}), why, role);
        await assert.rejects(a.reset({ name: "sys" }), why, role);
        assert.doesNotMatch(seen.filter((x) => typeof x === "string").join("\n"), /FROM "orders"/, "no rows read");
        await a.close();
    }
    await db.exec("RESET ROLE");
});

test("PostgreSQL (real): the database name is checked, and test_database must name it exactly", async () => {
    await assert.rejects(pgRig({ main: db }, "reader", { test_database: undefined }).run(GET, { name: "sys" }, {}), /"postgres" does not look like a test database/);
    await assert.rejects(pgRig({ main: db }, "reader", { test_database: "other" }).run(GET, { name: "sys" }, {}), /does not look like a test database/);
});

test("PostgreSQL (real): a named query must be one SELECT, and a refused one never reaches the server", async () => {
    for (const query of ["DELETE FROM orders", "SELECT 1; DELETE FROM orders", "SELECT * FROM orders) AS q; DROP TABLE orders; --"]) {
        const seen = [];
        const a = pgRig({ main: db }, "reader", { tables: [{ name: "orders", keys: ["order_no"], query }] }, seen);
        await assert.rejects(a.run(GET, { name: "sys" }, {}), { code: "SQL_REFUSED" }, query);
        assert.equal(seen.filter((x) => typeof x === "string" && /DELETE|DROP/.test(x) && !/has_table_privilege/.test(x)).length, 0, query);
        await a.close();
    }
    const fine = pgRig({ main: db }, "reader", { tables: [{ name: "orders", as: "open", keys: ["order_no"], query: "SELECT order_no, total FROM orders WHERE total > 15" }] });
    const o = await fine.run(GET, { name: "sys" }, {});
    assert.deepEqual(o.effects.tables.open.rows, [{ order_no: "A-2", total: "20.50" }, { order_no: "A-3", total: "30.00" }]);
    await fine.close();
    for (const name of ["orders; DROP TABLE orders", 'a"b', "a.b.c"]) {
        await assert.rejects(pgRig({ main: db }, "reader", { tables: [{ name, keys: ["order_no"] }] }).run(GET, { name: "sys" }, {}), /plain name/, name);
    }
});

test("PostgreSQL (real): the row cap is reported, and a capped table is an error so it cannot read as a match", async () => {
    const a = pgRig({ main: db }, "reader", { row_cap: 2 });
    const o = await a.run(GET, { name: "sys" }, {});
    assert.equal(o.effects.tables.orders.capped, true);
    assert.equal(o.effects.tables.orders.row_cap, 2);
    assert.equal(o.effects.tables.orders.rows.length, 2);
    assert.match(o.error, /row cap \(2\) was hit on orders/);
    await a.close();
});

test("settings: connections come from the environment, keys must be real and unique, and a change needs a system to send it to", async () => {
    const a = createAdapter({ drivers: { postgres: postgresDriver(async () => fakePg(() => db)) }, env: {}, settings: {} });
    await assert.rejects(a.run(GET, { name: "s", driver: "postgres", connection_string: "postgres://u:s3cret@h/x" }, {}), (e) => /not allowed in settings/.test(e.message) && !e.message.includes("s3cret"));
    await assert.rejects(a.run(GET, { name: "s", driver: "postgres", connection_env: "NOT_THERE" }, {}), /NOT_THERE is not set/);
    await assert.rejects(a.run(GET, { name: "s", driver: "nope", connection_env: "X" }, {}), /driver must be one of/);

    await assert.rejects(pgRig({ main: db }, "reader", { tables: [{ name: "orders", keys: ["order_no"], ignore: ["order_no"] }] }).run(GET, { name: "sys" }, {}), /cannot be left out/);
    await assert.rejects(pgRig({ main: db }, "reader", { tables: [{ name: "orders", keys: ["status"] }] }).run(GET, { name: "sys" }, {}), /two rows have the key/);
    await assert.rejects(pgRig({ main: db }, "reader", { tables: [{ name: "orders" }] }).run(GET, { name: "sys" }, {}), /needs keys/);
    const c = pgRig({ main: db }, "reader");
    assert.match((await c.run({ id: "P", request: { method: "POST", path: "/x", body: "{}" } }, { name: "sys" }, {})).error, /needs app_url/);
    await c.close();
});

test("a system's write shows as rows added, removed and changed, sorted by key (PostgreSQL, real)", async () => {
    const other = await makeDatabase();
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (d) => chunks.push(d));
        req.on("end", async () => {
            if (req.method === "POST") await asSystem(other, "INSERT INTO orders (order_no, total, status) VALUES ('Z-9', 1, 'new'), ('A-0', 2, 'new'); UPDATE orders SET status = 'paid' WHERE order_no = 'A-2'; DELETE FROM orders WHERE order_no = 'A-3'");
            res.writeHead(201, { "set-cookie": "s=header-only" });
            res.end(JSON.stringify({ authorization: req.headers["x-key"], read: req.method === "GET" }));
        });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
        const a = pgRig({ main: other }, "reader", { app_url: `http://127.0.0.1:${server.address().port}/` });
        const read = await a.run(GET, { name: "sys" }, {});
        assert.deepEqual(read.effects.tables.orders, { added: [], removed: [], changed: [] }, "a GET to the system changes nothing here");
        const o = await a.run({ id: "P", request: { method: "POST", path: "/orders", body: { a: 1 } } }, { name: "sys" }, { "x-key": "header-value" });
        assert.equal(o.status, 201);
        const t = o.effects.tables.orders;
        assert.deepEqual(t.added.map((r) => r.key.order_no), ["A-0", "Z-9"]);
        assert.deepEqual(t.removed, [{ key: { order_no: "A-3" }, row: { order_no: "A-3", status: "new", total: "30.00" } }]);
        assert.deepEqual(t.changed, [{ key: { order_no: "A-2" }, changes: { status: { before: "new", after: "paid" } } }]);
        assert.equal(o.headers, undefined, "response headers are never reported");
        assert.doesNotMatch(a.clean(o), /header-value/, "a system that echoes a credential cannot get it into the evidence");
        await a.close();
    } finally {
        server.closeAllConnections();
        server.close();
        await other.close();
    }
});

const msServer = (logins, extra = {}) => ({
    name: "cmtk_test",
    logins,
    tables: { orders: [{ order_no: "B", total: 2, at: new Date(0) }, { order_no: "A", total: 1, at: new Date(0) }] },
    ...extra,
});
const msRig = (server, user = "reader", extra = {}, seen = []) => createAdapter({
    drivers: { mssql: mssqlDriver(async () => fakeMssql(() => server, seen)) },
    env: { CONN: `Server=h;Database=x;User Id=${user};Password=s3cret-pw;` },
    settings: { sys: { driver: "mssql", connection_env: "CONN", tables: [{ name: "dbo.orders", as: "orders", keys: ["order_no"], ignore: ["at"] }], ...extra } },
});

test("SQL Server (stand-in): a read-only login reads, sorted by key, and every statement passes the SELECT check", async () => {
    const seen = [];
    const a = msRig(msServer({ reader: {} }), "reader", {}, seen);
    const o = await a.run(GET, { name: "sys" }, {});
    assert.deepEqual(o.effects.tables.orders.rows, [{ order_no: "A", total: 1 }, { order_no: "B", total: 2 }]);
    assert.ok(seen.some((s) => /fn_my_permissions\(NULL, 'DATABASE'\)/.test(s)));
    assert.ok(seen.some((s) => /HAS_PERMS_BY_NAME/.test(s)));
    for (const sql of seen) assert.equal(assertSelectOnly(sql, "mssql"), sql);
});

test("SQL Server (stand-in): each way a login can write is refused, and the database name is checked", async () => {
    for (const [login, why] of [
        [{ roles: { sysadmin: 1 } }, /in the sysadmin role/],
        [{ roles: { db_owner: 1 } }, /in the db_owner role/],
        [{ roles: { db_datawriter: 1 } }, /in the db_datawriter role/],
        [{ roles: { db_ddladmin: 1 } }, /in the db_ddladmin role/],
        [{ database: ["INSERT"] }, /has INSERT on this database/],
        [{ database: ["EXECUTE"] }, /has EXECUTE on this database/],
        [{ objects: [["dbo", "orders"]] }, /can write to dbo\.orders/],
    ]) {
        const seen = [];
        await assert.rejects(msRig(msServer({ reader: login }), "reader", {}, seen).run(GET, { name: "sys" }, {}), why);
        assert.equal(seen.some((s) => /FROM \[dbo\]/.test(s)), false, "no rows read");
    }
    await assert.rejects(msRig(msServer({ reader: {} }, { name: "orders" })).run(GET, { name: "sys" }, {}), /does not look like a test database/);
    assert.equal((await msRig(msServer({ reader: {} }, { name: "orders" }), "reader", { test_database: "orders" }).run(GET, { name: "sys" }, {})).error, undefined);
});

test("secrets: a connection that fails does not show its password", async () => {
    const conn = "Server=h;Database=x;User Id=reader;Password=s3cret-pw;";
    const a = msRig(msServer({}, { unreachable: `cannot reach ${conn}` }));
    const err = await a.run(GET, { name: "sys" }, {}).catch((e) => e);
    assert.equal(err.code, "ESOCKET");
    const out = a.clean({ error: err.message });
    assert.doesNotMatch(out, /s3cret/);
    assert.doesNotMatch(a.clean({ error: "postgres://bob:other-pw@h/x and Password=other-pw2" }), /other-pw/);
});

const cmtk = (cwd, env, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function project(driver, port, allowUnsafe, cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-database-"));
    const settingsFile = path.join(dir, "database-settings.json");
    const tables = driver === "postgres" ? ORDERS : [{ name: "dbo.orders", as: "orders", keys: ["order_no"], ignore: ["updated_at"] }];
    fs.writeFileSync(settingsFile, JSON.stringify({
        "*": { driver, tables, test_database: "postgres" },
        legacy: { app_url: `http://127.0.0.1:${port}/legacy` },
        candidate: { app_url: `http://127.0.0.1:${port}/candidate` },
        check: { connection_env: "CONN_LEGACY" },
    }));
    const manifest = {
        system: "orders",
        targets: { legacy: { connection_env: "CONN_LEGACY" }, candidate: { connection_env: "CONN_CANDIDATE" } },
        cases: ["cases/*.yaml"],
        allow_unsafe_methods: allowUnsafe,
        adapters: { database: { command: process.execPath, args: [STANDIN, "--settings", settingsFile], covers: ["database"] } },
    };
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(dir, "cases"));
    fs.writeFileSync(path.join(dir, "cases", "a.yaml"), JSON.stringify({ cases }));
    fs.mkdirSync(path.join(dir, "adapters", "database", "samples"), { recursive: true });
    fs.copyFileSync(path.join(ADAPTER, "samples", "cases.yaml"), path.join(dir, "adapters", "database", "samples", "cases.yaml"));
    return dir;
}
const ENV = {
    postgres: { CONN_LEGACY: "postgres://reader:s3cret-pw@legacy/x", CONN_CANDIDATE: "postgres://reader:s3cret-pw@candidate/x" },
    mssql: { CONN_LEGACY: "Server=legacy;Database=x;User Id=reader;Password=s3cret-pw;", CONN_CANDIDATE: "Server=candidate;Database=x;User Id=reader;Password=s3cret-pw;" },
};
const WRITER = {
    postgres: { CONN_LEGACY: "postgres://writer:s3cret-pw@legacy/x", CONN_CANDIDATE: "postgres://reader:s3cret-pw@candidate/x" },
    mssql: { CONN_LEGACY: "Server=legacy;Database=x;User Id=writer;Password=s3cret-pw;", CONN_CANDIDATE: "Server=candidate;Database=x;User Id=reader;Password=s3cret-pw;" },
};
const CREATE = { id: "ORDER-1", surface: "database", request: { method: "POST", path: "/orders", body: { order_no: "N-1", total: 5 } } };

for (const driver of ["postgres", "mssql"]) {
    test(`conformance kit, real CLI, ${driver}: the shipped samples pass; a login that can write fails the kit`, async () => {
        const dir = project(driver, await freePort(), false, []);
        try {
            let r = await cmtk(dir, { ...ENV[driver], STANDIN_PORT: "0" }, "adapter", "check", "database");
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /Adapter database passes the conformance kit/);
            r = await cmtk(dir, { ...WRITER[driver], STANDIN_PORT: "0" }, "adapter", "check", "database");
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /login can write/);
            assert.doesNotMatch(r.stdout + r.stderr, /s3cret/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test(`end to end, real CLI, ${driver}: compare matches equal row changes and catches a planted difference`, async () => {
        const port = await freePort();
        const dir = project(driver, port, true, [CREATE]);
        try {
            let r = await cmtk(dir, { ...ENV[driver], STANDIN_PORT: String(port) }, "compare", "--allow-unsafe", "--json");
            const same = JSON.parse(r.stdout);
            assert.equal(same.verdict, "PARITY", r.stdout + r.stderr);

            r = await cmtk(dir, { ...ENV[driver], STANDIN_PORT: String(port), STANDIN_CANDIDATE: "plant" }, "compare", "--allow-unsafe");
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /NO PARITY/);
            assert.match(r.stdout, /effects:\$\.tables\.orders\.added\[0\]\.row\.total: "?5\.00"? vs "?6\.00"?/);
            const evidence = fs.globSync("cmtk/evidence/**/*.json", { cwd: dir }).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
            assert.ok(evidence.includes("N-1"), "the evidence holds the rows");
            assert.doesNotMatch(evidence + r.stdout + r.stderr, /s3cret/);

            r = await cmtk(dir, { ...WRITER[driver], STANDIN_PORT: String(port) }, "compare", "--allow-unsafe", "--json");
            const refused = JSON.parse(r.stdout);
            assert.equal(refused.cases[0].result, "ERROR", r.stdout + r.stderr);
            assert.notEqual(refused.verdict, "PARITY");
            assert.match(refused.cases[0].why, /login can write/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

test("a case that makes the system write needs both unsafe switches", async () => {
    const port = await freePort();
    for (const [allowUnsafe, flag] of [[false, false], [true, false], [false, true]]) {
        const dir = project("mssql", port, allowUnsafe, [CREATE]);
        try {
            const r = await cmtk(dir, { ...ENV.mssql, STANDIN_PORT: String(port) }, "compare", ...(flag ? ["--allow-unsafe"] : []), "--json");
            assert.equal(JSON.parse(r.stdout).cases[0].result, "SKIPPED", r.stdout + r.stderr);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test("a missing driver package gives a clear error from the real adapter with nothing installed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-database-bare-"));
    try {
        for (const f of ["index.mjs", "drivers.mjs", "sql-guard.mjs"]) fs.copyFileSync(path.join(ADAPTER, f), path.join(dir, f));
        const child = spawn(process.execPath, [path.join(dir, "index.mjs")], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, A: ENV.postgres.CONN_LEGACY, B: ENV.mssql.CONN_LEGACY } });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        const done = new Promise((r) => child.on("close", r));
        for (const target of [{ name: "a", driver: "postgres", connection_env: "A" }, { name: "b", driver: "mssql", connection_env: "B" }]) {
            child.stdin.write(JSON.stringify({ op: "run", case: GET, target, headers: {} }) + "\n");
        }
        child.stdin.end();
        await done;
        const [a, b] = out.trim().split("\n").map((l) => JSON.parse(l));
        assert.match(a.error, /postgres driver needs the pg package.*npm install --no-save pg@/);
        assert.match(b.error, /mssql driver needs the mssql package/);
        assert.doesNotMatch(out, /s3cret/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("describe names the adapter, its kinds and its settings", () => {
    const d = createAdapter().describe();
    assert.equal(d.name, "database");
    assert.deepEqual(d.kinds, ["database"]);
    assert.ok(d.settings.includes("connection_env"));
});
