// Regression tests for the independent review of 0.1.0: each test names the problem it guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
    casesToYaml, compare, compareObservations, covers, diffJson, importHar, inside, loadCases, loadManifest, MAX_BODY, parseJsonExact,
    parsePath, recordSignoff, render, run, send, shortPair, signoffState, checkExpectation,
} from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-review-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const M = { scrub: { json_paths: [], xml_ignore: [], regex: [] }, compare_headers: [] };
const json = (body) => ({ status: 200, headers: { "content-type": "application/json" }, body });
const xml = (body) => ({ status: 200, headers: { "content-type": "text/xml" }, body });
const where = (a, b, level = "exact") => compareObservations(a, b, M, level).map((d) => d.where);
const OPTS = { timeoutS: 2, insecureTls: false };
const GET = (p) => ({ id: "X", request: { method: "GET", path: p } });

function server(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

// ---------------------------------------------------------------- 1, 2: the HTTP adapter

test("a streaming answer ends at the timeout instead of hanging the run", async () => {
    const s = await server((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const t = setInterval(() => res.write("data: ping\n\n"), 100);
        res.on("close", () => clearInterval(t));
    });
    try {
        const started = Date.now();
        const o = await send(s.url, GET("/events"), {}, { timeoutS: 1, insecureTls: false });
        assert.match(o.error, /within 1s/);
        assert.ok(Date.now() - started < 3000);
    } finally {
        await s.close();
    }
});

test("a compressed answer is capped after decompression, and a large one stops being read", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024));
    const s = await server((req, res) => {
        if (req.url === "/bomb") { res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }); return res.end(bomb); }
        res.writeHead(200, { "content-type": "text/plain" });
        const t = setInterval(() => res.write(Buffer.alloc(1024 * 1024, 97)), 5); // never ends on its own
        res.on("close", () => clearInterval(t));
    });
    try {
        const a = await send(s.url, GET("/bomb"), {}, OPTS);
        assert.equal(a.truncated, true);
        assert.ok(a.body.length <= MAX_BODY);
        const b = await send(s.url, GET("/endless"), {}, OPTS);
        assert.equal(b.truncated, true, "reading stops at the cap rather than at the timeout");
        assert.equal(b.error, undefined);
    } finally {
        await s.close();
    }
});

test("bytes that are not UTF-8 keep every byte, so different bytes are a difference", async () => {
    const s = await server((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(Buffer.from([0x63, 0x61, 0x66, req.url === "/a" ? 0xe9 : 0xe8])); });
    try {
        const a = await send(s.url, GET("/a"), {}, OPTS), b = await send(s.url, GET("/b"), {}, OPTS);
        assert.equal(a.body_encoding, "latin1");
        assert.deepEqual(where(a, b), ["body line 1"]);
        const utf8 = { ...a, body: "café", body_encoding: undefined };
        assert.deepEqual(where(utf8, a), ["body encoding"], "the same text in another encoding differs at exact");
        assert.deepEqual(where(utf8, a, "semantic"), []);
    } finally {
        await s.close();
    }
});

test("requests go straight to the target even when Node is told to use a proxy", async () => {
    let proxied = 0;
    const proxy = await server((req, res) => { proxied++; res.end("proxy"); });
    const target = await server((req, res) => res.end("target"));
    const script = `import { send } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        const o = await send(${JSON.stringify(target.url)}, { id: "X", request: { method: "GET", path: "/" } }, {}, { timeoutS: 5, insecureTls: false });
        process.stdout.write(o.body ?? o.error);`;
    try {
        const out = await new Promise((resolve) => {
            const c = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy.url, http_proxy: proxy.url, NO_PROXY: "", no_proxy: "" } });
            let text = "";
            c.stdout.on("data", (d) => { text += d; });
            c.on("close", () => resolve(text));
        });
        assert.equal(out, "target");
        assert.equal(proxied, 0);
    } finally {
        await proxy.close();
        await target.close();
    }
});

