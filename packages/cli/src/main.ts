#!/usr/bin/env node
// cmtk: the Complete Migration Toolkit command. Every command can be run again safely, prints the
// next step, and exits with a code CI can use:
//   0 PASS, PARITY or DRIFT ONLY · 1 FAIL or NO PARITY · 2 INCOMPLETE or NO EVIDENCE · 3 a usage or settings problem
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
    casesToYaml, compare, ConfigError, importHar, loadCases, loadManifest, ManifestError, PathError, processAdapter, readStructured, run,
    STARTER_MANIFEST, type Case, type Report,
} from "@cmtk/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version as string;

const HELP = `cmtk ${VERSION}: test any system from its requirements, and prove a migrated system behaves like the old one.

Usage:
  cmtk init --candidate <url> [--legacy <url>] [--system <name>]   write cmtk.yaml and a first case file
  cmtk import-har <file.har>... [--include <regex>] [--exclude <regex>] [--out <file>]
                                                                    turn recorded traffic into cases
  cmtk run [--target <name>] [--only <id,id>] [--allow-unsafe]      check one system against each case's expect: block
  cmtk compare [--only <id,id>] [--allow-unsafe]                    send each case to the reference and the candidate, and diff
  cmtk status                                                       the latest verdicts
  cmtk signoff run|compare                                          a person signs a report (asks at the keyboard; never for agents)
  cmtk adapter new <name>                                           write a new adapter from the template
  cmtk adapter check <name>                                         the conformance kit for an adapter

Options:
  --manifest <file>   default: cmtk.yaml in the current folder
  --json              print the report as JSON

Exit codes: 0 PASS, PARITY or DRIFT ONLY · 1 FAIL or NO PARITY · 2 INCOMPLETE or NO EVIDENCE · 3 usage or settings problem.
Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit`;

class UsageError extends Error {}

const exitFor = (v: Report["verdict"]) => (v === "PASS" || v === "PARITY" || v === "DRIFT ONLY" ? 0 : v === "FAIL" || v === "NO PARITY" ? 1 : 2);

