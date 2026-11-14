// Performance limits (#33): what the toolkit is tested to handle, as docs/FORMATS.md states them. The budgets are
// generous, so a slow CI machine does not fail them: they catch a change in kind, such as work that grows with the
// square of the input, and not a slow day. Everything runs against stand-ins on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { captureRequests, check, compare, compareObservations, loadCases, loadManifest, MAX_BODY, renderReport, run, shadow, summarise, trendOf } from "../dist/index.js";

const within = async (seconds, what, fn) => {
    const start = performance.now();
    const out = await fn();
    const took = (performance.now() - start) / 1000;
    assert.ok(took < seconds, `${what} took ${took.toFixed(1)} s; the limit is ${seconds} s`);
    return out;
};

function stand(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

const json = (body) => ({ status: 200, headers: { "content-type": "application/json" }, body });
const settings = { scrub: { json_paths: ["$..at"], xml_ignore: [], regex: [] }, compare_headers: [] };

const manyCases = (n) => {
    let yaml = "cases:\n";
    for (let i = 0; i < n; i++) yaml += `  - id: C-${i}\n    requirement: R-${i % 100}\n    request: GET /x/${i}\n    expect: { status: 200 }\n`;
    return yaml;
};

test("5,000 cases are read and checked, and 2,000 run and compared, in time, with a report a person can open", async () => {
    // 2,000 end to end, because each request is a new connection, and Windows has about 16,000 ports to give them.
    const s = await stand((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"path":${JSON.stringify(req.url)}}`); });
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-limits-"));
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), manyCases(5000));
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: big\ntargets:\n  legacy: { base_url: "${s.url}" }\n  candidate: { base_url: "${s.url}" }\n`);
        const m = loadManifest(path.join(dir, "cmtk.yaml"));
        assert.equal((await within(30, "reading 5,000 cases", () => loadCases(m))).length, 5000);
        assert.equal((await within(30, "checking 5,000 cases", () => check(m))).cases, 5000);
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), manyCases(2000));
        const c = await within(120, "comparing 2,000 cases", () => compare(m));
        assert.equal(c.counts.MATCH, 2000);
        assert.equal(c.verdict, "PARITY");
        assert.equal((await within(60, "running 2,000 cases", () => run(m))).counts.PASS, 2000);
        const md = fs.statSync(path.join(dir, "cmtk/evidence/compare/REPORT.md")).size;
        assert.ok(md < 2 * 1024 * 1024, `REPORT.md is ${md} bytes`);
    } finally {
        await s.close();
    }
});

test("a report with 100,000 differences is made in time", async () => {
    const cases = Array.from({ length: 5000 }, (_, i) => ({ id: `C-${i}`, name: `c ${i}`, requirement: [`R-${i % 50}`], surface: "http", result: "DIFFERENT", differences: Array.from({ length: 20 }, (_, k) => ({ where: `$.a[${k}].b`, reference: "1", candidate: "2" })) }));
    const r = await within(20, "summarising 100,000 differences", () => summarise({ mode: "compare", manifest: { system: "x" }, targets: { a: "u", b: "v" }, cases, contracts: [], drift: [], usedDrift: new Set(), date: "2026-01-01", partial: false }));
    assert.equal(r.verdict, "NO PARITY");
    const md = await within(20, "rendering it", () => renderReport(r));
    assert.match(md, /99500 more are in REPORT\.json/, "the report a person reads stays readable");
});

test("big answers up to the 5 MB cap: JSON, a text body and XML", async () => {
    const list = JSON.stringify(Array.from({ length: 80000 }, (_, i) => ({ id: i, name: `item ${i}`, price: i * 1.5, at: "x" })));
    assert.ok(list.length > 4 * 1024 * 1024 && list.length <= MAX_BODY, `${list.length}`);
    assert.deepEqual(await within(30, "comparing 5 MB of equal JSON", () => compareObservations(json(list), json(list), settings, "exact")), []);
    const changed = await within(30, "comparing 5 MB of JSON that differs everywhere", () => compareObservations(json(list), json(list.replace(/item/g, "itex")), settings, "exact"));
    assert.equal(changed.length, 80000);

    const numbers = `[${Array.from({ length: 2500000 }, (_, i) => i % 10).join(",")}]`;
    const worst = await within(60, "the most differences 5 MB can hold", () => compareObservations(json(numbers), json(numbers.replace(/,1,/g, ",2,")), settings, "exact"));
    assert.ok(worst.length > 200000);

    const text = "a line of text\n".repeat(330000);
    const t = await within(30, "comparing 5 MB of text", () => compareObservations({ status: 200, headers: { "content-type": "text/plain" }, body: text }, { status: 200, headers: { "content-type": "text/plain" }, body: `${text}x` }, settings, "exact"));
    assert.equal(t.length, 1);

    const para = "x".repeat(80);
    const xml = `<r>${`<a><b>${para}</b></a>`.repeat(50000)}</r>`;
    assert.ok(xml.length > 4 * 1024 * 1024 && xml.length <= MAX_BODY, `${xml.length}`);
    const xmlHeaders = { "content-type": "text/xml" };
    assert.deepEqual(await within(60, "comparing 5 MB of XML with 100,000 elements", () => compareObservations({ status: 200, headers: xmlHeaders, body: xml }, { status: 200, headers: xmlHeaders, body: xml }, settings, "exact")), []);
});

