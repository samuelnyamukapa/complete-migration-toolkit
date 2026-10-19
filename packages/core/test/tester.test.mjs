// The AI tester's engine: drafts, proposals and a person's decisions, exploration sessions and
// defect drafts. Agents propose; only a person decides.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
    acceptDraft, addFinding, addProposal, check, decideProposal, draftDefects, endSession, exploreRequest, loadCases, loadDrift, loadManifest,
    loadProposals, recordSignoff, rejectDraft, run, signoffState, startSession,
} from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-tester-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
const DAY = "2026-10-18";

function server(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) }));
    });
}

const shop = (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/items") {
        const page = Number(u.searchParams.get("page") ?? 0);
        if (page < 0) { res.writeHead(500, { "content-type": "text/plain" }); return res.end("System.ArgumentOutOfRangeException"); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ page, items: page === 0 ? ["mug", "cup"] : [] }));
    }
    if (u.pathname === "/api/who") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`hello ${req.headers.authorization ?? "nobody"}`); }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
};

function project(url, cases, extra = "") {
    const dir = tmp();
    write(dir, "cmtk.yaml", `# the shop\nsystem: shop\ntargets:\n  candidate: ${url}\nscrub:\n  json_paths: []   # values that change\n${extra}`);
    write(dir, "cmtk/cases/a.yaml", cases);
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")) };
}

test("draft cases are skipped until a person accepts them, and a rejected draft is kept with its reason", async () => {
    const s = await server(shop);
    const p = project(s.url, `cases:\r\n  - id: OK\r\n    requirement: R1\r\n    request: GET /api/items\r\n    expect: { status: 200 }\r\n  - id: D1\r\n    requirement: R1\r\n    request: GET /api/items?page=1\r\n    expect: { status: 200 }\r\n    draft: true\r\n    draft_note: drafted from story R1\r\n  - id: D2\r\n    request: GET /x\r\n    draft: true\r\n`);
    try {
        const r = await run(p.m());
        assert.deepEqual(r.cases.map((c) => c.result), ["PASS", "SKIPPED", "SKIPPED"]);
        assert.match(r.cases[1].why, /cmtk review/);
        assert.equal(r.verdict, "INCOMPLETE");
        assert.deepEqual(check(p.m()).drafts, ["D1", "D2"]);

        acceptDraft(p.m(), "D1", "Pat Tester", DAY);
        rejectDraft(p.m(), "D2", "Pat Tester", DAY, "duplicates OK");
        const text = read(p.dir, "cmtk/cases/a.yaml");
        assert.ok(text.includes("\r\n"), "Windows line endings survive the edit");
        assert.ok(!/draft(_note)?:/.test(text) && /accepted_by: Pat Tester/.test(text));
        assert.equal(loadCases(p.m()).find((c) => c.id === "D1").note, "drafted from story R1", "the drafter's note is kept");
        assert.deepEqual(loadCases(p.m()).map((c) => c.id), ["OK", "D1"]);
        assert.match(read(p.dir, "cmtk/rejected.yaml"), /rejected_because: duplicates OK/);
        assert.equal((await run(p.m())).verdict, "PASS");
    } finally {
        await s.close();
    }
});

