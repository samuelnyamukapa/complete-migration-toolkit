// What /cmtk:data's agent may do, and what it can't: it proposes, a person accepts, and the engine makes every row.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addDataFinding, addProposal, decideProposal, describeProposal, loadDataFindings, loadManifest, loadProposals, loadRecipe, makeRows, planRecipe, trafficAgainstSchema, validate, writeCases, makeData } from "../dist/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCHEMA = {
    type: "object", additionalProperties: false, required: ["start", "end", "total", "lines", "name"],
    properties: {
        start: { type: "string", format: "date" }, end: { type: "string", format: "date" },
        total: { type: "number", minimum: 0, maximum: 100000, multipleOf: 0.01 },
        lines: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", required: ["amount"], properties: { amount: { type: "number", minimum: 0, maximum: 100, multipleOf: 0.01 } } } },
        name: { type: "string" },
        city: { type: "string", enum: ["Leeds", "York"] },
        code: { type: "string", maxLength: 5 },
    },
};
function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-model-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    fs.writeFileSync(path.join(dir, "order.json"), JSON.stringify(SCHEMA));
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    planRecipe(m(), { schema: "order.json", id: "order", seed: 9 });
    return { dir, m };
}
const propose = (p, rule) => addProposal(p.m(), { kind: "data_rule", reason: "the rules say so", proposed_by: "agent: test", data_rule: { recipe: "order", said_by: "spec", evidence: "RULE-7: an order can't end before it starts", ...rule } }, "2026-11-04");
const accept = (p, x) => decideProposal(p.m(), x.id, true, "A Person", "2026-11-04");
const INVARIANT = { what: "invariant", invariant: { left: "$.end", op: ">=", right: "$.start" } };
const before = (p) => fs.readFileSync(path.join(p.dir, "cmtk", "data", "order.yaml"), "utf8");

test("a proposal waits: nothing in the recipe changes until a person accepts it", () => {
    const p = project();
    const was = before(p);
    const x = propose(p, INVARIANT);
    assert.equal(x.status, "pending");
    assert.equal(before(p), was);
    assert.ok(loadProposals(p.m()).some((q) => q.kind === "data_rule" && q.status === "pending"));
    assert.match(describeProposal(x), /spec says so/);
    decideProposal(p.m(), x.id, false, "A Person", "2026-11-04", "no");
    assert.equal(before(p), was, "a rejected proposal changes nothing");
    assert.throws(() => propose({ m: p.m }, { what: "invariant", invariant: { left: "$.end", op: ">=", right: "$.start" }, said_by: "a guess" }), /said_by must be/);
    assert.throws(() => propose(p, { ...INVARIANT, evidence: " " }), /evidence is required/);
});

test("an invariant, once accepted, holds in every valid row, and breaks only in a labelled negative", () => {
    const p = project();
    const applied = accept(p, propose(p, INVARIANT));
    assert.match(applied.applied, /with an edge row and a broken row/);
    assert.doesNotMatch(applied.applied, /labelled negatives/, "dates can move, so no row had to change");
    const { recipe } = loadRecipe(p.m(), "order");
    assert.deepEqual([recipe.model.invariants[0].accepted_by, recipe.model.invariants[0].said_by], ["A Person", "spec"]);
    const rows = makeRows(p.m(), recipe);
    for (const r of rows.filter((x) => x.expect_valid)) if (r.value?.start && r.value?.end) assert.ok(r.value.end >= r.value.start, r.name);
    const edge = rows.find((r) => r.name === "end_ge_start_at_edge_invariant");
    assert.equal(edge.value.end, edge.value.start);
    assert.equal(edge.expect_valid, true);
    const broken = rows.find((r) => r.name === "end_ge_start_broken_invariant");
    assert.equal(broken.expect_valid, false);
    assert.deepEqual(broken.invalid_because, { path: "$.end", keyword: "invariant" });
    assert.ok(broken.value.end < broken.value.start);
    assert.equal(Date.parse(broken.value.start) - Date.parse(broken.value.end), 86400000, "by exactly one step");
    assert.equal(rows.filter((r) => !r.expect_valid && r.invalid_because.keyword === "invariant").length, 1);
});

