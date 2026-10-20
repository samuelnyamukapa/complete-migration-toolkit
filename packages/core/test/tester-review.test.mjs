// Regression tests for the independent review of the 0.2.0 AI tester: each test names the problem.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
    acceptDraft, addProposal, decideProposal, describeProposal, draftDefects, endSession, exploreRequest, importHar, initProject, loadCases, loadManifest,
    recordSignoff, run, startSession,
} from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-tr-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const DAY = "2026-10-18";
const agent = { proposed_by: "agent: test" };

function server(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

test("cmtk init cannot write settings through a crafted address", () => {
    const dir = tmp();
    const evil = 'http://h:1 }\n  legacy: { base_url: http://x }\nadapters: { sh: { command: sh, args: [-c, "echo PWNED"] } }\n#';
    assert.throws(() => initProject(path.join(dir, "cmtk.yaml"), { candidate: evil }), /must be an http/);
    assert.ok(!fs.existsSync(path.join(dir, "cmtk.yaml")));
    assert.throws(() => initProject(path.join(dir, "notes.txt"), { candidate: "http://localhost:1" }), /\.yaml file/);
    assert.throws(() => initProject(path.join(dir, "missing", "cmtk.yaml"), { candidate: "http://localhost:1" }), /does not exist/);
    initProject(path.join(dir, "cmtk.yaml"), { candidate: "http://localhost:5002/app" });
    assert.match(fs.readFileSync(path.join(dir, "cmtk.yaml"), "utf8"), /base_url: "http:\/\/localhost:5002\/app"/);
});

test("a report names the settings that produced it, and sign-off refuses another settings file", async () => {
    const s = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"price":${req.socket.localPort % 2},"at":"${Date.now()}"}`); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\n`);
    write(dir, "other.yaml", `system: s\ntargets:\n  candidate: ${s.url}\nscrub: { json_paths: ["$..price"] }\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /, expect: { status: 200 } }\n");
    try {
        const r = await run(loadManifest(path.join(dir, "other.yaml")));
        assert.equal(r.settings.manifest, "other.yaml");
        assert.deepEqual(r.settings.scrub.json_paths, ["$..price"]);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8"), /Settings file: `other\.yaml`/);
        const ev = path.join(dir, "cmtk/evidence/run");
        assert.throws(() => recordSignoff(ev, { name: "Pat", role: "Tester", decision: "accept" }, DAY, loadManifest(path.join(dir, "cmtk.yaml"))), /produced from other\.yaml, not cmtk\.yaml/);
        const signed = recordSignoff(ev, { name: "Pat", role: "Tester", decision: "accept" }, DAY, loadManifest(path.join(dir, "other.yaml")));
        assert.equal(signed.manifest, "other.yaml");
    } finally {
        await s.close();
    }
});

test("a proposal shows a person exactly what would be applied", () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /a, expect: { status: 200 } }\n");
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    assert.throws(() => addProposal(m(), { ...agent, kind: "drift", case: "*", where: "$.price", reason: "ok\u001b[1A\r\u001b[2K harmless" }, DAY), /control characters/);
    assert.throws(() => addProposal(m(), { ...agent, kind: "drift", case: "*", where: "*", reason: "everything" }, DAY), /wildcard alone/);
    assert.throws(() => addProposal(m(), { ...agent, kind: "drift", case: "*", where: "$..[*]", reason: "everything" }, DAY), /wildcard alone/);
    const p = addProposal(m(), { ...agent, kind: "drift", case: "*", where: "$.price", reason: "fine" }, DAY);
    assert.match(describeProposal(p), /approve the difference at "\$\.price" for EVERY case/);
    addProposal(m(), { ...agent, kind: "expectation", case: "A", expect: { status: 201 }, reason: "story says 201" }, DAY);
    addProposal(m(), { ...agent, kind: "expectation", case: "A", expect: { status: 204 }, reason: "or 204?" }, DAY);
    const shown = { ...p };
    const file = path.join(dir, "cmtk/proposals.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("where: $.price", 'where: "*"'));
    assert.throws(() => decideProposal(m(), p.id, true, "Pat", DAY, undefined, shown), /changed after it was shown/);
    assert.match(fs.readFileSync(file, "utf8"), /^proposals:\n {2}- id: P-001/m, "lists are written one item per block, not on one line");
});

test("a draft that changed after it was shown is not accepted", () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: D, request: GET /a, expect: { status: 200 }, draft: true }\n");
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    const shown = loadCases(m())[0];
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: D, request: GET /admin, expect: { status: 200 }, draft: true }\n");
    assert.throws(() => acceptDraft(m(), "D", "Pat", DAY, shown), /changed after it was shown/);
});

test("exploration: one request at a time, a daily limit across sessions, no method overrides", async () => {
    let hits = 0;
    const s = await server((req, res) => { hits++; setTimeout(() => res.end("ok"), 200); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\nexplore_requests_per_day: 12\n`);
    write(dir, "cmtk/cases/a.yaml", "cases: []\n");
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    try {
        const sess = startSession(m(), { charter: "c", budget_requests: 10 });
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => exploreRequest(m(), sess.id, "GET /")));
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        assert.match(results.find((r) => r.status === "rejected").reason.message, /one at a time/);
        assert.equal(hits, 1, "refused requests never reach the system");
        await assert.rejects(() => exploreRequest(m(), sess.id, { method: "GET", path: "/", headers: { "X-HTTP-Method-Override": "DELETE" } }), /not allowed/);
        assert.throws(() => startSession(m(), { charter: "side by side", budget_requests: 5 }), /limit of 12/, "an open session holds its whole budget");
        endSession(m(), sess.id, { summary: "one request", not_covered: "the rest" });
        const next = startSession(m(), { charter: "again", budget_requests: 11 });
        endSession(m(), next.id, { summary: "none", not_covered: "all" });
        assert.throws(() => startSession(m(), { charter: "a third", budget_requests: 12 }), /1 requests sent or reserved/, "an ended session counts what it sent");
    } finally {
        await s.close();
    }
});

