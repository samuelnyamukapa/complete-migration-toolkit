// Findings 19 and 20 of the review of 0.6: recordings and logs hold credentials and personal data in shapes and names the
// first version missed. Each value below must reach no case, no capture file, no report and no request.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { cleanTarget, importHar, loadManifest, looksPersonal, looksSecret, shadow } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-shapes-"));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const server = (fn) => new Promise((resolve) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdEFGHijkl";

function har(entries) {
    const dir = tmp();
    const file = path.join(dir, "a.har");
    fs.writeFileSync(file, JSON.stringify({ log: { entries: entries.map((request) => ({ request })) } }));
    return importHar([file]);
}

test("HAR: a JWT in an ordinary query value is replaced", () => {
    const r = har([{ method: "GET", url: `http://x/search?q=${JWT}&page=2` }]);
    const yaml = JSON.stringify(r.cases);
    assert.ok(!yaml.includes("eyJhbGci"), yaml);
    assert.match(r.cases[0].request.path, /q=REDACTED&page=2/);
    assert.deepEqual(r.redacted, [r.cases[0].id]);
});

test("HAR: a key-shaped value after a semicolon, and in a path, is replaced", () => {
    const r = har([{ method: "GET", url: `http://x/reset/${JWT}/done` }, { method: "GET", url: "http://x/a?b=sk_live_ABCDEF123456" }]);
    const yaml = JSON.stringify(r.cases);
    assert.ok(!yaml.includes("eyJhbGci") && !yaml.includes("sk_live_"), yaml);
});

test("HAR: a header that looks like auth goes, by its name or by what it holds; ordinary ones stay", () => {
    const r = har([{ method: "GET", url: "http://x/a", headers: [
        { name: "X-Session", value: "abc123" },
        { name: "X-Session-Id", value: "abc124" },
        { name: "X-Auth-User", value: "abc125" },
        { name: "X-Custom", value: `Bearer ${JWT}` },
        { name: "X-Other", value: "Basic dXNlcjpwYXNz" },
        { name: "X-Plain", value: "sk_live_ABCDEF123456" },
        { name: "Accept", value: "application/json" },
        { name: "X-Tenant", value: "acme" },
    ] }]);
    assert.deepEqual(Object.keys(r.cases[0].request.headers).sort(), ["Accept", "X-Tenant"]);
    for (const h of ["x-session", "x-session-id", "x-auth-user", "x-custom", "x-other", "x-plain"]) assert.ok(r.droppedHeaders.includes(h), h);
});

test("HAR: JSON bodies lose values shaped like a key and short password names; the rest stays exact", () => {
    const r = har([{ method: "POST", url: "http://x/a", postData: { mimeType: "application/json", text: `{"data":"sk_live_ABCDEF","pw":"hunter2","nested":{"t":"${JWT}"},"qty":1.50,"note":"plain words"}` } }]);
    const body = r.cases[0].request.body;
    for (const s of ["sk_live_", "hunter2", "eyJhbGci"]) assert.ok(!body.includes(s), body);
    assert.ok(body.includes("1.50") && body.includes("plain words"), body);
});

test("HAR: forms and other formats are held to the same shapes", () => {
    const form = har([{ method: "POST", url: "http://x/f", postData: { mimeType: "application/x-www-form-urlencoded", text: `a=${JWT}&b=2` } }]);
    assert.ok(!form.cases[0].request.body.includes("eyJhbGci"));
    assert.match(form.cases[0].request.body, /b=2/);
    const xml = har([{ method: "POST", url: "http://x/g", postData: { mimeType: "text/xml", text: `<a><b>${JWT}</b><c>keep</c></a>` } }]);
    assert.ok(!xml.cases[0].request.body.includes("eyJhbGci"));
    assert.match(xml.cases[0].request.body, /keep/);
});

test("names that hold a credential: sas, ticket, passphrase, pw", () => {
    for (const n of ["sas", "ticket", "passphrase", "pw", "sas_token", "login_ticket"]) assert.equal(looksSecret(n), true, n);
    for (const n of ["page", "sort", "ticketing_enabled", "status"]) assert.equal(looksSecret(n), false, n);
});

