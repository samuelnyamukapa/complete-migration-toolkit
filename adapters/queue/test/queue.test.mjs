// The queue adapter: both drivers over an in-memory broker, the real conformance kit and a real
// `cmtk compare`. No network. The real brokers are covered by real-server.test.mjs, in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { confirmSafe, loadCases, loadManifest } from "../../../packages/core/dist/index.js";
import { createAdapter, looksLikeTest } from "../index.mjs";
import { rabbitmqDriver, serviceBusDriver } from "../drivers.mjs";
import { fakeAmqplib, fakeServiceBus, makeBroker } from "./support/fake-broker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..");
const CLI = path.join(ADAPTER, "..", "..", "packages", "cli", "dist", "main.js");
const STANDIN = path.join(HERE, "support", "standin.mjs");

const RABBIT = "amqp://bob:s3cret-pw@broker.example:5672/orders-test";
const BUS = "Endpoint=sb://orders-test.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=s3cret-key";

const order = { id: "ORD-1", total: 10 };
const worker = () => [
    { queue: "out", body: { n: 1 }, properties: { tenant: "t1", other: "left out" } },
    { queue: "out", body: { n: 2 } },
    { queue: "audit", body: { seen: true } },
];
const POST = { id: "Q", request: { method: "POST", path: "/orders", headers: { "Content-Type": "application/json" }, body: JSON.stringify(order) } };
const GET = { id: "D", request: { method: "GET", path: "/depth" } };
const FAST = { input_queue: "in", output_queues: "out,audit", quiet_ms: 150, limit_ms: 5000 };

function rig(kind = "rabbitmq", extra = {}, w = worker) {
    const broker = makeBroker(w);
    const drivers = {
        rabbitmq: rabbitmqDriver(async () => fakeAmqplib(() => broker)),
        servicebus: serviceBusDriver(async () => fakeServiceBus(() => broker)),
    };
    const a = createAdapter({
        drivers,
        env: { CONN: kind === "rabbitmq" ? RABBIT : BUS },
        settings: { sys: { ...FAST, driver: kind, connection_env: "CONN", ...extra } },
    });
    return { a, broker, target: { name: "sys" } };
}
const old = () => ({ body: Buffer.from('{"left":"over"}'), contentType: "application/json", properties: {} });

for (const kind of ["rabbitmq", "servicebus"]) {
    test(`${kind}: publishes, waits until quiet, and reports body, content type and named properties only`, async () => {
        const { a, broker, target } = rig(kind, { properties: "tenant" });
        const o = await a.run(POST, target, {});
        assert.equal(o.error, undefined);
        assert.deepEqual(broker.log.published, [{ queue: "in", body: JSON.stringify(order) }]);
        assert.deepEqual(o.effects.outputs.out, [
            { body: { n: 1 }, content_type: "application/json", properties: { tenant: "t1" } },
            { body: { n: 2 }, content_type: "application/json", properties: {} },
        ]);
        assert.deepEqual(o.effects.outputs.audit, [{ body: { seen: true }, content_type: "application/json", properties: {} }]);
        assert.doesNotMatch(JSON.stringify(o), /changes-every-run|messageId|enqueued/, "ids and times are left out");
    });

    test(`${kind}: a read-only method only reads how many wait: nothing published, purged or taken`, async () => {
        const { a, broker, target } = rig(kind);
        broker.put("out", old());
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
            const o = await a.run({ ...GET, request: { method, path: "/depth" } }, target, {});
            assert.deepEqual(o.effects.queues, { input: { depth: 0 }, out: { depth: 1 }, audit: { depth: 0 } });
        }
        assert.deepEqual(broker.log.published, []);
        assert.equal(broker.queues.get("out").length, 1);
    });

    test(`${kind}: reset leaves the queues alone; a publish empties them first`, async () => {
        const { a, broker, target } = rig(kind);
        broker.put("out", old());
        assert.deepEqual(await a.reset(target), { ok: true });
        assert.equal(broker.queues.get("out").length, 1, "reset comes before read-only cases too, so it must change nothing");
        const o = await a.run(POST, target, {});
        assert.doesNotMatch(JSON.stringify(o.effects), /left/);
    });

    test(`${kind}: a queue that does not exist is an error and is never created`, async () => {
        const { a, broker, target } = rig(kind, { input_queue: "missing" });
        await assert.rejects(a.run(POST, target, {}), /missing/);
        assert.equal(broker.queues.has("missing"), false);
    });
}

