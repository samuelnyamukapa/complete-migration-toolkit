// The `journey` match level, the model-call count and screenshots as evidence, with no browser: an adapter stands in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { check, compare, compareObservations, covers, evidenceFingerprint, exploreRequest, loadManifest, MATCH_LEVELS, renderReport, run, startSession } from "../dist/index.js";

const NONE = { scrub: { json_paths: [], xml_ignore: [], regex: [] }, compare_headers: [] };
const outcome = (more = {}) => ({ goal: "Buy a jacket", checks: [{ name: "in the basket", passed: true }], values: { items: "1" }, pages: [{ name: "basket", path: "/basket" }], ...more });
const diff = (a, b, m = NONE) => compareObservations({ status: 200, journey: a }, { status: 200, journey: b }, m, "journey");

test("journey is a match level", () => {
    assert.ok(MATCH_LEVELS.includes("journey"));
});

test("journey: paths, status, body and headers may differ when the outcomes are the same", () => {
    const a = { status: 200, headers: { "content-type": "a" }, body: "one", journey: outcome() };
    const b = { status: 417, headers: { "content-type": "b" }, body: "two", journey: outcome({ pages: [{ name: "basket", path: "/cart" }, { path: "/other" }] }) };
    assert.deepEqual(compareObservations(a, b, { ...NONE, compare_headers: ["content-type"] }, "journey"), []);
});

test("journey: a check that passes on one system only, a changed value and a page not reached are each named", () => {
    const d = diff(outcome(), outcome({ checks: [{ name: "in the basket", passed: false, expected: "1", actual: "0" }], values: { items: "0" }, pages: [] }));
    assert.deepEqual(d.map((x) => x.where).sort(), ["journey:check:in the basket", "journey:page:basket", "journey:value:items"]);
    assert.equal(d.find((x) => x.where.startsWith("journey:check")).candidate, "failed: expected 1, got 0");
});

test("journey: nothing reported, or nothing to compare, never reads as a match", () => {
    assert.deepEqual(diff(undefined, undefined), [{ where: "journey", reference: "(no journey reported)", candidate: "(no journey reported)" }]);
    assert.equal(diff(outcome(), undefined).length, 1);
    const empty = { goal: "g", checks: [], values: {}, pages: [] };
    assert.equal(diff(empty, empty)[0].where, "journey");
});

test("journey: the same check failing on both systems is parity, as it is for any legacy defect", () => {
    const failing = outcome({ checks: [{ name: "in the basket", passed: false, actual: "0" }] });
    assert.deepEqual(diff(failing, failing), []);
});

test("journey: goal, value missing on one side, page order and asked-for API calls", () => {
    assert.equal(diff(outcome(), outcome({ goal: "Other" }))[0].where, "journey:goal");
    assert.deepEqual(diff(outcome(), outcome({ values: { items: "1", extra: "x" } }))[0], { where: "journey:value:extra", reference: "(missing)", candidate: "x" });
    assert.deepEqual(diff(outcome({ values: { items: null } }), outcome())[0], { where: "journey:value:items", reference: "(not shown)", candidate: "1" });
    const order = diff(outcome({ pages: [{ name: "a", path: "/a" }, { name: "b", path: "/b" }] }), outcome({ pages: [{ name: "b", path: "/b" }, { name: "a", path: "/a" }] }));
    assert.deepEqual(order, [{ where: "journey:pages", reference: "a > b", candidate: "b > a" }]);
    const api = diff(outcome({ api_compared: ["POST /api 200"] }), outcome({ api_compared: ["POST /api 500"] }));
    assert.deepEqual(api.map((x) => x.where).sort(), ["journey:api:POST /api 200", "journey:api:POST /api 500"]);
    assert.deepEqual(diff(outcome({ api_calls: [{ page: "/", method: "GET", path: "/a" }] }), outcome({ api_calls: [] })), [], "API calls are reported, not compared, unless asked for");
});

test("journey: scrubs apply, and a person can approve a difference by its where", () => {
    const m = { ...NONE, scrub: { json_paths: [], xml_ignore: [], regex: [{ pattern: "\\d{4}-\\d{2}-\\d{2}" }] } };
    assert.deepEqual(diff(outcome({ values: { d: "on 2026-01-01" } }), outcome({ values: { d: "on 2026-02-02" } }), m), []);
    const pathScrub = { ...NONE, scrub: { json_paths: ["$.values.ref"], xml_ignore: [], regex: [] } };
    assert.deepEqual(diff(outcome({ values: { ref: "A" } }), outcome({ values: { ref: "B" } }), pathScrub), []);
    assert.ok(covers("journey:value:*", "journey:value:items"));
    assert.ok(!covers("journey:value:*", "journey:check:items"));
});

/** A project whose adapter is a small script: it answers from its target's settings. */
function project(reply, cases, more = "") {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cmtk-journey-"));
    fs.writeFileSync(path.join(dir, "a.mjs"), `
import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  const r = m.op === "reset" ? { ok: true } : (${reply})(m);
  process.stdout.write(JSON.stringify(r) + "\\n");
}`);
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), cases);
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s
targets:
  legacy: { base_url: "http://127.0.0.1:9" }
  candidate: { base_url: "http://127.0.0.1:9" }
