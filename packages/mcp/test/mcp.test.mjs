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
        assert.deepEqual(names, ["cmtk_compare", "cmtk_import_har", "cmtk_run", "cmtk_status"]);
        assert.ok(!names.some((n) => /sign/.test(n)));
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