test("defect drafts hold no credentials from paths, bodies or addresses", async () => {
    const s = await server((req, res) => { res.writeHead(500, { "content-type": "text/plain" }); res.end("boom"); });
    const dir = tmp();
    const url = s.url.replace("http://", "http://svc:Pa55word@");
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${url}\nallow_unsafe_methods: true\n`);
    write(dir, "cmtk/cases/a.yaml", `cases:
  - id: L
    request: { method: POST, path: "/login?api_key=AKIAXXXX1234&page=2", headers: { Content-Type: application/json }, body: '{"username":"alice","password":"hunter2-Pa55!","otp":"123456"}' }
    expect: { status: 200 }
`);
    try {
        await run(loadManifest(path.join(dir, "cmtk.yaml")), { allowUnsafe: true });
        const { file } = draftDefects(loadManifest(path.join(dir, "cmtk.yaml")), "run");
        const md = fs.readFileSync(path.join(dir, file), "utf8");
        for (const secret of ["AKIAXXXX1234", "hunter2", "123456", "Pa55word"]) assert.ok(!md.includes(secret), secret);
        assert.match(md, /page=2/, "the rest of the request is kept");
    } finally {
        await s.close();
    }
});

test("--accepted-only leaves drafts out and says so; an agent's HAR import is drafts", async () => {
    const s = await server((req, res) => res.end("ok"));
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /, expect: { status: 200 } }\n  - { id: D, request: GET /x, expect: { status: 200 }, draft: true }\n");
    try {
        const r = await run(loadManifest(path.join(dir, "cmtk.yaml")), { acceptedOnly: true });
        assert.equal(r.verdict, "PASS");
        assert.equal(r.excluded_drafts, 1);
        assert.match(r.reason, /1 draft case was left out/);
        write(dir, "w.har", JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "http://l/a", headers: [] } }] } }));
        assert.equal(importHar([path.join(dir, "w.har")], { draft: true }).cases[0].draft, true);
    } finally {
        await s.close();
    }
});

test("body_excludes fails on text that must never appear, and each result names its request", async () => {
    const s = await server((req, res) => { res.writeHead(500); res.end(req.url === "/bad" ? "System.Exception at System.Web.Mvc" : "fine"); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\n`);
    write(dir, "cmtk/cases/a.yaml", 'cases:\n  - { id: B, request: GET /bad, expect: { body_excludes: ["at System."] } }\n  - { id: G, request: GET /good, expect: { body_excludes: ["at System."] } }\n');
    try {
        const r = await run(loadManifest(path.join(dir, "cmtk.yaml")));
        const [b, g] = r.cases;
        assert.equal(b.result, "FAIL");
        assert.deepEqual([b.failures[0].check, b.failures[0].expected], ["body", 'never contains "at System."']);
        assert.match(b.failures[0].actual, /^found: .*at System\.Web/);
        assert.equal(g.result, "PASS");
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.json"), "utf8")).cases[0].request, "GET /bad");
    } finally {
        await s.close();
    }
});

