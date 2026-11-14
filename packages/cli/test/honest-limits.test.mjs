// Finding 15 of the review of 0.6: the terminal check stops accidents and agents that follow the rules. It does not
// stop a determined script, and the docs must say so. The first test shows the limit, so a doc can't quietly drift from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { recordSignoff, signoffState } from "../../core/dist/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("the limit is real: code that imports the core can sign with no terminal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-limit-"));
    fs.writeFileSync(path.join(dir, "REPORT.json"), JSON.stringify({ verdict: "PARITY" }));
    fs.writeFileSync(path.join(dir, "REPORT.md"), "# r\n");
    recordSignoff(dir, { name: "Jane Smith", role: "lead", decision: "accept" }, "2026-11-04");
    assert.equal(signoffState(dir).state, "signed");
});

test("the test plan says what the terminal check stops, what it doesn't, and what to do about it", () => {
    const plan = read("docs/TEST-PLAN.md");
    assert.match(plan, /### What the terminal check does and does not stop/);
    assert.match(plan, /accidents/);
    assert.match(plan, /agents that follow the rules/);
    assert.match(plan, /determined script/);
    assert.match(plan, /reviewed commit/i);
    for (const rule of ["**Only a person signs.**", "**Only a person installs an adapter.**"]) {
        const line = plan.split("\n").find((l) => l.includes(rule));
        assert.match(line, /terminal check/, rule);
    }
});

test("the places a person reads about signing point at the limit", () => {
    assert.match(read("README.md"), /determined script/);
    assert.match(read("docs/RUNBOOK.md"), /determined script/);
    assert.match(read("docs/ADAPTER-CONTRIBUTING.md"), /determined script/);
});

test("no message claims more than the check can do", () => {
    const main = read("packages/cli/src/main.ts");
    assert.doesNotMatch(main, /Agents and scripts do not (sign|install)/);
    const server = read("packages/mcp/src/server.ts");
    assert.match(server, /a rule to keep/, "the MCP instructions call it a rule, not a lock");
});
