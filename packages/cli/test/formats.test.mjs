// The frozen formats (#33): the schemas accept what the toolkit really reads and writes, refuse what it refuses, and
// docs/FORMATS.md lists what the code does. Examples and real output are checked, not samples written to fit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";

import { loadManifest, STARTER_MANIFEST } from "../../core/dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "main.js");
const SERVER = path.join(ROOT, "packages", "mcp", "dist", "server.js");
const FORMATS = fs.readFileSync(path.join(ROOT, "docs", "FORMATS.md"), "utf8").replace(/\r\n/g, "\n");

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaFiles = fs.readdirSync(path.join(ROOT, "schemas"));
const schemaOf = {};
for (const f of schemaFiles) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", f), "utf8"));
    schemaOf[f] = { doc, check: ajv.compile(doc) };
}
const valid = (schema, value, label) => {
    const s = schemaOf[schema];
    assert.ok(s.check(value), `${label}: ${ajv.errorsText(s.check.errors)}`);
};
const invalid = (schema, value, label) => assert.ok(!schemaOf[schema].check(value), `${label} should be refused`);

const yamlFiles = (dir) => {
    const out = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith(".yaml")) out.push(full);
        }
    };
    walk(dir);
    return out;
};
const read = (f) => YAML.parse(fs.readFileSync(f, "utf8"));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const examples = yamlFiles(path.join(ROOT, "examples"));

const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});
function stand(handler) {
    return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

test("every schema is listed in FORMATS.md and names its own address", () => {
    assert.ok(schemaFiles.length >= 10);
    for (const f of schemaFiles) {
        assert.ok(FORMATS.includes(`../schemas/${f}`), `${f} is not in FORMATS.md`);
        assert.equal(schemaOf[f].doc.$id, `https://raw.githubusercontent.com/samuelnyamukapa/complete-migration-toolkit/main/schemas/${f}`);
        assert.equal(schemaOf[f].doc.$schema, "http://json-schema.org/draft-07/schema#");
    }
});

test("cmtk.yaml: the schema accepts the starters and every example, and knows every key the toolkit reads", () => {
    const manifests = examples.filter((f) => read(f)?.targets);
    assert.ok(manifests.length >= 7, `${manifests.map(rel)}`);
    for (const f of manifests) valid("cmtk.schema.json", read(f), rel(f));
    valid("cmtk.schema.json", YAML.parse(STARTER_MANIFEST("s", "http://localhost:1", "http://localhost:2")), "the migration starter");
    valid("cmtk.schema.json", YAML.parse(STARTER_MANIFEST("s", undefined, "http://localhost:2")), "the tester starter");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-formats-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets: { a: \"http://localhost:1\" }\n");
    const known = Object.keys(schemaOf["cmtk.schema.json"].doc.properties);
    for (const k of Object.keys(loadManifest(path.join(dir, "cmtk.yaml")))) if (k !== "root" && k !== "file") assert.ok(known.includes(k), `${k} is missing from the schema`);
    const doc = fs.readFileSync(path.join(ROOT, "docs", "MANIFEST.md"), "utf8");
    for (const k of known) assert.ok(doc.includes(`\`${k}`), `${k} is missing from MANIFEST.md`);

    invalid("cmtk.schema.json", { targets: { a: "http://h" } }, "no system");
    invalid("cmtk.schema.json", { system: "s" }, "no targets");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "ftp://h" } }, "not http");
    invalid("cmtk.schema.json", { system: "s", targets: { a: { name: "x", base_url: "http://h" } } }, "a target's name in its settings");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "http://h" }, match: "loose" }, "an unknown match level");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "http://h" }, allow_unsafe_methods: "yes" }, "the switch as text");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "http://h" }, mtach: "exact" }, "a mistyped key");
    fs.writeFileSync(path.join(dir, "typo.yaml"), "system: s\ntargets: { a: \"http://localhost:1\" }\nmtach: exact\n");
    assert.equal(loadManifest(path.join(dir, "typo.yaml")).match, "exact", "the toolkit itself ignores an unknown key; only the schema flags it");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "http://h" }, adapters: { http: { command: "x" } } }, "an adapter called http");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "http://h" }, adapters: { q: { args: [] } } }, "an adapter with no command");
    invalid("cmtk.schema.json", { system: "s", targets: { a: "http://h" }, evidence_history: { max_mb: 0 } }, "a limit of nothing");
});

