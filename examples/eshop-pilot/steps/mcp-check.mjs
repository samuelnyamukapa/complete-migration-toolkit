// The cmtk MCP server, driven by an MCP client on Windows, as an agent would.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pilot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPkg = path.join(pilot, "tools", "complete-migration-toolkit", "packages", "mcp");
const req = createRequire(path.join(mcpPkg, "package.json"));
const { Client } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(req.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);

const client = new Client({ name: "pilot-check", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(mcpPkg, "dist", "server.js")] }));
const results = [];
try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    results.push(["four tools and no sign-off", tools.join(",") === "cmtk_compare,cmtk_import_har,cmtk_run,cmtk_status", tools.join(",")]);
    const status = await client.callTool({ name: "cmtk_status", arguments: { manifest: path.join(pilot, "cmtk.yaml") } });
    results.push(["cmtk_status with a Windows path", !status.isError, status.content[0].text]);
    for (const out of ["D:\\elsewhere\\x.yaml", "\\\\server\\share\\x.yaml", "..\\outside.yaml"]) {
        const r = await client.callTool({ name: "cmtk_import_har", arguments: { manifest: path.join(pilot, "cmtk.yaml"), har: ["recording.har"], out } });
        results.push([`import_har refuses out=${out}`, r.isError === true, r.content[0].text]);
    }
} finally {
    await client.close();
}
for (const [what, ok, detail] of results) console.log(`${ok ? "pass" : "FAIL"}  ${what}  (${String(detail).replace(/\s+/g, " ").slice(0, 160)})`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
