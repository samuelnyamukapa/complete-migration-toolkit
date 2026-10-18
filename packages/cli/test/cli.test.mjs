// The cmtk command end to end: init, import-har, run, compare, status, exit codes, the adapter
// template and its conformance kit, and sign-off refusing anything that is not a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");
// Async on purpose: the test's own HTTP servers must keep answering while cmtk runs.
const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

function server(body) {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "application/json" });
            res.end(req.url === "/" ? body : "{}");
        });
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)) }));
    });
}

test("help and version", async () => {
    const h = await cmtk(os.tmpdir(), "help");
    assert.equal(h.status, 0);
    assert.match(h.stdout, /cmtk run/);
    assert.match((await cmtk(os.tmpdir(), "--version")).stdout, /^\d+\.\d+\.\d+/);
});

test("init, run, compare, status and exit codes", async () => {
    const legacy = await server('{"name":"shop","version":1}');
    const candidate = await server('{"name":"shop","version":2}');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-cli-"));
    try {
        let r = await cmtk(dir, "init", "--legacy", legacy.url, "--candidate", candidate.url, "--system", "shop");
        assert.equal(r.status, 0, r.stderr);
        assert.ok(fs.existsSync(path.join(dir, "cmtk.yaml")));
        assert.equal((await cmtk(dir, "init", "--candidate", candidate.url)).status, 3, "never overwrites");

        r = await cmtk(dir, "run");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /verdict for shop: PASS/);
        assert.match(r.stdout, /Next: a person reviews the report and signs it/);

        r = await cmtk(dir, "compare");
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /NO PARITY/);
        assert.match(r.stdout, /\$\.version: 1 vs 2/);

        r = await cmtk(dir, "compare", "--json");
        assert.equal(JSON.parse(r.stdout).verdict, "NO PARITY");

        r = await cmtk(dir, "status");
        assert.match(r.stdout, /run: PASS on .*not signed/);
        assert.match(r.stdout, /compare: NO PARITY/);

        r = await cmtk(dir, "signoff", "run");
        assert.equal(r.status, 3);
        assert.match(r.stderr, /for a person at a keyboard/);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8"), /\| Name \| _+ \|/, "nothing was signed");

        assert.equal((await cmtk(dir, "run", "--only", "NOPE")).status, 3);
    } finally {
        await legacy.close();
        await candidate.close();
    }
});

test("import-har writes a new case file and never overwrites one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-cli-"));
    assert.equal((await cmtk(dir, "init", "--candidate", "http://127.0.0.1:9")).status, 0);
    fs.writeFileSync(path.join(dir, "rec.har"), JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "http://x/api/a", headers: [{ name: "Cookie", value: "s" }] } }] } }));
    const r = await cmtk(dir, "import-har", "rec.har");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Added 1 cases/);
    assert.match(fs.readFileSync(path.join(dir, "cmtk/cases/har.yaml"), "utf8"), /path: \/api\/a/);
    assert.equal((await cmtk(dir, "import-har", "rec.har")).status, 3);
});

test("adapter new writes a working adapter that passes the conformance kit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-cli-"));
    let r = await cmtk(dir, "adapter", "new", "mailbox");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, "adapters/mailbox/index.mjs")));
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "adapters/mailbox/index.mjs"), "utf8"), /__NAME__/);
    r = await cmtk(dir, "adapter", "check", "mailbox");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /passes the conformance kit/);

    // An adapter that leaks a header value fails the kit.
    const f = path.join(dir, "adapters/mailbox/index.mjs");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("headerNames: Object.keys(headers ?? {}).sort()", "leaked: headers"));
    r = await cmtk(dir, "adapter", "check", "mailbox");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL  SAMPLE-001: no header value appears/);
    assert.equal((await cmtk(dir, "adapter", "new", "http")).status, 3, "http is built in");
});

test("tester commands: init for one system, check, probe, review only at a keyboard, defects", async () => {
    const sys = await server('{"name":"shop"}');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-cli-tester-"));
    try {
        assert.equal((await cmtk(dir, "init", "--candidate", sys.url)).status, 0);
        const yaml = fs.readFileSync(path.join(dir, "cmtk.yaml"), "utf8");
        assert.ok(!/^(match|scrub|contracts|drift):/m.test(yaml), "no migration settings for one system");
        assert.ok(!fs.existsSync(path.join(dir, "cmtk", "drift.yaml")));
        fs.appendFileSync(path.join(dir, "cmtk/cases/example.yaml"), "  - { id: DRAFT-1, request: GET /x, draft: true }\n");
        const c = await cmtk(dir, "check");
        assert.equal(c.status, 0);
        assert.match(c.stdout, /1 draft cases wait for a person/);
        const p = await cmtk(dir, "probe", "candidate", "GET /");
        assert.equal(p.status, 0);
        assert.match(p.stdout, /^200 application\/json\n\{"name":"shop"\}/);
        const post = await cmtk(dir, "probe", "candidate", "POST /");
        assert.equal(post.status, 3);
        assert.match(post.stderr, /only reads/);
        const r = await cmtk(dir, "review");
        assert.equal(r.status, 3);
        assert.match(r.stderr, /person at a keyboard/);
        assert.equal((await cmtk(dir, "run")).status, 2, "a draft keeps the run INCOMPLETE");
        const d = await cmtk(dir, "defects", "run");
        assert.equal(d.status, 0);
        assert.match(d.stdout, /no defects to draft/);
    } finally {
        await sys.close();
    }
});
