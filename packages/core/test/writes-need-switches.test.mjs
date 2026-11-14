// Findings 5 and 12 of the review of 0.6: a case that writes needs both switches, whatever it says about itself.
// `safe: true` counts only when a person saw exactly that case, and a method override or a GET with a body is a write.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { acceptDraft, check, compare, confirmSafe, loadCases, loadManifest, overrideIn, removeSafe, run, safeConfirmed } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-writes-"));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const server = (fn) => new Promise((resolve) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
function recorder() {
    const seen = [];
    return { seen, handler: (req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end("{}"); }); } };
}
const project = (url, cases, more = "") => {
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${url}" }\n${more}`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases }));
    return dir;
};
const m = (dir) => loadManifest(path.join(dir, "cmtk.yaml"));

test("safe: true written into a file sends nothing: no person confirmed it", async () => {
    const r = recorder();
    const s = await server(r.handler);
    const dir = project(s.url, [{ id: "WIPE", request: "DELETE /everything", safe: true, expect: { status: 200 } }]);
    try {
        const report = await run(m(dir));
        assert.equal(report.cases[0].result, "SKIPPED");
        assert.match(report.cases[0].why, /no person has confirmed/);
        assert.deepEqual(r.seen, [], "nothing may reach the system");
        assert.match(check(m(dir)).warnings.join("\n"), /WIPE: .*safe: true.*no person has confirmed/s);
    } finally {
        await s.close();
    }
});

test("a person's confirmation sends that case with neither switch, and only that exact case", async () => {
    const r = recorder();
    const s = await server(r.handler);
    const dir = project(s.url, [{ id: "SOAP", request: { method: "POST", path: "/read", body: "<GetThing/>" }, safe: true, expect: { status: 200 } }]);
    try {
        const shown = loadCases(m(dir))[0];
        confirmSafe(m(dir), "SOAP", "Jane Smith", "2026-11-04", shown);
        assert.equal((await run(m(dir))).cases[0].result, "PASS");
        assert.deepEqual(r.seen, ["POST /read"]);

        const doc = YAML.parse(fs.readFileSync(path.join(dir, "cmtk/cases/a.yaml"), "utf8"));
        assert.equal(doc.cases[0].safe_confirmed_by, "Jane Smith");
        doc.cases[0].request.body = "<DeleteEverything/>";
        write(dir, "cmtk/cases/a.yaml", YAML.stringify(doc));
        r.seen.length = 0;
        const after = await run(m(dir));
        assert.equal(after.cases[0].result, "SKIPPED", "the person did not see this body");
        assert.deepEqual(r.seen, []);
    } finally {
        await s.close();
    }
});

test("a confirmation follows the bytes of an input file, too", async () => {
    const r = recorder();
    const s = await server(r.handler);
    const dir = project(s.url, [{ id: "F", request: { method: "POST", path: "/read", body_file: "in.xml" }, safe: true, expect: { status: 200 } }]);
    write(dir, "in.xml", "<GetThing/>");
    try {
        confirmSafe(m(dir), "F", "Jane Smith", "2026-11-04", loadCases(m(dir))[0]);
        assert.equal(safeConfirmed(loadCases(m(dir))[0], dir), true);
        write(dir, "in.xml", "<DeleteEverything/>");
        assert.equal(safeConfirmed(loadCases(m(dir))[0], dir), false);
        assert.equal((await run(m(dir))).cases[0].result, "SKIPPED");
        assert.deepEqual(r.seen, []);
    } finally {
        await s.close();
    }
});

test("accepting a draft that carries safe: true records the person who saw it; rejecting safe puts it behind the switches", async () => {
    const r = recorder();
    const s = await server(r.handler);
    const dir = project(s.url, [{ id: "D", request: "POST /read", safe: true, draft: true, expect: { status: 200 } }, { id: "E", request: "POST /other", safe: true, expect: { status: 200 } }]);
    try {
        acceptDraft(m(dir), "D", "Jane Smith", "2026-11-04");
        removeSafe(m(dir), "E", loadCases(m(dir))[1]);
        const report = await run(m(dir));
        assert.deepEqual(report.cases.map((c) => [c.id, c.result]), [["D", "PASS"], ["E", "SKIPPED"]]);
        assert.deepEqual(r.seen, ["POST /read"]);
        assert.equal(loadCases(m(dir))[1].safe, undefined);
    } finally {
        await s.close();
    }
});

