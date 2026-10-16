// Core engine tests: paths, diffs, contracts, expectations, drift, HAR import, and both modes
// end to end against two local HTTP servers.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
    checkExpectation, compare, compareObservations, coveringDrift, diffOpenApi, diffWsdl, importHar, loadCases, loadManifest,
    matches, parseJsonKeepingNumbers, parsePath, diffJson, run, scrubJson, scrubberOf, SCRUBBED,
} from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const M = { scrub: { json_paths: [], xml_ignore: [], regex: [] }, compare_headers: ["content-type"] };
const obs = (body, ct = "application/json", status = 200) => ({ status, headers: { "content-type": ct }, body });

test("JSON paths: keys, any key, indexes, recursive descent, quoted keys", () => {
    assert.ok(matches(parsePath("$..generatedAt"), ["data", 0, "generatedAt"]));
    assert.ok(matches(parsePath("$.items[*].price"), ["items", 3, "price"]));
    assert.ok(!matches(parsePath("$.items[0].price"), ["items", 3, "price"]));
    assert.ok(matches(parsePath("$.*"), ["anything"]));
    assert.ok(matches(parsePath("$['odd key']"), ["odd key"]));
    assert.throws(() => parsePath("items.price"));
});

test("scrubbing replaces only what the rules name", () => {
    const sc = scrubberOf({ scrub: { json_paths: ["$..at"], xml_ignore: [], regex: [{ pattern: "\\d+", replace: "N" }] } });
    assert.deepEqual(scrubJson({ a: { at: "x" }, at: "y", b: "id 1234" }, sc), { a: { at: SCRUBBED }, at: SCRUBBED, b: "id N" });
});

test("JSON: casing, number format and key order are exact-level differences", () => {
    const casing = diffJson(parseJsonKeepingNumbers('{"InvoiceId":1}'), parseJsonKeepingNumbers('{"invoiceId":1}'), true);
    assert.deepEqual(casing.map((d) => d.where).sort(), ["$.InvoiceId", "$.invoiceId"]);
    const n = (a, b, semantic) => diffJson(parseJsonKeepingNumbers(a), parseJsonKeepingNumbers(b), semantic).length;
    assert.equal(n('{"t":10}', '{"t":10.0}', false), 1);
    assert.equal(n('{"t":10}', '{"t":10.0}', true), 0);
    assert.equal(n('{"a":1,"b":2}', '{"b":2,"a":1}', false), 1);
    assert.equal(n('{"a":1,"b":2}', '{"b":2,"a":1}', true), 0);
    assert.equal(n('{"s":"10"}', '{"s":10}', true), 1, "a string is not a number");
    assert.equal(n('{"n":"a \\"10\\" b"}', '{"n":"a \\"10\\" b"}', false), 0, "numbers inside strings are left alone");
});

test("XML: namespace prefixes do not matter, text and namespaces do", () => {
    const a = obs('<s:E xmlns:s="urn:x"><s:T>1</s:T></s:E>', "text/xml");
    assert.equal(compareObservations(a, obs('<b:E xmlns:b="urn:x"><b:T>1</b:T></b:E>', "text/xml"), M, "exact").length, 0);
    assert.deepEqual(compareObservations(a, obs('<b:E xmlns:b="urn:x"><b:T>2</b:T></b:E>', "text/xml"), M, "exact").map((d) => d.where), ["/E/T/text()"]);
    assert.equal(compareObservations(a, obs('<b:E xmlns:b="urn:y"><b:T>1</b:T></b:E>', "text/xml"), M, "exact").length, 1);
});

test("match levels: contract compares the status only; semantic ignores the charset", () => {
    const a = { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: '{"a":1}' };
    const b = { status: 200, headers: { "content-type": "application/json" }, body: '{"a":2}' };
    assert.equal(compareObservations(a, b, M, "contract").length, 0);
    assert.deepEqual(compareObservations(a, b, M, "semantic").map((d) => d.where), ["$.a"]);
    assert.deepEqual(compareObservations(a, b, M, "exact").map((d) => d.where), ["header:content-type", "$.a"]);
});

