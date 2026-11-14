// docs/TEST-PLAN.md, "Sandboxes only for money and messages": an email adapter refuses anything
// that isn't a capture server. These must always pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { adapter, ADAPTER_DIR, listen, mailpit, receipt, system } from "./standins.mjs";

const POST = { id: "P", request: { method: "POST", path: "/send", body: { to: "a@b.test" } } };
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

const NOT_CAPTURE_SERVERS = {
    "a web server that answers 200 to everything": (_req, res) => json(res, 200, {}),
    "a page that is not JSON": (_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>webmail</html>"); },
    "an API with a messages list, but no Mailpit info": (req, res) => (req.url.startsWith("/api/v1/messages") ? json(res, 200, { total: 0, messages: [] }) : json(res, 404, {})),
    "something shaped like MailHog's list that doesn't say it is MailHog": (req, res) => (req.url.startsWith("/api/v2/messages") ? json(res, 200, { total: 0, start: 0, count: 0, items: [] }) : (res.writeHead(200), res.end("Welcome"))),
    "an address that redirects": (_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:9/api/v1/info" }); res.end(); },
};

for (const [what, handler] of Object.entries(NOT_CAPTURE_SERVERS)) {
    test(`safety: refuses ${what}, for run and reset, and never sends the case or deletes anything`, async () => {
        const fake = await listen(handler);
        const sys = await listen((_q, res) => json(res, 200, {}));
        const a = adapter();
        try {
            const target = { name: "legacy", base_url: sys.url, capture_url: fake.url };
            const run = (await a.call({ op: "run", case: POST, target, headers: {} })).reply;
            assert.match(run.error, /does not answer as Mailpit or MailHog/);
            assert.equal(run.effects, undefined);
            const reset = (await a.call({ op: "reset", target })).reply;
            assert.equal(reset.ok, false);
            assert.match(reset.error, /does not answer as Mailpit or MailHog/);
            assert.equal(sys.state.connections, 0, "the system was not asked to send anything");
            assert.ok(fake.state.requests.every((r) => r.method === "GET"), "only looked at it");
        } finally { await a.close(); await sys.close(); await fake.close(); }
    });
}

test("safety: a target with no capture address, or one holding a password, is refused before any network call", async () => {
    const sys = await listen((_q, res) => json(res, 200, {}));
    const a = adapter();
    try {
        assert.match((await a.call({ op: "run", case: POST, target: { name: "x", base_url: sys.url }, headers: {} })).reply.error, /no capture_url/);
        const { reply, raw } = await a.call({ op: "run", case: POST, target: { name: "x", base_url: sys.url, capture_url: "http://me:hunter2-planted@127.0.0.1:9" }, headers: {} });
        assert.match(reply.error, /user name or password/);
        assert.doesNotMatch(raw, /hunter2-planted/);
        assert.equal(sys.state.connections, 0);
    } finally { await a.close(); await sys.close(); }
});

test("safety: a redirect from the capture server or the system is not followed", async () => {
    const elsewhere = await listen((_q, res) => json(res, 200, {}));
    const cap = await mailpit();
    const sys = await listen((_q, res) => { res.writeHead(307, { location: `${elsewhere.url}/stolen` }); res.end(); });
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "run", case: POST, target: { name: "x", base_url: sys.url, capture_url: cap.url, quiet_ms: 20 }, headers: { Authorization: "Bearer planted-secret" } });
        assert.equal(reply.status, 307, "a redirect is an answer");
        assert.equal(elsewhere.state.connections, 0);
    } finally { await a.close(); await sys.close(); await elsewhere.close(); await cap.close(); }
});

test("safety: a path can't leave the address in the settings", async () => {
    const cap = await mailpit();
    const sys = await listen((_q, res) => json(res, 200, {}));
    const a = adapter();
    try {
        for (const p of ["//evil.test/x", "http://evil.test/x", "x"]) {
            const { reply } = await a.call({ op: "run", case: { id: "x", request: { method: "POST", path: p } }, target: { name: "x", base_url: sys.url, capture_url: cap.url }, headers: {} });
            assert.match(reply.error, /single '\/'/);
        }
        assert.equal(sys.state.connections, 0);
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("safety: no proxy, even with proxy environment variables and Node's proxy switch on", async () => {
    const proxy = await listen((_q, res) => json(res, 200, {}));
    const cap = await mailpit();
    cap.deliver(receipt());
    const proxied = { HTTP_PROXY: proxy.url, http_proxy: proxy.url, HTTPS_PROXY: proxy.url, https_proxy: proxy.url, NO_PROXY: "", no_proxy: "" };
    try {
        for (const env of [proxied, { ...proxied, NODE_USE_ENV_PROXY: "1" }, { ...proxied, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --use-env-proxy` }]) {
            const a = adapter(env);
            try {
                const { reply } = await a.call({ op: "run", case: { id: "G", request: { method: "GET", path: "/" } }, target: { name: "x", capture_url: cap.url }, headers: {} });
                assert.equal(proxy.state.connections, 0, "nothing went through the proxy");
                assert.equal(reply.effects?.emails?.length, 1, JSON.stringify(reply) + a.stderr());
            } finally { await a.close(); }
        }
    } finally { await proxy.close(); await cap.close(); }
});

test("safety: a header value never reaches what it reports, even when an email quotes it", async () => {
    const SECRET = "planted-header-secret-1234";
    const cap = await mailpit();
    const sys = await system(cap, () => [{ ...receipt(), text: `Your key is ${SECRET}` }]);
    const a = adapter();
    try {
        const { raw } = await a.call({ op: "run", case: POST, target: { name: "x", base_url: sys.url, capture_url: cap.url, quiet_ms: 20 }, headers: { "X-Key": SECRET } });
        assert.doesNotMatch(raw, /planted-header-secret/);
        const bad = await a.call({ op: "run", case: POST, target: { name: "x", base_url: sys.url, capture_url: cap.url, quiet_ms: 20 }, headers: { "X-Key": `${SECRET}\nbad` } });
        assert.doesNotMatch(bad.raw, /planted-header-secret/, "fetch quotes a bad header value in its error");
        assert.match(bad.reply.error, /could not be sent/);
        const garbage = await a.call(`not json ${SECRET}`);
        assert.doesNotMatch(garbage.raw, /planted-header-secret/, "JSON.parse quotes its input in its error");
        assert.equal(a.stderr(), "");
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("safety: the adapter imports only Node's own modules and its own runtime", () => {
    for (const f of ["index.mjs", "runtime.mjs"]) {
        const imports = [...fs.readFileSync(path.join(ADAPTER_DIR, f), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
        for (const i of imports) assert.ok(i.startsWith("node:") || i === "./runtime.mjs", `${f} imports ${i}`);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, "package.json"), "utf8")).dependencies, undefined);
});
