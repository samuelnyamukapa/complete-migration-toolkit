// The browser's own ways off the target: a redirect. Playwright's routes do not see one.
// A real second server records what reached it, so "no credentials sent" is measured, not assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

import { adapter, browserProblem, cmtk, manifest, project, recorder, site, TLS } from "./helpers.mjs";

const skip = await browserProblem();
const web = { skip, timeout: 120_000 };
const TOKEN = "Bearer escape-test-token-1234567890";
const AUTH = { authorization: TOKEN, "x-api-key": "escape-test-api-key-987" };

const settle = () => new Promise((r) => setTimeout(r, 400));

async function withAll(servers, fn) {
    const a = adapter();
    try {
        return await fn(a);
    } finally {
        await a.close();
        for (const s of servers) await s.close();
    }
}

test("a GET case redirected to another origin is stopped: nothing reaches it, and the case is an error", web, async () => {
    const other = await recorder();
    const target = await site({ "/redir": { location: `${other.url}/stolen` } });
    await withAll([other, target], async (a) => {
        const o = await a.run({ id: "R", request: { method: "GET", path: "/redir" } }, { name: "legacy", base_url: target.url }, AUTH);
        await settle();
        assert.deepEqual(other.seen, [], "the other server received a request");
        assert.ok(target.seen.some((r) => r.url === "/redir" && r.headers.authorization === TOKEN), "the target still gets its credentials");
        assert.match(o.error ?? "", /stopped/i);
        assert.match(o.error, /redirect/i);
        assert.ok(!JSON.stringify(o).includes("escape-test-token"), "no credential in the reply");
    });
});

test("a redirect off the target in a journey is an error, even when every check holds", web, async () => {
    const other = await recorder();
    const target = await site({ "/": `<img src="/pic" alt=""><p data-testid="ok">fine</p>`, "/pic": { location: `${other.url}/pixel` } });
    await withAll([other, target], async (a) => {
        const journey = { goal: "Open the page", steps: [{ goto: "/" }, { read: "v", from: { testid: "ok" } }, { check: "shown", value: "v", equals: "fine" }] };
        const o = await a.run({ id: "J", request: { method: "POST", path: "/" }, journey }, { name: "legacy", base_url: target.url }, AUTH);
        await settle();
        assert.deepEqual(other.seen, []);
        assert.equal(o.journey.checks[0].passed, true, "the check itself held");
        assert.match(o.error ?? "", /stopped/i);
        assert.notEqual(o.status, 200);
    });
});

test("through cmtk compare, two systems that both redirect off the target are not PARITY", web, async () => {
    const other = await recorder();
    const [x, y] = [await site({ "/redir": { location: `${other.url}/a` } }), await site({ "/redir": { location: `${other.url}/a` } })];
    const dir = project({
        "cmtk.yaml": manifest(x.url, y.url),
        "cmtk/cases/r.yaml": `cases:\n  - id: R\n    surface: web\n    match: structure\n    request: GET /redir\n`,
    });
    try {
        const r = await cmtk(dir, ["compare"]);
        const rep = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.json"), "utf8"));
        assert.notEqual(rep.verdict, "PARITY", r.stdout);
        assert.notEqual(r.status, 0);
        assert.deepEqual(other.seen, []);
    } finally {
        for (const s of [other, x, y]) await s.close();
    }
});

test("credentials go only to the target's origin, not to an origin the target's page may call", web, async () => {
    const allowed = await recorder();
    const target = await site({ "/": `<script>fetch(${JSON.stringify("ALLOWED/api")}).catch(()=>{})</script>`.replace("ALLOWED", allowed.url) });
    await withAll([allowed, target], async (a) => {
        const o = await a.run({ id: "A", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: target.url, allow_origins: allowed.url }, AUTH);
        await settle();
        assert.equal(o.error, undefined, o.error);
        const call = allowed.seen.find((r) => r.url === "/api");
        assert.ok(call, "an allowed origin is still reached");
        assert.equal(call.headers.authorization, undefined);
        assert.equal(call.headers["x-api-key"], undefined);
        assert.equal(target.seen.find((r) => r.url === "/").headers.authorization, TOKEN);
    });
});