test("an exploration session's plan is kept with its evidence", () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "cmtk/cases/a.yaml", "cases: []\n");
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    const sess = startSession(m, { charter: "paging limits", plan: "1. page 0\n2. page -1\n3. size 0" });
    const file = endSession(m, sess.id, { summary: "done", not_covered: "sorting" });
    assert.match(fs.readFileSync(path.join(dir, file), "utf8"), /2\. page -1/);
});

// From the eShop run in the Copilot app: a hung system, a run left behind by a client that gave up, and defect titles.

test("a system that stops answering ends the run early instead of waiting out every case", async () => {
    let hits = 0;
    const s = await server(() => { hits++; }); // takes the request, never answers
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\ntimeout_s: 1\n`);
    write(dir, "cmtk/cases/a.yaml", `cases:\n${[1, 2, 3, 4, 5, 6].map((i) => `  - { id: C${i}, request: GET /${i}, expect: { status: 200 } }`).join("\n")}\n`);
    try {
        const started = Date.now();
        const r = await run(loadManifest(path.join(dir, "cmtk.yaml")));
        assert.ok(Date.now() - started < 6000, "three timeouts, not six");
        assert.equal(hits, 3);
        assert.deepEqual(r.cases.map((c) => c.result), ["ERROR", "ERROR", "ERROR", "SKIPPED", "SKIPPED", "SKIPPED"]);
        assert.match(r.cases[3].why, /3 requests in a row got no answer, so the run stopped early/);
        assert.equal(r.verdict, "NO EVIDENCE");
        assert.match(r.next, /a system did not answer \(ETIMEDOUT/);
    } finally {
        await s.close();
    }
});

test("one run at a time per evidence folder", async () => {
    const s = await server((req, res) => setTimeout(() => res.end("ok"), 100));
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /, expect: { status: 200 } }\n");
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    const lock = path.join(dir, "cmtk/evidence/.run.lock");
    try {
        const first = run(m());
        await assert.rejects(() => run(m()), /Another `cmtk run` is writing cmtk[\\/]evidence[\\/]run/);
        assert.equal((await first).verdict, "PASS", "the first run is not disturbed");
        assert.ok(!fs.existsSync(lock), "the lock goes when the run ends");
        fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, started: new Date().toISOString() }));
        assert.equal((await run(m())).verdict, "PASS", "a lock left by a process that has gone does not block");
    } finally {
        await s.close();
    }
});

test("a defect draft is titled with the case's name", async () => {
    const s = await server((req, res) => { res.writeHead(404); res.end("Physical Path D:\\app"); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\n`);
    write(dir, "cmtk/cases/a.yaml", 'cases:\n  - { id: E1, name: "Error pages reveal the server path", note: "Observed: a path.\\nWhy it looks wrong: Error pages should not show where the server keeps its files.", request: GET /x, expect: { body_excludes: ["Physical Path"] } }\n  - { id: E2, request: GET /y, expect: { status: 200 } }\n');
    try {
        await run(loadManifest(path.join(dir, "cmtk.yaml")));
        const { drafts } = draftDefects(loadManifest(path.join(dir, "cmtk.yaml")), "run");
        assert.equal(drafts[0].title, "Error pages reveal the server path");
        assert.equal(drafts[0].why, "Error pages should not show where the server keeps its files.");
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/run/DEFECTS.md"), "utf8"), /### Why it matters\n\nError pages should not show/);
        assert.equal(drafts[1].why, undefined, "no note, no section");
        assert.match(drafts[1].title, /^status: expected 200, got 404/, "without a name, the failed check is the title");
    } finally {
        await s.close();
    }
});
