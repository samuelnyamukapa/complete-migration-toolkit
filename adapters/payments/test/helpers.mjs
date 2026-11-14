// What the payments tests share: the adapter over its real protocol, the real CLI, servers that count
// connections, and stand-ins for Stripe and for a system that uses it.
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-payments-"));
    fs.cpSync(ADAPTER_DIR, path.join(dir, "adapters", "payments"), { recursive: true, filter: (f) => path.basename(f) !== "test" });
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

