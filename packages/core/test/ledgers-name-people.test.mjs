// Findings 13 and 14 of the review of 0.6: a known issue says exactly how a case fails, and a ledger entry names a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { addProposal, compare, confirmSafe, decideProposal, describeProposal, loadCases, loadDrift, loadKnownIssues, loadManifest, looksLikeAgent, recordSignoff, run, SignoffError } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-people-"));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const server = (fn) => new Promise((resolve) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
const m = (dir) => loadManifest(path.join(dir, "cmtk.yaml"));
const project = (url = "http://127.0.0.1:9") => {
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${url}" }\n  candidate: { base_url: "${url}" }\nreference: legacy\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /x, expect: { status: 200 } }\n");
    return dir;
};
const ledger = (dir, fails, by = "Jane Smith") => write(dir, "cmtk/known-issues.yaml", YAML.stringify({ known_issues: [{ id: "K", case: "A", fails, reason: "r", accepted_by: by }] }));

for (const [what, fails] of [
    ["no pattern at all", [{ check: "status" }]],
    ["only what was expected, on a status", [{ check: "status", expected: "200" }]],
    ["only what was expected, on a JSON check", [{ check: "$.count", expected: "3" }]],
    ["an empty actual", [{ check: "status", actual: " " }]],
]) {
    test(`a known issue with ${what} is refused: it would accept any failure there`, () => {
        const dir = project();
        ledger(dir, fails);
        assert.throws(() => loadKnownIssues(m(dir)), /must say how it fails/);
        assert.throws(() => addProposal(m(dir), { kind: "known_issue", case: "A", fails, reason: "r", proposed_by: "agent" }, "2026-11-04"), /must say how it fails/);
    });
}

test("a status that fails a new way is still FAIL: the entry only covers what it says", async () => {
    let status = 404;
    const s = await server((req, res) => { res.statusCode = status; res.end("x"); });
    const dir = project(s.url);
    ledger(dir, [{ check: "status", actual: "404" }]);
    try {
        assert.equal((await run(m(dir), { target: "legacy" })).verdict, "PASS WITH KNOWN ISSUES");
        status = 500;
        assert.equal((await run(m(dir), { target: "legacy" })).verdict, "FAIL");
    } finally {
        await s.close();
    }
});

test("a body check may say what it wanted, because a body's text is not a stable thing to copy", () => {
    const dir = project();
    ledger(dir, [{ check: "body", expected: "JSON" }]);
    assert.equal(loadKnownIssues(m(dir)).length, 1);
});

test("the person deciding is told when an entry would accept more than one answer", () => {
    const text = describeProposal({ id: "P-1", kind: "known_issue", status: "pending", reason: "r", proposed_by: "agent", proposed_on: "d", case: "A", fails: [{ check: "body", expected: "JSON" }] });
    assert.match(text, /any answer that fails body/i);
    const exact = describeProposal({ id: "P-1", kind: "known_issue", status: "pending", reason: "r", proposed_by: "agent", proposed_on: "d", case: "A", fails: [{ check: "status", actual: "404" }] });
    assert.doesNotMatch(exact, /any answer that fails/i);
});

test("a proposal written before this rule can't be accepted into the ledger", () => {
    const dir = project();
    write(dir, "cmtk/proposals.yaml", YAML.stringify({ proposals: [{ id: "P-001", kind: "known_issue", status: "pending", reason: "r", proposed_by: "agent", proposed_on: "d", case: "A", fails: [{ check: "status" }] }] }));
    assert.throws(() => decideProposal(m(dir), "P-001", true, "Jane Smith", "2026-11-04"), /must say how it fails/);
    assert.equal(fs.existsSync(path.join(dir, "cmtk/known-issues.yaml")), false);
});

const AGENTS = ["agent", "Agent", "agent: claude", "The agent claude", "AI agent", "claude-code", "Claude Code", "claude", "copilot", "GitHub Copilot", "chatgpt", "gpt-5", "dependabot[bot]", "triage-bot", "release bot", "an agent acting for Jane"];
const PEOPLE = ["Jane Smith", "Claude Monet", "Claude Shannon", "Reagent Jones", "Abbot Hall", "Sam Nyamukapa", "Ai Weiwei", "Talbot Runhof"];

test("names that read as an agent or a tool are told apart from people", () => {
    for (const n of AGENTS) assert.equal(looksLikeAgent(n), true, n);
    for (const n of PEOPLE) assert.equal(looksLikeAgent(n), false, n);
});

for (const name of ["The agent claude", "AI agent", "agent: claude", "claude-code"]) {
    test(`${JSON.stringify(name)} can't accept a known issue, approve drift, decide a proposal, confirm safe or sign`, async () => {
        const dir = project();
        ledger(dir, [{ check: "status", actual: "404" }], name);
        assert.throws(() => loadKnownIssues(m(dir)), /must name a person/);
        fs.rmSync(path.join(dir, "cmtk/known-issues.yaml"));

        write(dir, "cmtk/drift.yaml", YAML.stringify({ drift: [{ id: "D", case: "*", where: "*", reason: "r", approved_by: name }] }));
        assert.throws(() => loadDrift(m(dir)), /must name a person/);
        fs.rmSync(path.join(dir, "cmtk/drift.yaml"));

        const p = addProposal(m(dir), { kind: "drift", case: "A", where: "$.price", reason: "r", proposed_by: "agent" }, "2026-11-04");
        assert.throws(() => decideProposal(m(dir), p.id, true, name, "2026-11-04"), /a person/);

        write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: POST /x, safe: true }\n");
        assert.throws(() => confirmSafe(m(dir), "A", name, "2026-11-04", loadCases(m(dir))[0]), /a person/i);

        write(dir, "ev/REPORT.json", JSON.stringify({ verdict: "PARITY" }));
        write(dir, "ev/REPORT.md", "# r\n");
        assert.throws(() => recordSignoff(path.join(dir, "ev"), { name, role: "lead", decision: "accept" }, "2026-11-04"), SignoffError);
    });
}

test("a drift entry that approves every difference in every case is refused, whoever signs it", async () => {
    const s = await server((req, res) => res.end(String(Math.random())));
    const dir = project(s.url);
    write(dir, "cmtk/drift.yaml", YAML.stringify({ drift: [{ id: "D", case: "*", where: "*", reason: "r", approved_by: "Jane Smith" }] }));
    try {
        assert.throws(() => loadDrift(m(dir)), /every difference/);
        await assert.rejects(compare(m(dir)), /every difference/);
    } finally {
        await s.close();
    }
});
