// Finding 3 of the review of 0.6: a read-only case must not reset anything, or it wipes the very state it came to compare.
// An adapter keeps the old behaviour only by asking for it in describe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { compare, confirmSafe, loadCases, loadManifest } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-reset-"));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

/** An adapter with a folder for each target: reset empties it, run reports what it holds. Every op is logged. */
const STUB = (describe) => `import fs from "node:fs";
import readline from "node:readline";
const log = (s) => fs.appendFileSync("ops.log", s + "\\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
    const msg = JSON.parse(line);
    if (msg.op === "describe") console.log(JSON.stringify(${describe}));
    else if (msg.op === "reset") { log("reset " + msg.target.name); fs.writeFileSync(msg.target.name + ".state", ""); console.log(JSON.stringify({ ok: true })); }
    else { log("run " + msg.target.name + " " + msg.case.id); console.log(JSON.stringify({ status: 200, headers: {}, effects: { holds: fs.readFileSync(msg.target.name + ".state", "utf8") } })); }
}
`;

function project(cases, { describe = '{ name: "stub", kinds: ["queue"] }', unsafe = false } = {}) {
    const dir = tmp();
    write(dir, "stub.mjs", STUB(describe));
    write(dir, "legacy.state", "one message");
    write(dir, "candidate.state", "a different message");
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { x: 1 }\n  candidate: { x: 1 }\nadapters:\n  stub: { command: "${process.execPath.replace(/\\/g, "/")}", args: [stub.mjs] }\n${unsafe ? "allow_unsafe_methods: true\n" : ""}`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: cases.map((c) => ({ surface: "stub", ...c })) }));
    return dir;
}
const m = (dir) => loadManifest(path.join(dir, "cmtk.yaml"));
const ops = (dir) => (fs.existsSync(path.join(dir, "ops.log")) ? fs.readFileSync(path.join(dir, "ops.log"), "utf8").trim().split("\n") : []);

test("a read-only case resets nothing: two different states read as DIFFERENT, and they are left as they were", async () => {
    const dir = project([{ id: "LOOK", request: "GET /messages" }]);
    const r = await compare(m(dir));
    assert.equal(r.cases[0].result, "DIFFERENT", JSON.stringify(r.cases[0]));
    assert.equal(r.verdict, "NO PARITY");
    assert.deepEqual(ops(dir), ["run legacy LOOK", "run candidate LOOK"]);
    assert.equal(fs.readFileSync(path.join(dir, "legacy.state"), "utf8"), "one message");
});

test("a case the systems agree on says it compared what they hold now, not a clean start", async () => {
    const dir = project([{ id: "LOOK", request: "GET /messages" }]);
    write(dir, "candidate.state", "one message");
    const r = await compare(m(dir));
    assert.equal(r.cases[0].result, "MATCH");
    assert.match(r.cases[0].note, /not reset/);
    assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8"), /not reset/);
});

test("a case that writes still starts clean on both systems, but only once both switches let it go", async () => {
    const dir = project([{ id: "SEND", request: "POST /send" }], { unsafe: true });
    const held = await compare(m(dir));
    assert.equal(held.cases[0].result, "SKIPPED");
    assert.deepEqual(ops(dir), [], "a case that is not sent resets nothing");
    const sent = await compare(m(dir), { allowUnsafe: true });
    assert.equal(sent.cases[0].result, "MATCH");
    assert.equal(sent.cases[0].note, undefined);
    assert.deepEqual(ops(dir), ["reset legacy", "reset candidate", "run legacy SEND", "run candidate SEND"]);
});

test("a read that overrides its method counts as a write, so it does get a clean start", async () => {
    const dir = project([{ id: "OV", request: "GET /x?_method=DELETE" }], { unsafe: true });
    await compare(m(dir), { allowUnsafe: true });
    assert.deepEqual(ops(dir).slice(0, 2), ["reset legacy", "reset candidate"]);
});

test("a case a person confirmed as safe changes nothing, so it resets nothing", async () => {
    const dir = project([{ id: "SOAP", request: "POST /read", safe: true }]);
    confirmSafe(m(dir), "SOAP", "Jane Smith", "2026-11-04", loadCases(m(dir))[0]);
    const r = await compare(m(dir));
    assert.equal(r.cases[0].result, "DIFFERENT");
    assert.deepEqual(ops(dir), ["run legacy SOAP", "run candidate SOAP"]);
});

test("an adapter can ask for a reset before reads in describe, and only then does it get one", async () => {
    const dir = project([{ id: "L1", request: "GET /a" }, { id: "L2", request: "GET /b" }], { describe: '{ name: "stub", kinds: ["queue"], reset_before_reads: true }' });
    const r = await compare(m(dir));
    assert.deepEqual(ops(dir).slice(0, 3), ["reset legacy", "reset candidate", "run legacy L1"]);
    assert.equal(ops(dir).filter((o) => o.startsWith("reset")).length, 4, "before each read");
    assert.equal(r.cases[0].note, undefined, "it did start clean");
});

test("an adapter whose describe is broken gets no reset before reads, and its case still runs", async () => {
    const dir = project([{ id: "LOOK", request: "GET /messages" }], { describe: '{ error: "no such op" }' });
    const r = await compare(m(dir));
    assert.equal(r.cases[0].result, "DIFFERENT");
    assert.deepEqual(ops(dir), ["run legacy LOOK", "run candidate LOOK"]);
});
