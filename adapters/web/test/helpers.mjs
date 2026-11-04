// What the web adapter's tests share: a browser check, a project on disk, and local sites.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ADAPTER = path.join(HERE, "..");
export const REPO = path.join(ADAPTER, "..", "..");
export const CLI = path.join(REPO, "packages", "cli", "dist", "main.js");
export const INDEX = path.join(ADAPTER, "index.mjs");

/** Whether Chromium can start here. Without one each test skips and says why; CMTK_REQUIRE_BROWSER=1 makes that a failure. */
export async function browserProblem() {
    try {
        const b = await require("playwright").chromium.launch({ headless: true });
        await b.close();
        return undefined;
    } catch (err) {
        const why = `no browser for the web adapter's tests (${String(err.message).split("\n")[0]}). Run: npx playwright install chromium`;
        if (process.env.CMTK_REQUIRE_BROWSER) throw new Error(`CMTK_REQUIRE_BROWSER is set, but ${why}`);
        process.stderr.write(`SKIPPED: ${why}\n`);
        return why;
    }
}

export const cmtk = (cwd, args, env = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

/** The adapter itself, spoken to as the toolkit speaks to it. */
export function adapter(env = {}, cwd = REPO) {
    const p = spawn(process.execPath, [INDEX], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    const closed = new Promise((resolve) => p.on("close", resolve));
    const send = async (m) => {
        p.stdin.write(JSON.stringify(m) + "\n");
        const n = await lines.next();
        assert.ok(!n.done, `the adapter stopped: ${stderr}`);
        return JSON.parse(n.value);
    };
    return { send, run: (c, target, headers = {}) => send({ op: "run", case: c, target, headers }), stderr: () => stderr, close: () => { p.stdin.end(); return closed; } };
}

/** A project folder: settings and case files. Each value is written as it is. */
export function project(files) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cmtk-web-"));
    for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
}

export const manifest = (legacy, candidate, more = "") => `system: shop
targets:
  legacy: { base_url: "${legacy}" }
  candidate: { base_url: "${candidate}" }
adapters:
  web: { command: "${process.execPath.replace(/\\/g, "/")}", args: ["${INDEX.replace(/\\/g, "/")}"], covers: [ui], timeout_s: 120 }
${more}
`;

/** Every file under a folder, as text. */
export function everyFile(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) everyFile(full, out);
        else out.push(full);
    }
    return out;
}

export async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/** A server that writes down every request and every socket upgrade it receives, with the headers. */
export async function recorder(body = "<!doctype html><title>Other</title><h1>Other</h1>") {
    const seen = [];
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        seen.push({ kind: "http", method: req.method, url: req.url, headers: req.headers });
        res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
        res.end(body);
    });
    server.on("upgrade", (req, socket) => {
        seen.push({ kind: "socket", url: req.url, headers: req.headers });
        sockets.add(socket);
        socket.on("error", () => {});
        const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    return { url: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, seen, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(r); }) };
}

/** A target whose pages are written by the test, and which records what it receives as well. */
export function site(routes, seen = []) {
    const s = serve((req, res) => {
        const url = new URL(req.url, "http://x");
        seen.push({ method: req.method, url: url.pathname, headers: req.headers });
        const r = routes[url.pathname];
        if (r?.location) { res.writeHead(r.status ?? 302, { location: r.location, ...(r.headers ?? {}) }); return res.end(); }
        if (r === undefined) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": "text/html", ...(r.headers ?? {}) });
        res.end(`<!doctype html><title>Page</title><h1>Page</h1>${r.html ?? r}`);
    });
    return s.then((x) => ({ ...x, seen }));
}

