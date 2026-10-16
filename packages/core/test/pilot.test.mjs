// Regression tests for what the eShop pilot found.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compare, importHar, loadManifest } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-pilot-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};

test("a target can be reached only through an adapter: settings instead of a base_url", async () => {
    const dir = tmp();
    write(dir, "echo.mjs", `import readline from "node:readline";
for await (const l of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(l);
  const reply = m.op === "run" ? { status: 200, effects: { probe: m.target.probe, runtime: m.target.runtime } } : { ok: true };
  process.stdout.write(JSON.stringify(reply) + "\\n");
}`);
    write(dir, "cmtk.yaml", `system: s
targets:
  legacy: { probe: legacy.exe, runtime: net472 }
  candidate: { probe: core.exe, runtime: net8 }
adapters:
  lib: { command: ${JSON.stringify(process.execPath)}, args: [echo.mjs] }
`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: LIB, surface: lib, request: GET /items }\n  - { id: WEB, request: GET / }\n");
    const r = await compare(loadManifest(path.join(dir, "cmtk.yaml")));
    const by = Object.fromEntries(r.cases.map((c) => [c.id, c]));
    assert.deepEqual(by.LIB.differences.map((d) => d.where).sort(), ["effects:$.probe", "effects:$.runtime"], "the adapter got each target's settings");
    assert.match(by.WEB.why, /has no base_url/);
    assert.equal(r.targets.legacy, "probe=legacy.exe, runtime=net472");
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  legacy: { base_url: ftp://x }\n");
    assert.throws(() => loadManifest(path.join(dir, "cmtk.yaml")), /http/);
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  legacy: { probe: [a, b] }\n");
    assert.throws(() => loadManifest(path.join(dir, "cmtk.yaml")), /text, a number or true\/false/);
});

test("imported cases name their HAR file, not the folder it was in", () => {
    const dir = tmp();
    write(dir, "private folder/recording.har", JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "http://l/a", headers: [] } }] } }));
    const r = importHar([path.join(dir, "private folder", "recording.har")]);
    assert.equal(r.cases[0].source, "har:recording.har");
});