adapters:
  ui: { command: "${process.execPath.replace(/\\/g, "/")}", args: [a.mjs] }
${more}`);
    return dir;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");
const CASE = "cases:\n  - { id: J, surface: ui, match: journey, request: GET /, expect: { status: 200 } }\n";

test("the report counts model calls, and a screenshot becomes an evidence file that no answer holds", async () => {
    const dir = project(`(m) => ({ status: 200, journey: ${JSON.stringify(outcome())}, model_calls: 0, screenshots: [{ page: "basket", png_base64: "${PNG}" }] })`, CASE);
    const r = await compare(loadManifest(path.join(dir, "cmtk.yaml")), { date: "2026-11-04" });
    assert.equal(r.verdict, "PARITY");
    assert.deepEqual(r.model_calls, { total: 0, cases_not_counted: 0 });
    assert.match(renderReport(r), /- Model calls: 0\n/);
    const answers = path.join(dir, "cmtk/evidence/compare/answers");
    const saved = JSON.parse(fs.readFileSync(path.join(answers, "J.reference.json"), "utf8"));
    assert.ok(!JSON.stringify(saved).includes(PNG));
    assert.equal(saved.screenshots[0].file, "J.reference.screen-01.png");
    assert.equal(saved.screenshots[0].page, "basket");
    assert.deepEqual(fs.readFileSync(path.join(answers, saved.screenshots[0].file)), Buffer.from(PNG, "base64"));
});

test("a screenshot counts towards the evidence a person signs: changing one changes the fingerprint", async () => {
    const dir = project(`(m) => ({ status: 200, journey: ${JSON.stringify(outcome())}, model_calls: 0, screenshots: [{ page: "basket", png_base64: "${PNG}" }] })`, CASE);
    await compare(loadManifest(path.join(dir, "cmtk.yaml")));
    const folder = path.join(dir, "cmtk/evidence/compare");
    const before = evidenceFingerprint(folder);
    fs.appendFileSync(path.join(folder, "answers/J.reference.screen-01.png"), "x");
    assert.notEqual(evidenceFingerprint(folder), before);
});

test("an exploration log and its answer to the agent hold no pictures", async () => {
    const dir = project(`(m) => ({ status: 200, body: "ok", model_calls: 0, screenshots: [{ page: "/", png_base64: "${PNG}" }] })`, CASE);
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    const s = startSession(m, { charter: "look around", surface: "ui", target: "candidate" });
    const probe = await exploreRequest(m, s.id, "GET /");
    assert.equal(probe.observation.status, 200);
    assert.equal(probe.observation.screenshots, undefined);
    const logs = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else logs.push(fs.readFileSync(path.join(d, e.name), "utf8")); } };
    walk(path.join(dir, "cmtk"));
    assert.ok(logs.length > 0);
    assert.ok(logs.every((t) => !t.includes(PNG)));
});

test("a model call is counted on both systems and in `cmtk run`, and an adapter that does not count is never read as zero", async () => {
    const dir = project(`(m) => ({ status: 200, journey: ${JSON.stringify(outcome())}, model_calls: 2 })`, CASE);
    assert.deepEqual((await compare(loadManifest(path.join(dir, "cmtk.yaml")))).model_calls, { total: 4, cases_not_counted: 0 });
    assert.deepEqual((await run(loadManifest(path.join(dir, "cmtk.yaml")))).model_calls, { total: 2, cases_not_counted: 0 });
    const silent = project(`(m) => ({ status: 200, journey: ${JSON.stringify(outcome())} })`, CASE);
    const r = await compare(loadManifest(path.join(silent, "cmtk.yaml")));
    assert.deepEqual(r.model_calls, { total: 0, cases_not_counted: 2 });
    assert.match(renderReport(r), /Model calls: 0 counted, and 2 answers from an adapter that does not count them/);
});

test("an adapter that reports no journey at the journey level reads as a difference, not parity", async () => {
    const dir = project(`(m) => ({ status: 200, body: "same" })`, CASE);
    const r = await compare(loadManifest(path.join(dir, "cmtk.yaml")));
    assert.equal(r.verdict, "NO PARITY");
    assert.equal(r.cases[0].differences[0].where, "journey");
});

test("`cmtk check` warns about a script that is not there", () => {
    const dir = project(`(m) => ({ status: 200 })`, "cases:\n  - { id: J, surface: ui, request: GET /, requirement: R, journey: { script: nope.json } }\n");
    assert.ok(check(loadManifest(path.join(dir, "cmtk.yaml"))).warnings.some((w) => /J: the script nope\.json does not exist/.test(w)));
});

test("`cmtk check` warns about an http case at the journey level", () => {
    const dir = project(`(m) => ({ status: 200 })`, "cases:\n  - { id: J, match: journey, request: GET /, requirement: R }\n");
    assert.ok(check(loadManifest(path.join(dir, "cmtk.yaml"))).warnings.some((w) => /J: match `journey` needs an adapter/.test(w)));
});