test("case files: the schema accepts every example, and refuses a host, a bad id and a bad check", () => {
    const files = examples.filter((f) => { const d = read(f); return Array.isArray(d?.cases) && !d.targets && !d.fields; });
    assert.ok(files.length >= 8, `${files.map(rel)}`);
    let count = 0;
    for (const f of files) {
        const doc = read(f);
        count += doc.cases.length;
        valid("cases.schema.json", doc, rel(f));
    }
    assert.ok(count > 50, `${count} cases`);
    const c = (over) => ({ cases: [{ id: "A-1", request: "GET /x", ...over }] });
    valid("cases.schema.json", c({}), "a minimal case");
    valid("cases.schema.json", [{ id: "A-1", request: { path: "/x" } }], "a bare list");
    invalid("cases.schema.json", c({ request: "GET http://evil.example.com/x" }), "a host in one line");
    invalid("cases.schema.json", c({ request: { path: "http://evil.example.com/x" } }), "a host");
    invalid("cases.schema.json", c({ request: { path: "//evil.example.com/x" } }), "two slashes");
    invalid("cases.schema.json", c({ id: "a b" }), "a space in an id");
    invalid("cases.schema.json", c({ id: "con" }), "a name Windows reserves");
    invalid("cases.schema.json", c({ match: "loose" }), "an unknown level");
    invalid("cases.schema.json", c({ expect: { json: { "$.a": { sort_of: 1 } } } }), "an unknown check");
    invalid("cases.schema.json", c({ expect: { stauts: 200 } }), "a mistyped key");
    invalid("cases.schema.json", { cases: [{ request: "GET /x" }] }, "no id");
});

test("ledgers: the schema accepts every example, and an entry always names a person", () => {
    const drifts = examples.filter((f) => /drift/.test(path.basename(f)));
    assert.ok(drifts.length >= 3);
    for (const f of drifts) valid("drift.schema.json", read(f) ?? [], rel(f));
    const d = { id: "D", where: "$.a", reason: "r", approved_by: "Jane Smith" };
    valid("drift.schema.json", { drift: [d] }, "an entry");
    invalid("drift.schema.json", { drift: [{ ...d, approved_by: undefined }] }, "no approver");
    invalid("drift.schema.json", { drift: [{ ...d, approved_by: "" }] }, "an empty approver");
    invalid("drift.schema.json", { drift: [{ ...d, approved_by: "agent: claude" }] }, "an agent as approver");

    const k = { id: "LEG-1", case: "A-1", fails: [{ check: "status", expected: "200", actual: 404 }], reason: "r", accepted_by: "Jane Smith" };
    valid("known-issues.schema.json", { known_issues: [k] }, "an entry");
    invalid("known-issues.schema.json", { known_issues: [{ ...k, accepted_by: "Agent Smith" }] }, "an agent");
    invalid("known-issues.schema.json", { known_issues: [{ ...k, case: "*" }] }, "every case");
    invalid("known-issues.schema.json", { known_issues: [{ ...k, fails: [] }] }, "nothing that fails");
    invalid("known-issues.schema.json", { known_issues: [{ ...k, fails: [{ check: "*" }] }] }, "a wildcard check");
});