test("a mapping as a request body is sent as JSON", async () => {
    let got;
    const s = await server((req, res) => { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { got = { b, ct: req.headers["content-type"] }; res.end("{}"); }); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\nallow_unsafe_methods: true\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - id: NEW\n    request: { method: POST, path: /orders, body: { sku: MUG-1, qty: 2 } }\n    expect: { status: 200 }\n");
    try {
        const r = await run(loadManifest(path.join(dir, "cmtk.yaml")), { allowUnsafe: true });
        assert.equal(r.verdict, "PASS");
        assert.deepEqual(JSON.parse(got.b), { sku: "MUG-1", qty: 2 });
        assert.equal(got.ct, "application/json");
    } finally {
        await s.close();
    }
});

test("changing data needs both switches: each one alone sends nothing", async () => {
    let posts = 0;
    const s = await server((req, res) => { if (req.method === "POST") posts++; res.end("{}"); });
    const dir = tmp();
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: PAY, request: { method: POST, path: /pay, body: '{}' }, expect: { status: 200 } }\n");
    const m = (allow) => { write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\nallow_unsafe_methods: ${allow}\n`); return loadManifest(path.join(dir, "cmtk.yaml")); };
    try {
        assert.equal((await run(m(true))).cases[0].result, "SKIPPED", "the setting without the flag");
        assert.equal((await run(m(false), { allowUnsafe: true })).cases[0].result, "SKIPPED", "the flag without the setting");
        assert.equal(posts, 0);
        assert.equal((await run(m(true), { allowUnsafe: true })).cases[0].result, "PASS");
        assert.equal(posts, 1);
    } finally {
        await s.close();
    }
});

// ---------------------------------------------------------------- 3: one bad input never ends the run

test("bad input stops before evidence is touched, and a failing case never ends the run", async () => {
    const s = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"name":"Mug"}'); });
    const dir = tmp();
    const manifest = (extra = "") => {
        write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: ${s.url}\n  candidate: ${s.url}/\nreference: legacy\ncandidate: candidate\n${extra}`);
        return loadManifest(path.join(dir, "cmtk.yaml"));
    };
    try {
        write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: OK, request: GET /a, expect: { status: 200 } }\n");
        assert.equal((await run(manifest())).verdict, "PASS");
        const kept = path.join(dir, "cmtk/evidence/run/REPORT.json");

        process.env.CMTK_BAD = "Bearer abc\n";
        await assert.rejects(() => run(manifest("headers_from_env: { Authorization: CMTK_BAD }\n")), /CMTK_BAD holds a line break/);
        delete process.env.CMTK_BAD;
        write(dir, "cmtk/cases/b.yaml", "cases:\n  - { id: Q, surface: queue, request: GET /q, expect: { status: 200 } }\n");
        await assert.rejects(() => run(manifest()), /surface "queue"/);
        assert.ok(fs.existsSync(kept), "the last evidence is still there");

        write(dir, "cmtk/cases/b.yaml", `cases:
  - { id: REGEX, request: GET /a, expect: { json: { "$.name": { matches: "([" } } } }
  - { id: MISSING, surface: ghost, request: GET /a, expect: { status: 200 } }
  - { id: RESET, surface: flaky, request: GET /a }
`);
        write(dir, "flaky.mjs", `import readline from "node:readline";
for await (const l of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(l);
  process.stdout.write(JSON.stringify(m.op === "reset" ? { ok: false, error: "database locked" } : { status: 200 }) + "\\n");
}`);
        const adapters = `adapters:\n  ghost: { command: cmtk-no-such-program-anywhere }\n  flaky: { command: ${JSON.stringify(process.execPath)}, args: [flaky.mjs] }\n`;
        const r = await run(manifest(adapters));
        const by = Object.fromEntries(r.cases.map((c) => [c.id, c]));
        assert.equal(by.OK.result, "PASS");
        assert.match(by.REGEX.why, /not a valid regular expression/);
        assert.match(by.MISSING.why, /could not start/);
        assert.equal(r.verdict, "INCOMPLETE");
        const c = await compare(manifest(adapters));
        assert.match(Object.fromEntries(c.cases.map((x) => [x.id, x])).RESET.why, /could not reset legacy: database locked/);
    } finally {
        await s.close();
    }
});

// ---------------------------------------------------------------- 4: HAR import never writes a credential