test("JSON nested deeper than the parser allows is compared as text, not lost", () => {
    const deep = "[".repeat(2000) + "1" + "]".repeat(2000);
    const other = "[".repeat(2000) + "2" + "]".repeat(2000);
    const d = compareObservations(json(deep), json(other), settings, "exact");
    assert.equal(d.length, 1);
    assert.equal(d[0].where, "body line 1");
});

test("an answer over 5 MB: reading stops at the cap, and the verdict is never PARITY or PASS", async () => {
    const big = Buffer.alloc(MAX_BODY + 1024, "a");
    const s = await stand((req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(req.url.startsWith("/big") ? big : "small");
    });
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-limits-big-"));
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: BIG, request: GET /big, expect: { status: 200 } }\n  - { id: SMALL, request: GET /small, expect: { status: 200 } }\n");
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: big\ntargets:\n  legacy: { base_url: "${s.url}" }\n  candidate: { base_url: "${s.url}" }\n`);
        const m = loadManifest(path.join(dir, "cmtk.yaml"));

        const c = await compare(m);
        assert.equal(c.verdict, "PARTIAL COMPARISON", "what lies past the cap was not compared");
        assert.doesNotMatch(c.verdict, /PARITY/);
        assert.match(c.reason, /1 answer was over 5 MB/);
        assert.equal(c.cases.find((x) => x.id === "BIG").truncated, true);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8"), /only the first 5 MB were compared/);
        const answer = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/answers/BIG.reference.json"), "utf8"));
        assert.equal(answer.body.length, MAX_BODY);

        const r = await run(m);
        assert.equal(r.verdict, "INCOMPLETE");
        assert.match(r.reason, /1 answer was over 5 MB/);

        fs.writeFileSync(path.join(dir, "t.log"), '1.1.1.1 - - [x] "GET /big HTTP/1.1" 200 1\n');
        const sh = await shadow(m, { from: [path.join(dir, "t.log")], rate: 1000 });
        assert.equal(sh.verdict, "INCOMPLETE");
        assert.equal(sh.replay.truncated, 1);
    } finally {
        await s.close();
    }
});

test("200,000 lines of log are read, and 365 dated runs of 2,000 cases make a trend, in time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-limits-log-"));
    const lines = Array.from({ length: 200000 }, (_, i) => `203.0.113.9 - - [10/Oct/2026:13:55:36 +0000] "GET /api/items/${i}?page=${i % 9}&sort=name HTTP/1.1" 200 123 "-" "Mozilla"`);
    fs.writeFileSync(path.join(dir, "big.log"), lines.join("\n"));
    const { stats } = await within(60, "reading 200,000 lines", () => captureRequests([path.join(dir, "big.log")], { sample: 0.01, seed: 1, max: 1000 }));
    assert.equal(stats.lines, 200000);
    assert.equal(stats.kept, 1000);

    const rows = Array.from({ length: 365 }, (_, r) => ({
        run: { run: `2026-01-01T00-00-${String(r).padStart(3, "0")}Z`, verdict: "NO PARITY", counts: {}, partial: false },
        results: new Map(Array.from({ length: 2000 }, (_, i) => [`C-${i}`, (i + r) % 7 ? "pass" : "fail"])),
        places: Array.from({ length: 200 }, (_, i) => ({ where: `$.w${i}`, case: `C-${i}`, approved: false })), used: new Set(), unused: [],
    }));
    const t = await within(30, "a trend over 365 runs", () => trendOf("compare", "x", rows, []));
    assert.equal(t.runs.length, 365);
    assert.ok(t.flaky.length > 1000);
});