test("real output validates, and every field it writes is in its schema", async () => {
    let plant = false;
    const a = await stand((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ v: 1, at: "x" })); });
    const b = await stand((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ v: plant ? 2 : 1, at: "y" })); });
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-formats-"));
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  legacy: { base_url: "${a.url}", surfaces: [http] }\n  candidate: { base_url: "${b.url}", surfaces: [http] }\nscrub:\n  json_paths: ["$.at"]\n`);
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: A-1, requirement: R, request: GET /x, expect: { status: 200 } }\n  - { id: A-2, requirement: R, request: GET /y, expect: { status: 500 } }\n  - { id: A-3, request: POST /y }\n");
        fs.writeFileSync(path.join(dir, "cmtk/known-issues.yaml"), 'known_issues:\n  - { id: LEG-1, case: A-2, fails: [{ check: status, expected: "500", actual: 200 }], reason: r, accepted_by: Jane Smith }\n');
        valid("known-issues.schema.json", read(path.join(dir, "cmtk/known-issues.yaml")), "the ledger");

        const reportFields = Object.keys(schemaOf["report.schema.json"].doc.properties);
        for (const mode of ["run", "compare"]) {
            await cmtk(dir, mode);
            const report = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence", mode, "REPORT.json"), "utf8"));
            valid("report.schema.json", report, mode);
            for (const k of Object.keys(report)) assert.ok(reportFields.includes(k), `${k} is missing from the schema`);
        }
        plant = true;
        fs.writeFileSync(path.join(dir, "t.log"), '1.1.1.1 - - [x] "GET /x?email=a%40b.com HTTP/1.1" 200 1\n"GET /y HTTP/1.1"\n');
        for (let i = 0; i < 2; i++) await cmtk(dir, "shadow", "--from", "t.log", "--rate", "1000", "--dated");
        const shadow = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/REPORT.json"), "utf8"));
        valid("shadow-report.schema.json", shadow, "shadow");
        for (const k of Object.keys(shadow)) assert.ok(Object.keys(schemaOf["shadow-report.schema.json"].doc.properties).includes(k), `${k} is missing from the schema`);
        for (const line of fs.readFileSync(path.join(dir, "cmtk/evidence/shadow/capture.jsonl"), "utf8").trim().split("\n")) valid("capture.schema.json", JSON.parse(line), "a capture line");
        assert.equal((await cmtk(dir, "trend", "--mode", "shadow")).status, 0);
        const t = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/trend/shadow/TREND.json"), "utf8"));
        valid("trend.schema.json", t, "trend");
        for (const k of Object.keys(t)) assert.ok(Object.keys(schemaOf["trend.schema.json"].doc.properties).includes(k), `${k} is missing from the schema`);

        invalid("report.schema.json", { tool: "cmtk", mode: "run" }, "a report with no verdict");
        invalid("capture.schema.json", { n: 1, method: "DELETE", path: "/x" }, "a capture that changes data");
        invalid("capture.schema.json", { n: 1, method: "GET", path: "http://evil.example.com/" }, "a capture with a host");
        invalid("shadow-report.schema.json", { ...shadow, verdict: "PARITY" }, "shadow never says parity");
    } finally {
        await a.close();
        await b.close();
    }
});

test("the adapter protocol: the template's real replies and the requests sent to it validate", async () => {
    const tpl = path.join(ROOT, "packages", "cli", "templates", "adapter-node", "index.mjs");
    const p = spawn(process.execPath, [tpl], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    const ask = async (msg) => {
        valid("adapter-request.schema.json", msg, `request ${msg.op}`);
        p.stdin.write(JSON.stringify(msg) + "\n");
        const reply = JSON.parse((await lines.next()).value);
        valid("adapter-reply.schema.json", reply, `reply to ${msg.op}`);
        return reply;
    };
    const target = { name: "legacy", base_url: "http://h" };
    assert.ok((await ask({ op: "describe" })).name);
    await ask({ op: "run", case: { id: "A", request: { method: "GET", path: "/x" } }, target, headers: { "X-Key": "v" } });
    await ask({ op: "reset", target });
    p.stdin.end();
    invalid("adapter-request.schema.json", { op: "delete" }, "an unknown op");
    invalid("adapter-request.schema.json", { op: "run", target }, "run with no case");
    invalid("adapter-reply.schema.json", "text", "a reply that is not an object");
    invalid("adapter-reply.schema.json", { error: 5 }, "an error that is not text");
    for (const op of ["describe", "run", "reset"]) assert.ok(FORMATS.includes(`"op":"${op}"`), op);
});

test("the MCP tools in FORMATS.md are the server's tools, and none can decide or reach a recording", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: "ignore" }));
    try {
        const tools = (await client.listTools()).tools.map((t) => t.name).sort();
        const section = FORMATS.split("## MCP tools")[1].split("\n## ")[0];
        const listed = [...section.matchAll(/^\| `(cmtk_\w+)` \|/gm)].map((m) => m[1]).sort();
        assert.deepEqual(listed, tools);
        assert.ok(!tools.some((n) => /sign|review|approve|accept|decide/.test(n)), "no tool lets an agent decide");
        assert.ok(!tools.some((n) => /shadow|trend/.test(n)), "recordings of real traffic stay away from models");
    } finally {
        await client.close();
    }
});

test("each exit code in FORMATS.md is what the command does", async () => {
    const section = FORMATS.split("## Exit codes")[1].split("\n## ")[0];
    const row = (code) => new RegExp(`^\\| ${code} \\|([^|]*)\\|`, "m").exec(section)[1];
    const src = fs.readFileSync(path.join(ROOT, "packages", "core", "src", "types.ts"), "utf8");
    const verdicts = [...src.split("export type Verdict =")[1].split(";")[0].matchAll(/"([A-Z ]+)"/g)].map((m) => m[1]);
    const shadowSrc = fs.readFileSync(path.join(ROOT, "packages", "core", "src", "shadow.ts"), "utf8");
    verdicts.push(...[...shadowSrc.split("export type ShadowVerdict =")[1].split(";")[0].matchAll(/"([A-Z ]+)"/g)].map((m) => m[1]));
    const listed = [0, 1, 2, 3, 4].flatMap((c) => row(c).split(",").map((v) => v.trim()).filter(Boolean));
    for (const v of verdicts) assert.ok(listed.includes(v), `${v} is not in the table`);

    const s = await stand((req, res) => {
        const status = req.url.startsWith("/ok") ? 200 : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
    });
    const project = (files, targets = `targets:\n  legacy: { base_url: "${s.url}" }\n  candidate: { base_url: "${s.url}" }\n`) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-exit-"));
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\n${targets}`);
        for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
        return dir;
    };
    const ok = { "cmtk/cases/a.yaml": "cases:\n  - { id: A, request: GET /ok, expect: { status: 200 } }\n" };
    try {
        const expect = async (dir, want, verdict, ...args) => {
            const r = await cmtk(dir, ...args);
            assert.equal(r.status, want, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
            if (verdict) { assert.ok(r.stdout.includes(verdict), `${verdict} in ${r.stdout}`); assert.ok(row(want).includes(verdict), `${verdict} under ${want}`); }
        };
        await expect(project(ok), 0, "PASS", "run");
        await expect(project(ok), 0, "PARITY", "compare");
        await expect(project({ "cmtk/cases/a.yaml": "cases:\n  - { id: A, request: GET /no, expect: { status: 200 } }\n" }), 1, "FAIL", "run");
        await expect(project({ "cmtk/cases/a.yaml": "cases:\n  - { id: A, request: GET /ok }\n  - { id: B, request: POST /ok }\n" }), 2, "INCOMPLETE", "compare");
        await expect(project({}), 2, "NO EVIDENCE", "run");
        await expect(project(ok), 3, undefined, "no-such-command");
        await expect(project({ ...ok, "cmtk/known-issues.yaml": 'known_issues:\n  - { id: K, case: B, fails: [{ check: status, expected: "201", actual: 200 }], reason: r, accepted_by: Jane Smith }\n', "cmtk/cases/a.yaml": "cases:\n  - { id: A, request: GET /ok, expect: { status: 200 } }\n  - { id: B, request: GET /ok, expect: { status: 201 } }\n" }), 4, "PASS WITH KNOWN ISSUES", "run");
        await expect(project(ok, `targets:\n  legacy: { base_url: "${s.url}", surfaces: [http, more] }\n  candidate: { base_url: "${s.url}", surfaces: [http] }\nadapters:\n  more: { command: node }\n`), 4, "PARTIAL COMPARISON", "compare");
        await expect(project({ "t.log": '"GET /ok HTTP/1.1"\n' }), 4, "NO UNEXPLAINED DIFFERENCES", "shadow", "--from", "t.log", "--rate", "1000");
        await expect(project(ok), 2, undefined, "trend");
    } finally {
        await s.close();
    }
});

test("a shadow replay takes no notice of the two unsafe switches", async () => {
    const seen = [];
    const s = await stand((req, res) => { seen.push(req.method); res.writeHead(200); res.end("{}"); });
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-switches-"));
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  legacy: { base_url: "${s.url}" }\n  candidate: { base_url: "${s.url}" }\nallow_unsafe_methods: true\n`);
        fs.writeFileSync(path.join(dir, "t.log"), '"DELETE /x HTTP/1.1"\n"POST /y HTTP/1.1"\n"GET /z HTTP/1.1"\n');
        const r = await cmtk(dir, "shadow", "--from", "t.log", "--rate", "1000", "--allow-unsafe", "--json");
        assert.deepEqual(seen, ["GET", "GET"]);
        assert.equal(JSON.parse(r.stdout).capture.dropped_total, 2);
    } finally {
        await s.close();
    }
});
