// The data tools through the real MCP server: an agent proposes, and nothing it passes writes a row or an answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "server.js");

test("cmtk_data_propose, _finding, _traffic and _diff: an agent proposes, and the recipe does not change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-mcp-data-"));
    const manifest = path.join(dir, "cmtk.yaml");
    fs.writeFileSync(manifest, "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    fs.writeFileSync(path.join(dir, "o.json"), JSON.stringify({ type: "object", required: ["a", "b", "n"], properties: { a: { type: "integer", minimum: 0, maximum: 9 }, b: { type: "integer", minimum: 0, maximum: 9 }, n: { type: "string" } } }));
    fs.writeFileSync(path.join(dir, "x.csv"), "id,v\n1,5\n");
    fs.writeFileSync(path.join(dir, "y.csv"), "id,v\n1,6\n");
    fs.writeFileSync(path.join(dir, "t.har"), JSON.stringify({ log: { entries: [{ request: { method: "POST", url: "http://x/o", postData: { text: JSON.stringify({ a: 99, b: 1, n: "Real Person" }) } } }] } }));
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    const call = (name, args) => client.callTool({ name, arguments: { manifest, ...args } });
    try {
        const plan = await call("cmtk_data_plan", { schema: "o.json", id: "o" });
        assert.equal(plan.isError, false, plan.content[0].text);
        assert.match(plan.content[0].text, /Low confidence, \$\.n/);
        const recipe = path.join(dir, "cmtk", "data", "o.yaml");
        const before = fs.readFileSync(recipe, "utf8");
        const p = await call("cmtk_data_propose", { recipe: "o", said_by: "spec", evidence: "RULE-1", reason: "the rule says so", what: "invariant", invariant: { left: "$.b", op: ">=", right: "$.a" }, agent: "test",
            // Not in the tool's shape: these must not reach anything.
            rows: [{ name: "mine" }], expect: { status: 200 } });
        assert.equal(p.isError, false, p.content[0].text);
        assert.match(p.content[0].text, /waits for a person/);
        assert.equal(fs.readFileSync(recipe, "utf8"), before, "nothing is applied by the tool");
        const stored = fs.readFileSync(path.join(dir, "cmtk", "proposals.yaml"), "utf8");
        assert.doesNotMatch(stored, /mine|status: 200/);
        const bad = await call("cmtk_data_propose", { recipe: "o", said_by: "guess", evidence: "x", reason: "y", what: "notional", name: "n", description: "d", over: ["$.a"] });
        assert.equal(bad.isError, true);
        const f = await call("cmtk_data_finding", { recipe: "o", field: "$.a", structure_says: "up to 9", production_says: "99 was sent", question: "Is 99 allowed?" });
        assert.match(f.content[0].text, /Finding F-001/);
        const t = await call("cmtk_data_traffic", { id: "o", har: "t.har", path: "/o" });
        assert.match(t.content[0].text, /\$\.a: Traffic sends what the schema refuses \(maximum\)\. 1 request\./);
        assert.doesNotMatch(t.content[0].text, /Real Person/);
        const d = await call("cmtk_data_diff", { a: "x.csv", b: "y.csv", key: ["id"] });
        assert.match(d.content[0].text, /DIFFERENT[\s\S]*row 1, v: "5" vs "6"/);
    } finally {
        await client.close();
    }
});
