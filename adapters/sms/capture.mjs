#!/usr/bin/env node
// A local capture for text messages: point a system's SMS provider address here and it records
// what would have been sent. Nothing leaves this machine. Credentials on a request are ignored and
// never kept. Everything is held in memory only.
//
//   node adapters/sms/capture.mjs --port 8026
//
// POST to any path records a message, written as Twilio's form (To, From, Body) or as JSON
// (to, from, text or body). GET /__cmtk/info says what this is. GET /__cmtk/messages lists what
// it holds, and DELETE /__cmtk/messages empties it.
import crypto from "node:crypto";
import http from "node:http";

const MOST_BYTES = 1024 * 1024;

const pick = (o, names) => { for (const n of names) if (o[n] !== undefined) return o[n]; return undefined; };

/** One record per recipient. A request that can't be read is kept as having no recipient, so the adapter can say so. */
function parse(type, body) {
    let fields = {};
    if (/json/i.test(type ?? "")) {
        try { fields = JSON.parse(body) ?? {}; } catch { fields = {}; }
    } else {
        const form = new URLSearchParams(body);
        fields = Object.fromEntries(new Set([...form.keys()]).values().map((k) => [k, form.getAll(k).length > 1 ? form.getAll(k) : form.get(k)]));
    }
    const to = pick(fields, ["To", "to", "recipient", "recipients", "destination"]);
    const from = pick(fields, ["From", "from", "originator", "sender"]);
    const text = pick(fields, ["Body", "body", "text", "message"]);
    return (Array.isArray(to) ? to : [to]).map((one) => ({ id: crypto.randomUUID(), to: one === undefined ? null : String(one), from: from === undefined ? null : String(from), text: text === undefined ? null : String(text) }));
}

export function startCapture(port = 0, host = "127.0.0.1") {
    const messages = [];
    const answer = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const server = http.createServer((req, res) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { size += c.length; if (size <= MOST_BYTES) chunks.push(c); });
        req.on("end", () => {
            const path = new URL(req.url, "http://x").pathname;
            if (req.method === "GET" && path === "/__cmtk/info") return answer(res, 200, { server: "cmtk-sms-capture", version: 1 });
            if (req.method === "GET" && path === "/__cmtk/messages") return answer(res, 200, { messages });
            if (req.method === "DELETE" && path === "/__cmtk/messages") { messages.length = 0; return answer(res, 200, { ok: true }); }
            if (req.method !== "POST") return answer(res, 404, {});
            if (size > MOST_BYTES) return answer(res, 413, {});
            const made = parse(req.headers["content-type"], Buffer.concat(chunks).toString("utf8"));
            messages.push(...made);
            // Enough of Twilio's answer that its client libraries accept it.
            return answer(res, 201, { sid: `SM${crypto.randomBytes(16).toString("hex")}`, status: "queued", to: made[0]?.to, from: made[0]?.from, body: made[0]?.text });
        });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
    const at = process.argv.indexOf("--port");
    const server = await startCapture(at > 0 ? Number(process.argv[at + 1]) : 8026);
    console.log(`SMS capture listening on http://127.0.0.1:${server.address().port}`);
}