function printReport(r: Report, json: boolean, manifestRoot: string, evidence: string) {
    if (json) {
        console.log(JSON.stringify(r, null, 2));
        return;
    }
    const counts = Object.entries(r.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ");
    console.log(`${r.mode === "run" ? "Test" : "Comparison"} verdict for ${r.system}: ${r.verdict}`);
    console.log(`Cases: ${counts}`);
    for (const k of r.contracts) console.log(`Contract ${k.name}: ${k.result}${k.findings.length ? ` (${k.findings.length} finding${k.findings.length === 1 ? "" : "s"})` : ""}`);
    for (const c of r.cases.filter((x) => x.result === "FAIL" || x.result === "DIFFERENT" || x.result === "ERROR").slice(0, 10)) {
        const first = c.failures?.[0] ? `${c.failures[0].check}: expected ${c.failures[0].expected}, got ${c.failures[0].actual}`
            : c.differences?.find((d) => !d.drift) ? (() => { const d = c.differences!.find((x) => !x.drift)!; return `${d.where}: ${d.reference} vs ${d.candidate}`; })()
            : c.why ?? "";
        console.log(`  ${c.result} ${c.id} ${c.name}: ${first}`);
    }
    const report = path.relative(process.cwd(), path.join(manifestRoot, evidence, r.mode, "REPORT.md")) || "REPORT.md";
    console.log(`Report: ${report}`);
    console.log(`Next: ${nextStep(r)}`);
}

function nextStep(r: Report): string {
    switch (r.verdict) {
        case "PASS": return "a person reviews the report and signs it with `cmtk signoff run`.";
        case "PARITY":
        case "DRIFT ONLY": return "a person reviews the report and signs it with `cmtk signoff compare`.";
        case "FAIL": return "fix what failed (or correct an expectation with the person who owns the requirement), then `cmtk run` again.";
        case "NO PARITY": return "for each difference: scrub it if it is noise, approve it as drift in the drift ledger (a named person), or fix the candidate. Then `cmtk compare` again.";
        case "INCOMPLETE": return "see why cases were skipped or failed to run, fix that, and run again.";
        default: return "add cases (cmtk/cases/*.yaml, or `cmtk import-har`), then run again.";
    }
}

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            manifest: { type: "string", default: "cmtk.yaml" },
            json: { type: "boolean", default: false },
            target: { type: "string" },
            only: { type: "string" },
            "allow-unsafe": { type: "boolean", default: false },
            candidate: { type: "string" },
            legacy: { type: "string" },
            system: { type: "string" },
            include: { type: "string" },
            exclude: { type: "string" },
            out: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
            version: { type: "boolean", short: "v", default: false },
        },
    });
    const [cmd, ...rest] = positionals;
    if (values.version) { console.log(VERSION); return 0; }
    if (values.help || !cmd || cmd === "help") { console.log(HELP); return 0; }
    const manifestFile = path.resolve(values.manifest!);
    const only = values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

    switch (cmd) {
        case "init": {
            if (!values.candidate) throw new UsageError("`cmtk init` needs --candidate <url> (and --legacy <url> to compare two systems).");
            if (fs.existsSync(manifestFile)) throw new UsageError(`${path.basename(manifestFile)} already exists; edit it instead.`);
            const system = values.system ?? path.basename(path.dirname(manifestFile));
            fs.writeFileSync(manifestFile, STARTER_MANIFEST(system.replace(/[^A-Za-z0-9_.-]/g, "-"), values.legacy, values.candidate), "utf8");
            const root = path.dirname(manifestFile);
            fs.mkdirSync(path.join(root, "cmtk", "cases"), { recursive: true });
            const example = path.join(root, "cmtk", "cases", "example.yaml");
            if (!fs.existsSync(example)) fs.writeFileSync(example, EXAMPLE_CASES, "utf8");
            const drift = path.join(root, "cmtk", "drift.yaml");
            if (!fs.existsSync(drift)) fs.writeFileSync(drift, DRIFT_HEADER, "utf8");
            loadManifest(manifestFile); // proves what was written is valid
            console.log(`Wrote ${path.relative(process.cwd(), manifestFile)}, cmtk/cases/example.yaml and cmtk/drift.yaml.`);
            console.log(`Next: edit the example case for your system, then \`cmtk run\`${values.legacy ? " and `cmtk compare`" : ""}.`);
            return 0;
        }
        case "import-har": {
            if (rest.length === 0) throw new UsageError("`cmtk import-har` needs at least one .har file.");
            const manifest = loadManifest(manifestFile);
            const existing = loadCases(manifest);
            const res = importHar(rest.map((f) => path.resolve(f)), { include: values.include, exclude: values.exclude, existing });
            const out = path.resolve(manifest.root, values.out ?? "cmtk/cases/har.yaml");
            if (fs.existsSync(out)) throw new UsageError(`${path.relative(process.cwd(), out)} already exists; pass --out <new file>.`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, casesToYaml(res.cases), "utf8");
            console.log(`Added ${res.cases.length} cases to ${path.relative(process.cwd(), out)}; skipped ${res.skipped} (static files, filtered or duplicates).`);
            if (res.droppedHeaders.length) console.log(`Dropped these headers from every case: ${res.droppedHeaders.join(", ")}. Credentials come from headers_from_env at run time.`);
            console.log("Next: name each case's requirement, add `expect:` checks for `cmtk run`, then run it.");
            return 0;
        }
        case "run":
        case "compare": {
            const manifest = loadManifest(manifestFile);
            const report = cmd === "run"
                ? await run(manifest, { target: values.target, only, allowUnsafe: values["allow-unsafe"] })
                : await compare(manifest, { only, allowUnsafe: values["allow-unsafe"] });
            printReport(report, values.json!, manifest.root, manifest.evidence);
            return exitFor(report.verdict);
        }
        case "status": {
            const manifest = loadManifest(manifestFile);
            let any = false;
            for (const mode of ["run", "compare"]) {
                const f = path.join(manifest.root, manifest.evidence, mode, "REPORT.json");
                if (!fs.existsSync(f)) continue;
                any = true;
                const r = JSON.parse(fs.readFileSync(f, "utf8")) as Report;
                const signed = /\|\s*Name\s*\|\s*(?!_+\s*\|)[^|\s][^|]*\|/.test(fs.readFileSync(path.join(path.dirname(f), "REPORT.md"), "utf8"));
                console.log(`${mode}: ${r.verdict} on ${r.date}${signed ? ", signed" : ", not signed"}`);
            }
            if (!any) console.log("No reports yet. Next: `cmtk run` or `cmtk compare`.");
            return 0;
        }
        case "signoff": return signoff(manifestFile, rest[0]);
        case "adapter": return adapterCommand(rest, manifestFile);
        default:
            throw new UsageError(`Unknown command ${cmd}. Run \`cmtk help\`.`);
    }
}

async function signoff(manifestFile: string, mode: string | undefined): Promise<number> {
    if (mode !== "run" && mode !== "compare") throw new UsageError("`cmtk signoff` needs `run` or `compare`.");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new UsageError("Sign-off is for a person at a keyboard: run `cmtk signoff` in a terminal yourself. Agents and scripts cannot sign.");
    }
    const manifest = loadManifest(manifestFile);
    const file = path.join(manifest.root, manifest.evidence, mode, "REPORT.md");
    if (!fs.existsSync(file)) throw new UsageError(`There is no ${mode} report yet. Run \`cmtk ${mode}\` first.`);
    const report = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "REPORT.json"), "utf8")) as Report;
    console.log(`${mode} report for ${report.system}: ${report.verdict} (${report.date}).`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const name = (await rl.question("Your full name: ")).trim();
        const role = (await rl.question("Your role: ")).trim();
        const decision = (await rl.question("Decision (accept / accept with conditions / reject): ")).trim().toLowerCase();
        if (!name || !role || !["accept", "accept with conditions", "reject"].includes(decision)) throw new UsageError("Name, role and one of the three decisions are all needed. Nothing was signed.");
        const date = new Date().toISOString().slice(0, 10);
        const cell = (v: string) => v.replace(/\|/g, "\\|");
        let text = fs.readFileSync(file, "utf8");
        text = text.replace(/^\| Name \|.*\|$/m, `| Name | ${cell(name)} |`).replace(/^\| Role \|.*\|$/m, `| Role | ${cell(role)} |`)
            .replace(/^\| Date \|.*\|$/m, `| Date | ${date} |`).replace(/^\| Decision \|.*\|$/m, `| Decision | ${decision} |`);
        fs.writeFileSync(file, text, "utf8");
        console.log(`Signed: ${name}, ${role}, ${decision}, ${date}.`);
        return 0;
    } finally {
        rl.close();
    }
}

