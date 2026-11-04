// The known-issues ledger (#40): a legacy defect recorded once, by a named person, told apart from a new failure.
// LEG-1 is the eShop pilot's defect: GET /api answers 404, so case API-2-01 fails. The cases are the pilot's own
// file; the system is a local stand-in that answers as legacy eShop did.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    addProposal, check, decideProposal, describeProposal, describeSignoff, draftDefects, loadKnownIssues, loadManifest, loadProposals, recordSignoff, run, signoffState,
} from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "main.js");
const API_CASES = path.join(ROOT, "examples", "eshop-pilot", "cmtk", "cases", "legacy", "api.yaml");

const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};

const LEG_1 = `known_issues:
  - id: LEG-1
    case: API-2-01
    fails:
      - { check: status, expected: "200", actual: 404 }
      - { check: body, expected: JSON }
    reason: CatalogController2 is never registered, so the route does not exist. Match legacy first.
    accepted_by: Jane Smith
    date: 2026-10-18
`;

/** Legacy eShop's API, as the pilot recorded it. `apiRoot` is what GET /api does. */
function legacy(apiRoot = (res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("<!DOCTYPE html><html><title>Not found</title></html>"); }) {
    return new Promise((resolve) => {
        const json = (res, v) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(v)); };
        const s = http.createServer((req, res) => {
            if (req.url === "/api") return apiRoot(res);
            if (req.url === "/api/brands") return json(res, ["Azure", ".NET", "Visual Studio", "SQL Server", "Other"].map((Brand, i) => ({ Id: i + 1, Brand })));
            if (req.url === "/api/brands/2") return json(res, { Id: 2, Brand: ".NET" });
            if (req.url === "/api/files") { res.writeHead(200); return res.end("binary"); }
            res.writeHead(404); res.end();
        });
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

function project(url, ledger) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-known-"));
    write(dir, "cmtk.yaml", `system: eshop-legacy\ntargets:\n  legacy: { base_url: "${url}" }\n  candidate: { base_url: "${url}" }\ndefault_target: legacy\nreference: legacy\ncandidate: candidate\ncases: [cmtk/cases/*.yaml]\n`);
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.copyFileSync(API_CASES, path.join(dir, "cmtk/cases/api.yaml"));
    if (ledger) write(dir, "cmtk/known-issues.yaml", ledger);
    return dir;
}
const manifestOf = (dir) => loadManifest(path.join(dir, "cmtk.yaml"));

