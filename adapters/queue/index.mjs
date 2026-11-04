#!/usr/bin/env node
// The queue adapter: publish a case's message to a system's input queue, wait until its output
// queues are quiet, and report what arrived. One JSON request per line on stdin, one JSON reply
// per line on stdout; see README.md. Read-only methods only read how many messages wait.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { DRIVERS } from "./drivers.mjs";

const NAME = "queue";
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
const TEST_WORD = /(^|[^a-z0-9])(test|tests|testing|qa|uat|sandbox|ci|cmtk|emulator|dev)([^a-z0-9]|$)/;
const LIVE_WORD = /(^|[^a-z])(prod|production|prd|live)\d*([^a-z]|$)/;
const wordsOf = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** A production word in a name or a host, with or without a number: prod2, orders-live. Nothing can name such a one as test. */
export const holdsProductionMarker = (text) => LIVE_WORD.test(wordsOf(text));

/** Whether a namespace or virtual host looks like one kept for testing. "/" does not, and neither does anything that says prod or live. */
export function looksLikeTest(name) {
    const n = String(name).toLowerCase();
    // `prod` inside a longer word, as in products, is not a marker but is not a test name either. A person can name that one exactly.
    return TEST_WORD.test(n) && !LIVE_WORD.test(wordsOf(name)) && !n.includes("prod");
}

