// Discover from modernize's map, on a system with no .NET at all. The fixture is hand-written in the shape of
// /modernize:map on AWS CardDemo: VSAM files, flat files, JCL jobs and CICS screens. The real run is still to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discover, loadManifest } from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "carddemo-topology.json");
const CLI = path.join(HERE, "..", "..", "cli", "dist", "main.js");

function project(adapters = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-map-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: carddemo\ntargets:\n  legacy: { base_url: "http://127.0.0.1:9" }\n${adapters}`);
    fs.mkdirSync(path.join(dir, "analysis", "carddemo"), { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(dir, "analysis", "carddemo", "topology.json"));
    return dir;
}
const SOURCE = "analysis/carddemo/topology.json";

test("a CardDemo-shaped map: VSAM and flat files, jobs and screens are all listed, under the right kind", () => {
    const dir = project();
    const { discovery } = discover(loadManifest(path.join(dir, "cmtk.yaml")), { topology: [SOURCE] }, "2026-11-04");
    const by = (k) => discovery.boundaries.filter((b) => b.kind === k).map((b) => b.name);
    assert.equal(by("files").length, 15);
    assert.ok(by("files").includes("ACCTDATA.VSAM.KSDS") && by("files").includes("DALYTRAN.PS"));
    assert.deepEqual(by("database"), [], "a VSAM file is not a database");
    assert.equal(by("worker").length, 19);
    assert.ok(by("worker").includes("POSTTRAN"));
    assert.equal(by("ui").length, 17);
    assert.ok(by("ui").includes("COSGN00"));
    assert.equal(discovery.boundaries.filter((b) => b.covered_by).length, 0);
    assert.equal(discovery.boundaries.find((b) => b.name === "ACCTDATA.VSAM.KSDS").where, "AWS.M2.CARDDEMO.ACCTDATA.VSAM.KSDS");
    assert.deepEqual(discovery.notes, [`${SOURCE} also holds 7 program nodes, not listed as boundaries because each is inside the system.`]);
});

test("the inventory says what needs a new adapter: VSAM unload, JCL batch and 3270 screens", () => {
    const dir = project();
    const { discovery } = discover(loadManifest(path.join(dir, "cmtk.yaml")), { topology: [SOURCE] }, "2026-11-04");
    const needs = (name) => discovery.boundaries.find((b) => b.name === name).needs;
    assert.match(needs("ACCTDATA.VSAM.KSDS"), /unloads it to a flat file/);
    assert.match(needs("DALYTRAN.PS"), /A flat file/);
    assert.match(needs("POSTTRAN"), /batch adapter that submits this JCL/);
    assert.match(needs("COSGN00"), /3270 terminal adapter/);
    const md = fs.readFileSync(path.join(dir, "cmtk", "discovery", "BOUNDARIES.md"), "utf8");
    assert.match(md, /## What these need/);
    assert.match(md, /\*\*17\*\*: A 3270 terminal adapter/);
    assert.match(md, /\*\*10\*\*: VSAM keeps records by key/);
    assert.match(md, /\*\*19\*\*: A batch adapter/);
    assert.match(md, /Note: .*7 program nodes/);
    assert.match(md, /An adapter covers a kind, not a technology/);
});

test("a data store the map doesn't describe is flagged as a guess, not silently called a database", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "m.json"), JSON.stringify({ root: { kind: "system", id: "s", children: [
        { kind: "datastore", name: "ACCTDATA" },
        { kind: "datastore", name: "ORDERS", type: "DB2 table" },
        { kind: "datastore", name: "HIER", type: "IMS database" },
        { kind: "queue", name: "Q1", type: "IBM MQ" },
    ] } }));
    const { discovery } = discover(loadManifest(path.join(dir, "cmtk.yaml")), { topology: ["m.json"] }, "2026-11-04");
    const b = (n) => discovery.boundaries.find((x) => x.name === n);
    assert.equal(b("ACCTDATA").kind, "database");
    assert.match(b("ACCTDATA").needs, /calling it a database is a guess/);
    assert.match(b("ORDERS").needs, /DB2 driver/);
    assert.match(b("HIER").needs, /IMS is hierarchical/);
    assert.match(b("Q1").needs, /IBM MQ client/);
});

test("a map written as flat nodes is read too; anything else is refused", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "m.json"), JSON.stringify({ nodes: [{ kind: "job", name: "NIGHTLY", type: "JCL" }], edges: [] }));
    fs.writeFileSync(path.join(dir, "bad.json"), "{}");
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    assert.equal(discover(m, { topology: ["m.json"], fresh: true }, "2026-11-04").discovery.boundaries[0].name, "NIGHTLY");
    assert.throws(() => discover(m, { topology: ["bad.json"] }), /not modernize's topology\.json/);
});

test("the real command: cmtk discover --topology on the fixture, and an adapter's covers takes a kind off the list", () => {
    const dir = project("adapters:\n  batch: { command: node, args: [x.mjs], covers: [files, worker] }\n");
    const r = spawnSync(process.execPath, [CLI, "discover", "--topology", SOURCE], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /51 boundaries: 34 covered by an adapter, 17 uncovered\./);
    assert.match(r.stdout, /uncovered ui in: COSGN00/);
    assert.doesNotMatch(r.stdout, /uncovered files/);
    assert.match(r.stdout, /Note: .*7 program nodes/);
});
