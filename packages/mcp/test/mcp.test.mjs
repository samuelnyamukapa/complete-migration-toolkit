// The MCP server: the tools an agent gets, and the one it never gets (sign-off).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

test("tools: run, compare, import, status, and no sign-off", async () => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mcp-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  candidate: { base_url: ${url} }\n`);
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: OK, requirement: R1, request: GET /, expect: { json: { '$.ok': { equals: true } } } }\n");

    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    try {
        const names = (await client.listTools()).tools.map((t) => t.name).sort();
        assert.deepEqual(names, ["cmtk_check", "cmtk_commands_for_person", "cmtk_compare", "cmtk_data_cases", "cmtk_data_check", "cmtk_data_make", "cmtk_data_plan", "cmtk_defects", "cmtk_discover", "cmtk_explore_end", "cmtk_explore_finding", "cmtk_explore_request",
            "cmtk_explore_start", "cmtk_import_har", "cmtk_init", "cmtk_proposals", "cmtk_propose", "cmtk_run", "cmtk_status"]);
        assert.ok(!names.some((n) => /sign|review|approve|accept|decide/.test(n)), "no tool lets an agent decide");
        const r = await client.callTool({ name: "cmtk_run", arguments: { manifest: path.join(dir, "cmtk.yaml") } });
        assert.equal(r.isError, false);
        assert.match(r.content[0].text, /verdict: PASS/);
        const s = await client.callTool({ name: "cmtk_status", arguments: { manifest: path.join(dir, "cmtk.yaml") } });
        assert.match(s.content[0].text, /run: PASS on .*, not signed/);
        const bad = await client.callTool({ name: "cmtk_compare", arguments: { manifest: path.join(dir, "cmtk.yaml") } });
        assert.equal(bad.isError, true);
        assert.match(bad.content[0].text, /reference/);
    } finally {
        await client.close();
        srv.close();
    }
});

test("no tool installs an adapter, and an agent can only hand a person the command", async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mcp-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\n");
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: Q1, requirement: R1, surface: queue, request: GET /q, expect: { status: 200 } }\n");
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    try {
        const tools = (await client.listTools()).tools;
        assert.ok(!tools.some((t) => /adapter|install|registry|plugin/i.test(t.name)), "no tool is named for it");
        assert.ok(!tools.some((t) => /registry|pin\b/i.test(JSON.stringify(t.inputSchema))), "no tool takes a registry or a pin");
        const people = await client.callTool({ name: "cmtk_commands_for_person", arguments: { manifest: path.join(dir, "cmtk.yaml") } });
        assert.match(people.content[0].text, /install an adapter: .* adapter add <name>/);
        // A report an agent reads names the gap too.
        const r = await client.callTool({ name: "cmtk_run", arguments: { manifest: path.join(dir, "cmtk.yaml") } });
        assert.match(r.content[0].text, /no adapter for surface queue, so nothing was sent for: Q1/);
        assert.match(r.content[0].text, /verdict: NO EVIDENCE/);
    } finally {
        await client.close();
    }
    // The install code lives in the command, which the server does not import.
    const src = fs.readFileSync(path.join(root, "packages/mcp/src/server.ts"), "utf8");
    assert.ok(!/registry\.js|commitInstall|prepareInstall|complete-migration-toolkit"/.test(src.split("const server =")[0]));
    const core = fs.readdirSync(path.join(root, "packages/core/src")).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(root, "packages/core/src", f), "utf8")).join("\n");
    assert.ok(!/commitInstall|prepareInstall/.test(core), "core, which the server imports, cannot install");
    assert.ok(!Object.keys(JSON.parse(fs.readFileSync(path.join(root, "packages/mcp/package.json"), "utf8")).dependencies).includes("complete-migration-toolkit"));
});

test("the plugin: bundled server and command, one version everywhere, seven skills", async () => {
test("the plugin: bundled server and command, one version everywhere, eight skills", async () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const plugin = path.join(root, "plugin");
    const version = JSON.parse(fs.readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8")).version;
    for (const f of ["plugin.json", ".claude-plugin/plugin.json"]) assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, f), "utf8")).version, version, f);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".github/plugin/marketplace.json"), "utf8")).plugins[0].version, version);
    for (const s of ["test", "plan", "discover", "data", "triage", "explore", "defects", "journey"]) {
        const md = fs.readFileSync(path.join(plugin, "skills", s, "SKILL.md"), "utf8");
        assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: "`), `${s} frontmatter`);
    }
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, "server", "cmtk-mcp.mjs")] }));
    try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        assert.equal(names.length, 19);
        assert.ok(!names.some((n) => /sign|review|approve|accept|decide/.test(n)));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-plugin-"));
        const init = await client.callTool({ name: "cmtk_init", arguments: { manifest: path.join(dir, "cmtk.yaml"), candidate: "http://127.0.0.1:9" } });
        assert.equal(init.isError, false, init.content[0].text);
        const cmds = await client.callTool({ name: "cmtk_commands_for_person", arguments: { manifest: path.join(dir, "cmtk.yaml") } });
        assert.match(cmds.content[0].text, /server[\\/]cmtk\.mjs'? review/);
    } finally {
        await client.close();
    }
});

