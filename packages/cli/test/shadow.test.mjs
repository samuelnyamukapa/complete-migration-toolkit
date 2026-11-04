// `cmtk shadow` (#30): a local replay of recorded requests, with planted differences and planted unsafe requests.
// The differences must be found, the unsafe requests never sent, and nothing personal may reach any file written.
// The two systems are small stand-ins on this machine: no real traffic has been replayed through this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureRequests, cleanTarget, endpointOf, loadManifest, redactText, shadow } from "../../core/dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "dist", "main.js");

const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CMTK_TEST_TOKEN: "env-secret-value-123" } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

/** A stand-in system. It logs every request it gets, and `answer` may differ per system. */
function system(answer) {
    const seen = [];
    let inFlight = 0, most = 0;
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            inFlight++;
            most = Math.max(most, inFlight);
            seen.push({ method: req.method, url: req.url, headers: req.headers, at: performance.now() });
            const a = answer(req);
            res.writeHead(a.status ?? 200, { "content-type": "application/json", ...(a.headers ?? {}) });
            res.end(req.method === "HEAD" ? undefined : a.body ?? "{}", () => { inFlight--; });
        });
        s.listen(0, "127.0.0.1", () => resolve({ seen, most: () => most, url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

function project(a, b, extra = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-shadow-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: shadowed\ntargets:\n  legacy: { base_url: "${a}" }\n  candidate: { base_url: "${b}" }\n${extra}`);
    return dir;
}

function everything(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else out.push([path.relative(dir, full), fs.readFileSync(full, "utf8")]);
        }
    };
    walk(dir);
    return out;
}

const clf = (method, target, status = 200) => `203.0.113.9 - jane.smith [10/Oct/2026:13:55:36 +0000] "${method} ${target} HTTP/1.1" ${status} 123 "https://example.com/from?email=referrer@example.com" "Mozilla/5.0 (secret-agent)"`;

test("planted differences are found, by endpoint, and planted unsafe requests are never sent", async () => {
    const answer = (planted) => (req) => {
        if (req.url.startsWith("/api/orders/7")) return { body: JSON.stringify({ id: 7, total: planted ? "12.01" : "12.00", at: planted ? "2026-01-02T03:04:05Z" : "2026-05-06T07:08:09Z" }) };
        if (req.url.startsWith("/api/gone") && planted) return { status: 404 };
        if (req.url.startsWith("/api/moved")) return { status: 302, headers: { location: planted ? "/other" : "/same" } };
        return { body: JSON.stringify({ ok: true }) };
    };
    const [a, b] = await Promise.all([system(answer(false)), system(answer(true))]);
    try {
        const dir = project(a.url, b.url, "scrub:\n  json_paths: [\"$.at\"]\ncompare_headers: [content-type, location]\n");
        fs.writeFileSync(path.join(dir, "traffic.log"), [
            clf("GET", "/api/items?page=1"),
            clf("GET", "/api/orders/7"),
            clf("GET", "/api/orders/7?x=1"),
            clf("HEAD", "/api/items"),
            clf("OPTIONS", "/api/items"),
            clf("GET", "/api/gone"),
            clf("GET", "/api/moved"),
            // Planted, and none may reach either system.
            clf("POST", "/api/orders"),
            clf("PUT", "/api/orders/7"),
            clf("PATCH", "/api/orders/7"),
            clf("DELETE", "/api/orders/7"),
            clf("delete", "/api/lowercase"),
            clf("GET", "/api/orders/7?_method=DELETE"),
            clf("CONNECT", "evil.example.com:443"),
            "this line is not a request and holds someone@example.com",
        ].join("\r\n") + "\r\n");
        fs.writeFileSync(path.join(dir, "mirror.jsonl"), [
            JSON.stringify({ method: "GET", url: "/api/items?page=2" }),
            JSON.stringify({ method: "POST", path: "/api/from-json", body: "{}" }),
            JSON.stringify({ method: "GET", path: "/api/get-with-body", body: "{\"delete\":true}" }),
            JSON.stringify({ method: "GET", path: "/api/override", headers: { "X-HTTP-Method-Override": "DELETE" } }),
            JSON.stringify({ request: "GET /api/nginx-style HTTP/1.1" }),
        ].join("\n"));

        const r = await cmtk(dir, "shadow", "--from", "traffic.log", "--from", "mirror.jsonl", "--rate", "1000");
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /UNEXPLAINED DIFFERENCES/);
        const report = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/REPORT.json"), "utf8"));

        for (const sys of [a, b]) {
            const methods = new Set(sys.seen.map((s) => s.method));
            assert.deepEqual([...methods].sort(), ["GET", "HEAD", "OPTIONS"], "only reads reach a system");
            for (const s of sys.seen) assert.doesNotMatch(s.url, /lowercase|_method|from-json|get-with-body|override|evil/);
        }
        assert.equal(report.capture.dropped_total, 10);
        assert.deepEqual(report.capture.dropped, { CONNECT: 1, DELETE: 2, "GET that overrides its method": 2, "GET with a body": 1, PATCH: 1, POST: 2, PUT: 1 });
        assert.equal(report.capture.unreadable, 1);
        assert.equal(report.replay.sent, 9);

        const byName = Object.fromEntries(report.endpoints.map((e) => [e.endpoint, e]));
        assert.equal(byName["GET /api/orders/{id}"].unexplained, 2);
        assert.deepEqual(byName["GET /api/orders/{id}"].differences.map((d) => d.where), ["$.total"], "the scrub hid $.at, and only the planted difference shows");
        assert.deepEqual(byName["GET /api/gone"].differences.map((d) => [d.where, d.reference, d.candidate]).slice(0, 1), [["status", "200", "404"]]);
        assert.deepEqual(byName["GET /api/moved"].differences.map((d) => d.where), ["header:location"], "a redirect is compared");
        assert.ok(a.seen.every((s) => s.url !== "/other" && s.url !== "/same"), "a redirect is never followed");
        assert.equal(byName["GET /api/items"].unexplained, 0);
        assert.equal(byName["HEAD /api/items"].matched, 1);
        assert.equal(byName["OPTIONS /api/items"].matched, 1);
        assert.equal(report.endpoints[0].unexplained, 2, "the worst endpoint comes first");
        const md = fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/REPORT.md"), "utf8");
        assert.match(md, /GET \/api\/orders\/\{id\}/);
        assert.doesNotMatch(report.reason + md, /\bPARITY\b/, "a replay never says parity");
    } finally {
        await a.close();
        await b.close();
    }
});

test("credentials are stripped and personal data redacted before anything is stored or sent", async () => {
    const secretish = (req) => ({ body: JSON.stringify({ email: req.socket.localPort % 2 ? "ann@example.com" : "bob@example.com", phone: `+44 7700 900${req.socket.localPort % 1000}`, note: `port ${req.socket.localPort}` }) });
    const [a, b] = await Promise.all([system(secretish), system(secretish)]);
    try {
        const dir = project(a.url, b.url, "headers_from_env: { Authorization: CMTK_TEST_TOKEN }\n");
        const PLANTED = ["jane.doe@example.com", "jane.smith", "203.0.113.9", "4111111111111111", "AB123456C", "+447700900123", "sk_live_abcdef123456", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl", "letmein-password", "cookie-secret-1", "basic-secret-2", "RG24 8AA", "Smith", "referrer@example.com", "secret-agent", "abcdef0123456789abcdef0123456789", "session-in-path", "CUST-998877"];
        fs.writeFileSync(path.join(dir, "t.log"), [
            clf("GET", "/api/customers/jane.doe%40example.com?token=letmein-password&page=2"),
            clf("GET", "/api/cards/4111111111111111"),
            clf("GET", "/api/people?surname=Smith&nino=AB123456C&postcode=RG24%208AA"),
            clf("GET", "/api/lookup?q=%2B447700900123&code=abc&key=sk_live_abcdef123456"),
            clf("GET", "/api/a;jsessionid=session-in-path/b?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl"),
            clf("GET", "/api/hex/abcdef0123456789abcdef0123456789"),
            clf("GET", "/api/own/CUST-998877"),
            clf("GET", "https://user:basic-secret-2@evil.example.com/api/absolute?page=1"),
        ].join("\n"));
        fs.writeFileSync(path.join(dir, "m.jsonl"), JSON.stringify({ method: "GET", url: "/api/mirror", headers: { Cookie: "s=cookie-secret-1", Authorization: "Basic basic-secret-2", "X-Api-Key": "cookie-secret-1", Accept: "application/json", "X-Other": "kept-out" } }) + "\n");

        const r = await cmtk(dir, "shadow", "--from", "t.log", "--from", "m.jsonl", "--rate", "1000", "--redact", "CUST-\\d+");
        assert.ok([1, 4].includes(r.status), r.stdout + r.stderr);

        const files = everything(path.join(dir, "cmtk"));
        assert.ok(files.some(([f]) => f.endsWith("capture.jsonl")));
        for (const [file, text] of files) {
            for (const p of [...PLANTED, "env-secret-value-123", "ann@example.com", "bob@example.com", "7700 900"]) assert.ok(!text.includes(p), `${p} is in ${file}`);
        }
        for (const sys of [a, b]) {
            for (const s of sys.seen) {
                for (const p of PLANTED) assert.ok(!decodeURIComponent(s.url).includes(p), `${p} was sent in ${s.url}`);
                assert.equal(s.headers.cookie, undefined);
                assert.equal(s.headers["x-api-key"], undefined);
                assert.equal(s.headers["x-other"], undefined);
                assert.equal(s.headers.authorization, "env-secret-value-123", "a replay's credential comes only from the environment");
            }
            assert.ok(sys.seen.every((s) => !/evil/.test(s.headers.host)), "a host in the log never decides where a request goes");
        }
        assert.ok(a.seen.some((s) => s.url === "/api/absolute?page=1"));
        assert.ok(a.seen.some((s) => s.headers.accept === "application/json" && s.url === "/api/mirror"));
        for (const out of [r.stdout, r.stderr]) for (const p of [...PLANTED, "env-secret-value-123"]) assert.ok(!out.includes(p), `${p} was printed`);

        const report = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/REPORT.json"), "utf8"));
        assert.ok(report.capture.redacted_requests >= 7);
        assert.equal(report.capture.credential_headers_stripped, 3);
        assert.equal(report.values, "withheld");
        assert.deepEqual(report.sources, ["t.log", "m.jsonl"], "file names only");
        assert.ok(!fs.existsSync(path.join(dir, "cmtk/evidence/shadow/answers")), "answers are not kept");
        for (const e of report.endpoints) for (const d of e.differences) if (d.where !== "status") assert.match(d.reference + d.candidate, /withheld|missing/);
    } finally {
        await a.close();
        await b.close();
    }
});

test("--keep-values stores differing values with personal data redacted", async () => {
    const say = (name) => () => ({ body: JSON.stringify({ customer: { email: `${name}@example.com`, surname: name }, note: `ring ${name}@example.com`, price: name === "ann" ? 1 : 2 }) });
    const [a, b] = await Promise.all([system(say("ann")), system(say("bob"))]);
    try {
        const dir = project(a.url, b.url);
        fs.writeFileSync(path.join(dir, "t.log"), clf("GET", "/api/x"));
        const m = loadManifest(path.join(dir, "cmtk.yaml"));
        const r = await shadow(m, { from: [path.join(dir, "t.log")], keepValues: true, rate: 1000 });
        const ds = Object.fromEntries(r.endpoints[0].differences.map((d) => [d.where, d]));
        assert.equal(ds["$.price"].reference, "1");
        assert.equal(ds["$.price"].candidate, "2");
        assert.equal(ds["$.customer.email"].reference, "REDACTED");
        assert.equal(ds["$.customer.surname"].candidate, "REDACTED");
        assert.doesNotMatch(ds["$.note"].reference, /example\.com/);
        assert.equal(r.values, "redacted");
        for (const [, text] of everything(path.join(dir, "cmtk"))) assert.doesNotMatch(text, /ann@|bob@/);
    } finally {
        await a.close();
        await b.close();
    }
});

test("the usual drift ledger applies, an unused entry is reported, and a clean replay exits 4 and never says parity", async () => {
    const say = (v) => () => ({ body: JSON.stringify({ v, same: 1 }) });
    const [a, b] = await Promise.all([system(say(1)), system(say(2))]);
    try {
        const dir = project(a.url, b.url);
        fs.mkdirSync(path.join(dir, "cmtk"));
        fs.writeFileSync(path.join(dir, "cmtk/drift.yaml"), `drift:\n  - { id: D1, case: "shadow:GET /api/x", where: "$.v", reason: intended, approved_by: Jane Smith }\n  - { id: D2, case: "*", where: "$.never", reason: old, approved_by: Jane Smith }\n  - { id: D3, case: CASE-1, where: "$.v", reason: another case, approved_by: Jane Smith }\n`);
        fs.writeFileSync(path.join(dir, "t.log"), clf("GET", "/api/x"));
        const r = await cmtk(dir, "shadow", "--from", "t.log", "--rate", "1000", "--json");
        assert.equal(r.status, 4, r.stdout + r.stderr);
        const report = JSON.parse(r.stdout);
        assert.equal(report.verdict, "NO UNEXPLAINED DIFFERENCES");
        assert.equal(report.replay.drift, 1);
        assert.equal(report.endpoints[0].differences[0].drift, "D1");
        assert.deepEqual(report.unused_drift, ["D2"], "an entry for a recorded case says nothing about shadow traffic");
        assert.match(report.reason, /never the whole system/);
        assert.doesNotMatch(JSON.stringify({ v: report.verdict, r: report.reason, n: report.next }), /PARITY/);
        const status = await cmtk(dir, "status");
        assert.match(status.stdout, /shadow: NO UNEXPLAINED DIFFERENCES/);
    } finally {
        await a.close();
        await b.close();
    }
});

test("--rate limits the requests, one at a time, and --sample and --max choose them the same way each time", async () => {
    const [a, b] = await Promise.all([system(() => ({})), system(() => ({}))]);
    try {
        const dir = project(a.url, b.url);
        const lines = Array.from({ length: 1000 }, (_, i) => clf("GET", `/api/items/${i}`));
        fs.writeFileSync(path.join(dir, "t.log"), lines.join("\n"));
        const log = path.join(dir, "t.log");
        const pick = async (seed, sample = 0.25) => (await captureRequests([log], { sample, seed, max: 100000 })).requests.map((q) => q.path);
        const one = await pick(7);
        assert.ok(one.length > 180 && one.length < 320, `about a quarter, got ${one.length}`);
        assert.deepEqual(await pick(7), one, "the same seed gives the same sample");
        assert.notDeepEqual(await pick(8), one);

        const m = loadManifest(path.join(dir, "cmtk.yaml"));
        const waits = [];
        let clock = 0;
        const fake = await shadow(m, { from: [log], max: 5, rate: 10, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
        assert.equal(fake.replay.sent, 5);
        assert.equal(fake.capture.over_limit, 995);
        assert.deepEqual(waits.map(Math.round), [100, 100, 100, 100], "at 10 a second, one every 100 ms");
        assert.match(fake.reason, /995 left out by the limit of 5/);

        a.seen.length = 0;
        const start = performance.now();
        await shadow(m, { from: [log], max: 6, rate: 50 });
        const took = performance.now() - start;
        assert.equal(a.seen.length, 6);
        assert.ok(took >= 90, `six at 50 a second take at least 100 ms (timer slack aside), took ${took}`);
        const spans = a.seen.slice(1).map((s, i) => s.at - a.seen[i].at);
        assert.ok(spans.every((g) => g >= 10), `requests were spaced: ${spans}`);
        assert.equal(a.most(), 1, "one at a time");
        assert.equal(b.most(), 1, "one at a time");
    } finally {
        await a.close();
        await b.close();
    }
});

test("--capture-only writes the clean requests and sends nothing", async () => {
    const [a, b] = await Promise.all([system(() => ({})), system(() => ({}))]);
    try {
        const dir = project(a.url, b.url);
        fs.writeFileSync(path.join(dir, "t.log"), `${clf("GET", "/api/x?email=a%40b.com")}\n${clf("POST", "/api/y")}\n`);
        const r = await cmtk(dir, "shadow", "--from", "t.log", "--capture-only");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(a.seen.length + b.seen.length, 0);
        const capture = fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
        assert.deepEqual(capture, [{ n: 1, method: "GET", path: "/api/x?email=REDACTED", redacted: ["personal field"] }]);
    } finally {
        await a.close();
        await b.close();
    }
});

test("reads IIS (W3C) logs and CRLF files, and refuses what it cannot use", async () => {
    const [a, b] = await Promise.all([system(() => ({})), system(() => ({}))]);
    try {
        const dir = project(a.url, b.url);
        fs.writeFileSync(path.join(dir, "u_ex.log"), [
            "#Software: Microsoft Internet Information Services 10.0",
            "#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip sc-status",
            "2026-10-10 13:55:36 10.0.0.1 GET /Catalog/Details id=5&email=a@b.com 80 DOMAIN\\jane 203.0.113.9 200",
            "2026-10-10 13:55:37 10.0.0.1 POST /Catalog/Create - 80 - 203.0.113.9 302",
            "2026-10-10 13:55:38 10.0.0.1 HEAD /Catalog - 80 - 203.0.113.9 200",
        ].join("\r\n") + "\r\n");
        const r = await cmtk(dir, "shadow", "--from", "u_ex.log", "--rate", "1000", "--json");
        assert.equal(r.status, 4, r.stdout + r.stderr);
        assert.deepEqual(a.seen.map((s) => `${s.method} ${s.url}`), ["GET /Catalog/Details?id=5&email=REDACTED", "HEAD /Catalog"]);
        assert.equal(JSON.parse(r.stdout).capture.dropped.POST, 1);

        for (const [args, want] of [
            [["shadow"], /needs --from/],
            [["shadow", "--from", "missing.log"], /missing\.log does not exist/],
            [["shadow", "--from", "u_ex.log", "--sample", "0"], /--sample must be/],
            [["shadow", "--from", "u_ex.log", "--rate", "0"], /--rate must be/],
            [["shadow", "--from", "u_ex.log", "--format", "x"], /--format must be/],
            [["shadow", "--from", "u_ex.log", "--keep-header", "Authorization"], /never kept/],
            [["shadow", "--from", "u_ex.log", "--keep-header", "X-HTTP-Method-Override"], /never kept/],
            [["shadow", "--from", "u_ex.log", "--redact", "("], /--redact/],
        ]) {
            const bad = await cmtk(dir, ...args);
            assert.equal(bad.status, 3, args.join(" "));
            assert.match(bad.stderr, want);
        }
        assert.ok(!fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/REPORT.json"), "utf8").includes(dir), "no machine path in the report");

        fs.writeFileSync(path.join(dir, "writes.log"), clf("POST", "/api/y"));
        const none = await cmtk(dir, "shadow", "--from", "writes.log", "--json");
        assert.equal(none.status, 2);
        assert.equal(JSON.parse(none.stdout).verdict, "NO EVIDENCE");
    } finally {
        await a.close();
        await b.close();
    }
});

test("a system that stops answering ends the replay early, and the verdict is not clean", async () => {
    const a = await system(() => ({}));
    const dir = project(a.url, "http://127.0.0.1:9");
    fs.writeFileSync(path.join(dir, "t.log"), Array.from({ length: 8 }, (_, i) => clf("GET", `/x/${i}`)).join("\n"));
    const r = await cmtk(dir, "shadow", "--from", "t.log", "--rate", "1000", "--json");
    await a.close();
    assert.equal(r.status, 2);
    const report = JSON.parse(r.stdout);
    assert.equal(report.replay.errors, 3);
    assert.equal(report.replay.not_sent, 5);
    assert.equal(a.seen.length, 3);
});

test("the shapes: what is redacted, and what is left alone so endpoints stay readable", () => {
    assert.equal(cleanTarget("/api/orders/42?page=2&sort=name").path, "/api/orders/42?page=2&sort=name");
    assert.equal(cleanTarget("/a%20b?x=%20y+z").path, "/a%20b?x=%20y+z", "a value with nothing to hide keeps its exact encoding");
    assert.equal(cleanTarget("/x?name=Jane&page=1").path, "/x?name=REDACTED&page=1");
    assert.equal(cleanTarget("/x?a@b.com").path, "/x?REDACTED");
    assert.equal(cleanTarget("/users/a@b.com/orders").path, "/users/REDACTED/orders");
    assert.equal(cleanTarget("//evil.example.com/x"), undefined);
    assert.equal(cleanTarget("*"), undefined);
    assert.equal(cleanTarget("/x\ny"), undefined);
    assert.equal(cleanTarget("/" + "a".repeat(9000)), undefined);
    assert.equal(cleanTarget("https://h.example.com").path, "/");
    assert.equal(redactText("order 4242424242424241 ok").text, "order 4242424242424241 ok", "fails the card check, so it is an id");
    assert.equal(redactText("card 4242424242424242").text, "card REDACTED");
    assert.deepEqual(redactText("call 07700900123").kinds, ["phone number"]);
    assert.deepEqual(redactText("from 10.1.2.3").kinds, ["IP address"]);
    assert.equal(endpointOf("GET", "/a/12/b/REDACTED/3f2504e0-4f89-11d3-9a0c-0305e82c3301?x=1"), "GET /a/{id}/b/{id}/{id}");
});