test("proposals: an agent proposes, only a person's decision applies it, with that person's name", () => {
    const p = project("http://127.0.0.1:9", "cases:\n  - { id: A, request: GET /a, expect: { status: 200 } }\n");
    const agent = { proposed_by: "agent: test" };
    assert.throws(() => addProposal(p.m(), { ...agent, kind: "scrub", reason: "r", rule: { regex: { pattern: "([" } } }, DAY), /not a valid regular expression/);
    assert.throws(() => addProposal(p.m(), { ...agent, kind: "drift", reason: "r", case: "NOPE", where: "$.a" }, DAY), /no case NOPE/);
    assert.throws(() => addProposal(p.m(), { ...agent, kind: "drift", reason: "r", where: "$.a", approved_by: "Bot" }, DAY), /only a person decides/);
    const s1 = addProposal(p.m(), { ...agent, kind: "scrub", reason: "a timestamp on every call", rule: { json_path: "$..generatedAt" } }, DAY);
    const d1 = addProposal(p.m(), { ...agent, kind: "drift", reason: "decimals now always shown", case: "A", where: "$.total" }, DAY);
    const e1 = addProposal(p.m(), { ...agent, kind: "expectation", reason: "the story says 201", case: "A", expect: { status: 201 } }, DAY);
    const f1 = addProposal(p.m(), { ...agent, kind: "defect", reason: "r", title: "total is rounded", cases: ["A"] }, DAY);
    assert.deepEqual([s1.id, d1.id, e1.id, f1.id], ["P-001", "P-002", "P-003", "P-004"]);
    assert.throws(() => addProposal(p.m(), { ...agent, kind: "drift", reason: "again", case: "A", where: "$.total" }, DAY), /already waiting/);
    assert.equal(loadDrift(p.m()).length, 0, "nothing is applied by proposing");

    decideProposal(p.m(), "P-001", true, "Pat Tester", DAY);
    decideProposal(p.m(), "P-002", true, "Pat Tester", DAY);
    decideProposal(p.m(), "P-003", true, "Pat Tester", DAY);
    decideProposal(p.m(), "P-004", false, "Pat Tester", DAY, "not a bug: rounding is in the story");
    assert.deepEqual(p.m().scrub.json_paths, ["$..generatedAt"]);
    assert.match(read(p.dir, "cmtk.yaml"), /# the shop[\s\S]*# values that change/, "comments in cmtk.yaml survive");
    assert.deepEqual(loadDrift(p.m()).map((d) => [d.id, d.where, d.approved_by]), [["DRIFT-001", "$.total", "Pat Tester"]]);
    assert.deepEqual(loadCases(p.m())[0].expect, { status: 201 });
    assert.deepEqual(loadProposals(p.m()).map((x) => x.status), ["accepted", "accepted", "accepted", "rejected"]);
    assert.throws(() => decideProposal(p.m(), "P-001", true, "Pat Tester", DAY), /already accepted/);
});

test("exploration: read-only, within budget, every answer logged, findings become drafts", async () => {
    const s = await server(shop);
    const p = project(s.url, "cases:\n  - { id: A, request: GET /api/items, expect: { status: 200 } }\n");
    try {
        const t0 = new Date("2026-10-18T10:00:00Z");
        const sess = startSession(p.m(), { charter: "break paging with odd page numbers", budget_requests: 2, budget_minutes: 5 }, t0);
        await assert.rejects(() => exploreRequest(p.m(), sess.id, "POST /api/items", t0), /only reads/);
        await assert.rejects(() => exploreRequest(p.m(), sess.id, "GET //evil.example/x", t0), /single '\/'/);
        await assert.rejects(() => exploreRequest(p.m(), "../../etc", "GET /", t0), /not a session id/);
        const a = await exploreRequest(p.m(), sess.id, "GET /api/items?page=1", t0);
        const b = await exploreRequest(p.m(), sess.id, { method: "GET", path: "/api/items?page=-1" }, t0);
        assert.equal(b.observation.status, 500);
        assert.equal(a.left, 1);
        await assert.rejects(() => exploreRequest(p.m(), sess.id, "GET /api/items", t0), /used its budget/);
        const late = startSession(p.m(), { charter: "x", budget_minutes: 1 }, t0);
        await assert.rejects(() => exploreRequest(p.m(), late.id, "GET /", new Date("2026-10-18T10:02:00Z")), /time budget/);

        const f = addFinding(p.m(), sess.id, { title: "a negative page crashes the server", request: "GET /api/items?page=-1", observed: "500 with a .NET exception name", why: "bad input should give 400, not a crash", evidence: [2], expect: { status: 400 } });
        assert.equal(f.counted, true);
        const draft = loadCases(p.m()).find((c) => c.id === f.caseId);
        assert.equal(draft.draft, true);
        assert.match(draft.draft_note, /answers\/002\.json/);
        const report = endSession(p.m(), sess.id, { summary: "paging crashes on negative pages", not_covered: "page sizes" });
        const md = read(p.dir, report);
        assert.match(md, /\| 2 \| `GET \/api\/items\?page=-1` \| 500 \|/);
        assert.match(md, /Not covered\n\npage sizes/);
        await assert.rejects(() => exploreRequest(p.m(), sess.id, "GET /", t0), /has ended/);
        assert.ok(fs.existsSync(path.join(p.dir, "cmtk/evidence/explore", sess.id, "answers/002.json")));
    } finally {
        await s.close();
    }
});

test("defect drafts: grouped by cause, with steps and evidence, credentials removed, and outside the sign-off", async () => {
    const s = await server(shop);
    const p = project(s.url, `cases:
  - { id: P1, requirement: CAT-1, request: GET /api/items?page=-1, expect: { status: 200 } }
  - { id: P2, requirement: CAT-1, request: GET /api/items?page=-2, expect: { status: 200 } }
  - { id: W1, requirement: AUTH-1, request: GET /api/who, expect: { body_contains: [welcome] } }
`, "headers_from_env: { Authorization: CMTK_T_TOKEN }\n");
    process.env.CMTK_T_TOKEN = "Bearer sekrit-value-123";
    try {
        await run(p.m());
        const dir = path.join(p.dir, "cmtk/evidence/run");
        recordSignoff(dir, { name: "Pat", role: "Tester", decision: "reject" }, DAY);
        const { drafts, file } = draftDefects(p.m(), "run");
        assert.equal(drafts.length, 2);
        assert.deepEqual(drafts[0].cases, ["P1", "P2"], "one draft for two cases failing the same way");
        assert.match(drafts[0].title, /status: expected 200, got 500 \(2 cases\)/);
        assert.match(drafts[0].steps[0], /GET \/api\/items\?page=-1/);
        assert.deepEqual(drafts[0].evidence, ["answers/P1.json", "answers/P2.json"]);
        const md = read(p.dir, file);
        assert.ok(!md.includes("sekrit-value-123"), "the credential never reaches a draft");
        assert.equal(signoffState(dir).state, "signed", "drafting defects does not void a signature");
    } finally {
        delete process.env.CMTK_T_TOKEN;
        await s.close();
    }
});