test("a total = sum of lines invariant: the engine works it out", () => {
    const p = project();
    const a = accept(p, propose(p, { what: "invariant", invariant: { left: "$.total", op: "sum", right: "$.lines[*].amount" } }));
    assert.match(a.applied, /rows that break it are now labelled negatives/, "a boundary on the total can't sum to its lines");
    const rows = makeRows(p.m(), loadRecipe(p.m(), "order").recipe);
    const edgeRow = rows.find((r) => r.name === "total_maximum_at_3bva");
    assert.equal(edgeRow.expect_valid, false);
    assert.equal(edgeRow.invalid_because.keyword, "invariant");
    const sum = (r) => r.value.lines.reduce((a, l) => a + l.amount, 0);
    for (const r of rows.filter((x) => x.expect_valid && x.name !== "lines_empty" && x.value?.total !== undefined && Array.isArray(x.value?.lines))) {
        if (!r.value.lines.every((l) => typeof l.amount === "number")) continue;
        assert.ok(Math.abs(r.value.total - sum(r)) < 1e-6, `${r.name}: ${r.value.total} vs ${sum(r)}`);
    }
    const broken = rows.find((r) => r.name === "total_sum_lines_each_amount_broken_invariant");
    assert.ok(Math.abs(broken.value.total - sum(broken) - 0.01) < 1e-6);
});

test("invariants can't compare what has no order", () => {
    const p = project();
    assert.throws(() => propose(p, { what: "invariant", invariant: { left: "$.name", op: ">=", right: "$.start" } }), /must be numbers or dates/);
    assert.throws(() => propose(p, { what: "invariant", invariant: { left: "$.nope", op: ">=", right: "$.start" } }), /has no field \$\.nope/);
    assert.throws(() => propose(p, { what: "invariant", invariant: { left: "$.total", op: "sum", right: "$.start" } }), /A sum needs/);
    assert.throws(() => propose(p, { what: "invariant", invariant: { left: "$.end", op: "like", right: "$.start" } }), /needs left, right and an op/);
});

test("a vocabulary only where the schema is silent, each value checked, and marked low confidence", () => {
    const p = project();
    const prompted_with = { name: "name", description: "the customer's name", rejection: "name must be a person" };
    assert.throws(() => propose(p, { what: "vocabulary", path: "$.city", values: ["Hull"], prompted_with }), /already says what \$\.city may hold/);
    assert.throws(() => propose(p, { what: "vocabulary", path: "$.total", values: ["1"], prompted_with }), /not text/);
    assert.throws(() => propose(p, { what: "vocabulary", path: "$.code", values: ["far too long"], prompted_with }), /gate refuses "far too long"/);
    assert.throws(() => propose(p, { what: "vocabulary", path: "$.name", values: ["Ann"] }), /prompted_with needs/);
    accept(p, propose(p, { what: "vocabulary", path: "$.name", values: ["Ann Lee", "Raj Patel"], prompted_with }));
    const { recipe } = loadRecipe(p.m(), "order");
    const f = recipe.fields.find((x) => x.path === "$.name");
    assert.equal(f.valid_from, "vocabulary");
    assert.match(f.low_confidence, /Realistic, not proved/);
    const rows = makeRows(p.m(), recipe);
    assert.ok(["Ann Lee", "Raj Patel"].includes(rows.find((r) => r.name === "baseline_valid").value.name));
    assert.ok(rows.some((r) => r.name === "name_hostile_sql_quote"), "boundaries and negatives still come from the engine");
});

test("a field the schema says nothing about is marked low confidence from the start", () => {
    const p = project();
    const { recipe } = loadRecipe(p.m(), "order");
    assert.match(recipe.fields.find((f) => f.path === "$.name").low_confidence, /says nothing about this text/);
    assert.equal(recipe.fields.find((f) => f.path === "$.code").low_confidence, undefined);
});