const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("LEG-1 in the ledger: the verdict names it and exits 4; with the entry removed it is FAIL and exits 1", async () => {
    const s = await legacy();
    try {
        const dir = project(s.url, LEG_1);
        const withEntry = await cmtk(dir, "run");
        assert.equal(withEntry.status, 4, withEntry.stdout + withEntry.stderr);
        assert.match(withEntry.stdout, /verdict for eshop-legacy: PASS WITH KNOWN ISSUES/);
        assert.match(withEntry.stdout, /FAIL \(known issue LEG-1\) API-2-01/);
        assert.match(withEntry.stdout, /LEG-1, accepted by Jane Smith/);
        const md = fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8");
        assert.match(md, /\*\*Verdict: PASS WITH KNOWN ISSUES\*\*/);
        assert.match(md, /\| API-2-01 \|.*\| FAIL \(known issue LEG-1\) \|/);
        assert.match(md, /## Known issues/);
        assert.match(md, /\| LEG-1 \| API-2-01 \| status, expected 200, actual 404; body, expected JSON \| CatalogController2.*\| Jane Smith \| 2026-10-18 \| still fails \|/);
        const r = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.json"), "utf8"));
        assert.equal(r.counts.FAIL, 0, "not a new failure");
        assert.equal(r.counts["KNOWN ISSUE"], 1);
        assert.equal(r.counts.PASS, 5, "and never counted as passed");
        assert.equal(r.cases.find((c) => c.id === "API-2-01").result, "FAIL", "the case still failed");
        assert.equal(r.requirements.find((q) => q.requirement === "API-2/AC-1").failed, 1, "its requirement still shows a failure");

        fs.rmSync(path.join(dir, "cmtk/known-issues.yaml"));
        const without = await cmtk(dir, "run");
        assert.equal(without.status, 1, without.stdout);
        assert.match(without.stdout, /verdict for eshop-legacy: FAIL/);
        assert.doesNotMatch(without.stdout, /known issue/i);
        assert.doesNotMatch(fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8"), /known issue/i);
    } finally {
        await s.close();
    }
});

test("a real regression does not hide behind LEG-1: a new way of failing, or another case failing, is FAIL", async () => {
    const worse = await legacy((res) => { res.writeHead(500, { "content-type": "text/html" }); res.end("<html>boom</html>"); });
    try {
        const r = await run(manifestOf(project(worse.url, LEG_1)));
        assert.equal(r.verdict, "FAIL", "500 is not the accepted 404");
        const c = r.cases.find((x) => x.id === "API-2-01");
        assert.equal(c.known_issues, undefined);
        assert.equal(c.failures.find((f) => f.check === "status").known_issue, undefined);
        assert.equal(c.failures.find((f) => f.check === "body").known_issue, "LEG-1", "the report says which part is accepted");
    } finally {
        await worse.close();
    }
    const s = await legacy();
    try {
        const dir = project(s.url, LEG_1);
        write(dir, "cmtk/cases/new.yaml", "cases:\n  - { id: NEW-1, request: GET /api/brands/2, expect: { status: 201 } }\n");
        const r = await run(manifestOf(dir));
        assert.equal(r.verdict, "FAIL");
        assert.equal(r.counts.FAIL, 1);
        assert.match(r.reason, /^1 case failed\. 1 case failed only as known issues \(LEG-1, accepted by Jane Smith\)\./);
    } finally {
        await s.close();
    }
});

test("an entry limited to one target does not cover another", async () => {
    const s = await legacy();
    try {
        const dir = project(s.url, `${LEG_1}    target: legacy\n`);
        assert.equal((await run(manifestOf(dir), { target: "legacy" })).verdict, "PASS WITH KNOWN ISSUES");
        const other = await run(manifestOf(dir), { target: "candidate" });
        assert.equal(other.verdict, "FAIL");
        assert.equal(other.known_issues, undefined);
    } finally {
        await s.close();
    }
});

test("an entry that no longer fails is reported, but only when its case was checked", async () => {
    const fixed = await legacy((res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"Message":"Hello World!"}'); });
    try {
        const dir = project(fixed.url, LEG_1);
        const r = await run(manifestOf(dir));
        assert.equal(r.verdict, "PASS", "nothing failed, so no known issue qualifies it");
        assert.deepEqual(r.stale_known_issues, ["LEG-1"]);
        assert.match(r.reason, /A known issue no longer fails \(LEG-1\): a person removes it from the ledger\./);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8"), /No longer failing: LEG-1\./);

        const notRun = await run(manifestOf(dir), { only: ["API-1-01"] });
        assert.deepEqual(notRun.stale_known_issues, [], "a partial run cannot say");
        assert.equal(notRun.known_issues[0].state, "not checked");
    } finally {
        await fixed.close();
    }
    const dir = project("http://127.0.0.1:9", LEG_1);
    const down = await run(manifestOf(dir));
    assert.deepEqual(down.stale_known_issues, [], "a case that could not run says nothing about the entry");

    write(dir, "cmtk/known-issues.yaml", LEG_1.replace("API-2-01", "GONE-1"));
    assert.match(check(manifestOf(dir)).warnings.join("\n"), /known issue LEG-1: there is no case GONE-1/);
    const gone = await run(manifestOf(dir));
    assert.deepEqual(gone.stale_known_issues, ["LEG-1"], "its case no longer exists");
});

test("a partial run is never a pass of any kind, known issues or not", async () => {
    const s = await legacy();
    try {
        const r = await run(manifestOf(project(s.url, LEG_1)), { only: ["API-2-01"] });
        assert.equal(r.verdict, "INCOMPLETE");
        assert.match(r.reason, /with no new failures\. 1 case failed only as known issues/);
    } finally {
        await s.close();
    }
});

test("only a person adds an entry: the ledger refuses what no person accepted", () => {
    const dir = project("http://127.0.0.1:9");
    const bad = (text, rx) => {
        write(dir, "cmtk/known-issues.yaml", text);
        assert.throws(() => loadKnownIssues(manifestOf(dir)), rx);
        assert.throws(() => check(manifestOf(dir)), rx);
    };
    bad(LEG_1.replace("    accepted_by: Jane Smith\n", ""), /accepted_by.*required.*named person/);
    bad(LEG_1.replace("Jane Smith", "\"agent: triage\""), /must name a person, not an agent/);
    bad(LEG_1.replace("case: API-2-01", 'case: "*"'), /must name one case/);
    bad(LEG_1.replace("check: status", 'check: "*"'), /wildcard is not allowed/);
    bad(LEG_1.replace(/    fails:\n.*\n.*\n/, ""), /`fails` must list what fails/);
    bad(`${LEG_1}  - { id: LEG-1, case: A, fails: [{ check: status }], reason: r, accepted_by: B }\n`, /used twice/);
});

test("an agent proposes an entry; nothing changes until a person accepts it with their name", async () => {
    const s = await legacy();
    try {
        const dir = project(s.url);
        const m = manifestOf(dir);
        assert.throws(() => addProposal(m, { kind: "known_issue", case: "API-2-01", fails: [{ check: "status" }], reason: "r", proposed_by: "agent", accepted_by: "Jane Smith" }, "2026-11-04"), /cannot carry an approval/);
        assert.throws(() => addProposal(m, { kind: "known_issue", case: "NOPE", fails: [{ check: "status" }], reason: "r", proposed_by: "agent" }, "2026-11-04"), /no case NOPE/);
        assert.throws(() => addProposal(m, { kind: "known_issue", case: "API-2-01", reason: "r", proposed_by: "agent" }, "2026-11-04"), /`fails` must list/);
        const p = addProposal(m, { kind: "known_issue", issue_id: "LEG-1", case: "API-2-01", fails: [{ check: "status", expected: "200", actual: "404" }, { check: "body", expected: "JSON" }], reason: "the route was never registered", proposed_by: "agent: triage" }, "2026-11-04");
        assert.equal(p.status, "pending");
        assert.match(describeProposal(p), /record known issue "LEG-1": case "API-2-01" may keep failing/);
        assert.ok(!fs.existsSync(path.join(dir, "cmtk/known-issues.yaml")), "the proposal alone writes no entry");
        assert.equal((await run(m)).verdict, "FAIL", "and changes no verdict");

        const d = decideProposal(m, p.id, true, "Jane Smith", "2026-11-04");
        assert.equal(d.applied, "LEG-1 in cmtk/known-issues.yaml");
        const [entry] = loadKnownIssues(m);
        assert.equal(entry.accepted_by, "Jane Smith");
        assert.equal(entry.reason, "the route was never registered");
        assert.equal((await run(m)).verdict, "PASS WITH KNOWN ISSUES");
        assert.equal(loadProposals(m)[0].status, "accepted");
        assert.throws(() => addProposal(m, { kind: "known_issue", issue_id: "LEG-1", case: "API-2-01", fails: [{ check: "status" }], reason: "r", proposed_by: "agent" }, "2026-11-04"), /already holds LEG-1/);

        const next = addProposal(m, { kind: "known_issue", case: "API-3-01", fails: [{ check: "status", actual: "500" }], reason: "r", proposed_by: "agent" }, "2026-11-04");
        assert.equal(decideProposal(m, next.id, true, "Jane Smith", "2026-11-04").applied, "KNOWN-001 in cmtk/known-issues.yaml");
        const rejected = addProposal(m, { kind: "known_issue", case: "API-1-01", fails: [{ check: "status", actual: "500" }], reason: "r", proposed_by: "agent" }, "2026-11-04");
        decideProposal(m, rejected.id, false, "Jane Smith", "2026-11-04", "no");
        assert.equal(loadKnownIssues(m).length, 2, "a rejected proposal adds nothing");
    } finally {
        await s.close();
    }
});

test("a sign-off says what it covers, and is tied to the known issues in the evidence", async () => {
    const s = await legacy();
    try {
        const dir = project(s.url, LEG_1);
        await run(manifestOf(dir));
        const ev = path.join(dir, "cmtk/evidence/run");
        const signed = recordSignoff(ev, { name: "A Person", role: "Architect", decision: "accept" }, "2026-11-04");
        assert.equal(signed.verdict, "PASS WITH KNOWN ISSUES");
        assert.deepEqual(signed.known_issues, ["LEG-1 (accepted by Jane Smith)"]);
        assert.match(describeSignoff(signoffState(ev)), /signed by A Person.*accept, 2026-11-04; known issues still failing: LEG-1 \(accepted by Jane Smith\)/);

        // The entry is in the signed evidence: rewriting who accepted it breaks the signature.
        const f = path.join(ev, "REPORT.json");
        fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("Jane Smith", "Someone Else"));
        assert.equal(signoffState(ev).state, "stale");

        // Running again with another ledger makes new evidence, so the signature does not carry over.
        const copy = fs.readFileSync(path.join(ev, "SIGNOFF.json"));
        fs.rmSync(path.join(dir, "cmtk/known-issues.yaml"));
        await run(manifestOf(dir));
        fs.writeFileSync(path.join(ev, "SIGNOFF.json"), copy);
        assert.equal(signoffState(ev).state, "stale");
    } finally {
        await s.close();
    }
});

test("a known issue is not drafted as a new defect; a new failure still is", async () => {
    const s = await legacy();
    try {
        const dir = project(s.url, LEG_1);
        await run(manifestOf(dir));
        assert.equal(draftDefects(manifestOf(dir), "run").drafts.length, 0);
        fs.rmSync(path.join(dir, "cmtk/known-issues.yaml"));
        await run(manifestOf(dir));
        assert.equal(draftDefects(manifestOf(dir), "run").drafts.length, 1);
    } finally {
        await s.close();
    }
});

test("the eShop example holds LEG-1 as a proposal waiting for a person, not as a ledger entry", () => {
    const example = path.join(ROOT, "examples", "eshop-pilot");
    assert.ok(!fs.existsSync(path.join(example, "cmtk", "known-issues.yaml")), "only a person adds the entry");
    const m = loadManifest(path.join(example, "cmtk.yaml"));
    const [p] = loadProposals(m);
    assert.equal(p.kind, "known_issue");
    assert.equal(p.status, "pending");
    assert.equal(p.issue_id, "LEG-1");
    assert.equal(p.case, "API-2-01");
    assert.match(p.proposed_by, /^agent/);
    assert.equal(p.decided_by, undefined);
});

test("cmtk check refuses an entry that accepts any answer", () => {
    const dir = project("http://127.0.0.1:9", LEG_1.replace('{ check: body, expected: JSON }', "{ check: body }"));
    assert.throws(() => check(manifestOf(dir)), /must say how it fails/);
});
