// Local stand-ins, written from Mailpit's and MailHog's documented API shapes, and the helpers the
// tests share. Mailpit: its API docs and the typed mailpit-api client. MailHog: its API docs and its
// clients. MailHog's list is { total, start, count, items }; its swagger file says `messages`, but
// the server and every client use `items`.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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

/** A project in a temporary folder with this adapter copied in, as a person would have it. */
export function project(name, manifest, cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cmtk-${name}-`));
    fs.cpSync(ADAPTER_DIR, path.join(dir, "adapters", name), { recursive: true, filter: (f) => path.basename(f) !== "test" });
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), manifest);
    if (cases) {
        fs.mkdirSync(path.join(dir, "cmtk", "cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk", "cases", "cases.yaml"), cases);
    }
    return dir;
}

/** Everything under a folder, read as text, to search for a planted secret. */
export function allText(dir) {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "latin1")).join("\n");
}

/** The adapter in its own process, spoken to over the real protocol. */
export function adapter(env = {}, dir = ADAPTER_DIR) {
    const p = spawn(process.execPath, [path.join(dir, "index.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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

/** An HTTP server that counts connections, so a test can say nothing reached it at all. */
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
        url: `http://127.0.0.1:${s.address().port}`,
        state,
        close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }),
    })));
}

const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

let nextId = 1;
const id = () => `id-${nextId++}-${crypto.randomUUID()}`;
const sha = (b, kind = "sha256") => crypto.createHash(kind).update(b).digest("hex");