test("a mutation is an operator, not a row: the engine builds it, the validator judges it, and the gate keeps only what adds coverage", () => {
    const p = project();
    assert.throws(() => propose(p, { what: "mutation", operator: "write_my_own", path: "$.name" }), /engine's operators/);
    assert.throws(() => propose(p, { what: "mutation", operator: "empty_string", path: "$.name" }), /gate refuses it: it makes the same data as name_hostile_empty/);
    assert.throws(() => propose(p, { what: "mutation", operator: "absent", path: "$.name" }), /gate refuses it: \$\.name is required/);
    const x = propose(p, { what: "mutation", operator: "decomposed_accent", path: "$.name" });
    accept(p, x);
    const { recipe } = loadRecipe(p.m(), "order");
    const row = recipe.rows.find((r) => r.name === "mutation_decomposed_accent_name");
    assert.equal(row.oracle, "human");
    assert.equal(row.expect_valid, true, "the validator decided that, not the proposer");
    assert.equal(row.set["$.name"], "café");
    assert.throws(() => propose(p, { what: "mutation", operator: "decomposed_accent", path: "$.name" }), /already has mutation_decomposed_accent_name/);
    const same = propose(p, { what: "mutation", operator: "same_as_field", path: "$.end", other: "$.start" });
    accept(p, same);
    const r2 = makeRows(p.m(), loadRecipe(p.m(), "order").recipe).find((r) => r.name === "mutation_same_as_field_end");
    assert.equal(r2.value.end, r2.value.start);
});

test("a mutation that only repeats a reason an existing row has is refused", () => {
    const p = project();
    assert.throws(() => propose(p, { what: "mutation", operator: "negative_one", path: "$.total" }), /gate refuses it: .* adds no coverage/);
});

test("the gate runs again at the moment a person accepts", () => {
    const p = project();
    const y = propose(p, { what: "mutation", operator: "whitespace_only", path: "$.name" });
    // The recipe changes under the proposal: the accept finds the row already there.
    const file = path.join(p.dir, "cmtk", "data", "order.yaml");
    fs.writeFileSync(file, before(p).replace("  rows:\n", "  rows:\n    - name: mutation_whitespace_only_name\n      technique: hostile\n      coverage_item: x\n      expect_valid: true\n      oracle: human\n"));
    assert.throws(() => accept(p, y), /gate refuses it/);
    assert.equal(loadProposals(p.m()).find((q) => q.id === y.id).status, "pending", "nothing was applied");
});

test("no proposal can carry a row or an answer, whatever is passed", () => {
    const p = project();
    for (const k of ["rows", "set", "value", "expect", "expect_valid", "invalid_because", "status"]) {
        assert.throws(() => propose(p, { what: "notional", name: "age", description: "age at booking", over: ["$.start"], [k]: [] }), new RegExp(`can't hold ${k}`), k);
    }
});

test("notional variables and state machines are recorded with their name and source, and say they make no rows yet", () => {
    const p = project();
    const n = accept(p, propose(p, { what: "notional", name: "stay", description: "days between start and end", over: ["$.start", "$.end"] }));
    assert.match(n.applied, /no row is made from it yet/);
    const s = accept(p, propose(p, { what: "state_machine", name: "order", states: ["open", "paid"], transitions: [{ from: "open", to: "paid", on: "pay" }] }));
    assert.match(s.applied, /no sequence is made from it yet/);
    const { recipe } = loadRecipe(p.m(), "order");
    assert.equal(recipe.model.notional[0].accepted_by, "A Person");
    assert.equal(recipe.model.state_machines[0].said_by, "spec");
    assert.throws(() => propose(p, { what: "state_machine", name: "x", states: ["a", "b"], transitions: [{ from: "a", to: "z", on: "go" }] }), /needs states from the list/);
    assert.throws(() => propose(p, { what: "notional", name: "x", description: "y", over: ["$.nope"] }), /no field/);
});

test("disagreements are findings: two sides, a question, and nothing settled", () => {
    const p = project();
    const was = before(p);
    assert.throws(() => addDataFinding(p.m(), { recipe: "order", field: "$.total", structure_says: "up to 100000", question: "which?", found_by: "agent" }), /at least two/);
    assert.throws(() => addDataFinding(p.m(), { recipe: "order", field: "$.total", structure_says: "a", spec_says: "b", question: " ", found_by: "agent" }), /question/);
    const f = addDataFinding(p.m(), { recipe: "order", field: "$.total", structure_says: "minimum 0", spec_says: "RULE-13: above 0", question: "Is an order of zero allowed?", found_by: "agent: test" }, "2026-11-04");
    assert.equal(f.status, "open");
    assert.equal(f.id, "F-001");
    assert.equal(loadDataFindings(p.m(), "order").length, 1);
    assert.equal(before(p), was, "the recipe is untouched");
    assert.equal(addDataFinding(p.m(), { recipe: "order", field: "$.x", spec_says: "a", production_says: "b", question: "?", found_by: "agent" }).id, "F-002");
});

test("traffic against the schema: paths, counts and reasons, and never a value from the recording", () => {
    const p = project();
    const secret = "Margaret Hale-4111111111111111";
    const entry = (body, url = "http://x/orders", method = "POST") => ({ request: { method, url, postData: { text: JSON.stringify(body) } } });
    const good = { start: "2026-01-01", end: "2026-01-02", total: 1, lines: [{ amount: 1 }], name: "x" };
    fs.writeFileSync(path.join(p.dir, "t.har"), JSON.stringify({ log: { entries: [
        entry(good), entry({ ...good, total: -5, name: secret }), entry({ ...good, total: -6, loyalty: secret }), entry(good, "http://x/other"), entry(good, "http://x/orders", "GET"),
    ] } }));
    const { requests, disagreements } = trafficAgainstSchema(p.m(), "order", "t.har", { path: "/orders" });
    assert.equal(requests, 3);
    assert.deepEqual(disagreements.map((d) => [d.field, d.keyword, d.requests]), [["$.loyalty", "not in the schema", 1], ["$.total", "minimum", 2]]);
    assert.ok(!JSON.stringify(disagreements).includes("Margaret"));
    assert.throws(() => trafficAgainstSchema(p.m(), "order", "missing.har", { path: "/orders" }), /does not exist/);
    assert.throws(() => trafficAgainstSchema(p.m(), "order", "t.har"), /Say which requests/);
});

test("a row only a person can judge is never asserted automatically, even with a status given", async () => {
    const p = project();
    accept(p, propose(p, { what: "mutation", operator: "decomposed_accent", path: "$.name" }));
    await makeData(p.m(), "order", { now: "2026-11-04T00:00:00Z" });
    const { cases } = writeCases(p.m(), "order", { path: "/orders", expectValid: 201, expectInvalid: 400 });
    const human = cases.find((c) => /by mutation/.test(c.name));
    assert.equal(human.expect, undefined);
    assert.match(human.draft_note, /Only a person can say what this row should get/);
    assert.ok(cases.filter((c) => c.expect).length > 10);
    assert.ok(cases.every((c) => c.draft), "every case is a draft");
});

test("the skill says what it must, and offers no way round it", () => {
    const skill = fs.readFileSync(path.join(ROOT, "plugin", "skills", "data", "SKILL.md"), "utf8");
    for (const w of ["cmtk_data_propose", "cmtk_data_finding", "cmtk_data_traffic", "structure", "spec", "production", "Never commit rows", "never write an expectation", "one operation", "low confidence", "never presented as coverage", "derived", "human", "Inventory", "HAR"]) assert.ok(skill.includes(w), w);
    assert.equal(validate({ type: "string" }, "x").length, 0);
});