async function adapterCommand(args: string[], manifestFile: string): Promise<number> {
    const [sub, name] = args;
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || name === "http") throw new UsageError("Give the adapter a name of letters, digits, '.', '-' and '_' (not http, which is built in).");
    const root = path.dirname(manifestFile);
    const dir = path.join(root, "adapters", name);
    if (sub === "new") {
        if (fs.existsSync(dir)) throw new UsageError(`adapters/${name} already exists.`);
        const tpl = path.join(HERE, "..", "templates", "adapter-node");
        fs.cpSync(tpl, dir, { recursive: true });
        for (const f of ["index.mjs", "README.md", path.join("samples", "cases.yaml")]) {
            const p = path.join(dir, f);
            fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("__NAME__", name), "utf8");
        }
        console.log(`Wrote adapters/${name}/. Next: write run() in index.mjs, then \`cmtk adapter check ${name}\`.`);
        console.log(`Register it in cmtk.yaml:\n  adapters:\n    ${name}: { command: node, args: [adapters/${name}/index.mjs] }`);
        return 0;
    }
    if (sub === "check") return adapterCheck(name, dir, manifestFile);
    throw new UsageError("`cmtk adapter` takes `new <name>` or `check <name>`.");
}

/** The conformance kit: an adapter is usable when every check here passes. */
async function adapterCheck(name: string, dir: string, manifestFile: string): Promise<number> {
    let spec = { command: process.execPath, args: [path.join(dir, "index.mjs")] };
    if (fs.existsSync(manifestFile)) {
        const m = loadManifest(manifestFile);
        if (m.adapters[name]) spec = { command: m.adapters[name]!.command, args: m.adapters[name]!.args ?? [] };
    }
    const samplesFile = path.join(dir, "samples", "cases.yaml");
    const doc = fs.existsSync(samplesFile) ? (readStructured(samplesFile) as { cases?: Case[] }) : {};
    const samples = doc.cases ?? [];
    const secret = `cmtk-check-${Math.random().toString(36).slice(2)}`;
    const target = { name: "check", base_url: "http://127.0.0.1:9" };
    const checks: [string, boolean, string?][] = [];
    const adapter = processAdapter(name, spec, path.dirname(manifestFile));
    try {
        checks.push(["has at least one sample case", samples.length > 0, "add cases to samples/cases.yaml"]);
        for (const c of samples) {
            const a = await adapter.run(c, target, { "X-Cmtk-Check": secret });
            const b = await adapter.run(c, target, { "X-Cmtk-Check": secret });
            const shapeOk = typeof a === "object" && a !== null && (a.error === undefined || typeof a.error === "string");
            checks.push([`${c.id}: answers with an observation`, shapeOk && !a.error, a.error]);
            checks.push([`${c.id}: the same case twice gives the same observation`, JSON.stringify(a) === JSON.stringify(b)]);
            checks.push([`${c.id}: no header value appears in what it reports`, !JSON.stringify(a).includes(secret)]);
        }
    } finally {
        await adapter.close?.();
    }
    for (const [what, ok, hint] of checks) console.log(`${ok ? "pass" : "FAIL"}  ${what}${!ok && hint ? ` (${hint})` : ""}`);
    const failed = checks.filter(([, ok]) => !ok).length;
    console.log(failed ? `${failed} check${failed === 1 ? "" : "s"} failed.` : `Adapter ${name} passes the conformance kit.`);
    return failed ? 1 : 0;
}

const EXAMPLE_CASES = `# Cases for \`cmtk run\` (one system, checked against expectations) and \`cmtk compare\`
# (the same request to the reference and the candidate). Each case says which requirement it answers for.
cases:
  - id: EXAMPLE-001
    name: the home page answers
    requirement: REQ-1
    request: GET /
    expect:
      status: 200
`;

const DRIFT_HEADER = `# Approved drift: differences between the reference and the candidate that a named person accepted.
# Only a person adds an entry. Each needs id, where (from a report), reason and approved_by.
#  - id: DRIFT-001
#    case: "*"                      # or one case id
#    where: "header:content-type"   # a where value from REPORT.md; JSON paths may use [*]
#    reason: charset added to every JSON answer; consumers ignore it
#    approved_by: Jane Smith
#    date: 2026-10-16
drift: []
`;

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
        if (err instanceof UsageError || err instanceof ManifestError || err instanceof ConfigError || err instanceof PathError) console.error(`cmtk: ${err.message}`);
        else console.error(`cmtk: ${err?.stack ?? err}`);
        process.exit(3);
    },
);
