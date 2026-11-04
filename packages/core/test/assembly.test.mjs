// A class library's public surface across builds, through REA. The fixtures are real REA 6.8.0 output for
// assemblies compiled from test/fixtures/rea/src (see its README), cut down to the fields cmtk reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check, compare, diffAssemblies, loadManifest, mapName, nameDigest, proveTypeNames, readInventory } from "../dist/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rea");
const read = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), "utf8"));
const inv = (n) => readInventory(read(`${n}.members.json`), n);
const CONTRACT = { types: ["Shop.Services.ICatalogService", "Shop.Services.CatalogService", "Shop.Models.*"], namespace_map: { Shop: "ShopCore" } };

test("REA's own digest of a type's name is the one cmtk computes", () => {
    const t = inv("Shop").types.find((x) => x.full_name === "Shop.Models.Item");
    assert.equal(nameDigest("Shop.Models.Item").toString("hex"), t.name_sha256);
});

test("a namespace map: the longest match wins, on a namespace boundary", () => {
    const map = { Shop: "ShopCore", "Shop.Legacy": "Old" };
    assert.equal(mapName("Shop.Models.Item", map), "ShopCore.Models.Item");
    assert.equal(mapName("Shop.Legacy.X", map), "Old.X");
    assert.equal(mapName("Shopping.X", map), "Shopping.X");
});

test("a referenced type is named only by proof: IList`1 and Decimal come out of REA's digests", () => {
    const a = inv("Shop");
    const search = a.methods.find((m) => m.name === "Search" && m.declaring_type === "Shop.Services.ICatalogService");
    assert.match(search.signature.return_type, /^class:\d+<class:\d+>$/, "REA writes the type as a build-local number");
    proveTypeNames(a, a.methods.concat(a.fields));
    assert.ok([...a.refs.values()].includes("System.Collections.Generic.IList`1"));
    assert.ok([...a.refs.values()].includes("System.Decimal"));
});

test("a wrong digest proves nothing: the name stays unknown", () => {
    const a = inv("Shop");
    const m = structuredClone(a.methods.find((x) => x.name === "Search"));
    m.signature.resolved_sha256 = "0".repeat(64);
    proveTypeNames(a, [m]);
    assert.ok(![...a.refs.values()].includes("System.Collections.Generic.IList`1"));
});

test("across a namespace move, the same surface compares as unchanged; REA's exact comparison would call it all removed", () => {
    const { findings, note } = diffAssemblies(inv("Shop"), inv("ShopCore"), CONTRACT);
    assert.deepEqual(findings, []);
    assert.match(note, /public members of 3 types compared/);
});

test("private and internal members are not the contract: Helper and Audit going away is no finding", () => {
    const names = inv("Shop").methods.map((m) => m.name);
    assert.ok(names.includes("Helper") && names.includes("Audit"));
    assert.ok(!inv("ShopCore").methods.map((m) => m.name).includes("Audit"));
    assert.deepEqual(diffAssemblies(inv("Shop"), inv("ShopCore"), { types: ["Shop.Services.CatalogService"], namespace_map: { Shop: "ShopCore" } }).findings, []);
});

test("a planted change is caught: a changed signature, a removed method, an added method", () => {
    const { findings } = diffAssemblies(inv("Shop"), inv("ShopCoreChanged"), { types: ["Shop.Services.ICatalogService"], namespace_map: { Shop: "ShopCore" } });
    const what = findings.map((f) => `${f.breaking} ${f.what}`);
    assert.deepEqual(what, [
        "true ShopCore.Services.ICatalogService: signature changed: ShopCore.Models.Item FindItem(int) → ShopCore.Models.Item FindItem(long)",
        "true ShopCore.Services.ICatalogService: method removed: void Remove(ShopCore.Models.Item)",
        "false ShopCore.Services.ICatalogService: method added: int Count()",
    ]);
});

test("without the map, a namespace move reads as the type removed", () => {
    const { findings } = diffAssemblies(inv("Shop"), inv("ShopCore"), { types: ["Shop.Services.ICatalogService"] });
    assert.deepEqual(findings.map((f) => f.what), ["type removed: Shop.Services.ICatalogService (expected Shop.Services.ICatalogService)"]);
});

test("a signature cmtk can't prove is a finding for a person, never unchanged", () => {
    // Take away the digests that prove IList`1 on one side: the shapes agree, but the type could be anything.
    const raw = read("ShopCore.members.json");
    for (const m of raw.normalized_result.methods) if (m.name === "Search") { m.signature.raw_sha256 = "0".repeat(64); m.signature.resolved_sha256 = "1".repeat(64); }
    const { findings } = diffAssemblies(inv("Shop"), readInventory(raw, "x"), { types: ["Shop.Services.ICatalogService"], namespace_map: { Shop: "ShopCore" } });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].breaking, null);
    assert.match(findings[0].what, /Search: can't be proved unchanged/);
});

