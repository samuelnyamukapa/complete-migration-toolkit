#!/usr/bin/env node
// The database adapter: a read-only snapshot of chosen tables before and after each case, and the
// rows added, removed and changed, sorted by key. It refuses a login that can write, and sends
// nothing but one SELECT at a time. One JSON request per line on stdin, one JSON reply per line on
// stdout; see README.md.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { DRIVERS, nameParts } from "./drivers.mjs";
import { assertSelectOnly } from "./sql-guard.mjs";

const NAME = "database";
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
const TEST_WORD = /(^|[^a-z0-9])(test|tests|testing|qa|uat|sandbox|ci|cmtk|dev)([^a-z0-9]|$)/;
const LIVE_WORD = /(^|[^a-z0-9])(prod|production|prd|live)([^a-z0-9]|$)/;

export function looksLikeTest(name) {
    const n = String(name).toLowerCase();
    return TEST_WORD.test(n) && !LIVE_WORD.test(n);
}

const positive = (v, key, fallback) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a whole number above 0`);
    return n;
};

/** One value as plain JSON that reads the same on both systems. */
function plain(v) {
    if (v === undefined) return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "invalid date" : v.toISOString();
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString("hex");
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, plain(v[k])]));
    return v;
}

const compareValues = (a, b) => {
    if (a === b) return 0;
    if (a === null) return -1; // nulls first on both systems
    if (b === null) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const [x, y] = [String(a), String(b)];
    return x < y ? -1 : x > y ? 1 : 0;
};

function tablesOf(s, targetName) {
    if (!Array.isArray(s.tables) || !s.tables.length) throw new Error(`target ${targetName}: tables must list at least one { name, keys } (settings file)`);
    return s.tables.map((t) => {
        if (!t || typeof t.name !== "string") throw new Error(`target ${targetName}: each table needs a name`);
        const keys = typeof t.keys === "string" ? [t.keys] : t.keys;
        if (!Array.isArray(keys) || !keys.length) throw new Error(`table ${t.name} needs keys, the columns that identify a row`);
        if (t.query === undefined) nameParts(t.name, "table");
        for (const k of keys) nameParts(k, "key column");
        const ignore = new Set(t.ignore ?? []);
        for (const k of keys) if (ignore.has(k)) throw new Error(`table ${t.name}: ${k} is a key, so it cannot be left out`);
        return { report: t.as ?? t.name, name: t.name, query: t.query, keys: keys.map(String), ignore };
    });
}

/** One table's rows, by key, sorted. `capped` when there were more than the cap. */
async function snapshot(conn, driver, t, cap) {
    if (t.query !== undefined) assertSelectOnly(t.query, driver.dialect); // before it is wrapped, so a person's query is judged by itself
    const sql = t.query !== undefined ? driver.selectFrom(t.query, t.keys, cap + 1) : driver.selectAll(t.name, t.keys, cap + 1);
    const rows = await conn.query(sql);
    const capped = rows.length > cap;
    const byKey = new Map();
    for (const raw of capped ? rows.slice(0, cap) : rows) {
        const row = {};
        for (const col of Object.keys(raw).sort()) if (!t.ignore.has(col)) row[col] = plain(raw[col]);
        for (const k of t.keys) if (!(k in row)) throw new Error(`table ${t.name}: the key column ${k} is not in its rows`);
        const key = Object.fromEntries(t.keys.map((k) => [k, row[k]]));
        const id = JSON.stringify(t.keys.map((k) => row[k]));
        if (byKey.has(id)) throw new Error(`table ${t.name}: two rows have the key ${id}; the keys must identify one row`);
        byKey.set(id, { key, row });
    }
    const sorted = [...byKey.values()].sort((a, b) => {
        for (const k of t.keys) {
            const d = compareValues(a.key[k], b.key[k]);
            if (d) return d;
        }
        return 0;
    });
    return { rows: new Map(sorted.map((r) => [JSON.stringify(t.keys.map((k) => r.row[k])), r])), order: sorted, capped };
}

function difference(before, after) {
    const removed = before.order.filter((r) => !after.rows.has(JSON.stringify(Object.values(r.key)))).map(({ key, row }) => ({ key, row }));
    const added = [];
    const changed = [];
    for (const { key, row } of after.order) {
        const was = before.rows.get(JSON.stringify(Object.values(key)));
        if (!was) { added.push({ key, row }); continue; }
        const changes = {};
        for (const col of [...new Set([...Object.keys(was.row), ...Object.keys(row)])].sort()) {
            const [x, y] = [was.row[col] ?? null, row[col] ?? null];
            if (JSON.stringify(x) !== JSON.stringify(y)) changes[col] = { before: x, after: y };
        }
        if (Object.keys(changes).length) changed.push({ key, changes });
    }
    return { added, removed, changed };
}

const AGENTS = { "http:": new http.Agent({ keepAlive: false }), "https:": new https.Agent({ keepAlive: false }) };

/** The case's own request, sent to the system. Redirects are answers; no proxy; never reports a response header. */
function sendToSystem(baseUrl, req, extra, timeoutS) {
    return new Promise((resolve, reject) => {
        const url = new URL(baseUrl.replace(/\/+$/, "") + req.path);
        const headers = { ...(req.headers ?? {}), ...extra };
        const body = req.body && typeof req.body === "object" ? JSON.stringify(req.body) : req.body;
        if (typeof req.body === "object" && req.body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
        const data = typeof body === "string" ? Buffer.from(body, "utf8") : undefined;
        if (data) headers["content-length"] = String(data.length);
        const r = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers, agent: AGENTS[url.protocol], timeout: timeoutS * 1000 }, (res) => {
            const chunks = [];
            res.on("data", (d) => chunks.push(d));
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", reject);
        });
        r.on("timeout", () => r.destroy(Object.assign(new Error(`no answer from the system within ${timeoutS}s`), { code: "ETIMEDOUT" })));
        r.on("error", reject);
        if (data) r.write(data);
        r.end();
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAdapter({ drivers = DRIVERS, settings = {}, env = process.env } = {}) {
    const ready = new Map();
    const secrets = new Set();

    const settingsOf = (target) => ({ ...settings["*"], ...settings[target.name], ...target });

    function prepare(target) {
        const s = settingsOf(target);
        for (const k of ["connection", "connection_string", "url", "uri", "password"]) {
            if (s[k] !== undefined) throw new Error(`target ${target.name}: \`${k}\` is not allowed in settings. Put the connection in an environment variable and name it in connection_env`);
        }
        const driver = drivers[s.driver];
        if (!driver) throw new Error(`target ${target.name}: driver must be one of ${Object.keys(drivers).join(", ")}`);
        if (typeof s.connection_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.connection_env)) throw new Error(`target ${target.name}: connection_env must name an environment variable`);
        const connection = env[s.connection_env];
        if (!connection) throw new Error(`target ${target.name}: the environment variable ${s.connection_env} is not set`);
        secrets.add(connection);
        for (const p of driver.secretsOf(connection)) secrets.add(p);
        return { s, driver, connection };
    }

    /** Connect once per target. Nothing runs until the server itself has said this login cannot write. */
    function start(target) {
        if (ready.has(target.name)) return ready.get(target.name);
        const p = prepare(target);
        const opening = (async () => {
            const raw = await p.driver.open(p.connection);
            const conn = { query: (sql, params) => raw.query(assertSelectOnly(sql, p.driver.dialect), params), close: () => raw.close() };
            try {
                const name = await p.driver.databaseName(conn.query);
                if (!looksLikeTest(name) && p.s.test_database !== name) {
                    throw new Error(`target ${target.name}: the database ${JSON.stringify(name)} does not look like a test database, so nothing was read. If it is one, set test_database to that exact name`);
                }
                const rights = await p.driver.whoCanWrite(conn.query);
                if (rights.length) {
                    throw new Error(`target ${target.name}: refused, because this login can write: ${rights.slice(0, 5).join("; ")}${rights.length > 5 ? `; and ${rights.length - 5} more` : ""}. Connect with a read-only login`);
                }
            } catch (err) {
                await raw.close().catch(() => {});
                throw err;
            }
            return { ...p, conn };
        })();
        ready.set(target.name, opening); // a refused login stays refused for this run
        return opening;
    }

    async function run(c, target, headers) {
        for (const v of Object.values(headers ?? {})) if (v) secrets.add(String(v));
        const req = c?.request ?? {};
        const method = String(req.method ?? "GET").toUpperCase();
        for (const k of ["body_file", "body_form", "files", "before"]) {
            if (req[k] !== undefined) return { error: `this adapter does not support \`${k}\`; give the request in \`body\`` };
        }
        const { s, driver, conn } = await start(target);
        const tables = tablesOf(s, target.name);
        const cap = positive(s.row_cap, "row_cap", 1000);
        const appUrl = s.app_url;
        if (!READ_ONLY.has(method) && !appUrl) return { error: `target ${target.name}: ${method} needs app_url, the system that receives the request; without it nothing would happen and the rows would look unchanged` };

        const before = [];
        for (const t of tables) before.push(await snapshot(conn, driver, t, cap));

        const effects = { tables: {} };
        const out = { status: 200, effects };
        const capped = [];
        if (!appUrl) {
            tables.forEach((t, i) => {
                effects.tables[t.report] = { rows: before[i].order.map((r) => r.row), ...(before[i].capped ? { capped: true, row_cap: cap } : {}) };
                if (before[i].capped) capped.push(t.report);
            });
        } else {
            const answer = await sendToSystem(String(appUrl), { ...req, method }, headers ?? {}, positive(s.app_timeout_s, "app_timeout_s", 30));
            out.status = answer.status;
            out.body = answer.body;
            const settle = s.settle_ms === undefined ? 0 : positive(s.settle_ms, "settle_ms", 0);
            if (settle) await sleep(settle);
            for (const [i, t] of tables.entries()) {
                const after = await snapshot(conn, driver, t, cap);
                const wasCapped = before[i].capped || after.capped;
                effects.tables[t.report] = { ...difference(before[i], after), ...(wasCapped ? { capped: true, row_cap: cap } : {}) };
                if (wasCapped) capped.push(t.report);
            }
        }
        // An error too, so a partial reading can never count as a match. The rows read stay in the observation.
        if (capped.length) out.error = `the row cap (${cap}) was hit on ${capped.join(", ")}, so this is only part of the data: raise row_cap, or narrow the table with a query`;
        return out;
    }

    /** Nothing to put back, because each case compares its own before and after. It only checks the target. */
    async function reset(target) {
        await start(target);
        return { ok: true };
    }

    async function close() {
        for (const opening of ready.values()) {
            await opening.then((o) => o.conn.close()).catch(() => {});
        }
        ready.clear();
    }

    function clean(reply) {
        let text = JSON.stringify(reply);
        for (const s of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(JSON.stringify(s).slice(1, -1), "<hidden>");
        return text.replace(/\b(postgres(?:ql)?|mssql|sqlserver):\/\/[^\s"@/]*@/gi, "$1://<hidden>@").replace(/((?:password|pwd)\s*=\s*)[^;\s"]+/gi, "$1<hidden>");
    }

    const describe = () => ({
        name: NAME,
        kinds: [NAME],
        settings: ["driver", "connection_env", "tables", "row_cap", "app_url", "app_timeout_s", "settle_ms", "test_database"],
    });

    return { describe, run, reset, close, clean };
}

const failure = (err) => ({ error: err?.code && typeof err.code === "string" ? `${err.code}: ${err.message}` : `${err?.message ?? err}` });

export function readSettings(args, cwd = process.cwd()) {
    const i = args.indexOf("--settings");
    if (i < 0) return {};
    const file = path.resolve(cwd, args[i + 1] ?? "");
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        throw new Error(`the settings file ${args[i + 1]} could not be read as JSON: ${err.message}`);
    }
}

export async function serve(adapter, input = process.stdin, output = process.stdout) {
    for await (const line of readline.createInterface({ input })) {
        let reply;
        try {
            const msg = JSON.parse(line);
            if (msg.op === "describe") reply = adapter.describe();
            else if (msg.op === "run") reply = await adapter.run(msg.case, msg.target, msg.headers);
            else if (msg.op === "reset") reply = await adapter.reset(msg.target);
            else reply = { error: `unknown op ${msg.op}` };
        } catch (err) {
            reply = { ok: false, ...failure(err) };
        }
        output.write(adapter.clean(reply) + "\n");
    }
    await adapter.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    let settings = {};
    let startup;
    try { settings = readSettings(process.argv.slice(2)); } catch (err) { startup = err; }
    const adapter = createAdapter({ settings });
    await serve(startup ? { ...adapter, run: () => { throw startup; }, reset: () => { throw startup; } } : adapter);
    process.exit(0); // a database client may keep timers alive after close
}