const positive = (v, key, fallback) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a number above 0`);
    return n;
};

/** A list as JSON or as comma-separated text (target settings can only hold text), or a map of report name to queue. Gives report name to queue. */
function queueMap(v) {
    if (v === undefined || v === "") return {};
    if (typeof v === "string") v = v.split(",").map((q) => q.trim()).filter(Boolean);
    if (Array.isArray(v)) return Object.fromEntries(v.map((q) => [String(q), String(q)]));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, q]) => [k, String(q)]));
    throw new Error("output_queues must be a list, comma-separated text, or a map of report name to queue");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A message as plain facts. JSON is reported as JSON, so the engine compares it field by field. */
function report(m, propertyNames) {
    const out = {};
    let text;
    if (Buffer.isBuffer(m.body) || m.body instanceof Uint8Array) {
        try { text = UTF8.decode(m.body); } catch { out.body = Buffer.from(m.body).toString("base64"); out.body_encoding = "base64"; }
    } else if (typeof m.body === "string") text = m.body;
    else out.body = m.body ?? null; // the Service Bus client has already decoded it
    if (text !== undefined) {
        try { out.body = JSON.parse(text); } catch { out.body = text; }
    }
    if (m.contentType) out.content_type = m.contentType;
    if (propertyNames.length) {
        out.properties = {};
        for (const p of propertyNames) if (m.properties?.[p] !== undefined) out.properties[p] = m.properties[p];
    }
    return out;
}

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
    return JSON.stringify(v) ?? "null";
}
const byContent = (a, b) => { const [x, y] = [canonical(a), canonical(b)]; return x < y ? -1 : x > y ? 1 : 0; };

export function createAdapter({ drivers = DRIVERS, settings = {}, env = process.env } = {}) {
    const open = new Map();
    const secrets = new Set();

    const settingsOf = (target) => ({ ...settings["*"], ...settings[target.name], ...target });

    /** Everything that can be refused without touching the network. */
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
        const namespace = driver.namespaceOf(connection);
        if ((driver.hostsOf?.(connection) ?? []).some(holdsProductionMarker)) {
            throw new Error(`target ${target.name}: the connection's host holds a production marker, so nothing was sent. test_namespace does not change that`);
        }
        if (holdsProductionMarker(namespace)) {
            throw new Error(`target ${target.name}: ${JSON.stringify(namespace)} does not look like a test namespace or virtual host: it holds a production marker, so nothing was sent. test_namespace does not change that`);
        }
        if (!looksLikeTest(namespace) && s.test_namespace !== namespace) {
            throw new Error(`target ${target.name}: ${JSON.stringify(namespace)} does not look like a test namespace or virtual host, so nothing was sent. If it is one, set test_namespace to that exact name`);
        }
        return { s, driver, connection };
    }

    async function connect(target, p) {
        if (!open.has(target.name)) open.set(target.name, await p.driver.open(p.connection));
        return open.get(target.name);
    }

    async function run(c, target, headers) {
        for (const v of Object.values(headers ?? {})) if (v) secrets.add(String(v));
        const req = c?.request ?? {};
        const method = String(req.method ?? "GET").toUpperCase();
        for (const k of ["body_file", "body_form", "files", "before"]) {
            if (req[k] !== undefined) return { error: `this adapter does not support \`${k}\`; give the message in \`body\`` };
        }
        const p = prepare(target);
        const { s } = p;
        const outputs = queueMap(s.output_queues);
        const input = s.input_queue === undefined ? undefined : String(s.input_queue);

        if (READ_ONLY.has(method)) {
            const conn = await connect(target, p);
            const queues = {};
            for (const [name, q] of Object.entries({ ...(input ? { input } : {}), ...outputs })) {
                const d = await conn.depth(q);
                queues[name] = { depth: d.count, ...(d.capped ? { at_least: true } : {}) };
            }
            return { status: 200, effects: { queues } };
        }

        if (method !== "POST") return { error: `${method} has no meaning for a queue: POST publishes, and GET reads how many messages wait` };
        if (c.safe === true) return { error: "publishing changes state, so this case cannot be marked safe: remove `safe: true`, and it runs only with both unsafe switches on" };
        if (target.name === "check" && s.kit_may_publish !== true) return { error: "the conformance kit has no unsafe switches, so it may not publish: use a GET sample, or set kit_may_publish on the check target of a test namespace" };
        if (!input) return { error: `target ${target.name}: input_queue is not set` };
        // The case loader turns a mapping into JSON text; the conformance kit passes samples as written.
        const body = req.body && typeof req.body === "object" ? JSON.stringify(req.body) : req.body;
        if (typeof body !== "string") return { error: "publishing needs a message in `body`" };
        const contentType = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? (typeof req.body === "object" ? "application/json" : undefined);
        const quietMs = positive(s.quiet_ms, "quiet_ms", 1000);
        const limitMs = positive(s.limit_ms, "limit_ms", 30000);
        const maxMessages = positive(s.max_messages, "max_messages", 1000);
        const names = Array.isArray(s.properties) ? s.properties : String(s.properties ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        const properties = c.properties && typeof c.properties === "object" ? c.properties : {};

        const conn = await connect(target, p);
        // The clean start happens here and not in reset: see reset below.
        for (const q of new Set([input, ...Object.values(outputs)])) await conn.purge(q);
        await conn.publish(input, { body: Buffer.from(body, "utf8"), ...(contentType ? { contentType } : {}), properties });

        const got = Object.fromEntries(Object.keys(outputs).map((k) => [k, []]));
        const started = Date.now();
        let last = started;
        let count = 0;
        let problem;
        const poll = Math.min(100, quietMs);
        for (;;) {
            for (const [name, q] of Object.entries(outputs)) {
                const taken = await conn.take(q, poll);
                if (taken.length) last = Date.now();
                count += taken.length;
                got[name].push(...taken.map((m) => report(m, names)));
            }
            const now = Date.now();
            if (now - last >= quietMs) break;
            if (count >= maxMessages) { problem = `more than max_messages (${maxMessages}) arrived, so this is only part of the output`; break; }
            if (now - started >= limitMs) { problem = `messages were still arriving after limit_ms (${limitMs}), so this is only part of the output`; break; }
            await sleep(poll);
        }
        const inOrder = !(c.order_matters === false || s.order_matters === false);
        if (!inOrder) for (const list of Object.values(got)) list.sort(byContent);
        return {
            status: 200,
            effects: { outputs: got, ...(inOrder ? {} : { compared_as: "set" }), ...(problem ? { partial: true } : {}) },
            // An error too, so a partial reading can never count as a match.
            ...(problem ? { error: problem } : {}),
        };
    }

    /**
     * `cmtk compare` calls reset before every case, read-only ones too, and reset is not told which
     * case comes next. A read-only case must change nothing, so reset only checks the target.
     * Queues are emptied immediately before a publish, which also covers `cmtk run` (no reset at all).
     */
    async function reset(target) {
        prepare(target);
        return { ok: true };
    }

    async function close() {
        for (const conn of open.values()) await conn.close().catch(() => {});
        open.clear();
    }

    /** What may leave this process. Every reply passes through here. */
    function clean(reply) {
        let text = JSON.stringify(reply);
        for (const s of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(JSON.stringify(s).slice(1, -1), "<hidden>");
        return text.replace(/\b(amqps?:\/\/)[^\s"@/]*@/g, "$1<hidden>@").replace(/(SharedAccessKey=)[^;\s"]+/gi, "$1<hidden>");
    }

    const describe = () => ({
        name: NAME,
        kinds: [NAME],
        settings: ["driver", "connection_env", "input_queue", "output_queues", "properties", "quiet_ms", "limit_ms", "max_messages", "order_matters", "test_namespace"],
    });

    return { describe, run, reset, close, clean };
}

/** The errors a broker gives, with the code first, because the engine reads ECONNREFUSED and the like as "no answer". */
const failure = (err) => ({ error: err?.code && typeof err.code === "string" ? `${err.code}: ${err.message}` : `${err?.message ?? err}` });

/** Settings for every target, by target name, with "*" for all of them. Target settings can only hold text and numbers, so lists go here. */
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
    process.exit(0); // a broker client may keep timers alive after close
}