test("HAR import keeps credentials out of query strings, bodies and headers", () => {
    const dir = tmp();
    const h = (name, value) => ({ name, value });
    const entries = [
        { request: { method: "POST", url: "http://l/login", headers: [h("Content-Type", "application/json")], postData: { mimeType: "application/json", text: '{"user":"ann","password":"hunter2","remember":true}' } } },
        { request: { method: "GET", url: "http://l/api/items?access_token=tok123&page=2&author=ann", headers: [h("X-API-Key", "key123"), h("Ocp-Apim-Subscription-Key", "sub123"), h("Accept", "application/json")] } },
        { request: { method: "POST", url: "http://l/form", headers: [], postData: { mimeType: "application/x-www-form-urlencoded", text: "user=ann&pwd=pw123&otp=654321" } } },
        { request: { method: "POST", url: "http://l/Billing.svc", headers: [h("Content-Type", "text/xml")], postData: { mimeType: "text/xml", text: "<s:Envelope><s:Header><wsse:Password>soap123</wsse:Password></s:Header><s:Body><GetTotal/></s:Body></s:Envelope>" } } },
    ];
    write(dir, "w.har", JSON.stringify({ log: { entries } }));
    const r = importHar([path.join(dir, "w.har")]);
    const yaml = casesToYaml(r.cases);
    for (const secret of ["hunter2", "tok123", "key123", "sub123", "pw123", "654321", "soap123"]) assert.ok(!yaml.includes(secret), secret);
    assert.ok(yaml.includes("page=2") && yaml.includes("author=ann") && yaml.includes('"user":"ann"'), "everything else is kept");
    assert.deepEqual(r.redacted, ["HAR-001", "HAR-002", "HAR-003", "HAR-004"]);
});

test("HAR import: key headers, XML attributes and CDATA; the rest of a body is kept exactly", () => {
    const dir = tmp();
    const entries = [
        { request: { method: "GET", url: "http://l/api/run", headers: [{ name: "x-functions-key", value: "fnkey123" }, { name: "Accept", value: "*/*" }] } },
        { request: { method: "POST", url: "http://l/Login.svc", headers: [], postData: { mimeType: "text/xml", text: '<Login user="ann" password="attr123"/><Pwd><![CDATA[cdata123]]></Pwd><Note><![CDATA[keep me]]></Note>' } } },
        { request: { method: "POST", url: "http://l/login", headers: [], postData: { mimeType: "application/json", text: '{"id":12345678901234567890,"price":10.0,"2":"b","1":"a","password":"pw"}' } } },
    ];
    write(dir, "w.har", JSON.stringify({ log: { entries } }));
    const r = importHar([path.join(dir, "w.har")]);
    const yaml = casesToYaml(r.cases);
    for (const secret of ["fnkey123", "attr123", "cdata123"]) assert.ok(!yaml.includes(secret), secret);
    assert.ok(yaml.includes('user="ann"') && yaml.includes("keep me"));
    assert.equal(r.cases[2].request.body, '{"id":12345678901234567890,"price":10.0,"2":"b","1":"a","password":"REDACTED"}');
});

// ---------------------------------------------------------------- 5: the diff misses nothing real

test("JSON: own keys only, key order as sent, every digit of a number", () => {
    const d = (a, b, semantic = false) => diffJson(parseJsonExact(a), parseJsonExact(b), semantic).map((x) => x.where);
    assert.deepEqual(d('{"a":1}', '{"a":1,"constructor":1}'), ["$.constructor"]);
    assert.deepEqual(d('{"a":1,"valueOf":2}', '{"a":1}'), ["$.valueOf"]);
    assert.deepEqual(d('{"a":1}', '{"a":1,"__proto__":{"x":1}}'), ["$.__proto__"]);
    assert.deepEqual(d('{"2":"b","1":"a"}', '{"1":"a","2":"b"}'), ["$"], "integer-like keys keep their order");
    assert.deepEqual(d('{"id":9007199254740993}', '{"id":9007199254740992}', true), ["$.id"]);
    assert.deepEqual(d('{"t":10}', '{"t":1.0e1}', true), []);
    assert.deepEqual(d('{"\\u0000n":"x"}', '{"\\u0000n":"x"}'), []);
    assert.throws(() => parseJsonExact('{"a":01}'), /malformed number/);
    assert.deepEqual(where(json('{"a":01}'), json('{"a":1}')), ["body line 1"], "invalid JSON is compared as text");
});

