// Findings 17, 18 and 21 of the review of 0.6: nothing is written or read outside the project through a dangling link
// or an include, and a name from a DDL script can't become SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addProposal, inside, loadManifest, ManifestError, readXsd, writeSeed } from "../dist/index.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-inside-")));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const link = (target, at, t) => { try { fs.symlinkSync(target, at); return true; } catch { t.skip("this machine can't make links"); return false; } };

test("a dangling link is refused, so nothing can be written through it", (t) => {
    const parent = tmp();
    const root = path.join(parent, "project");
    fs.mkdirSync(path.join(root, "cmtk"), { recursive: true });
    const outside = path.join(parent, "outside.yaml");
    if (!link(outside, path.join(root, "cmtk/proposals.yaml"), t)) return;
    write(root, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: \"http://127.0.0.1:9\" }\n");
    const m = loadManifest(path.join(root, "cmtk.yaml"));
    assert.throws(() => inside(m, "cmtk/proposals.yaml"), ManifestError);
    assert.throws(() => addProposal(m, { kind: "scrub", rule: { json_path: "$.at" }, reason: "r", proposed_by: "agent" }, "2026-11-04"), /through a link|outside/);
    assert.equal(fs.existsSync(outside), false, "nothing may be written outside");
});

test("a dangling link part way down a path is refused too", (t) => {
    const parent = tmp();
    const root = path.join(parent, "project");
    fs.mkdirSync(root);
    if (!link(path.join(parent, "gone"), path.join(root, "out"), t)) return;
    assert.throws(() => inside({ root }, "out/a/b.yaml"), ManifestError);
});

test("an ordinary path still resolves, whether or not it exists", () => {
    const root = tmp();
    write(root, "a/b.txt", "x");
    assert.equal(inside({ root }, "a/b.txt"), path.join(root, "a/b.txt"));
    assert.equal(inside({ root }, "a/new/c.txt"), path.join(root, "a/new/c.txt"));
});

const HOSTILE = "a'; DROP TABLE users;--";
const DDL = `CREATE TABLE [${HOSTILE}] (id int NOT NULL PRIMARY KEY, [it's] int NOT NULL);\n`;

test("a table name with a quote can't break out of the control totals", () => {
    const root = tmp();
    write(root, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: \"http://127.0.0.1:9\" }\n");
    write(root, "schema.sql", DDL);
    const { folder } = writeSeed(loadManifest(path.join(root, "cmtk.yaml")), { ddl: "schema.sql", id: "seed1", rows: 1 });
    const sql = fs.readFileSync(path.join(root, folder, "control-totals.sql"), "utf8");
    assert.ok(!/(^|[^'])'a'; DROP/.test(sql), sql);
    assert.ok(sql.includes("'dbo.a''; DROP TABLE users;--'"), sql);
    // Every line that is not a comment has balanced quotes, so no text falls outside a string.
    for (const line of sql.split("\n").filter((l) => !l.startsWith("--"))) {
        const noBrackets = line.replace(/\[[^\]]*\]/g, "");
        assert.equal((noBrackets.match(/'/g) ?? []).length % 2, 0, line);
    }
    for (const file of fs.readdirSync(path.join(root, folder)).filter((f) => f.endsWith(".sql"))) {
        const text = fs.readFileSync(path.join(root, folder, file), "utf8");
        for (const line of text.split("\n").filter((l) => l.includes("DROP TABLE users"))) assert.ok(line.includes(`[${HOSTILE}]`) || line.includes("a''; DROP") || line.startsWith("--"), `${file}: ${line}`);
    }
});

const SCHEMA = (inner) => `<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">${inner}<xs:element name="a" type="xs:string"/></xs:schema>`;

test("an xs:include that climbs out of the project is not read, and the reader says so", () => {
    const parent = tmp();
    const root = path.join(parent, "project");
    write(parent, "outside.xsd", SCHEMA("").replace('name="a"', 'name="stolen"'));
    write(root, "s/main.xsd", SCHEMA('<xs:include schemaLocation="../../outside.xsd"/>'));
    const model = readXsd(path.join(root, "s/main.xsd"), undefined, root);
    assert.ok(!JSON.stringify(model).includes("stolen"), "nothing from outside may be read");
    assert.match(model.notes.join("\n"), /outside\.xsd.*not read/);
    assert.deepEqual(readXsd(path.join(root, "s/main.xsd")).notes.length, 1, "with no project named, it stays in the file's own folder");
});

test("an xs:include inside the project still works", () => {
    const root = tmp();
    write(root, "s/other.xsd", SCHEMA("").replace('name="a"', 'name="kept"'));
    write(root, "s/main.xsd", SCHEMA('<xs:include schemaLocation="other.xsd"/>'));
    assert.deepEqual(readXsd(path.join(root, "s/main.xsd"), "kept", root).notes, [], "kept comes from the included file");
});
