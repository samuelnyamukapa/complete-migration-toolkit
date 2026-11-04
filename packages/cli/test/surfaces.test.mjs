// Targets that list their surfaces (#42): one manifest for a partly rebuilt system, and a report that states its
// scope. The eShop example manifest and its case files are used as they are, in a copy, with local stand-ins for
// legacy eShop and for the catalog probe: neither real system has run with this manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check, compare, loadManifest, recordSignoff, run, describeSignoff, signoffState } from "../../core/dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const CLI = path.join(HERE, "..", "dist", "main.js");
const EXAMPLE = path.join(ROOT, "examples", "eshop-pilot");

const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

function server() {
    const seen = [];
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            seen.push(req.url);
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
        });
        s.listen(0, "127.0.0.1", () => resolve({ seen, url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

/** Answers the same on both targets, except for a path named in PLANT. Logs each run, so a test can see what was sent. */
const ADAPTER = `import fs from "node:fs";
import readline from "node:readline";
const log = process.env.CMTK_TEST_LOG;
for await (const l of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(l);
  let reply = { ok: true };
  if (m.op === "run") {
    if (log) fs.appendFileSync(log, m.target.name + " " + m.case.id + "\\n");
    const planted = m.target.name === "candidate" && process.env.CMTK_TEST_PLANT === m.case.id;
    reply = { status: 200, body: JSON.stringify({ path: m.case.request.path, planted }) };
  }
  process.stdout.write(JSON.stringify(reply) + "\\n");
}
`;

function eshopCopy(url) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-surfaces-"));
    const yaml = fs.readFileSync(path.join(EXAMPLE, "cmtk-one-manifest.yaml"), "utf8");
    assert.match(yaml, /NOT YET RUN/, "the example says it has not run against the real systems");
    write(dir, "cmtk-one-manifest.yaml", yaml.replace("http://localhost:53190", url));
    for (const rel of ["cmtk/cases/legacy", "cmtk/cases/catalogcore"]) fs.cpSync(path.join(EXAMPLE, rel), path.join(dir, rel), { recursive: true });
    fs.copyFileSync(path.join(EXAMPLE, "cmtk/drift-catalogcore.yaml"), path.join(dir, "cmtk/drift-catalogcore.yaml"));
    write(dir, "adapters/catalog/index.mjs", ADAPTER);
    return dir;
}

test("the eShop example as one manifest: catalog cases compare, HTTP cases do not, and the report states the scope", async () => {
    const legacy = await server();
    try {
        const dir = eshopCopy(legacy.url);
        const r = await cmtk(dir, "compare", "--manifest", "cmtk-one-manifest.yaml");
        assert.equal(r.status, 4, r.stdout + r.stderr);
        assert.match(r.stdout, /verdict for eshop: PARTIAL COMPARISON/);
        assert.doesNotMatch(r.stdout, /PARITY/);
        assert.match(r.stdout, /This comparison covers only catalog, not the whole system\. Not compared: \d+ cases on http \(candidate has no http surface\)/);
        assert.deepEqual(legacy.seen, [], "nothing is sent for a case that is not comparable");

        const report = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence-one-manifest/compare/REPORT.json"), "utf8"));
        const catalog = report.cases.filter((c) => c.surface === "catalog");
        const web = report.cases.filter((c) => c.surface === "http");
        assert.ok(catalog.length >= 24 && web.length > 0);
        assert.ok(catalog.every((c) => c.result === "MATCH"));
        assert.ok(web.every((c) => c.result === "NOT COMPARABLE" && c.why === "not comparable: candidate has no http surface"));
        assert.equal(report.counts.ERROR, 0, "it does not count as an error");
        assert.equal(report.counts["NOT COMPARABLE"], web.length);
        assert.equal(report.scope.whole, false);
        assert.deepEqual(report.scope.compared, [{ surface: "catalog", cases: catalog.length }]);
        assert.deepEqual(report.scope.not_compared, [{ surface: "http", cases: web.length, why: "candidate has no http surface" }]);

        const md = fs.readFileSync(path.join(dir, "cmtk/evidence-one-manifest/compare/REPORT.md"), "utf8");
        assert.match(md, /\*\*Verdict: PARTIAL COMPARISON\*\* \(only part of the system: see Scope\)/);
        assert.match(md, /## Scope/);
        assert.match(md, /- Not compared: http, \d+ cases: candidate has no http surface/);
        assert.match(md, /\| API-2-01 \|.*\| not comparable: candidate has no http surface \|/);
        assert.doesNotMatch(md, /PARITY/);
    } finally {
        await legacy.close();
    }
});

test("the eShop example as one manifest: cmtk run sends the HTTP cases to legacy and leaves the compare-only ones out", async () => {
    const legacy = await server();
    try {
        const dir = eshopCopy(legacy.url);
        const log = path.join(dir, "adapter.log");
        const m = loadManifest(path.join(dir, "cmtk-one-manifest.yaml"));
        process.env.CMTK_TEST_LOG = log;
        const r = await run(m).finally(() => { delete process.env.CMTK_TEST_LOG; });
        assert.ok(legacy.seen.length > 0, "the HTTP cases reached legacy");
        assert.ok(!fs.existsSync(log), "no catalog case ran");
        assert.ok(r.cases.every((c) => c.surface === "http"));
        assert.ok(r.excluded_compare_only >= 24);
        assert.match(r.reason, /on a compare-only surface \(catalog\) were left out: `cmtk compare` covers them\./);
    } finally {
        await legacy.close();
    }
});

test("a planted difference on the shared surface is caught, and the scope is still stated", async () => {
    const legacy = await server();
    const dir = eshopCopy(legacy.url);
    try {
        process.env.CMTK_TEST_PLANT = "SVC-2-01";
        const r = await compare(loadManifest(path.join(dir, "cmtk-one-manifest.yaml")));
        assert.equal(r.verdict, "NO PARITY");
        assert.equal(r.cases.find((c) => c.id === "SVC-2-01").result, "DIFFERENT");
        assert.match(r.reason, /1 case answered differently\. This comparison covers only catalog, not the whole system\./);
    } finally {
        delete process.env.CMTK_TEST_PLANT;
        await legacy.close();
    }
});

// ---------------------------------------------------------------- small projects

function project(targets, cases, more = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-surfaces-"));
    write(dir, "cmtk.yaml", `system: s\ntargets:\n${targets}\nreference: legacy\ncandidate: candidate\nadapters:\n  catalog: { command: ${JSON.stringify(process.execPath)}, args: [a.mjs] }\n${more}`);
    write(dir, "a.mjs", ADAPTER);
    write(dir, "cmtk/cases/a.yaml", `cases:\n${cases}\n`);
    return { dir, m: loadManifest(path.join(dir, "cmtk.yaml")) };
}
const CATALOG = "  - { id: C1, surface: catalog, request: GET /items }";

test("PARITY needs every surface the targets list to be compared", async () => {
    const a = await server(), b = await server();
    try {
        const both = `  legacy: { base_url: "${a.url}", surfaces: [http, catalog] }\n  candidate: { base_url: "${b.url}", surfaces: [http, catalog] }`;
        const whole = await compare(project(both, `${CATALOG}\n  - { id: W1, request: GET / }`).m);
        assert.equal(whole.verdict, "PARITY");
        assert.equal(whole.scope.whole, true);
        assert.match(whole.scope.statement, /Every surface the targets list was compared: catalog, http\./);

        const noCases = await compare(project(both, CATALOG).m);
        assert.equal(noCases.verdict, "PARTIAL COMPARISON", "a surface both offer, with no case, was not compared");
        assert.deepEqual(noCases.scope.no_cases, ["http"]);
        assert.match(noCases.reason, /http \(no case compared it\)/);

        // The candidate lacks http and no case is on it: no case is "not comparable", and it is still only part of the system.
        const lacks = await compare(project(`  legacy: { base_url: "${a.url}", surfaces: [http, catalog] }\n  candidate: { surfaces: [catalog] }`, CATALOG).m);
        assert.equal(lacks.verdict, "PARTIAL COMPARISON");
        assert.deepEqual(lacks.scope.not_compared, [{ surface: "http", cases: 0, why: "candidate has no http surface" }]);
    } finally {
        await a.close();
        await b.close();
    }
});

test("targets that list no surfaces work as before, with no scope", async () => {
    const a = await server(), b = await server();
    try {
        const r = await compare(project(`  legacy: { base_url: "${a.url}" }\n  candidate: { base_url: "${b.url}" }`, "  - { id: W1, request: GET / }").m);
        assert.equal(r.verdict, "PARITY");
        assert.equal(r.scope, undefined);
    } finally {
        await a.close();
        await b.close();
    }
});

test("only a surface one lacks, with nothing comparable: NO EVIDENCE. An error beside it: INCOMPLETE", async () => {
    const a = await server();
    try {
        const none = await compare(project(`  legacy: { base_url: "${a.url}", surfaces: [http] }\n  candidate: { surfaces: [catalog] }`, "  - { id: W1, request: GET / }").m);
        assert.equal(none.verdict, "NO EVIDENCE");
        assert.match(none.reason, /No case ran: 1 case not comparable/);
        assert.match(none.next, /a surface both targets offer/);

        const draft = await compare(project(`  legacy: { base_url: "${a.url}", surfaces: [http, catalog] }\n  candidate: { surfaces: [catalog] }`, `${CATALOG}\n  - { id: W1, request: GET / }\n  - { id: C2, surface: catalog, draft: true, request: GET /x }`).m);
        assert.equal(draft.verdict, "INCOMPLETE");
        assert.match(draft.reason, /1 case were skipped\. This comparison covers only catalog/);
    } finally {
        await a.close();
    }
});

test("a contract is only checked over http on both: otherwise it is not comparable, and nothing is sent", async () => {
    const a = await server();
    try {
        const r = await compare(project(`  legacy: { base_url: "${a.url}", surfaces: [http, catalog] }\n  candidate: { surfaces: [catalog] }`, CATALOG, "contracts:\n  - { name: api, kind: openapi, path: /swagger.json }\n").m);
        assert.equal(r.contracts[0].result, "NOT COMPARABLE");
        assert.match(r.contracts[0].findings[0].what, /not comparable: candidate has no http surface/);
        assert.equal(r.verdict, "PARTIAL COMPARISON");
        assert.deepEqual(r.scope.contracts_not_compared, ["api"]);
        assert.deepEqual(a.seen, []);
    } finally {
        await a.close();
    }
});

test("drift for a case that was not compared is not called stale; drift that a compared case no longer needs is", async () => {
    const a = await server();
    try {
        const { dir, m } = project(`  legacy: { base_url: "${a.url}", surfaces: [http, catalog] }\n  candidate: { surfaces: [catalog] }`, `${CATALOG}\n  - { id: W1, request: GET / }`);
        write(dir, "cmtk/drift.yaml", "drift:\n  - { id: D-W, case: W1, where: status, reason: r, approved_by: A }\n  - { id: D-C, case: C1, where: status, reason: r, approved_by: A }\n");
        assert.deepEqual((await compare(m)).unused_drift, ["D-C"]);
    } finally {
        await a.close();
    }
});

test("cmtk run on a target that lacks a surface: nothing is sent, and it is never a pass", async () => {
    const a = await server();
    try {
        const { dir, m } = project(`  legacy: { base_url: "${a.url}", surfaces: [http] }\n  candidate: { surfaces: [catalog] }`, "  - { id: C1, surface: catalog, request: GET /items, expect: { status: 200 } }\n  - { id: W1, request: GET /, expect: { status: 200 } }");
        const r = await run(m, { target: "legacy" });
        assert.equal(r.verdict, "INCOMPLETE");
        assert.equal(r.cases.find((c) => c.id === "C1").why, "not run: legacy has no catalog surface");
        assert.equal(r.cases.find((c) => c.id === "W1").result, "PASS");
        assert.ok(dir);
    } finally {
        await a.close();
    }
});

test("a sign-off on part of a system records the scope", async () => {
    const a = await server();
    try {
        const { dir, m } = project(`  legacy: { base_url: "${a.url}", surfaces: [http, catalog] }\n  candidate: { surfaces: [catalog] }`, `${CATALOG}\n  - { id: W1, request: GET / }`);
        await compare(m);
        const ev = path.join(dir, "cmtk/evidence/compare");
        const s = recordSignoff(ev, { name: "A Person", role: "Architect", decision: "accept" }, "2026-11-04");
        assert.equal(s.verdict, "PARTIAL COMPARISON");
        assert.match(s.scope, /covers only catalog, not the whole system/);
        assert.match(describeSignoff(signoffState(ev)), /for what was compared only\. This comparison covers only catalog/);
    } finally {
        await a.close();
    }
});

test("surfaces are checked when the settings load, and cmtk check says what will not be comparable", () => {
    const bad = (targets, rx, more) => assert.throws(() => project(targets, CATALOG, more), rx);
    bad("  legacy: { base_url: 'http://x', surfaces: [] }\n  candidate: { probe: p }", /surfaces must be a list of surface names/);
    bad("  legacy: { base_url: 'http://x', surfaces: catalog }\n  candidate: { probe: p }", /surfaces must be a list/);
    bad("  legacy: { base_url: 'http://x', surfaces: [queue] }\n  candidate: { probe: p }", /names "queue", which has no adapter/);
    bad("  legacy: { surfaces: [http] }\n  candidate: { probe: p }", /lists http, so it needs a base_url/);
    bad("  legacy: { base_url: 'http://x' }\n  candidate: { probe: p }", /compare_only_surfaces names "queue"/, "compare_only_surfaces: [queue]\n");
    const { m } = project("  legacy: { base_url: 'http://x', surfaces: [http, catalog] }\n  candidate: { surfaces: [catalog] }", `${CATALOG}\n  - { id: W1, request: GET / }`);
    assert.match(check(m).warnings.join("\n"), /1 case on http: candidate has no http surface, so `cmtk compare` reports it as not comparable\./);
    assert.equal(m.targets.candidate.surfaces[0], "catalog");
});

test("the eShop example manifest itself loads, and its cases are all on a surface it knows", () => {
    const m = loadManifest(path.join(EXAMPLE, "cmtk-one-manifest.yaml"));
    assert.deepEqual(m.targets.legacy.surfaces, ["http", "catalog"]);
    assert.deepEqual(m.targets.candidate.surfaces, ["catalog"]);
    assert.deepEqual(m.compare_only_surfaces, ["catalog"]);
    assert.match(check(m).warnings.join("\n"), /cases on http: candidate has no http surface/);
});
