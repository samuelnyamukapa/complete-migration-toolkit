// A dedicated worker opens its own sockets, and Playwright's routeWebSocket does not see them.
// A real second server records what reached it, so "no socket" is measured, not assumed.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import https from "node:https";

import { adapter, browserProblem, recorder, site, TLS } from "./helpers.mjs";

const skip = await browserProblem();
const web = { skip, timeout: 120_000 };
const AUTH = { authorization: "Bearer escape-test-token-1234567890", "x-api-key": "escape-test-api-key-987" };

const settle = () => new Promise((r) => setTimeout(r, 400));
const blockedIn = (o) => JSON.parse(o.body ?? "{}").blocked ?? o.journey?.blocked ?? [];

async function withAll(servers, fn) {
    const a = adapter();
    try {
        return await fn(a);
    } finally {
        await a.close();
        for (const s of servers) await s.close();
    }
}

const WORKER = (wsUrl) => `<script>
  const code = ${JSON.stringify(`new WebSocket(${JSON.stringify(wsUrl)})`)};
  try { window.w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" }))); document.title = "made"; } catch (e) { document.title = "refused"; }
</script>`;

test("a worker in a read-only case opens no socket to another origin, and carries no credentials", web, async () => {
    const other = await recorder();
    const target = await site({ "/": WORKER(`${other.ws}/s`) });
    await withAll([other, target], async (a) => {
        const o = await a.run({ id: "W", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: target.url }, AUTH);
        await settle();
        assert.deepEqual(other.seen, [], "the other server received a socket");
        assert.ok(blockedIn(o).some((b) => /worker/i.test(b.why)), JSON.stringify(o).slice(0, 400));
    });
});

test("a worker in a read-only case opens no socket to the target either", web, async () => {
    const seen = [];
    const server = await recorder();
    const target = await site({ "/": WORKER(`${server.ws}/s`) }, seen);
    await withAll([server, target], async (a) => {
        const o = await a.run({ id: "W", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: target.url, allow_origins: server.url });
        await settle();
        assert.deepEqual(server.seen.filter((r) => r.kind === "socket"), []);
        assert.ok(blockedIn(o).some((b) => /worker/i.test(b.why)));
    });
});

test("a worker reached through an empty frame is refused as well", web, async () => {
    const other = await recorder();
    const code = JSON.stringify(`new WebSocket(${JSON.stringify(`${other.ws}/s`)})`);
    const target = await site({ "/": `<iframe id="f"></iframe><script>
        const W = document.getElementById("f").contentWindow.Worker;
        try { new W(URL.createObjectURL(new Blob([${code}], { type: "text/javascript" }))); } catch (e) {}
    </script>` });
    await withAll([other, target], async (a) => {
        await a.run({ id: "W", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: target.url });
        await settle();
        assert.deepEqual(other.seen, []);
    });
});

test("a worker in a case that may write still cannot reach another origin, and that case is an error", web, async () => {
    const other = await recorder();
    const target = await site({ "/": WORKER(`${other.ws}/s`) });
    await withAll([other, target], async (a) => {
        const journey = { goal: "Open the page", steps: [{ goto: "/" }, { check: "here", path: "/" }] };
        const o = await a.run({ id: "W", request: { method: "POST", path: "/" }, journey }, { name: "legacy", base_url: target.url }, AUTH);
        await settle();
        assert.deepEqual(other.seen, []);
        assert.match(o.error ?? "", /stopped/i);
    });
});

test("a worker's fetch to another origin is blocked and no credentials arrive", web, async () => {
    const other = await recorder();
    const code = `fetch(${JSON.stringify(`${other.url}/w`)}).catch(()=>{})`;
    const target = await site({ "/": `<script>new Worker(URL.createObjectURL(new Blob([${JSON.stringify(code)}], { type: "text/javascript" })))</script>` });
    await withAll([other, target], async (a) => {
        const journey = { goal: "Open the page", steps: [{ goto: "/" }, { check: "here", path: "/" }] };
        await a.run({ id: "W", request: { method: "POST", path: "/" }, journey }, { name: "legacy", base_url: target.url }, AUTH);
        await settle();
        assert.deepEqual(other.seen, []);
    });
});

test("a page's own socket to the target works in a case that may write", web, async () => {
    const server = await recorder();
    const target = await site({ "/": `<script>const s = new WebSocket(${JSON.stringify(`${server.ws}/s`)}); s.onopen = () => { document.title = "open"; };</script>` });
    await withAll([server, target], async (a) => {
        const journey = { goal: "Open the page", steps: [{ goto: "/" }, { check: "here", path: "/" }] };
        const o = await a.run({ id: "W", request: { method: "POST", path: "/" }, journey }, { name: "legacy", base_url: target.url, allow_origins: server.url });
        await settle();
        assert.equal(o.error, undefined, o.error);
        assert.equal(server.seen.filter((r) => r.kind === "socket").length, 1);
    });
});

test("over https the fence cannot tell a socket from a page, so a read-only case refuses the worker itself", web, async () => {
    const seen = [];
    const sockets = new Set();
    const server = https.createServer(TLS, (req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        const wss = `wss://${req.headers.host}/s`;
        res.end(`<!doctype html><title>Page</title><h1>Page</h1>${WORKER(wss)}`);
    });
    server.on("upgrade", (req, socket) => {
        seen.push(req.url);
        sockets.add(socket);
        socket.on("error", () => {});
        const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `https://127.0.0.1:${server.address().port}`;
    const close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(r); });
    await withAll([{ close }], async (a) => {
        const o = await a.run({ id: "W", request: { method: "GET", path: "/" } }, { name: "legacy", base_url: url, insecure_tls: true });
        await settle();
        assert.deepEqual(seen, []);
        assert.ok(blockedIn(o).some((b) => /worker/i.test(b.why)));
    });
});