test("an agent's draft_expect import drafts expectations a person must confirm, and copies nothing else", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mcp-"));
    const manifest = path.join(dir, "cmtk.yaml");
    fs.writeFileSync(manifest, "system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\n");
    fs.writeFileSync(path.join(dir, "w.har"), JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "http://x/b", headers: [] }, response: { status: 200, headers: [{ name: "Content-Type", value: "application/json" }, { name: "X-User", value: "jane" }], content: { text: "jane@example.com" } } }] } }));
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    try {
        const imp = await client.callTool({ name: "cmtk_import_har", arguments: { manifest, har: ["w.har"], draft_expect: true } });
        assert.equal(imp.isError, false, imp.content[0].text);
        assert.match(imp.content[0].text, /drafted an expectation for 1 .*a person confirms one by one/);
        const yaml = fs.readFileSync(path.join(dir, "cmtk/cases/har.yaml"), "utf8");
        assert.match(yaml, /draft: true/);
        assert.match(yaml, /expect_draft: true/);
        assert.doesNotMatch(yaml, /jane/);
        const run = await client.callTool({ name: "cmtk_run", arguments: { manifest } });
        assert.match(run.content[0].text, /draft expectation: review it/);
    } finally {
        await client.close();
    }
});

test("an agent can propose a known issue but never add one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mcp-"));
    const manifest = path.join(dir, "cmtk.yaml");
    fs.writeFileSync(manifest, "system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\n");
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: A, request: GET /, expect: { status: 200 } }\n");
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    try {
        const r = await client.callTool({ name: "cmtk_propose", arguments: { manifest, kind: "known_issue", issue_id: "LEG-1", case: "A", fails: [{ check: "status", actual: "404" }], reason: "legacy defect", agent: "triage", accepted_by: "Jane Smith" } });
        assert.equal(r.isError, false, r.content[0].text);
        assert.match(r.content[0].text, /record known issue "LEG-1"/);
        assert.match(r.content[0].text, /waits for a person/);
        assert.ok(!fs.existsSync(path.join(dir, "cmtk/known-issues.yaml")), "no entry is written");
        const proposals = fs.readFileSync(path.join(dir, "cmtk/proposals.yaml"), "utf8");
        assert.match(proposals, /status: pending/);
        assert.match(proposals, /proposed_by: "agent: triage"/);
        assert.doesNotMatch(proposals, /Jane Smith/, "a name an agent passes never reaches the proposal");
    } finally {
        await client.close();
    }
});

test("an agent's HAR import is drafts, CI can leave drafts out, and the person's commands are quoted", async () => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    // A folder name a shell would otherwise split or expand.
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mcp-")), "it's $(here)");
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    const manifest = path.join(dir, "cmtk.yaml");
    fs.writeFileSync(manifest, `system: s\ntargets:\n  candidate: { base_url: "${url}" }\n`);
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: OK, request: GET /, expect: { status: 200 } }\n");
    fs.writeFileSync(path.join(dir, "w.har"), JSON.stringify({ log: { entries: [{ request: { method: "GET", url: `${url}/b`, headers: [] }, response: { status: 200 } }] } }));

    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    try {
        const imp = await client.callTool({ name: "cmtk_import_har", arguments: { manifest, har: ["w.har"] } });
        assert.equal(imp.isError, false, imp.content[0].text);
        assert.match(imp.content[0].text, /added 1 draft cases/);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/cases/har.yaml"), "utf8"), /draft: true/);

        const all = await client.callTool({ name: "cmtk_run", arguments: { manifest } });
        assert.match(all.content[0].text, /verdict: INCOMPLETE/);
        const ci = await client.callTool({ name: "cmtk_run", arguments: { manifest, accepted_only: true } });
        assert.match(ci.content[0].text, /verdict: PASS/);
        assert.match(ci.content[0].text, /1 draft case was left out/);

        const cmds = (await client.callTool({ name: "cmtk_commands_for_person", arguments: { manifest } })).content[0].text;
        const quoted = process.platform === "win32" ? `'${manifest.replace(/'/g, "''")}'` : `'${manifest.replace(/'/g, "'\\''")}'`;
        assert.ok(cmds.includes(`review --manifest ${quoted}`), cmds);
        const missing = await client.callTool({ name: "cmtk_commands_for_person", arguments: { manifest: path.join(dir, "nope.yaml") } });
        assert.equal(missing.isError, true);
    } finally {
        await client.close();
        srv.close();
    }
});