test("order: arrival order counts by default; with order_matters false messages compare as a set, duplicates kept", async () => {
    const twice = () => [{ queue: "out", body: { n: 2 } }, { queue: "out", body: { n: 1 } }, { queue: "out", body: { n: 2 } }];
    const { a, target } = rig("rabbitmq", {}, twice);
    const inOrder = await a.run(POST, target, {});
    assert.deepEqual(inOrder.effects.outputs.out.map((m) => m.body.n), [2, 1, 2]);
    assert.equal(inOrder.effects.compared_as, undefined);
    const asSet = await a.run({ ...POST, order_matters: false }, target, {});
    assert.deepEqual(asSet.effects.outputs.out.map((m) => m.body.n), [1, 2, 2]);
    assert.equal(asSet.effects.compared_as, "set");
    const fromSettings = rig("rabbitmq", { order_matters: false }, twice);
    assert.deepEqual((await fromSettings.a.run(POST, fromSettings.target, {})).effects.outputs.out.map((m) => m.body.n), [1, 2, 2]);
});

test("the two systems can use different queue names and report under one name", async () => {
    const { a, target } = rig("rabbitmq", { output_queues: { orders: "out" } });
    const o = await a.run(POST, target, {});
    assert.deepEqual(Object.keys(o.effects.outputs), ["orders"]);
});

test("output that never goes quiet stops at the time limit, and reads as an error, never a match", async () => {
    const broker = makeBroker();
    const drivers = { rabbitmq: rabbitmqDriver(async () => fakeAmqplib(() => broker)) };
    const a = createAdapter({ drivers, env: { CONN: RABBIT }, settings: { sys: { driver: "rabbitmq", connection_env: "CONN", input_queue: "in", output_queues: "out", quiet_ms: 5000, limit_ms: 100 } } });
    const timer = setInterval(() => broker.put("out", old()), 5);
    try {
        const o = await a.run(POST, { name: "sys" }, {});
        assert.match(o.error, /still arriving after limit_ms/);
        assert.equal(o.effects.partial, true);
    } finally {
        clearInterval(timer);
    }
});

test("safety: a publish cannot be marked safe, other methods are refused, and the kit may not publish by default", async () => {
    const { a, broker, target } = rig();
    assert.match((await a.run({ ...POST, safe: true }, target, {})).error, /cannot be marked safe/);
    for (const method of ["PUT", "PATCH", "DELETE"]) assert.match((await a.run({ ...POST, request: { ...POST.request, method } }, target, {})).error, /POST publishes/);
    const checked = rig("rabbitmq");
    const kit = createAdapter({ drivers: { rabbitmq: rabbitmqDriver(async () => fakeAmqplib(() => checked.broker)) }, env: { CONN: RABBIT }, settings: { check: { ...FAST, driver: "rabbitmq", connection_env: "CONN" } } });
    assert.match((await kit.run(POST, { name: "check" }, {})).error, /may not publish/);
    for (const k of ["body_file", "body_form", "files", "before"]) assert.match((await a.run({ ...POST, request: { ...POST.request, [k]: "x" } }, target, {})).error, new RegExp(k));
    assert.deepEqual(broker.log.published, []);
    assert.deepEqual(checked.broker.log.published, []);
});

