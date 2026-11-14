// What the SMS tests share: the adapter over its real protocol, the real CLI, servers that count
// connections, a system that texts through the capture, and a stand-in for Twilio's API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ADAPTER_DIR = path.join(HERE, "..");
const CLI = path.join(HERE, "..", "..", "..", "packages", "cli", "dist", "main.js");

export const cmtk = (cwd, env, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

export function project(manifest, cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-sms-"));
    fs.cpSync(ADAPTER_DIR, path.join(dir, "adapters", "sms"), { recursive: true, filter: (f) => path.basename(f) !== "test" });
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), manifest);
    if (cases) {
        fs.mkdirSync(path.join(dir, "cmtk", "cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk", "cases", "cases.yaml"), cases);
    }
    return dir;
}

export function allText(dir) {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "latin1")).join("\n");
}

export function adapter(env = {}) {
    const p = spawn(process.execPath, [path.join(ADAPTER_DIR, "index.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    const lines = readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    const call = async (msg) => {
        p.stdin.write((typeof msg === "string" ? msg : JSON.stringify(msg)) + "\n");
        const { value, done } = await lines.next();
        if (done) throw new Error(`the adapter stopped: ${stderr}`);
        return { reply: JSON.parse(value), raw: value };
    };
    return { call, stderr: () => stderr, close: () => new Promise((r) => { p.on("close", r); p.stdin.end(); }) };
}

export function listen(handler) {
    const state = { connections: 0, requests: [] };
    const s = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString("utf8");
        state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        await handler(req, res, body);
    });
    s.on("connection", () => { state.connections++; });
    return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve({
        url: `http://127.0.0.1:${s.address().port}`, state,
        close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }),
    })));
}

export const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

/** A system that texts a fresh code through its SMS provider address (the capture) on POST /send-code. `form` uses Twilio's form; otherwise JSON. */
export function smsSystem(providerUrl, { text = (code) => `Your code is ${code}`, form = true, to = "+15005550006" } = {}) {
    return listen(async (req, res, body) => {
        if (req.method !== "POST" || !req.url.startsWith("/send-code")) return json(res, 404, {});
        const code = String(Math.floor(100000 + Math.random() * 899999));
        const recipient = (body && JSON.parse(body).to) || to;
        const r = form
            ? await fetch(`${providerUrl}/2010-04-01/Accounts/ACtest/Messages.json`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic cGxhbnRlZA==" }, body: new URLSearchParams({ To: recipient, From: "+15005550006", Body: text(code) }) })
            : await fetch(`${providerUrl}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: recipient, from: "+15005550006", text: text(code) }) });
        await r.arrayBuffer();
        return json(res, 202, { sent: true });
    });
}

/**
 * A stand-in for Twilio's Messages API with test credentials: From must be +15005550006 or it is
 * refused (code 21606), and To +15005550009 is not SMS capable (code 21614). An error's message quotes
 * the account. It holds what it was sent, so a test can look.
 */
export function twilio({ sid, token }) {
    return listen((req, res, body) => {
        const m = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\.json$/.exec(req.url);
        if (req.method !== "POST" || !m) return json(res, 404, {});
        const expected = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;
        if (req.headers.authorization !== expected) return json(res, 401, { code: 20003, message: `Authenticate failed for ${m[1]}`, status: 401 });
        const f = new URLSearchParams(body);
        if (f.get("From") !== "+15005550006") return json(res, 400, { code: 21606, message: `The From number on account ${m[1]} is not valid`, status: 400 });
        if (f.get("To") === "+15005550009") return json(res, 400, { code: 21614, message: `To is not SMS capable, on account ${m[1]}`, status: 400 });
        return json(res, 201, { sid: `SM${Date.now()}`, account_sid: m[1], to: f.get("To"), from: f.get("From"), body: f.get("Body"), status: "queued", date_created: new Date().toUTCString(), error_code: null });
    });
}