test("safe: true an agent wrote on a GET reaches no adapter, so a web or desktop journey only reads", async () => {
    const dir = tmp();
    write(dir, "stub.mjs", `import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
    const msg = JSON.parse(line);
    if (msg.op === "run") console.log(JSON.stringify({ status: 200, headers: {}, body: String(msg.case.safe ?? "absent") }));
    else if (msg.op === "reset") console.log(JSON.stringify({ ok: true }));
    else console.log(JSON.stringify({ name: "stub", kinds: ["ui"] }));
}
`);
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { x: 1 }\nadapters:\n  ui: { command: "${process.execPath.replace(/\\/g, "/")}", args: [stub.mjs] }\n`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: [{ id: "J", surface: "ui", request: "GET /", safe: true, expect: { status: 200, body_contains: ["absent"] } }] }));
    assert.equal((await run(m(dir))).cases[0].result, "PASS", "without a confirmation the adapter must not be told it is safe");
    confirmSafe(m(dir), "J", "Jane Smith", "2026-11-04", loadCases(m(dir))[0]);
    const after = await run(m(dir));
    assert.equal(after.cases[0].result, "FAIL", "with one, it is told");
});

for (const [what, c] of [
    ["an override header", { method: "GET", path: "/ov", headers: { "X-HTTP-Method-Override": "DELETE" } }],
    ["the X-HTTP-Method header", { method: "GET", path: "/ov", headers: { "x-http-method": "PUT" } }],
    ["_method in the query", { method: "GET", path: "/ov?_method=DELETE" }],
    ["an encoded _method", { method: "GET", path: "/ov?%5Fmethod=DELETE" }],
    ["_method after a semicolon", { method: "GET", path: "/ov?a=1;_method=DELETE" }],
    ["_HttpMethod", { method: "GET", path: "/ov?_HttpMethod=DELETE" }],
    ["method=DELETE", { method: "HEAD", path: "/ov?method=DELETE" }],
    ["_method on a matrix parameter", { method: "GET", path: "/ov;_method=DELETE" }],
    ["a GET with a body", { method: "GET", path: "/ov", body: "{}" }],
    ["a GET with a form", { method: "GET", path: "/ov", body_form: { a: 1 } }],
    ["a before page that overrides", { method: "GET", path: "/ov", before: { get: "/page?_method=DELETE" } }],
]) {
    test(`${what} needs both switches, like any other write`, async () => {
        const r = recorder();
        const s = await server(r.handler);
        const dir = project(s.url, [{ id: "OV", request: c, expect: { status: 200 } }]);
        try {
            const report = await run(m(dir));
            assert.equal(report.cases[0].result, "SKIPPED", JSON.stringify(report.cases[0]));
            assert.deepEqual(r.seen, []);
            write(dir, "cmtk.yaml", `${fs.readFileSync(path.join(dir, "cmtk.yaml"), "utf8")}allow_unsafe_methods: true\n`);
            assert.notEqual((await run(m(dir), { allowUnsafe: true })).cases[0].result, "SKIPPED", "with both switches it goes");
        } finally {
            await s.close();
        }
    });
}

test("an ordinary read stays a read: a query that merely says method, or an override back to GET", async () => {
    assert.equal(overrideIn("/search?method=sum&payment_method=card"), undefined);
    assert.equal(overrideIn("/x?_method=GET", { "X-HTTP-Method-Override": "HEAD" }), undefined);
    assert.equal(overrideIn("/x", { "x-method-override": "PATCH" }), "PATCH");
    const r = recorder();
    const s = await server(r.handler);
    const dir = project(s.url, [{ id: "OK", request: "GET /search?method=sum", expect: { status: 200 } }]);
    try {
        assert.equal((await run(m(dir))).cases[0].result, "PASS");
    } finally {
        await s.close();
    }
});

test("compare holds overrides back as well", async () => {
    const r = recorder();
    const [a, b] = [await server(r.handler), await server(r.handler)];
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${a.url}" }\n  candidate: { base_url: "${b.url}" }\n`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: [{ id: "OV", request: "GET /ov?_method=DELETE" }] }));
    try {
        assert.equal((await compare(m(dir))).cases[0].result, "SKIPPED");
        assert.deepEqual(r.seen, []);
    } finally {
        await a.close(); await b.close();
    }
});