test("names that hold a person: customerName, guest", () => {
    for (const n of ["customerName", "customer_name", "guest", "guestName", "patient", "recipient", "clientName"]) assert.equal(looksPersonal(n), true, n);
    for (const n of ["hostname", "filename", "page", "guests_count", "customerId"]) assert.equal(looksPersonal(n), false, n);
});

test("a person's name in a path is replaced after a collection of people; numeric ids and plain routes stay", () => {
    assert.equal(cleanTarget("/users/jane.smith/profile").path, "/users/REDACTED/profile");
    assert.equal(cleanTarget("/customers/jsmith").path, "/customers/REDACTED");
    assert.equal(cleanTarget("/users/42/profile").path, "/users/42/profile");
    assert.equal(cleanTarget("/users/me").path, "/users/me");
    assert.equal(cleanTarget("/users").path, "/users");
    assert.equal(cleanTarget("/users/search?page=1").path, "/users/search?page=1");
    assert.equal(cleanTarget("/products/blue-mug").path, "/products/blue-mug");
});

test("query values after a semicolon are cleaned like any other", () => {
    const c = cleanTarget("/a?x=1;token=abc123;email=jane@example.com");
    assert.doesNotMatch(c.path, /abc123|jane/);
    assert.match(c.path, /^\/a\?x=1;token=REDACTED;email=REDACTED$/);
});

test("shadow: an email as a JSON key reaches no report and no output; every planted value stays out of what is sent and kept", async () => {
    const answer = (extra) => (req, res) => {
        seen.push(req.url);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ users: { "jane.doe@example.com": extra }, phones: { "+447700900123": extra } }));
    };
    const seen = [];
    const [a, b] = [await server(answer(1)), await server(answer(2))];
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${a.url}" }\n  candidate: { base_url: "${b.url}" }\nreference: legacy\n`);
    write(dir, "t.jsonl", [
        '{"method":"GET","uri":"/one?customerName=Jane%20Doe"}',
        '{"method":"GET","uri":"/two?guest=John"}',
        '{"method":"GET","uri":"/users/jane.smith/profile"}',
        '{"method":"GET","uri":"/three?ticket=tkt-999&sas=sv123&passphrase=open-sesame"}',
    ].join("\n"));
    const logged = [];
    try {
        const r = await shadow(loadManifest(path.join(dir, "cmtk.yaml")), { from: ["t.jsonl"].map((f) => path.join(dir, f)), rate: 1000, note: (l) => logged.push(l) });
        const planted = ["jane.doe@example.com", "+447700900123", "Jane", "John", "jane.smith", "tkt-999", "sv123", "open-sesame"];
        const files = fs.readdirSync(path.join(dir, "cmtk/evidence"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
        assert.ok(files.length);
        for (const f of files) for (const p of planted) assert.ok(!fs.readFileSync(f, "utf8").includes(p), `${path.basename(f)} holds ${p}`);
        for (const p of planted) assert.ok(!JSON.stringify(r).includes(p), `the report holds ${p}`);
        for (const u of seen) for (const p of ["Jane", "John", "jane.smith", "tkt-999", "sv123", "open-sesame"]) assert.ok(!u.includes(p), u);
        assert.ok(r.endpoints.some((e) => e.differences.length), "the difference is still reported");
    } finally {
        await a.close(); await b.close();
    }
});

test("shadow: every spelling of a method override is dropped and counted, and neither system gets it", async () => {
    const seen = [];
    const s = await server((req, res) => { seen.push(req.url); res.end("{}"); });
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${s.url}" }\n  candidate: { base_url: "${s.url}" }\nreference: legacy\n`);
    write(dir, "t.log", ['"GET /a?a=1;_method=DELETE HTTP/1.1"', '"GET /b?_HttpMethod=DELETE HTTP/1.1"', '"GET /c?method=DELETE HTTP/1.1"', '"GET /d?method=sum HTTP/1.1"'].join("\n"));
    try {
        await shadow(loadManifest(path.join(dir, "cmtk.yaml")), { from: [path.join(dir, "t.log")], rate: 1000, note: () => {} });
        assert.deepEqual([...new Set(seen)], ["/d?method=sum"]);
    } finally {
        await s.close();
    }
});