test("names: only test namespaces and virtual hosts pass, unless settings name that exact one", async () => {
    for (const ok of ["orders-test", "test", "qa.orders", "cmtk_legacy", "emulator", "orders-uat"]) assert.equal(looksLikeTest(ok), true, ok);
    for (const bad of ["/", "orders", "prod-test", "contest", "live-qa", "latest"]) assert.equal(looksLikeTest(bad), false, bad);

    const cases = [
        ["rabbitmq", "amqp://u:p@h/orders", "orders"],
        ["rabbitmq", "amqp://u:p@h", "/"],
        ["rabbitmq", "amqp://u:p@h/%2F", "/"],
        ["servicebus", "Endpoint=sb://contoso.servicebus.windows.net/;SharedAccessKey=x", "contoso"],
    ];
    for (const [driver, connection, name] of cases) {
        const opened = [];
        const importer = async () => { opened.push(driver); throw new Error("must not load"); };
        const drivers = { rabbitmq: rabbitmqDriver(importer), servicebus: serviceBusDriver(importer) };
        const settings = { sys: { driver, connection_env: "CONN", input_queue: "in" } };
        const a = createAdapter({ drivers, settings, env: { CONN: connection } });
        await assert.rejects(a.run(GET, { name: "sys" }, {}), new RegExp(`${JSON.stringify(name).replace("/", "\\/")} does not look like a test`));
        await assert.rejects(a.reset({ name: "sys" }), /does not look like a test/);
        assert.deepEqual(opened, [], "refused before any driver is loaded");
        const named = createAdapter({ drivers, settings: { sys: { ...settings.sys, test_namespace: "another" } }, env: { CONN: connection } });
        await assert.rejects(named.run(GET, { name: "sys" }, {}), /does not look like a test/, "naming a different one does not help");
        const right = createAdapter({ drivers, settings: { sys: { ...settings.sys, test_namespace: name } }, env: { CONN: connection } });
        await assert.rejects(right.run(GET, { name: "sys" }, {}), /must not load/, "naming the exact one gets past the check");
    }
    assert.equal(serviceBusDriver().namespaceOf("Endpoint=sb://localhost;SharedAccessKeyName=k;SharedAccessKey=x;UseDevelopmentEmulator=true"), "emulator");
});

test("names: one holding a production marker is never test, and part of a word is not a marker", () => {
    for (const bad of ["prod2_test", "customers_prod01_dev", "prod-test", "test-production", "qa_prd1", "live2-test", "test.live", "ordersLive_test", "OrdersPROD_qa", "products_test", "reproduce_dev"]) assert.equal(looksLikeTest(bad), false, bad);
    for (const ok of ["delivery-test", "olive_qa", "orders-test"]) assert.equal(looksLikeTest(ok), true, ok);
});

const refusingDrivers = (opened) => {
    const load = async () => { opened.push("loaded"); throw new Error("must not load"); };
    return { rabbitmq: rabbitmqDriver(load), servicebus: serviceBusDriver(load) };
};
const queueRig = (driver, connection, more = {}, opened = []) => createAdapter({ drivers: refusingDrivers(opened), env: { CONN: connection }, settings: { sys: { driver, connection_env: "CONN", queues: { in: "in", out: ["out"] }, ...more } } });

test("a production marker in the name can't be named as test; a word that only holds `prod` can, exactly", async () => {
    const opened = [];
    await assert.rejects(queueRig("rabbitmq", "amqp://b:p@broker.example/prod2_test", { test_namespace: "prod2_test" }, opened).run(GET, { name: "sys" }, {}), /production/);
    assert.deepEqual(opened, []);
    await assert.rejects(queueRig("rabbitmq", "amqp://b:p@broker.example/products_test", { test_namespace: "products_test" }).run(GET, { name: "sys" }, {}), /must not load/);
});