test("side effects reported by an adapter are compared like a JSON body", () => {
    const a = { status: 200, effects: { emails: [{ to: "a@x", subject: "Hi" }] } };
    const b = { status: 200, effects: { emails: [{ to: "a@x", subject: "Hello" }] } };
    assert.deepEqual(compareObservations(a, b, M, "exact").map((d) => d.where), ["effects:$.emails[0].subject"]);
});

test("expectations: status, headers, JSON checks and body text", () => {
    const o = { status: 200, headers: { "content-type": "application/json" }, body: '{"items":[{"name":"Mug","price":4.5}],"count":1}' };
    assert.deepEqual(checkExpectation({ status: 200, json: { "$.count": { equals: 1 }, "$.items[*].name": { type: "string" }, "$.missing": { exists: false } } }, o), []);
    const f = checkExpectation({ status: [201, 204], headers: { "Content-Type": { matches: "xml" } }, json: { "$.items[0].price": { equals: 5 } }, body_contains: ["Cup"] }, o);
    assert.deepEqual(f.map((x) => x.check), ["status", "header:content-type", "$.items[0].price", "body"]);
});

test("OpenAPI and WSDL: removals and type changes break consumers, additions do not", () => {
    const api = (extra = {}) => ({ paths: { "/a": { get: { responses: { 200: {}, 404: {} } } }, ...extra }, components: { schemas: { Inv: { properties: { Id: { type: "integer" } } } } } });
    assert.deepEqual(diffOpenApi(api(), api({ "/b": { get: {} } })).map((f) => f.breaking), [false]);
    const changed = api();
    changed.components.schemas.Inv.properties.Id.type = "string";
    delete changed.paths["/a"].get.responses[404];
    assert.ok(diffOpenApi(api(), changed).every((f) => f.breaking));
    const wsdl = (tns) => `<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" targetNamespace="${tns}"><w:portType name="P"><w:operation name="GetTotal"/></w:portType></w:definitions>`;
    assert.deepEqual(diffWsdl(wsdl("http://tempuri.org/"), wsdl("http://tempuri.org/")), []);
    assert.equal(diffWsdl(wsdl("http://tempuri.org/"), wsdl("http://tempuri.org/new"))[0].breaking, true);
});

test("drift: by case or every case, JSON paths with wildcards, other places as globs", () => {
    const ledger = [{ id: "D1", case: "C1", where: "$.items[*].price", reason: "r", approved_by: "p" }, { id: "D2", case: "*", where: "header:*", reason: "r", approved_by: "p" }];
    assert.equal(coveringDrift(ledger, "C1", "$.items[3].price")?.id, "D1");
    assert.equal(coveringDrift(ledger, "C2", "$.items[3].price"), undefined);
    assert.equal(coveringDrift(ledger, "C2", "header:content-type")?.id, "D2");
});

test("HAR import drops credentials, static files and duplicates", () => {
    const dir = tmp();
    const entry = (url, method = "GET", body) => ({ request: { method, url, headers: [{ name: "Cookie", value: "secret" }, { name: "Authorization", value: "Bearer secret" }, { name: "Accept", value: "application/json" }, { name: ":authority", value: "x" }], ...(body ? { postData: { text: body } } : {}) } });
    write(dir, "w.har", JSON.stringify({ log: { entries: [entry("http://l/api/i/42"), entry("http://l/api/i/42"), entry("http://l/site.css"), entry("http://l/api/pay", "POST", "{}")] } }));
    const r = importHar([path.join(dir, "w.har")]);
    assert.equal(r.cases.length, 2);
    assert.equal(r.skipped, 2);
    assert.ok(!JSON.stringify(r.cases).includes("secret"));
    assert.deepEqual(r.cases.map((c) => c.id), ["HAR-001", "HAR-002"]);
    assert.ok(r.droppedHeaders.includes("cookie"));
});

// ---------------------------------------------------------------- end to end

function server(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)), server: s }));
    });
}

const send = (res, code, ct, body) => { res.writeHead(code, { "content-type": ct }); res.end(body); };