test("a redirect to an allowed origin carries no credentials over http, and a case holding credentials is an error", web, async () => {
    const allowed = await recorder();
    const target = await site({ "/go": { location: `${allowed.url}/landing` } });
    await withAll([allowed, target], async (a) => {
        const o = await a.run({ id: "A", request: { method: "GET", path: "/go" } }, { name: "legacy", base_url: target.url, allow_origins: allowed.url }, AUTH);
        await settle();
        for (const r of allowed.seen) {
            assert.equal(r.headers.authorization, undefined, "Playwright repeats the headers on a redirect, and they must not arrive");
            assert.equal(r.headers["x-api-key"], undefined);
        }
        assert.match(o.error ?? "", /credentials/);
    });
});

test("with no credentials, a redirect to an allowed origin is followed as before", web, async () => {
    const allowed = await recorder();
    const target = await site({ "/go": { location: `${allowed.url}/landing` } });
    await withAll([allowed, target], async (a) => {
        const o = await a.run({ id: "A", request: { method: "GET", path: "/go" } }, { name: "legacy", base_url: target.url, allow_origins: allowed.url });
        assert.equal(o.error, undefined, o.error);
        assert.equal(o.status, 200);
        assert.ok(allowed.seen.some((r) => r.url === "/landing"));
    });
});

test("a redirect that stays on the target keeps credentials and cookies, and is not an error", web, async () => {
    const seen = [];
    const target = await site({ "/": { location: "/next", headers: { "set-cookie": "sid=abc; Path=/" } }, "/next": "<p>there</p>" }, seen);
    await withAll([target], async (a) => {
        const o = await a.run({ id: "S", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: target.url }, AUTH);
        assert.equal(o.error, undefined, o.error);
        assert.equal(o.status, 200);
        const next = seen.find((r) => r.url === "/next");
        assert.equal(next.headers.authorization, TOKEN);
        assert.match(next.headers.cookie ?? "", /sid=abc/);
    });
});

async function secureSite(answer) {
    const seen = [];
    const server = https.createServer(TLS, (req, res) => {
        seen.push({ url: req.url, headers: req.headers });
        answer(req, res);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `https://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const page = (_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Page</title><h1>Page</h1>"); };

test("over https the target gets its credentials, and a redirect to an https address not listed is stopped", web, async () => {
    const other = await secureSite(page);
    const target = await secureSite((req, res) => {
        if (req.url === "/go") { res.writeHead(302, { location: `${other.url}/stolen` }); return res.end(); }
        page(req, res);
    });
    await withAll([other, target], async (a) => {
        const ok = await a.run({ id: "H", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: target.url, insecure_tls: true }, AUTH);
        assert.equal(ok.error, undefined, ok.error);
        assert.equal(ok.status, 200);
        assert.equal(target.seen.find((r) => r.url === "/").headers.authorization, TOKEN);
        const o = await a.run({ id: "H", request: { method: "GET", path: "/go" } }, { name: "legacy", base_url: target.url, insecure_tls: true }, AUTH);
        await settle();
        assert.deepEqual(other.seen, []);
        assert.match(o.error ?? "", /stopped/i);
    });
});

test("over https a redirect to an allowed address cannot be cleaned, so the case is an error that says the credentials are exposed", web, async () => {
    const allowed = await secureSite(page);
    const target = await secureSite((req, res) => { res.writeHead(302, { location: `${allowed.url}/landing` }); res.end(); });
    await withAll([allowed, target], async (a) => {
        const o = await a.run({ id: "H", request: { method: "GET", path: "/go" } }, { name: "legacy", base_url: target.url, insecure_tls: true, allow_origins: allowed.url }, AUTH);
        assert.match(o.error ?? "", /treat them as exposed/);
        assert.equal(o.status, undefined);
    });
});

test("a target that does not answer still reads as ECONNREFUSED, through the fence", web, async () => {
    const gone = await recorder();
    const url = gone.url;
    await gone.close();
    await withAll([], async (a) => {
        const o = await a.run({ id: "G", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: url });
        assert.match(o.error ?? "", /^ECONNREFUSED/);
    });
});