test("the host counts: a production host is refused before any driver loads, whatever the namespace says", async () => {
    for (const [driver, connection] of [
        ["rabbitmq", "amqps://b:s3cret@broker.prod.acme.com/test"],
        ["rabbitmq", "amqp://b:s3cret@prod2-rabbit.acme.com:5672/orders-test"],
        ["rabbitmq", "amqp://b:s3cret@live.acme.com/cmtk"],
        ["servicebus", "Endpoint=sb://acme-prod.servicebus.windows.net/;SharedAccessKeyName=k;SharedAccessKey=s3cret-key;UseDevelopmentEmulator=true"],
        ["servicebus", "Endpoint=sb://acme.prod.example.net/;SharedAccessKeyName=k;SharedAccessKey=s3cret-key"],
    ]) {
        const opened = [];
        for (const more of [{}, { test_namespace: "test" }, { test_namespace: "acme-prod" }, { test_namespace: "acme" }, { test_namespace: "cmtk" }]) {
            await assert.rejects(queueRig(driver, connection, more, opened).run(GET, { name: "sys" }, {}), (e) => /production/.test(e.message) && !e.message.includes("s3cret"), connection);
        }
        assert.deepEqual(opened, [], connection);
    }
    await assert.rejects(queueRig("rabbitmq", "amqp://b:p@products.example/orders-test").run(GET, { name: "sys" }, {}), /must not load/, "a host that only holds `prod` inside a word is left alone");
});

test("the emulator switch counts only on this machine, and a second Endpoint is refused", () => {
    const d = serviceBusDriver();
    const rest = "SharedAccessKeyName=k;SharedAccessKey=x";
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(d.namespaceOf(`Endpoint=sb://${host};${rest};UseDevelopmentEmulator=true`), "emulator", host);
    assert.equal(d.namespaceOf(`Endpoint=sb://acme-prod.servicebus.windows.net/;${rest};UseDevelopmentEmulator=true`), "acme-prod");
    assert.equal(d.namespaceOf(`Endpoint=sb://localhost.evil.example/;${rest};UseDevelopmentEmulator=true`), "localhost");
    assert.throws(() => d.namespaceOf(`${rest};UseDevelopmentEmulator=true`), /no Endpoint/);
    assert.throws(() => d.namespaceOf(`Endpoint=sb://orders-test.example/;Endpoint=sb://acme-prod.example/;${rest}`), /more than one Endpoint/);
});

test("secrets: connections come from the environment only and never appear in a reply", async () => {
    const a = createAdapter({ drivers: { rabbitmq: rabbitmqDriver(async () => fakeAmqplib(() => makeBroker())) }, env: {}, settings: {} });
    await assert.rejects(a.run(GET, { name: "s", driver: "rabbitmq", connection_string: RABBIT }, {}), (e) => /not allowed in settings/.test(e.message) && !e.message.includes("s3cret"));
    await assert.rejects(a.run(GET, { name: "s", driver: "rabbitmq", connection_env: "NOT_THERE" }, {}), /NOT_THERE is not set/);
    await assert.rejects(a.run(GET, { name: "s", driver: "rabbitmq", connection_env: "bad name" }, {}), /must name an environment variable/);

    for (const [driver, conn] of [["rabbitmq", RABBIT], ["servicebus", BUS]]) {
        const failing = async () => { throw new Error(`cannot reach ${conn} with s3cret`); };
        const b = createAdapter({ drivers: { rabbitmq: rabbitmqDriver(failing), servicebus: serviceBusDriver(failing) }, env: { CONN: conn }, settings: {} });
        const err = await b.run(GET, { name: "s", driver, connection_env: "CONN" }, {}).catch((e) => e);
        const out = b.clean({ error: err.message });
        assert.doesNotMatch(out, /s3cret-(pw|key)/);
        assert.match(out, /<hidden>/);
    }
    // A broker that echoes a header or the password back still cannot get it out.
    const c = rig();
    await c.a.run(GET, c.target, { "X-Key": "header-value" });
    assert.doesNotMatch(c.a.clean({ body: "header-value and amqp://bob:other@h/x" }), /header-value|other/);
});