test("a listed type that isn't there, or a part-read assembly, never reads as unchanged", () => {
    assert.equal(diffAssemblies(inv("Shop"), inv("ShopCore"), { types: ["Shop.Nope"], namespace_map: { Shop: "ShopCore" } }).findings.filter((f) => f.breaking === null).length, 2);
    const raw = read("ShopCore.members.json");
    raw.normalized_result.coverage.state = "partial";
    assert.match(diffAssemblies(inv("Shop"), readInventory(raw, "x"), CONTRACT).findings[0].what, /read only part/);
    assert.throws(() => readInventory({ nope: 1 }, "x.json"), /not the output of/);
});

function project(contract, drift = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-asm-"));
    for (const n of ["Shop", "ShopCore", "ShopCoreChanged"]) fs.mkdirSync(path.join(dir, "rea"), { recursive: true }), fs.copyFileSync(path.join(FIX, `${n}.members.json`), path.join(dir, "rea", `${n}.json`));
    fs.mkdirSync(path.join(dir, "cmtk", "cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk", "drift.yaml"), drift);
    return dir;
}
const server = () => new Promise((res) => { const s = http.createServer((_q, r) => { r.setHeader("content-type", "text/plain"); r.end("same"); }); s.listen(0, "127.0.0.1", () => res(s)); });
const write = (dir, url, candidate) => {
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  legacy: { base_url: "${url}" }\n  candidate: { base_url: "${url}" }\ncontracts:\n  - name: catalog\n    kind: assembly\n    legacy: rea/Shop.json\n    candidate: ${candidate}\n    types: [Shop.Services.ICatalogService]\n    namespace_map: { Shop: ShopCore }\n`);
    fs.writeFileSync(path.join(dir, "cmtk", "cases", "one.yaml"), "cases:\n  - id: C1\n    requirement: R1\n    request: { method: GET, path: / }\n");
};

test("in cmtk compare: unchanged is parity; a change is no parity until a person approves it in the drift ledger", async () => {
    const s = await server();
    const url = `http://127.0.0.1:${s.address().port}`;
    try {
        const dir = project();
        write(dir, url, "rea/ShopCore.json");
        let r = await compare(loadManifest(path.join(dir, "cmtk.yaml")), { date: "2026-11-04" });
        assert.equal(r.verdict, "PARITY");
        assert.equal(r.contracts[0].result, "EQUIVALENT");

        write(dir, url, "rea/ShopCoreChanged.json");
        r = await compare(loadManifest(path.join(dir, "cmtk.yaml")), { date: "2026-11-04" });
        assert.equal(r.verdict, "NO PARITY");
        assert.equal(r.contracts[0].result, "BREAKING");
        assert.equal(r.contracts[0].findings.length, 3);

        const entries = r.contracts[0].findings.map((f, i) => `  - { id: D${i + 1}, case: "*", where: ${JSON.stringify(f.where)}, reason: agreed with consumers, approved_by: A Person, approved_on: 2026-11-04 }`).join("\n");
        fs.writeFileSync(path.join(dir, "cmtk", "drift.yaml"), `drift:\n${entries}\n`);
        r = await compare(loadManifest(path.join(dir, "cmtk.yaml")), { date: "2026-11-04" });
        assert.equal(r.verdict, "DRIFT ONLY");
        assert.ok(r.contracts[0].findings.every((f) => f.drift));
    } finally { s.close(); }
});

test("in cmtk compare: REA's output missing or unreadable is an incomplete comparison, not parity", async () => {
    const s = await server();
    try {
        const dir = project();
        write(dir, `http://127.0.0.1:${s.address().port}`, "rea/absent.json");
        const m = loadManifest(path.join(dir, "cmtk.yaml"));
        assert.ok(check(m).warnings.some((w) => /absent\.json does not exist/.test(w)));
        const r = await compare(m, { date: "2026-11-04" });
        assert.equal(r.contracts[0].result, "ERROR");
        assert.equal(r.verdict, "INCOMPLETE");
    } finally { s.close(); }
});

test("settings for an assembly contract are checked", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-asm-"));
    const f = path.join(dir, "cmtk.yaml");
    fs.writeFileSync(f, "system: s\ntargets: { legacy: { base_url: 'http://x' } }\ncontracts:\n  - { name: a, kind: assembly, legacy: a.dll }\n");
    assert.throws(() => loadManifest(f), /needs `legacy` and `candidate`/);
    fs.writeFileSync(f, "system: s\ntargets: { legacy: { base_url: 'http://x' } }\ncontracts:\n  - { name: a, kind: assembly, legacy: a.dll, candidate: b.dll }\n");
    assert.throws(() => loadManifest(f), /needs `types`/);
});