// A certificate made for these tests alone, valid only for this machine's own address. It protects nothing.
export const TLS = {
    key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg9NIE94weXQcPiCR8
VQRG0eaFSu7KgvDvcEKj2XfZFQqhRANCAATS36W1ydi4mftd1KbCFhNCe4k1GQeA
9GIvJo6aMrr2fsj7/9bRAZ3+sVK9kl9Dqb8330c/zyhZ+AgnTj/1k9dZ
-----END PRIVATE KEY-----
`,
    cert: `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUAXh2s07fsshncd2LM2tEIQ/0chswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwNDEyNDg1MloYDzIxMjYxMDEx
MTI0ODUyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATS36W1ydi4mftd1KbCFhNCe4k1GQeA9GIvJo6aMrr2fsj7/9bRAZ3+
sVK9kl9Dqb8330c/zyhZ+AgnTj/1k9dZo28wbTAdBgNVHQ4EFgQUsN3IfVhdMvZD
z+xlqiXp6s9HfMYwHwYDVR0jBBgwFoAUsN3IfVhdMvZDz+xlqiXp6s9HfMYwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZI
zj0EAwIDSQAwRgIhANZFAg1rYhYUAWSWEeHOaWvb6aPvMxiaj8cjdYYL/DkhAiEA
p9N/Q5ffY45m8gliSdWaxrvKYiqKlf+w1eox/v+6LgU=
-----END CERTIFICATE-----
`,
};

const html = (res, body, status = 200, extra = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...extra }); res.end(`<!doctype html><html lang="en">${body}</html>`); };
const cookieOf = (req) => /sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1];

function baskets() {
    const all = new Map();
    let next = 1;
    return {
        of(req, res) {
            let sid = cookieOf(req);
            const set = {};
            if (!sid || !all.has(sid)) { sid = `s${next++}`; all.set(sid, 0); set["set-cookie"] = `sid=${sid}; Path=/`; }
            return { sid, set, count: () => all.get(sid), add: () => all.set(sid, all.get(sid) + 1) };
        },
    };
}

/** The old shop: server-rendered pages with a form post to /basket/add. */
export function oldShop(log = []) {
    const b = baskets();
    return serve((req, res) => {
        const url = new URL(req.url, "http://x");
        const s = b.of(req, res);
        log.push(`${req.method} ${url.pathname}`);
        const page = (title, body) => html(res, `<head><title>${title}</title><style>body{font-family:serif;background:#eee}</style></head><body><header>Old Shop</header><main>${body}</main></body>`, 200, s.set);
        if (url.pathname === "/") return page("Shop", `<h1>Old Shop</h1><form action="/search"><label>Search <input name="q"></label><button>Search</button></form>`);
        if (url.pathname === "/search") return page("Results", `<h1>Results</h1><ul><li><a href="/product/red-jacket">Red jacket</a></li><li><a href="/product/blue-hat">Blue hat</a></li></ul>`);
        if (url.pathname === "/product/red-jacket") return page("Red jacket", `<h1>Red jacket</h1><p>Price: <b data-testid="price">£49.00</b></p><form method="post" action="/basket/add"><button>Add to basket</button></form>`);
        if (url.pathname === "/basket/add" && req.method === "POST") { s.add(); res.writeHead(303, { location: "/basket", ...s.set }); return res.end(); }
        if (url.pathname === "/basket") return page("Basket", `<h1>Your basket</h1><p>Items: <span data-testid="count">${s.count()}</span></p><p>Total: <span data-testid="total">£${(s.count() * 49).toFixed(2)}</span></p>`);
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
}

/** The new shop: another UI over another API, with other words on the screen. `brokenBasket` plants the defect. */
export function newShop({ brokenBasket = false, log = [] } = {}) {
    const b = baskets();
    return serve((req, res) => {
        const url = new URL(req.url, "http://x");
        const s = b.of(req, res);
        log.push(`${req.method} ${url.pathname}`);
        const page = (title, body) => html(res, `<head><title>${title}</title><style>body{font-family:sans-serif;background:#102030;color:#fff;display:grid;gap:2em}</style></head><body><nav><a href="/">Home</a></nav><section>${body}</section></body>`, 200, s.set);
        if (url.pathname === "/") return page("New Shop", `<h2>Find something</h2><input aria-label="What are you looking for?" id="q"><button id="go" onclick="location='/items?term='+encodeURIComponent(q.value)">Find</button>`);
        if (url.pathname === "/items") return page("Items", `<h2>We found</h2><div><a href="/items/7">Red jacket</a> <a href="/items/8">Blue hat</a></div>`);
        if (url.pathname === "/items/7") {
            return page("Red jacket", `<h2>Red jacket</h2><div data-testid="cost">£49.00</div><button onclick="fetch('/api/cart',{method:'POST'}).then(()=>location='/cart')">Add to cart</button>`);
        }
        if (url.pathname === "/api/cart" && req.method === "POST") { if (!brokenBasket) s.add(); res.writeHead(200, { "content-type": "application/json", ...s.set }); return res.end('{"ok":true}'); }
        if (url.pathname === "/cart") return page("Cart", `<h2>Cart</h2><div>In your cart: <em id="n">${s.count()}</em></div><div>To pay <em id="t">£${(s.count() * 49).toFixed(2)}</em></div>`);
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
}

/** The same journey on both shops: what differs is written under `on: { candidate: … }`. */
export const BASKET_JOURNEY = `    journey:
      goal: Find a red jacket and add it to the basket
      step_timeout_ms: 3000
      steps:
        - goto: /
        - fill: { label: Search }
          with: red jacket
          on: { candidate: { fill: { label: "What are you looking for?" } } }
        - click: { role: button, name: Search }
          on: { candidate: { click: { role: button, name: Find } } }
        - click: { role: link, name: Red jacket }
        - reach: product
          see: { role: heading, name: Red jacket }
        - read: price
          from: { testid: price }
          on: { candidate: { from: { testid: cost } } }
        - click: { role: button, name: Add to basket }
          on: { candidate: { click: { role: button, name: Add to cart } } }
        - reach: basket
          path: /basket
          on: { candidate: { path: /cart } }
        - read: items
          from: { testid: count }
          on: { candidate: { from: { css: "#n" } } }
        - read: total
          from: { testid: total }
          on: { candidate: { from: { css: "#t" } } }
        - check: the basket holds the jacket
          value: items
          equals: 1
        - check: the total is the jacket's price
          value: total
          equals: £49.00
`;