const cmtk = (cwd, env, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

function project({ driver, allowUnsafe = false, settings = {}, cases = [] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-queue-"));
    const settingsFile = path.join(dir, "queue-settings.json");
    const each = { driver, input_queue: "in", output_queues: "out,audit", properties: "tenant", quiet_ms: 250, limit_ms: 10000, ...settings };
    fs.writeFileSync(settingsFile, JSON.stringify({ "*": each, check: { connection_env: "CONN_LEGACY", kit_may_publish: true } }));
    const manifest = {
        system: "orders",
        targets: { legacy: { connection_env: "CONN_LEGACY" }, candidate: { connection_env: "CONN_CANDIDATE" } },
        cases: ["cases/*.yaml"],
        allow_unsafe_methods: allowUnsafe,
        adapters: { queue: { command: process.execPath, args: [STANDIN, "--settings", settingsFile], covers: ["queue"] } },
    };
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(dir, "cases"));
    fs.writeFileSync(path.join(dir, "cases", "a.yaml"), JSON.stringify({ cases }));
    fs.mkdirSync(path.join(dir, "adapters", "queue", "samples"), { recursive: true });
    return dir;
}
const ENV = {
    rabbitmq: { CONN_LEGACY: "amqp://bob:s3cret-pw@h/legacy-test", CONN_CANDIDATE: "amqp://bob:s3cret-pw@h/candidate-test" },
    servicebus: { CONN_LEGACY: "Endpoint=sb://legacy-test.x/;SharedAccessKey=s3cret-key", CONN_CANDIDATE: "Endpoint=sb://candidate-test.x/;SharedAccessKey=s3cret-key" },
};
const PUBLISH = { id: "ORDER-1", surface: "queue", request: { method: "POST", path: "/orders", body: order } };

for (const driver of ["rabbitmq", "servicebus"]) {
    test(`conformance kit, real CLI, ${driver}: the shipped samples, and a publishing sample`, async () => {
        const dir = project({ driver });
        try {
            const samples = path.join(dir, "adapters", "queue", "samples", "cases.yaml");
            fs.copyFileSync(path.join(ADAPTER, "samples", "cases.yaml"), samples);
            let r = await cmtk(dir, ENV[driver], "adapter", "check", "queue");
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /Adapter queue passes the conformance kit/);

            fs.writeFileSync(samples, JSON.stringify({ cases: [PUBLISH] }));
            r = await cmtk(dir, ENV[driver], "adapter", "check", "queue");
            assert.equal(r.status, 0, r.stdout + r.stderr);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });

    test(`end to end, real CLI, ${driver}: compare catches a planted difference, and accepts a reorder only as a set`, async () => {
        const dir = project({ driver, allowUnsafe: true, cases: [PUBLISH] });
        const asSet = path.join(dir, "cases", "a.yaml");
        try {
            let r = await cmtk(dir, { ...ENV[driver], STANDIN_CANDIDATE: "same" }, "compare", "--allow-unsafe", "--json");
            assert.equal(JSON.parse(r.stdout).verdict, "PARITY", r.stdout + r.stderr);

            r = await cmtk(dir, { ...ENV[driver], STANDIN_CANDIDATE: "plant" }, "compare", "--allow-unsafe");
            assert.equal(r.status, 1, r.stdout + r.stderr);
            assert.match(r.stdout, /NO PARITY/);
            assert.match(r.stdout, /effects:\$\.outputs\.out\[0\]\.body\.total: 10 vs 11/);

            r = await cmtk(dir, { ...ENV[driver], STANDIN_CANDIDATE: "reorder" }, "compare", "--allow-unsafe", "--json");
            assert.equal(JSON.parse(r.stdout).verdict, "NO PARITY", "order counts unless the case says otherwise");

            fs.writeFileSync(asSet, JSON.stringify({ cases: [{ ...PUBLISH, order_matters: false }] }));
            r = await cmtk(dir, { ...ENV[driver], STANDIN_CANDIDATE: "reorder" }, "compare", "--allow-unsafe", "--json");
            assert.equal(JSON.parse(r.stdout).verdict, "PARITY", r.stdout + r.stderr);

            const evidence = fs.globSync("cmtk/evidence/**/*.json", { cwd: dir }).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
            assert.ok(evidence.includes("order-seen"), "the evidence holds the messages");
            assert.doesNotMatch(evidence + r.stdout + r.stderr, /s3cret/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    });
}

test("publishing needs both unsafe switches: with either one alone, nothing is published", async () => {
    for (const [allowUnsafe, flag] of [[false, false], [true, false], [false, true]]) {
        const dir = project({ driver: "rabbitmq", allowUnsafe, cases: [PUBLISH] });
        const log = path.join(dir, "published.log");
        try {
            for (const cmd of ["compare", "run"]) {
                const r = await cmtk(dir, { ...ENV.rabbitmq, STANDIN_LOG: log }, cmd, ...(flag ? ["--allow-unsafe"] : []), "--json");
                const outcome = JSON.parse(r.stdout).cases[0];
                assert.equal(outcome.result, "SKIPPED", r.stdout + r.stderr);
                assert.equal(fs.existsSync(log), false, `allow_unsafe_methods=${allowUnsafe} --allow-unsafe=${flag}: nothing may be published`);
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
    }
    // And `safe: true` is no way round them. Written into a file, the engine holds it back.
    // Even once a person confirms it, so the engine lets it through, the adapter refuses it.
    const dir = project({ driver: "rabbitmq", cases: [{ ...PUBLISH, safe: true }] });
    const log = path.join(dir, "published.log");
    try {
        let r = await cmtk(dir, { ...ENV.rabbitmq, STANDIN_LOG: log }, "compare", "--json");
        assert.equal(JSON.parse(r.stdout).cases[0].result, "SKIPPED");
        assert.equal(fs.existsSync(log), false);
        const m = loadManifest(path.join(dir, "cmtk.yaml"));
        confirmSafe(m, PUBLISH.id, "Jo Tester", "2026-11-04", loadCases(m)[0]);
        r = await cmtk(dir, { ...ENV.rabbitmq, STANDIN_LOG: log }, "compare", "--json");
        assert.equal(JSON.parse(r.stdout).cases[0].result, "ERROR");
        assert.equal(fs.existsSync(log), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});

test("a limit hit on either system makes the case an error, so the verdict cannot be PARITY", async () => {
    const dir = project({ driver: "rabbitmq", allowUnsafe: true, settings: { max_messages: 1 }, cases: [PUBLISH] });
    try {
        const r = await cmtk(dir, ENV.rabbitmq, "compare", "--allow-unsafe", "--json");
        const report = JSON.parse(r.stdout);
        assert.equal(report.cases[0].result, "ERROR");
        assert.notEqual(report.verdict, "PARITY");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});

test("a missing driver package gives a clear error, naming the package, from the real adapter with nothing installed", async () => {
    // Copied outside the repository, where no node_modules can supply the package.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-queue-bare-"));
    try {
        for (const f of ["index.mjs", "drivers.mjs"]) fs.copyFileSync(path.join(ADAPTER, f), path.join(dir, f));
        const child = spawn(process.execPath, [path.join(dir, "index.mjs")], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CONN: RABBIT, CONN2: BUS } });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        const done = new Promise((r) => child.on("close", r));
        const line = (target) => JSON.stringify({ op: "run", case: GET, target, headers: {} }) + "\n";
        child.stdin.write(line({ name: "a", driver: "rabbitmq", connection_env: "CONN", input_queue: "in" }));
        child.stdin.write(line({ name: "b", driver: "servicebus", connection_env: "CONN2", input_queue: "in" }));
        child.stdin.end();
        await done;
        const [a, b] = out.trim().split("\n").map((l) => JSON.parse(l));
        assert.match(a.error, /rabbitmq driver needs the amqplib package.*npm install --no-save amqplib@/);
        assert.match(b.error, /servicebus driver needs the @azure\/service-bus package/);
        assert.doesNotMatch(out, /s3cret/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});

test("describe names the adapter, its kinds and its settings", () => {
    const d = createAdapter().describe();
    assert.equal(d.name, "queue");
    assert.deepEqual(d.kinds, ["queue"]);
    assert.ok(d.settings.includes("connection_env"));
});