/** A stand-in for Mailpit's /api/v1. Older Mailpit has no Checksums on an attachment, so `checksums: false` leaves them out. */
export async function mailpit({ checksums = true } = {}) {
    const store = [];
    const addr = (a) => ({ Name: a.name ?? "", Address: a.address });
    const server = await listen((req, res) => {
        const u = new URL(req.url, "http://x");
        const part = /^\/api\/v1\/message\/([^/]+)\/part\/([^/]+)$/.exec(u.pathname);
        const one = /^\/api\/v1\/message\/([^/]+)$/.exec(u.pathname);
        if (req.method === "GET" && u.pathname === "/api/v1/info") {
            return json(res, 200, { Version: "v1.27.0", LatestVersion: "v1.27.0", Database: "/tmp/mailpit.db", DatabaseSize: 1, Messages: store.length, Unread: 0, Tags: {},
                RuntimeStats: { Memory: 1, MessagesDeleted: 0, SMTPAccepted: 0, SMTPAcceptedSize: 0, SMTPIgnored: 0, SMTPRejected: 0, Uptime: 1 } });
        }
        if (req.method === "GET" && u.pathname === "/api/v1/messages") {
            const start = Number(u.searchParams.get("start") ?? 0), limit = Number(u.searchParams.get("limit") ?? 50);
            const newestFirst = [...store].reverse();
            return json(res, 200, {
                total: store.length, unread: 0, messages_count: store.length, messages_unread: 0, start, tags: [],
                messages: newestFirst.slice(start, start + limit).map((m) => ({
                    ID: m.id, MessageID: `${m.id}@mail`, Read: false, From: addr(m.from), To: m.to.map(addr), Cc: (m.cc ?? []).map(addr), Bcc: (m.bcc ?? []).map(addr), ReplyTo: [],
                    Subject: m.subject, Created: new Date().toISOString(), Username: "", Tags: [], Size: 1, Attachments: (m.attachments ?? []).length, Snippet: "",
                })),
            });
        }
        if (req.method === "DELETE" && u.pathname === "/api/v1/messages") { store.length = 0; res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
        if (req.method === "GET" && part) {
            const m = store.find((x) => x.id === part[1]);
            const a = (m?.attachments ?? [])[Number(part[2]) - 1];
            if (!a) return json(res, 404, {});
            res.writeHead(200, { "content-type": a.type });
            return res.end(a.bytes);
        }
        if (req.method === "GET" && one) {
            const m = store.find((x) => x.id === one[1]);
            if (!m) return json(res, 404, {});
            const attachment = (a, i) => ({ PartID: String(i + 1), FileName: a.name, ContentType: a.type, ContentID: "", Size: a.bytes.length,
                ...(checksums ? { Checksums: { MD5: sha(a.bytes, "md5"), SHA1: sha(a.bytes, "sha1"), SHA256: sha(a.bytes) } } : {}) });
            return json(res, 200, {
                ID: m.id, MessageID: `${m.id}@mail`, From: addr(m.from), To: m.to.map(addr), Cc: (m.cc ?? []).map(addr), Bcc: (m.bcc ?? []).map(addr), ReplyTo: [], ReturnPath: m.from.address,
                Subject: m.subject, ListUnsubscribe: { Errors: "", Header: "", HeaderPost: "", Links: [] }, Date: new Date().toISOString(), Tags: [], Text: m.text ?? "", HTML: m.html ?? "", Size: 1,
                Inline: [], Attachments: (m.attachments ?? []).map(attachment),
            });
        }
        return json(res, 404, {});
    });
    return { ...server, deliver: (m) => store.push({ ...m, id: id() }), count: () => store.length };
}

const pathOf = (a) => { const [Mailbox, Domain] = a.split("@"); return { Relays: null, Mailbox, Domain, Params: "" }; };
const named = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
const qp = (text) => [...Buffer.from(text, "utf8")].map((b) => (b === 13 || b === 10 || (b >= 32 && b < 127 && b !== 61) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");

/** One message as MailHog stores it: headers as lists, the MIME tree with each body still encoded. */
function mailhogMessage(m) {
    const leaf = (Headers, Body) => ({ Headers, Body, Size: Body.length, MIME: null });
    const alt = [];
    if (m.text !== undefined) alt.push(leaf({ "Content-Type": ["text/plain; charset=utf-8"], "Content-Transfer-Encoding": ["quoted-printable"] }, qp(m.text.replace(/\n/g, "\r\n"))));
    if (m.html !== undefined) alt.push(leaf({ "Content-Type": ['text/html; charset="UTF-8"'], "Content-Transfer-Encoding": ["base64"] }, Buffer.from(m.html, "utf8").toString("base64")));
    const files = (m.attachments ?? []).map((a) => leaf(
        { "Content-Type": [`${a.type}; name="${a.name}"`], "Content-Disposition": [`attachment; filename="${a.name}"`], "Content-Transfer-Encoding": ["base64"] },
        a.bytes.toString("base64")));
    const top = { Subject: [`=?UTF-8?B?${Buffer.from(m.subject, "utf8").toString("base64")}?=`], From: [named(m.from)], To: [m.to.map((a) => named(a)).join(", ")], "Message-ID": [`${id()}@mail`], Date: [new Date().toUTCString()], "MIME-Version": ["1.0"] };
    if (m.cc?.length) top.Cc = [m.cc.map((a) => named(a)).join(", ")];
    let mime = null, body = "";
    if (files.length) {
        top["Content-Type"] = ['multipart/mixed; boundary="outer"'];
        mime = { Parts: [{ Headers: { "Content-Type": ['multipart/alternative; boundary="inner"'] }, Body: "(the parts)", Size: 1, MIME: { Parts: alt } }, ...files] };
        body = "(the raw body)";
    } else if (alt.length > 1) {
        top["Content-Type"] = ['multipart/alternative; boundary="inner"'];
        mime = { Parts: alt };
        body = "(the raw body)";
    } else {
        Object.assign(top, alt[0].Headers);
        body = alt[0].Body;
    }
    const envelope = [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((a) => pathOf(a.address));
    return {
        ID: `${id()}@mailhog.example`, From: pathOf(m.from.address), To: envelope,
        Content: { Headers: top, Body: body, Size: body.length, MIME: null }, Created: new Date().toISOString(), MIME: mime,
        Raw: { From: m.from.address, To: envelope.map((p) => `${p.Mailbox}@${p.Domain}`), Data: "(raw)", Helo: "client" },
    };
}

/** A stand-in for MailHog: GET /api/v2/messages, GET and DELETE /api/v1/messages, and its web page. */
export async function mailhog() {
    const store = [];
    const server = await listen((req, res) => {
        const u = new URL(req.url, "http://x");
        const one = /^\/api\/v1\/messages\/([^/]+)$/.exec(u.pathname);
        if (req.method === "GET" && u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!DOCTYPE html><html><head><title>MailHog</title></head><body></body></html>"); }
        if (req.method === "GET" && u.pathname === "/api/v2/messages") {
            const start = Number(u.searchParams.get("start") ?? 0), limit = Number(u.searchParams.get("limit") ?? 50);
            const items = store.slice(start, start + limit);
            return json(res, 200, { total: store.length, count: items.length, start, items });
        }
        if (req.method === "DELETE" && u.pathname === "/api/v1/messages") { store.length = 0; res.writeHead(200); return res.end(); }
        if (req.method === "GET" && one) {
            const m = store.find((x) => x.ID === decodeURIComponent(one[1]));
            return m ? json(res, 200, m) : json(res, 404, {});
        }
        return json(res, 404, {});
    });
    return { ...server, deliver: (m) => store.push(mailhogMessage(m)), count: () => store.length };
}

/** A system that sends the given mail to its capture server when it gets POST /send, after an optional delay. */
export async function system(capture, mail, delays = []) {
    return listen((req, res) => {
        if (req.method === "POST" && req.url === "/send") {
            mail().forEach((m, i) => setTimeout(() => capture.deliver(m), delays[i] ?? 0));
            return json(res, 202, { accepted: true, id: crypto.randomUUID() });
        }
        return json(res, 404, {});
    });
}

export const receipt = (token = "a1b2c3d4e5f60718293a4b5c6d7e8f90") => ({
    from: { name: "Shop", address: "shop@example.test" },
    to: [{ name: "Zed", address: "zed@example.test" }, { name: "Ann", address: "ann@example.test" }],
    cc: [{ address: "copy@example.test" }],
    bcc: [{ address: "hidden@example.test" }],
    subject: "Your order: café",
    text: `Thanks.\nTrack it: https://shop.example.test/track/${token}?lang=en&token=${token}.\n`,
    html: `<p>Thanks. <a href="https://shop.example.test/track/${token}?lang=en&amp;token=${token}">Track it</a></p>`,
    attachments: [{ name: "receipt.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1.4 receipt") }],
});