test("XML: moved mixed content and leaf whitespace are differences at exact", () => {
    assert.deepEqual(where(xml("<a>x<b/>y</a>"), xml("<a>xy<b/></a>")), ["/a/text()[1]", "/a/text()[2]"]);
    assert.deepEqual(where(xml("<a><n> Bob </n></a>"), xml("<a><n>Bob</n></a>")), ["/a/n/text()"]);
    assert.deepEqual(where(xml("<a><n> Bob </n></a>"), xml("<a><n>Bob</n></a>"), "semantic"), []);
    assert.deepEqual(where(xml("<a>\n  <n>1</n>\n</a>"), xml("<a><n>1</n></a>")), [], "indentation is not data");
});

test("a long value that differs near its end shows where it differs", () => {
    const a = "x".repeat(200) + "A", b = "x".repeat(200) + "B";
    const [ra, rb] = shortPair(a, b);
    assert.notEqual(ra, rb);
    assert.ok(ra.length <= 82 && ra.endsWith("A"));
});

// ---------------------------------------------------------------- 6: every where can be approved

test("drift can name any where a report shows", () => {
    assert.ok(covers("/Envelope/Body/c[2]/text()", "/Envelope/Body/c[2]/text()"));
    assert.ok(!covers("/Envelope/Body/c[2]/text()", "/Envelope/Body/c2/text()"));
    assert.ok(covers("/Envelope/Body/c[*]/text()", "/Envelope/Body/c[7]/text()"));
    assert.ok(covers("contract:api: operation added: *", "contract:api: operation added: GET /b"));
    const odd = render(["it's", "back\\slash"]);
    assert.deepEqual(parsePath(odd).map((t) => t.name), ["it's", "back\\slash"]);
    assert.ok(covers(odd, odd));
});

test("equals ignores key order", () => {
    const o = json('{"a":{"x":1,"y":2}}');
    assert.deepEqual(checkExpectation({ json: { "$.a": { equals: { y: 2, x: 1 } } } }, o), []);
});

// ---------------------------------------------------------------- 7, 8, 9, 11: sign-off, paths, verdicts

