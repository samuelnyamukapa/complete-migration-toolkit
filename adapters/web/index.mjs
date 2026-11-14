#!/usr/bin/env node
// The web adapter: drives a real browser through Playwright, so a comparison covers what people can do on
// the screen as well as what an API answers. One JSON request per line on stdin, one JSON reply per line on
// stdout, diagnostics on stderr. See README.md and docs/ADAPTERS.md.
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

import { clean, insideProject, runCase, secretsOf } from "./journey.mjs";

const require = createRequire(import.meta.url);
console.log = console.error; // nothing but the protocol on stdout

const NO_BROWSER = "no browser: the web adapter needs the playwright package and Chromium. Run `npm install`, then `npx playwright install chromium`";

let browser, launching;

async function browserFor() {
    if (browser?.isConnected()) return browser;
    launching ??= (async () => {
        const { chromium } = require("playwright");
        // No proxies: the browser goes straight to the target, even when proxy variables are set.
        return chromium.launch({ headless: true, args: ["--no-proxy-server"] });
    })();
    try {
        browser = await launching;
    } finally {
        launching = undefined;
    }
    return browser;
}

// ---------------------------------------------------------------- a static folder as a target

const MEDIA = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const servers = new Map();

/** `serve_folder`: the adapter serves a folder of built pages itself, on this machine, read-only. The conformance kit uses it, and it suits a static front end. */
async function serveFolder(rel) {
    const root = insideProject(rel, "serve_folder");
    if (servers.has(root)) return servers.get(root).url;
    if (!fs.existsSync(root)) throw new Error(`serve_folder: ${rel} does not exist`);
    const server = http.createServer((req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
        const wanted = decodeURIComponent(new URL(req.url, "http://x").pathname);
        let file = path.join(root, wanted);
        if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
        if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file += ".html";
        if (!fs.existsSync(file)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
        res.writeHead(200, { "content-type": MEDIA[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
        res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    servers.set(root, { server, url });
    return url;
}

// ---------------------------------------------------------------- what may leave this process

/** Every value that must not leave: credentials from headers and from the environment. Short values would only mangle text. */
function redact(reply, secrets) {
    const { screenshots, ...rest } = reply;
    let text = JSON.stringify(rest);
    for (const [name, value] of [...secrets].sort((x, y) => String(y[1]).length - String(x[1]).length)) {
        if (String(value).length < 4) continue;
        const inJson = JSON.stringify(String(value)).slice(1, -1);
        text = text.split(inJson).join(`<secret ${clean(name)}>`);
    }
    return { ...JSON.parse(text), ...(screenshots ? { screenshots } : {}) };
}

// ---------------------------------------------------------------- the protocol

function describe() {
    return {
        name: "web",
        kinds: ["ui"],
        settings: ["base_url", "serve_folder", "allow_origins", "step_timeout_ms", "navigation_timeout_ms", "insecure_tls"],
    };
}

async function run(testCase, target, headers) {
    const secrets = secretsOf(headers);
    const base = target.serve_folder ? await serveFolder(target.serve_folder) : target.base_url;
    if (!base) return { error: `target ${target.name} has no base_url or serve_folder, so a web case cannot run on it` };
    let b;
    try {
        b = await browserFor();
    } catch (err) {
        process.stderr.write(`${String(err.message).split("\n")[0]}\n`);
        return { error: NO_BROWSER };
    }
    return redact(await runCase(b, testCase, target, headers ?? {}, base, secrets), secrets);
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
    let reply;
    try {
        const msg = JSON.parse(line);
        if (msg.op === "describe") reply = describe();
        else if (msg.op === "run") reply = await run(msg.case, msg.target, msg.headers);
        // Each case gets a new browser context, so no cookie or storage carries over. A system's own data is its own to reset.
        else if (msg.op === "reset") reply = { ok: true };
        else reply = { error: `unknown op ${msg.op}` };
    } catch (err) {
        reply = { error: `${err?.name ?? "Error"}: ${String(err?.message ?? err).split("\n")[0]}` };
    }
    process.stdout.write(JSON.stringify(reply) + "\n");
}
await browser?.close().catch(() => {});
for (const { server } of servers.values()) server.close();
