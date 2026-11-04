// Findings 9 and 11 of the review of 0.6: a system that echoes what it was sent, and an agent that passes a secret
// to an exploration, must not leave it in the evidence. Nothing here may be found in any file the run wrote.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { addFinding, compare, endSession, exploreRequest, loadManifest, run, startSession } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-secrets-"));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const server = (fn) => new Promise((resolve) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
const m = (dir) => loadManifest(path.join(dir, "cmtk.yaml"));
const everyFile = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
const noneHolds = (dir, secrets) => {
    for (const f of everyFile(dir)) {
        const text = fs.readFileSync(f, "utf8");
        for (const s of secrets) assert.ok(!text.includes(s), `${path.relative(dir, f)} holds ${s}`);
    }
};

const TOKEN = "tok3n-abcdef-0123456789";

const echo = (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("x-echo", String(req.headers.authorization ?? ""));
    res.setHeader("set-cookie", ["session=s3ss10n-value-1; Path=/; HttpOnly", "theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT"]);
    res.end(JSON.stringify({ seen: req.headers.authorization ?? null, bare: String(req.headers.authorization ?? "").replace("Bearer ", ""), url: encodeURIComponent(String(req.headers.authorization ?? "")) }));
};

test("a system that echoes a header from the environment leaves it in no evidence file", async () => {
    process.env.CMTK_T9 = `Bearer ${TOKEN}`;
    const s = await server(echo);
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${s.url}" }\n  candidate: { base_url: "${s.url}" }\nreference: legacy\nheaders_from_env: { Authorization: CMTK_T9 }\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: ECHO, request: GET /echo, expect: { status: 200 } }\n");
    try {
        await run(m(dir));
        await compare(m(dir));
        noneHolds(dir, [TOKEN, encodeURIComponent(TOKEN), encodeURIComponent(`Bearer ${TOKEN}`)]);
        const answer = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/run/answers/ECHO.json"), "utf8"));
        assert.match(answer.body, /REDACTED/, "the answer is kept, with the value replaced");
    } finally {
        delete process.env.CMTK_T9;
        await s.close();
    }
});

test("a session cookie's value stays out of the evidence; its name and attributes stay in, and a before step still uses it", async () => {
    const s = await server((req, res) => {
        if (req.url === "/page") { res.setHeader("set-cookie", "session=s3ss10n-value-1; Path=/; HttpOnly"); res.end("<html></html>"); return; }
        res.setHeader("set-cookie", "session=s3ss10n-value-2; Path=/; HttpOnly");
        res.end(String(req.headers.cookie ?? "no cookie") === "session=s3ss10n-value-1" ? "got it" : "no cookie");
    });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
    write(dir, "cmtk/cases/a.yaml", YAML.stringify({ cases: [{ id: "C", request: { method: "GET", path: "/a", before: { get: "/page" } }, expect: { status: 200, body_contains: ["got it"], headers: { "set-cookie": { matches: "^session=REDACTED; Path=/; HttpOnly$" } } } }] }));
    try {
        const r = await run(m(dir));
        assert.equal(r.cases[0].result, "PASS", JSON.stringify(r.cases[0]));
        noneHolds(dir, ["s3ss10n-value"]);
    } finally {
        await s.close();
    }
});

test("every Set-Cookie line is cleaned, a date's comma included, and the same names on two systems still match", async () => {
    const answer = (value) => (req, res) => { res.setHeader("set-cookie", [`session=${value}; Path=/`, `other=${value}; Expires=Wed, 21 Oct 2026 07:28:00 GMT`]); res.end("{}"); };
    const [a, b] = [await server(answer("first-value")), await server(answer("second-value"))];
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${a.url}" }\n  candidate: { base_url: "${b.url}" }\nreference: legacy\ncompare_headers: [set-cookie]\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: C, request: GET /a }\n");
    try {
        const r = await compare(m(dir));
        assert.equal(r.cases[0].result, "MATCH", JSON.stringify(r.cases[0]));
        noneHolds(dir, ["first-value", "second-value"]);
    } finally {
        await a.close(); await b.close();
    }
});

test("an exploration sends what the agent gave, and logs neither its headers nor its query secrets", async () => {
    let got;
    const s = await server((req, res) => { got = { url: req.url, auth: req.headers.authorization }; res.setHeader("content-type", "text/plain"); res.end(`you sent ${req.headers.authorization}`); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
    try {
        const session = startSession(m(dir), { charter: "look around" });
        const p = await exploreRequest(m(dir), session.id, { method: "GET", path: `/items?api_key=${TOKEN}&page=2`, headers: { Authorization: `Bearer ${TOKEN}`, "X-Custom-Id": "keep-me", "X-Api-Secret": "hunter2hunter2" } });
        assert.equal(got.auth, `Bearer ${TOKEN}`, "the system gets the header");
        assert.ok(got.url.includes(TOKEN), "and the query");
        assert.doesNotMatch(JSON.stringify(p.observation), new RegExp(TOKEN), "the agent's own secret is not handed back either");
        addFinding(m(dir), session.id, { title: "odd", request: `GET /items?api_key=${TOKEN}`, observed: "o", why: "w", evidence: [1] });
        endSession(m(dir), session.id, { summary: "s", not_covered: "n" });
        noneHolds(dir, [TOKEN, "hunter2hunter2"]);
        const logged = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/explore", session.id, "answers/001.json"), "utf8"));
        assert.equal(logged.request.headers.Authorization, "REDACTED");
        assert.equal(logged.request.headers["X-Custom-Id"], "keep-me");
        assert.match(logged.request.path, /api_key=REDACTED&page=2/);
    } finally {
        await s.close();
    }
});

test("an exploration refuses _method in the path, as it refuses the header", async () => {
    let hits = 0;
    const s = await server((req, res) => { hits++; res.end("{}"); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
    try {
        const session = startSession(m(dir), { charter: "look around" });
        await assert.rejects(exploreRequest(m(dir), session.id, "GET /x?_method=DELETE"), /only reads/);
        await assert.rejects(exploreRequest(m(dir), session.id, "GET /x?a=1;_HttpMethod=PUT"), /only reads/);
        assert.equal(hits, 0);
    } finally {
        await s.close();
    }
});