async function twoSystems(cases, extra = "") {
    const contract = (added) => JSON.stringify({ paths: { "/a": { get: { responses: { 200: {} } } }, ...(added ? { "/b": { get: { responses: { 200: {} } } } } : {}) } });
    const legacy = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/openapi.json" ? contract(false) : '{"n":1}'); });
    const candidate = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(req.url === "/openapi.json" ? contract(true) : '{"n":1}'); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: ${legacy.url}\n  candidate: ${candidate.url}\n${extra}`);
    write(dir, "cmtk/cases/a.yaml", cases);
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")), close: async () => { await legacy.close(); await candidate.close(); } };
}

test("a contract change needs approval like any other difference", async () => {
    const p = await twoSystems("cases:\n  - { id: A, request: GET /a }\n", "contracts:\n  - { name: api, kind: openapi, path: /openapi.json }\n");
    try {
        const r = await compare(p.m());
        assert.equal(r.contracts[0].result, "COMPATIBLE");
        assert.equal(r.verdict, "NO PARITY", "an added operation is still a change to a locked contract");
        write(p.dir, "cmtk/drift.yaml", "drift:\n  - { id: D1, where: 'contract:api: operation added: GET /b', reason: new endpoint agreed with consumers, approved_by: Test Person }\n");
        const s = await compare(p.m());
        assert.equal(s.verdict, "DRIFT ONLY");
        assert.equal(s.contracts[0].findings[0].drift, "D1");
    } finally {
        await p.close();
    }
});

test("verdicts: a system that is down, partial runs, and drift on partial runs", async () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /a, expect: { status: 200 } }\n");
    const down = await run(loadManifest(path.join(dir, "cmtk.yaml")));
    assert.equal(down.verdict, "NO EVIDENCE");
    assert.match(down.next, /did not answer/);

    const p = await twoSystems("cases:\n  - { id: A, request: GET /a }\n  - { id: B, request: GET /b }\n");
    write(p.dir, "cmtk/drift.yaml", "drift:\n  - { id: D1, case: B, where: $.x, reason: r, approved_by: Test Person }\n  - { id: D2, case: A, where: $.x, reason: r, approved_by: Test Person }\n");
    try {
        const r = await compare(p.m(), { only: ["A"] });
        assert.equal(r.verdict, "INCOMPLETE");
        assert.equal(r.partial, true);
        assert.deepEqual(r.unused_drift, ["D2"], "drift for a case that did not run is not called unused");
    } finally {
        await p.close();
    }
});

test("sign-off is tied to the evidence and refuses a report with no evidence", async () => {
    const p = await twoSystems("cases:\n  - { id: A, request: GET /a }\n");
    try {
        await compare(p.m());
        const dir = path.join(p.dir, "cmtk/evidence/compare");
        assert.deepEqual(signoffState(dir), { state: "none" });
        recordSignoff(dir, { name: "Test Person", role: "Test lead", decision: "accept" }, "2026-10-16");
        assert.equal(signoffState(dir).state, "signed");
        assert.match(fs.readFileSync(path.join(dir, "REPORT.md"), "utf8"), /\| Evidence \| sha256 [0-9a-f]{64} \|/);
        fs.writeFileSync(path.join(dir, "answers", "A.candidate.json"), "{}");
        assert.equal(signoffState(dir).state, "stale", "changed evidence voids the signature");
        await compare(p.m());
        assert.equal(signoffState(dir).state, "none", "running again clears it");
        assert.throws(() => recordSignoff(dir, { name: "", role: "x", decision: "accept" }, "2026-10-16"), /Nothing was signed/);

        recordSignoff(dir, { name: "Ann $& Co", role: "Lead $1 $'", decision: "accept" }, "2026-10-16");
        const md = path.join(dir, "REPORT.md");
        assert.match(fs.readFileSync(md, "utf8"), /^\| Name \| Ann \$& Co \|$/m, "typed text is written as typed");
        assert.match(fs.readFileSync(md, "utf8"), /^\| Role \| Lead \$1 \$' \|$/m);
        fs.writeFileSync(md, fs.readFileSync(md, "utf8").replace("**Verdict: PARITY**", "**Verdict: PASS**"));
        assert.equal(signoffState(dir).state, "stale", "editing the report text voids the signature");
    } finally {
        await p.close();
    }
    const empty = tmp();
    write(empty, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(empty, "cmtk/cases/a.yaml", "cases: []\n");
    await run(loadManifest(path.join(empty, "cmtk.yaml")));
    assert.throws(() => recordSignoff(path.join(empty, "cmtk/evidence/run"), { name: "A", role: "B", decision: "accept" }, "2026-10-16"), /no evidence/);
});

test("evidence is never deleted outside the project, even through a link", async () => {
    const dir = tmp(), outside = tmp();
    write(outside, "run/important.txt", "keep me");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /a, expect: { status: 200 } }\n");
    fs.symlinkSync(outside, path.join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\nevidence: linked\n");
    await assert.rejects(() => run(loadManifest(path.join(dir, "cmtk.yaml"))), /through a link/);
    assert.equal(fs.readFileSync(path.join(outside, "run/important.txt"), "utf8"), "keep me");
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\nevidence: .\n");
    await assert.rejects(() => run(loadManifest(path.join(dir, "cmtk.yaml"))), /project folder itself/);
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    for (const p of [path.resolve(outside, "x.har"), "../x.yaml", process.platform === "win32" ? "D:\\elsewhere\\x.har" : "/etc/x.har"]) assert.throws(() => inside(m, p), /outside the project/);
});

test("ids that would collide as Windows file names are refused, and cases must be globs", () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: Item-1, request: GET /a }\n  - { id: ITEM-1, request: GET /b }\n");
    assert.throws(() => loadCases(m()), /used twice/);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: CON, request: GET /a }\n");
    assert.throws(() => loadCases(m()), /Windows/);
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\ncases: cmtk/cases/*.yaml\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /a }\n");
    assert.equal(loadCases(m()).length, 1, "one glob as a string is accepted");
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\ncases: 3\n");
    assert.throws(() => m(), /glob/);
    assert.ok(HERE);
});
