// Findings 6 and 7 of the review of 0.6: a contract cut at 5 MB, and an `expect:` that checks nothing, must never read as a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { addProposal, check, checkContract, checkExpectation, compare, loadManifest, MAX_BODY, run } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-pass-"));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const server = (fn) => new Promise((resolve) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
const m = (dir) => loadManifest(path.join(dir, "cmtk.yaml"));

test("a text contract that differs only after the 5 MB cap is not IDENTICAL, and the comparison is not PARITY", async () => {
    const big = (tail) => (req, res) => { res.setHeader("content-type", "text/plain"); res.end(Buffer.concat([Buffer.alloc(MAX_BODY + 10, "a"), Buffer.from(tail)])); };
    const [a, b] = [await server(big("one")), await server(big("two"))];
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${a.url}" }\n  candidate: { base_url: "${b.url}" }\ncontracts:\n  - { name: spec, kind: text, path: /spec }\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /x }\n");
    try {
        const r = await compare(m(dir));
        assert.notEqual(r.contracts[0].result, "IDENTICAL");
        assert.equal(r.contracts[0].result, "ERROR");
        assert.match(r.contracts[0].findings[0].what, /5 MB/);
        assert.notEqual(r.verdict, "PARITY");
        assert.equal(r.verdict, "INCOMPLETE");
    } finally {
        await a.close(); await b.close();
    }
});

test("a cut contract never gets as far as being read, whatever its kind and whichever side was cut", () => {
    const whole = { status: 200, body: "{}", sha256: "x" };
    const cut = { ...whole, truncated: true };
    for (const kind of ["text", "openapi", "wsdl", "xsd"]) {
        assert.equal(checkContract({ name: "n", kind, path: "/" }, cut, whole).result, "ERROR", kind);
        assert.equal(checkContract({ name: "n", kind, path: "/" }, whole, cut).result, "ERROR", kind);
    }
});

for (const [what, expect, why] of [
    ["an empty expect", {}, /holds no check/],
    ["misspelt keys", { stauts: 200, body_contain: ["x"] }, /stauts/],
    ["one good key and one misspelt", { status: 200, body_contain: ["x"] }, /body_contain/],
    ["a status that is not a number", { status: "200" }, /status/],
    ["a misspelt JSON check", { json: { "$.a": { equal: 1 } } }, /equal/],
    ["a JSON check with no test in it", { json: { "$.a": {} } }, /\$\.a/],
    ["an empty json block", { json: {} }, /holds no check/],
    ["a misspelt header check", { headers: { "content-type": { match: "x" } } }, /content-type/],
    ["body_contains that is not a list", { body_contains: "x" }, /body_contains/],
]) {
    test(`${what} is refused when the case is loaded, so cmtk check says so`, () => {
        const dir = tmp();
        write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: \"http://127.0.0.1:9\" }\n");
        write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: [{ id: "A", request: "GET /x", expect }] }));
        assert.throws(() => check(m(dir)), why);
    });
}

test("a pattern that can't compile is an error on its own case, never a pass", async () => {
    const s = await server((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"a":"x"}'); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: [{ id: "A", request: "GET /x", expect: { json: { "$.a": { matches: "(" } } } }] }));
    try {
        assert.equal((await run(m(dir))).cases[0].result, "ERROR");
    } finally {
        await s.close();
    }
});

test("against a 500, what used to pass now stops the run instead", async () => {
    let hits = 0;
    const s = await server((req, res) => { hits++; res.statusCode = 500; res.end("boom"); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /x, expect: { stauts: 200 } }\n");
    try {
        await assert.rejects(run(m(dir)), /stauts/);
        assert.equal(hits, 0);
    } finally {
        await s.close();
    }
});

test("every check still loads, and a good expect still works", async () => {
    const s = await server((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"a":1,"b":"two"}'); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: [{ id: "A", request: "GET /x", expect: {
        status: [200, 201], headers: { "content-type": { matches: "json" }, "x-none": { matches: "^$" } }, json: { "$.a": { equals: 1 }, "$.b": { matches: "^t" }, "$.c": { exists: false }, "$": { type: "object" } }, body_contains: ["two"], body_excludes: ["three"],
    } }] }));
    try {
        const r = await run(m(dir));
        assert.deepEqual(r.cases[0].failures?.map((f) => f.check), ["header:x-none"]);
    } finally {
        await s.close();
    }
});

test("an expectation with no check can't pass, even if it reaches the check some other way", () => {
    assert.deepEqual(checkExpectation({}, { status: 500, body: "boom" }).map((f) => f.check), ["expect"]);
    assert.deepEqual(checkExpectation({ stauts: 200 }, { status: 500, body: "boom" }).map((f) => f.check), ["expect"]);
});

test("an expectation proposal is held to the same rules", () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: \"http://127.0.0.1:9\" }\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: A, request: GET /x }\n");
    assert.throws(() => addProposal(m(dir), { kind: "expectation", case: "A", expect: { json: { "$.a": { equal: 1 } } }, reason: "r", proposed_by: "agent" }, "2026-11-04"), /equal/);
});