function system(isNew) {
    return (req, res) => {
        let auth = req.headers.authorization;
        if (req.url === "/swagger.json") return send(res, 200, "application/json", JSON.stringify({ paths: { "/api/items": { get: { responses: { 200: {} } } }, ...(isNew ? {} : { "/api/health": { get: { responses: { 200: {} } } } }) } }));
        if (req.url === "/api/items") return send(res, 200, "application/json", JSON.stringify({ count: 2, generatedAt: isNew ? "2026-10-16T10:00:01" : "2026-10-16T10:00:00", items: [{ name: "Mug" }, { name: "Cup" }] }));
        if (req.url === "/api/price") return send(res, 200, "application/json", isNew ? '{"total":10.0}' : '{"total":10}');
        if (req.url === "/api/who") return send(res, 200, "text/plain", auth ?? "anonymous");
        if (req.url === "/redirect") { res.writeHead(302, { location: "/elsewhere" }); return res.end(); }
        if (req.method === "POST") return send(res, 201, "application/json", "{}");
        return send(res, 404, "text/plain", "nope");
    };
}

async function project(cases, extra = "") {
    const legacy = await server(system(false));
    const candidate = await server(system(true));
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: shop\ntargets:\n  legacy: { base_url: ${legacy.url} }\n  candidate: { base_url: ${candidate.url} }\n${extra}`);
    write(dir, "cmtk/cases/a.yaml", cases);
    return { dir, manifest: () => loadManifest(path.join(dir, "cmtk.yaml")), close: async () => { await legacy.close(); await candidate.close(); } };
}

test("cmtk run: expectations per requirement, a report, and unsafe requests skipped", async () => {
    const p = await project(`cases:
  - id: ITEMS-1
    requirement: STORY-1/AC-1
    request: GET /api/items
    expect: { status: 200, json: { "$.count": { equals: 2 }, "$.items[*].name": { type: string } } }
  - id: ITEMS-2
    requirement: [STORY-1/AC-2]
    request: GET /api/items
    expect: { json: { "$.count": { equals: 3 } } }
  - id: PAY-1
    requirement: STORY-2
    request: { method: POST, path: /api/pay, body: "{}" }
    expect: { status: 201 }
  - id: NOTHING
    request: GET /api/items
`);
    try {
        const r = await run(p.manifest(), { date: "2026-10-16" });
        assert.equal(r.verdict, "FAIL");
        assert.deepEqual(r.cases.map((c) => c.result), ["PASS", "FAIL", "SKIPPED", "SKIPPED"]);
        assert.deepEqual(r.requirements.map((q) => [q.requirement, q.passed, q.failed, q.other]), [["(no requirement named)", 0, 0, 1], ["STORY-1/AC-1", 1, 0, 0], ["STORY-1/AC-2", 0, 1, 0], ["STORY-2", 0, 0, 1]]);
        const md = fs.readFileSync(path.join(p.dir, "cmtk/evidence/run/REPORT.md"), "utf8");
        assert.match(md, /\*\*Verdict: FAIL\*\*/);
        assert.match(md, /\| Decision \| accept \/ accept with conditions \/ reject \|/);
        assert.ok(fs.existsSync(path.join(p.dir, "cmtk/evidence/run/answers/ITEMS-1.json")));
    } finally {
        await p.close();
    }
});

test("cmtk compare: contracts, differences, noise suggestions, drift and match levels", async () => {
    const cases = `cases:
  - { id: ITEMS, request: GET /api/items }
  - { id: PRICE, request: GET /api/price }
  - { id: GONE, request: GET /missing }
  - { id: REDIR, request: GET /redirect }
`;
    const p = await project(cases, "contracts:\n  - { name: api, kind: openapi, path: /swagger.json }\n");
    try {
        const r = await compare(p.manifest(), { date: "2026-10-16" });
        assert.equal(r.verdict, "NO PARITY");
        assert.equal(r.contracts[0].result, "BREAKING");
        const by = Object.fromEntries(r.cases.map((c) => [c.id, c]));
        assert.equal(by.ITEMS.result, "DIFFERENT");
        assert.deepEqual(by.ITEMS.differences.map((d) => d.where), ["$.generatedAt"]);
        assert.equal(by.PRICE.result, "DIFFERENT");
        assert.equal(by.GONE.result, "MATCH");
        assert.equal(by.REDIR.result, "MATCH", "a redirect is compared, not followed");
        assert.deepEqual(r.suggested_scrubs.map((s) => s.where), ["$.generatedAt"]);
    } finally {
        await p.close();
    }
    const q = await project(cases, `overrides:\n  - { path: /api/price, match: semantic }\nscrub: { json_paths: ["$..generatedAt"] }\ndrift: cmtk/drift.yaml\n`);
    write(q.dir, "cmtk/drift.yaml", "drift:\n  - { id: DRIFT-1, case: '*', where: '$.nothing', reason: stale, approved_by: Test Person }\n");
    try {
        const r = await compare(q.manifest(), { date: "2026-10-16" });
        assert.equal(r.verdict, "PARITY");
        assert.deepEqual(r.unused_drift, ["DRIFT-1"]);
    } finally {
        await q.close();
    }
});

test("cmtk compare: approved drift gives DRIFT ONLY, not PARITY", async () => {
    const p = await project("cases:\n  - { id: PRICE, request: GET /api/price }\n", "drift: cmtk/drift.yaml\n");
    write(p.dir, "cmtk/drift.yaml", "drift:\n  - { id: DRIFT-1, case: PRICE, where: $.total, reason: decimals now always shown, approved_by: Test Person }\n");
    try {
        const r = await compare(p.manifest(), { date: "2026-10-16" });
        assert.equal(r.verdict, "DRIFT ONLY");
        assert.equal(r.cases[0].result, "DRIFT");
        assert.equal(r.cases[0].differences[0].drift, "DRIFT-1");
    } finally {
        await p.close();
    }
});

test("secrets come from the environment, reach the system, and never reach disk", async () => {
    const p = await project("cases:\n  - { id: WHO, request: GET /api/who, expect: { body_contains: [Bearer] } }\n", "headers_from_env: { Authorization: CMTK_TEST_TOKEN }\n");
    process.env.CMTK_TEST_TOKEN = "Bearer s3cr3t-value";
    try {
        const r = await run(p.manifest(), { date: "2026-10-16" });
        assert.equal(r.verdict, "PASS");
        const answer = fs.readFileSync(path.join(p.dir, "cmtk/evidence/run/answers/WHO.json"), "utf8");
        assert.match(answer, /s3cr3t/, "the system echoed it back, so its own answer holds it");
        for (const f of ["REPORT.md", "REPORT.json"]) assert.ok(!fs.readFileSync(path.join(p.dir, "cmtk/evidence/run", f), "utf8").includes("s3cr3t"), f);
        assert.ok(!fs.readFileSync(path.join(p.dir, "cmtk.yaml"), "utf8").includes("s3cr3t"));
    } finally {
        delete process.env.CMTK_TEST_TOKEN;
        await p.close();
    }
    await assert.rejects(() => run(p.manifest()), /CMTK_TEST_TOKEN/);
});

test("settings and cases are checked before anything is sent", async () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: ftp://x }\n");
    assert.throws(() => loadManifest(path.join(dir, "cmtk.yaml")), /http/);
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: http://127.0.0.1:9 }\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: X, request: GET //evil.example/x }\n");
    assert.throws(() => loadCases(loadManifest(path.join(dir, "cmtk.yaml"))), /single '\/'/);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: X, request: GET /a }\n  - { id: X, request: GET /b }\n");
    assert.throws(() => loadCases(loadManifest(path.join(dir, "cmtk.yaml"))), /used twice/);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: X, request: GET /a }\n");
    await assert.rejects(() => compare(loadManifest(path.join(dir, "cmtk.yaml"))), /reference/);
    write(dir, "cmtk/drift.yaml", "drift:\n  - { id: D1, where: $.a, reason: r }\n");
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  legacy: http://127.0.0.1:9\n  candidate: http://127.0.0.1:8\n");
    await assert.rejects(() => compare(loadManifest(path.join(dir, "cmtk.yaml"))), /approved_by/);
});
