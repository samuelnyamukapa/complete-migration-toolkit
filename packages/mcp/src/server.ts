#!/usr/bin/env node
// The cmtk verbs as MCP tools, so an AI agent drives the toolkit exactly as a person does.
// Sign-off is deliberately not a tool: only a person signs, with `cmtk signoff` at a keyboard.
// Nothing here writes to stdout except the MCP connection.
import fs from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { casesToYaml, compare, describeSignoff, importHar, inside, loadCases, loadManifest, run, signoffState, type Report } from "@cmtk/core";

const server = new McpServer({ name: "cmtk", version: "0.1.1" }, {
    instructions:
        "Complete Migration Toolkit. `cmtk_run` checks one system against each case's expectations; `cmtk_compare` sends each case to the " +
        "reference and the candidate and diffs the answers. Pass `manifest` as the absolute path of cmtk.yaml. Never add drift, scrub " +
        "rules or loosen a match level without a person's agreement, never change an expectation to make a case pass, and never sign: " +
        "a person runs `cmtk signoff` themselves.",
});

const manifestArg = z.string().describe("Absolute path of the project's cmtk.yaml.");

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

function summary(r: Report): string {
    const lines = [`verdict: ${r.verdict}${r.partial ? " (partial run)" : ""}`, r.reason, `cases: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}`];
    for (const k of r.contracts) lines.push(`contract ${k.name}: ${k.result}${k.findings.length ? ` — ${k.findings.map((f) => `${f.what}${f.drift ? ` (drift ${f.drift})` : ""}`).join("; ")}` : ""}`);
    for (const c of r.cases.filter((x) => x.result !== "PASS" && x.result !== "MATCH").slice(0, 40)) {
        const detail = c.failures?.map((f) => `${f.check}: expected ${f.expected}, got ${f.actual}`).join("; ")
            ?? c.differences?.map((d) => `${d.where}: ${d.reference} vs ${d.candidate}${d.drift ? ` (drift ${d.drift})` : ""}`).join("; ")
            ?? c.why ?? "";
        lines.push(`${c.result} ${c.id} [${c.requirement.join(", ") || "no requirement"}]: ${detail}`);
    }
    if (r.suggested_scrubs.length) lines.push(`probably noise (ask a person before scrubbing): ${r.suggested_scrubs.map((s) => s.where).join(", ")}`);
    if (r.unused_drift.length) lines.push(`drift that matched nothing: ${r.unused_drift.join(", ")}`);
    lines.push(`next: ${r.next}`);
    lines.push("The full report is REPORT.md in the evidence folder. Only a person signs it, with `cmtk signoff`.");
    return lines.join("\n");
}

async function guarded<T>(fn: () => Promise<T> | T, render: (v: T) => string) {
    try {
        return text(render(await fn()));
    } catch (err) {
        return text(`cmtk: ${(err as Error).message}`, true);
    }
}

const only = z.array(z.string()).optional().describe("Only these case ids.");
const allowUnsafe = z.boolean().optional().describe("Also run requests that change data. Only after a person agreed, and only when cmtk.yaml allows it too.");

server.registerTool("cmtk_run", {
    description: "Check one system against each case's `expect:` block, and write REPORT.md and REPORT.json with results per requirement.",
    inputSchema: { manifest: manifestArg, target: z.string().optional().describe("Target name; default is default_target."), only, allow_unsafe: allowUnsafe },
}, async (a) => guarded(() => run(loadManifest(a.manifest), { target: a.target, only: a.only, allowUnsafe: a.allow_unsafe }), summary));

server.registerTool("cmtk_compare", {
    description: "Send each case to the reference and the candidate, check the contracts, diff the answers against the drift ledger, and write REPORT.md and REPORT.json.",
    inputSchema: { manifest: manifestArg, only, allow_unsafe: allowUnsafe },
}, async (a) => guarded(() => compare(loadManifest(a.manifest), { only: a.only, allowUnsafe: a.allow_unsafe }), summary));

server.registerTool("cmtk_import_har", {
    description: "Turn HAR recordings into a new case file. Credentials, static files and duplicates are dropped.",
    inputSchema: {
        manifest: manifestArg,
        har: z.array(z.string()).min(1).describe("HAR files inside the project folder."),
        out: z.string().optional().describe("New case file, relative to cmtk.yaml. Default cmtk/cases/har.yaml."),
        include: z.string().optional(),
        exclude: z.string().optional(),
    },
}, async (a) => guarded(() => {
    const m = loadManifest(a.manifest);
    const files = a.har.map((f) => inside(m, f));
    const out = inside(m, a.out ?? "cmtk/cases/har.yaml");
    if (fs.existsSync(out)) throw new Error(`${path.relative(m.root, out)} already exists; choose another \`out\`.`);
    const res = importHar(files, { include: a.include, exclude: a.exclude, existing: loadCases(m) });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, casesToYaml(res.cases), "utf8");
    return { res, out: path.relative(m.root, out) };
}, ({ res, out }) => `added ${res.cases.length} cases to ${out}; skipped ${res.skipped}; dropped headers: ${res.droppedHeaders.join(", ") || "none"}` +
    (res.redacted.length ? `; credential-like values replaced with REDACTED in ${res.redacted.join(", ")}: a person gives those cases test values` : "")));

server.registerTool("cmtk_status", {
    description: "The latest run and compare verdicts, and whether a person has signed each report.",
    inputSchema: { manifest: manifestArg },
}, async (a) => guarded(() => {
    const m = loadManifest(a.manifest);
    const out: string[] = [];
    for (const mode of ["run", "compare"]) {
        const dir = path.join(m.root, m.evidence, mode);
        const f = path.join(dir, "REPORT.json");
        if (!fs.existsSync(f)) continue;
        const r = JSON.parse(fs.readFileSync(f, "utf8")) as Report;
        out.push(`${mode}: ${r.verdict} on ${r.date}, ${describeSignoff(signoffState(dir))}`);
    }
    return out.join("\n") || "No reports yet.";
}, (s) => s));

await server.connect(new StdioServerTransport());
