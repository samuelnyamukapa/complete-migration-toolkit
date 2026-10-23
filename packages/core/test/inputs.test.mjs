// Cases that send files: a body from a file, and multipart uploads, each fingerprinted in the evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { check, compare, loadCases, loadManifest, MULTIPART_BOUNDARY, run } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-in-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Answers with what it received: the content type, the body's hash, and the multipart parts it parsed. */
function echo() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            const chunks = [];
            req.on("data", (d) => chunks.push(d));
            req.on("end", () => {
                const body = Buffer.concat(chunks);
                const type = req.headers["content-type"] ?? "";
                const parts = [];
                const m = /boundary=(.+)$/.exec(type);
                if (m) {
                    for (const piece of body.toString("latin1").split(`--${m[1]}`)) {
                        const h = /name="([^"]+)"; filename="([^"]*)"\r\nContent-Type: ([^\r]+)\r\n\r\n/.exec(piece);
                        if (h) parts.push({ field: h[1], filename: h[2], type: h[3], bytes: piece.length - h.index - h[0].length - 2 });
                    }
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ type, sha256: sha(body), length: body.length, parts }));
            });
        });
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

test("a case sends a file as its body, and the evidence carries the file's fingerprint", async () => {
    const s = await echo();
    const dir = tmp();
    const payload = JSON.stringify({ items: [{ id: 1, price: "10.00" }] });
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\nallow_unsafe_methods: true\n`);
    write(dir, "cmtk/data/order.json", payload);
    write(dir, "cmtk/data/report.csv", "id,name\r\n1,Mug\r\n");
    write(dir, "cmtk/cases/a.yaml", `cases:
  - id: J
    request: { method: POST, path: /orders, body_file: cmtk/data/order.json }
    expect: { status: 200, json: { "$.type": { equals: application/json }, "$.sha256": { equals: "${sha(payload)}" } } }
  - id: U
    request:
      method: POST
      path: /import
      files:
        - { field: file, path: cmtk/data/report.csv, filename: catalog.csv }
        - { field: notes, path: cmtk/data/order.json, content_type: text/plain }
    expect: { status: 200, json: { "$.parts[0].field": { equals: file }, "$.parts[0].filename": { equals: catalog.csv }, "$.parts[0].type": { equals: text/csv }, "$.parts[1].type": { equals: text/plain }, "$.parts[1].filename": { equals: order.json } } }
  - id: M
    request: { method: POST, path: /missing, body_file: cmtk/data/nope.json }
    expect: { status: 200 }
`);
    try {
        const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
        assert.ok(check(m()).warnings.some((w) => /M: the input file cmtk\/data\/nope\.json does not exist/.test(w)));
        const r = await run(m(), { allowUnsafe: true });
        const by = (id) => r.cases.find((c) => c.id === id);
        assert.equal(by("J").result, "PASS");
        assert.deepEqual(by("J").inputs, [{ path: "cmtk/data/order.json", sha256: sha(payload), bytes: payload.length }]);
        assert.equal(by("U").result, "PASS", JSON.stringify(by("U").failures));
        assert.equal(by("U").inputs.length, 2);
        assert.equal(by("U").inputs[0].filename, "catalog.csv");
        assert.equal(by("U").inputs[0].content_type, "text/csv");
        assert.equal(by("M").result, "ERROR");
        assert.match(by("M").why, /input file cmtk\/data\/nope\.json does not exist/);
        const md = fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8");
        assert.match(md, /## Input files/);
        assert.match(md, /\| U \| cmtk\/data\/report\.csv \| [0-9a-f]{16}… \| 16 \| field file, catalog\.csv \(text\/csv\) \|/);
        const answer = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/run/answers/U.json"), "utf8"));
        assert.ok(!JSON.stringify(answer).includes("1,Mug"), "the evidence holds the fingerprint, not the file");
    } finally {
        await s.close();
    }
});

test("both systems get a byte-identical multipart body, so an upload can be compared", async () => {
    const a = await echo(), b = await echo();
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: ${a.url}\n  candidate: ${b.url}\nallow_unsafe_methods: true\nscrub: { json_paths: ["$.length"] }\n`);
    write(dir, "cmtk/data/in.csv", "a,b\n1,2\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: U, request: { method: POST, path: /import, files: [{ field: f, path: cmtk/data/in.csv }] } }\n");
    try {
        const r = await compare(loadManifest(path.join(dir, "cmtk.yaml")), { allowUnsafe: true });
        assert.equal(r.cases[0].result, "MATCH", JSON.stringify(r.cases[0].differences));
        assert.equal(r.cases[0].inputs[0].path, "cmtk/data/in.csv");
        const ans = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/answers/U.reference.json"), "utf8"));
        assert.match(ans.body, new RegExp(MULTIPART_BOUNDARY));
    } finally {
        await a.close(); await b.close();
    }
});

test("a case may not reach outside the project for its files", () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: X, request: { method: POST, path: /a, body_file: ../secrets.json } }\n");
    assert.throws(() => loadCases(loadManifest(path.join(dir, "cmtk.yaml"))), /outside the project folder/);
    write(dir, "cmtk/cases/a.yaml", 'cases:\n  - { id: X, request: { method: POST, path: /a, files: [{ field: "f\\"; name=\\"x", path: cmtk/x.csv }] } }\n');
    assert.throws(() => loadCases(loadManifest(path.join(dir, "cmtk.yaml"))), /cannot hold quotes or line breaks/);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: X, request: { method: POST, path: /a, body: '{}', body_file: cmtk/x.json } }\n");
    assert.throws(() => loadCases(loadManifest(path.join(dir, "cmtk.yaml"))), /not both/);
});
