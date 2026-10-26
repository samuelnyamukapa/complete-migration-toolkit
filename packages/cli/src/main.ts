#!/usr/bin/env node
// cmtk: the Complete Migration Toolkit command. Every command can be run again safely, prints the
// next step, and exits with a code CI can use:
//   0 PASS, PARITY or DRIFT ONLY · 1 FAIL or NO PARITY · 2 INCOMPLETE or NO EVIDENCE · 3 a usage or settings problem
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import YAML from "yaml";

import {
    acceptDraft, adaptersFor, casesToYaml, check, compare, ConfigError, decideProposal, describeCheck, describeDiscovery, describeProposal, discover, describeSignoff, draftDefects,
    envHeaders, importHar, inside, loadCases, loadManifest, loadProposals, ManifestError, PathError, processAdapter, readStructured, recordSignoff,
    initProject, rejectDraft, run, SAFE_METHODS, signoffState, SignoffError, type Case, type Report,
    planRecipe, makeData, makeRows, loadRecipe, checkQuotas, isHappy, writeCases, describeLeftOut, FAKER_VERSION, type DataFormat,
} from "@cmtk/core";

// Node 22 before 22.17 flags fs.globSync and path.matchesGlob as experimental and prints a warning
// on every run. They behave as documented, so keep that one warning out of what people read.
process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.error(`${w.name}: ${w.message}`); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A bundled copy (the plugin's server/cmtk.mjs) has the version built in; otherwise read it from package.json.
declare const __CMTK_VERSION__: string | undefined;
const VERSION = typeof __CMTK_VERSION__ === "string" ? __CMTK_VERSION__ : (JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version as string);

const HELP = `cmtk ${VERSION}: test any system from its requirements, and prove a migrated system behaves like the old one.

Usage:
  cmtk init --candidate <url> [--legacy <url>] [--system <name>]   write cmtk.yaml and a first case file
  cmtk import-har <file.har>... [--include <regex>] [--exclude <regex>] [--out <file>]
                                                                    turn recorded traffic into cases
  cmtk run [--target <name>] [--only <id,id>] [--allow-unsafe] [--accepted-only]
                                                                    check one system against each case's expect: block
                                                                    (--accepted-only leaves draft cases out, as in CI)
  cmtk compare [--only <id,id>] [--allow-unsafe]                    send each case to the reference and the candidate, and diff
  cmtk status                                                       the latest verdicts
  cmtk check                                                        check settings and case files; sends nothing
  cmtk discover [--assembly <dll>]... [--rea-json <file>]... [--config <file>]... [--har <file>]... [--topology <file>]... [--fresh]
                                                                    list every boundary of the legacy system, and flag the uncovered ones
                                                                    (--assembly needs REA: npm install --global rea-agents)
  cmtk review                                                       a person accepts or rejects draft cases and proposals
  cmtk defects run|compare                                          draft defects from the latest report
  cmtk probe <target> "GET /path" [--surface <name>]                send one read-only request and show the answer
  cmtk data plan --schema <file> [--operation "POST /path"] [--id <name>] [--seed <n>] [--clock <iso>] [--locale <loc>]
                                                                    compile a test-data recipe from a JSON Schema or an OpenAPI operation
  cmtk data make <id> [--format json,csv,xlsx]                      regenerate the rows from the recipe, check them, write the files
  cmtk data check <id>                                              check a recipe's rows and quotas without writing files
  cmtk data cases <id> [--path /api/x] [--requirement <id>] [--out <file>]
                       [--encoding form] [--before-get /page] [--take field=selector]...
                       [--expect-valid 302] [--expect-invalid 200] [--rows valid|invalid]
                       [--only-rows name,name] [--except-rows name,name]
                                                                    one draft case per row, each sending its row from a file
  cmtk signoff run|compare                                          a person signs a report, at a terminal (never an agent)
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
    console.log(r.reason);
    console.log(`Next: ${r.next}`);
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
            "accepted-only": { type: "boolean", default: false },
            candidate: { type: "string" },
            legacy: { type: "string" },
            system: { type: "string" },
            include: { type: "string" },
            exclude: { type: "string" },
            out: { type: "string" },
            surface: { type: "string" },
            assembly: { type: "string", multiple: true },
            "rea-json": { type: "string", multiple: true },
            config: { type: "string", multiple: true },
            har: { type: "string", multiple: true },
            topology: { type: "string", multiple: true },
            fresh: { type: "boolean", default: false },
            schema: { type: "string" },
            operation: { type: "string" },
            id: { type: "string" },
            seed: { type: "string" },
            clock: { type: "string" },
            locale: { type: "string" },
            format: { type: "string" },
            path: { type: "string" },
            method: { type: "string" },
            requirement: { type: "string" },
            encoding: { type: "string" },
            "before-get": { type: "string" },
            take: { type: "string", multiple: true },
            "expect-valid": { type: "string" },
            "expect-invalid": { type: "string" },
            rows: { type: "string" },
            "only-rows": { type: "string" },
            "except-rows": { type: "string" },
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
            const written = initProject(manifestFile, { candidate: values.candidate, legacy: values.legacy, system: values.system });
            console.log(`Wrote ${written.map((f) => path.relative(process.cwd(), f)).join(", ")}.`);
            console.log(`Next: edit the example case for your system, then \`cmtk run\`${values.legacy ? " and `cmtk compare`" : ""}.`);
            return 0;
        }
        case "import-har": {
            if (rest.length === 0) throw new UsageError("`cmtk import-har` needs at least one .har file.");
            const manifest = loadManifest(manifestFile);
            const existing = loadCases(manifest);
            const res = importHar(rest.map((f) => path.resolve(f)), { include: values.include, exclude: values.exclude, existing });
            const out = inside(manifest, values.out ?? "cmtk/cases/har.yaml");
            if (fs.existsSync(out)) throw new UsageError(`${path.relative(process.cwd(), out)} already exists; pass --out <new file>.`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, casesToYaml(res.cases), "utf8");
            console.log(`Added ${res.cases.length} cases to ${path.relative(process.cwd(), out)}; skipped ${res.skipped} (static files, filtered or duplicates).`);
            if (res.droppedHeaders.length) console.log(`Dropped these headers from every case: ${res.droppedHeaders.join(", ")}. Credentials come from headers_from_env at run time.`);
            if (res.redacted.length) console.log(`Replaced credential-like values with REDACTED in ${res.redacted.length} case${res.redacted.length === 1 ? "" : "s"} (${res.redacted.slice(0, 10).join(", ")}${res.redacted.length > 10 ? ", …" : ""}). Give those cases test values before they run.`);
            console.log("Next: name each case's requirement, add `expect:` checks for `cmtk run`, then run it.");
            return 0;
        }
        case "run":
        case "compare": {
            const manifest = loadManifest(manifestFile);
            const report = cmd === "run"
                ? await run(manifest, { target: values.target, only, allowUnsafe: values["allow-unsafe"], acceptedOnly: values["accepted-only"] })
                : await compare(manifest, { only, allowUnsafe: values["allow-unsafe"], acceptedOnly: values["accepted-only"] });
            printReport(report, values.json!, manifest.root, manifest.evidence);
            return exitFor(report.verdict);
        }
        case "status": {
            const manifest = loadManifest(manifestFile);
            let any = false;
            for (const mode of ["run", "compare"]) {
                const dir = path.join(manifest.root, manifest.evidence, mode);
                const f = path.join(dir, "REPORT.json");
                if (!fs.existsSync(f)) continue;
                any = true;
                const r = JSON.parse(fs.readFileSync(f, "utf8")) as Report;
                console.log(`${mode}: ${r.verdict} on ${r.date}${r.settings ? ` from ${r.settings.manifest}` : ""}, ${describeSignoff(signoffState(dir))}`);
            }
            if (!any) console.log("No reports yet. Next: `cmtk run` or `cmtk compare`.");
            return 0;
        }
        case "signoff": return signoff(manifestFile, rest[0]);
        case "review": return review(manifestFile);
        case "check": {
            console.log(describeCheck(check(loadManifest(manifestFile))));
            return 0;
        }
        case "defects": {
            const mode = rest[0];
            if (mode !== "run" && mode !== "compare") throw new UsageError("`cmtk defects` needs `run` or `compare`.");
            const m = loadManifest(manifestFile);
            const { file, drafts } = draftDefects(m, mode);
            console.log(drafts.length ? `Drafted ${drafts.length} defect${drafts.length === 1 ? "" : "s"} in ${path.relative(process.cwd(), path.join(m.root, file))}.` : `Nothing failed, so there are no defects to draft (${file}).`);
            if (drafts.length) console.log("Next: a person checks each draft and files it in your tracker.");
            return 0;
        }
        case "discover": {
            const m = loadManifest(manifestFile);
            const { file, discovery } = discover(m, { assemblies: values.assembly, reaJson: values["rea-json"], configs: values.config, har: values.har, topology: values.topology, fresh: values.fresh });
            if (values.json) { console.log(JSON.stringify(discovery, null, 2)); return 0; }
            console.log(`Boundaries for ${discovery.system}: ${describeDiscovery(discovery)}`);
            for (const b of discovery.boundaries.filter((x) => !x.covered_by)) console.log(`  uncovered ${b.kind} ${b.direction}: ${b.name}${b.where ? ` (${b.where})` : ""}`);
            console.log(`Inventory: ${path.relative(process.cwd(), path.join(m.root, file))}`);
            console.log(discovery.boundaries.some((x) => !x.covered_by) ? "Next: for each uncovered kind, add an adapter (`cmtk adapter new <name>`, then `covers:` in cmtk.yaml) or have a person record why it is out of scope." : "Next: write cases for each boundary, then `cmtk compare`.");
            return 0;
        }
        case "probe": return probe(manifestFile, rest, values.surface);
        case "adapter": return adapterCommand(rest, manifestFile);
        case "data": return dataCommand(rest, manifestFile, values);
        default:
            throw new UsageError(`Unknown command ${cmd}. Run \`cmtk help\`.`);
    }
}

async function signoff(manifestFile: string, mode: string | undefined): Promise<number> {
    if (mode !== "run" && mode !== "compare") throw new UsageError("`cmtk signoff` needs `run` or `compare`.");
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new UsageError("Sign-off is for a person at a keyboard: run `cmtk signoff` in a terminal yourself. Agents and scripts do not sign.");
    }
    const manifest = loadManifest(manifestFile);
    const dir = path.join(manifest.root, manifest.evidence, mode);
    const json = path.join(dir, "REPORT.json");
    if (!fs.existsSync(json)) throw new UsageError(`There is no ${mode} report yet. Run \`cmtk ${mode}\` first.`);
    const report = JSON.parse(fs.readFileSync(json, "utf8")) as Report;
    console.log(`${mode} report for ${report.system}: ${report.verdict} (${report.date}). ${report.reason}`);
    if (report.settings) {
        const st = report.settings;
        const scrubs = [...st.scrub.json_paths, ...st.scrub.xml_ignore.map((e) => `XML ${e}`), ...st.scrub.regex.map((x) => `regex ${x.pattern}`)];
        console.log(`Produced from ${st.manifest}.${mode === "compare" ? ` Hidden by scrubs: ${scrubs.length ? scrubs.join(", ") : "nothing"}. Approved drift: ${st.drift_entries} entries in ${st.drift_file}.` : ""}`);
    } else console.log("This report does not record which settings produced it (made by cmtk before 0.2.0).");
    console.log(`Read it first: ${path.relative(process.cwd(), path.join(dir, "REPORT.md"))}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const name = await rl.question("Your full name: ");
        const role = await rl.question("Your role: ");
        const decision = await rl.question("Decision (accept / accept with conditions / reject): ");
        const s = recordSignoff(dir, { name, role, decision }, new Date().toISOString().slice(0, 10), manifest);
        console.log(`Signed: ${s.name}, ${s.role}, ${s.decision}, ${s.date}. Evidence fingerprint ${s.evidence_sha256.slice(0, 12)}…`);
        return 0;
    } finally {
        rl.close();
    }
}

/** A person at the keyboard accepts or rejects each draft case and each proposal. Agents can propose; only this decides. */
async function review(manifestFile: string): Promise<number> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new UsageError("Review is for a person at a keyboard: run `cmtk review` in a terminal yourself. Agents propose; people decide.");
    }
    const m = loadManifest(manifestFile);
    const drafts = loadCases(m).filter((c) => c.draft);
    const pending = loadProposals(m).filter((p) => p.status === "pending");
    if (!drafts.length && !pending.length) { console.log("Nothing to review: no draft cases and no proposals."); return 0; }
    console.log(`${drafts.length} draft case${drafts.length === 1 ? "" : "s"} and ${pending.length} proposal${pending.length === 1 ? "" : "s"} to review.`);
    console.log("For each: a = accept, r = reject (you give a reason), s = skip for now, q = stop.");
    console.log("A = accept this draft and every remaining draft in the same file (you confirm first): for the cases a recipe generated, once you have read the recipe.\n");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const date = new Date().toISOString().slice(0, 10);
    const tally = { accepted: 0, rejected: 0, skipped: 0, failed: 0 };
    let stopped = false;
    rl.on("close", () => { stopped = true; });
    try {
        const name = (await rl.question("Your full name: ")).trim();
        if (!name || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new UsageError("A name of up to 100 characters is needed: it goes on everything you accept or reject. Nothing was changed.");
        const ask = async (all = false): Promise<"a" | "A" | "r" | "s" | "q"> => {
            for (;;) {
                const raw = (await rl.question(`Accept, reject, skip or quit? [a/${all ? "A/" : ""}r/s/q] `)).trim();
                if (all && raw === "A") return "A";
                const v = raw.toLowerCase();
                if (["a", "r", "s", "q"].includes(v)) return v as "a" | "r" | "s" | "q";
            }
        };
        const done = new Set<string>();
        const items: (() => Promise<boolean>)[] = [
            ...drafts.map((c) => async () => {
                if (done.has(c.id)) return true;
                const { file: _file, draft: _d, ...shown } = c;
                console.log(`\nDraft case ${c.id} in ${c.file}:\n${YAML.stringify(shown, { lineWidth: 0 }).trimEnd().replace(/^/gm, "  ")}`);
                const rest = drafts.filter((d) => d.file === c.file && !done.has(d.id));
                let v = await ask(rest.length > 1);
                while (v === "A") {
                    const yes = (await rl.question(`Accept all ${rest.length} remaining drafts in ${c.file}, ${c.id} included? Type yes to confirm: `)).trim().toLowerCase();
                    if (yes === "yes") break;
                    console.log("  nothing changed; asking again for this one");
                    v = await ask(true);
                }
                if (v === "q") return false;
                if (v === "A") {
                    for (const d of rest) {
                        try { acceptDraft(m, d.id, name, date, d); tally.accepted++; console.log(`  accepted ${d.id}`); }
                        catch (err) { console.log(`  ${d.id} not changed: ${(err as Error).message}`); tally.failed++; }
                        done.add(d.id);
                    }
                    return true;
                }
                done.add(c.id);
                if (v === "a") { acceptDraft(m, c.id, name, date, c); tally.accepted++; }
                if (v === "r") { rejectDraft(m, c.id, name, date, (await rl.question("Why reject it? ")).trim() || "no reason given"); tally.rejected++; }
                if (v === "s") tally.skipped++;
                return true;
            }),
            ...pending.map((p) => async () => {
                console.log(`\n${describeProposal(p)}`);
                const v = await ask();
                if (v === "q") return false;
                if (v === "a") { const d = decideProposal(m, p.id, true, name, date, undefined, p); console.log(`  applied: ${d.applied}`); tally.accepted++; }
                if (v === "r") { decideProposal(m, p.id, false, name, date, (await rl.question("Why reject it? ")).trim() || "no reason given", p); tally.rejected++; }
                if (v === "s") tally.skipped++;
                return true;
            }),
        ];
        for (const item of items) {
            if (stopped) break;
            try {
                if (!(await item())) break;
            } catch (err) {
                if (stopped || (err as Error).name === "AbortError") break;
                // One item that can't be applied never ends the review: say why, change nothing for it, and go on.
                console.log(`  not changed: ${(err as Error).message}`);
                tally.failed++;
            }
        }
    } catch (err) {
        if (!(stopped || (err as Error).name === "AbortError")) throw err;
    } finally {
        rl.close();
    }
    console.log(`\n${stopped ? "Stopped. " : ""}Accepted ${tally.accepted}, rejected ${tally.rejected}, skipped ${tally.skipped}${tally.failed ? `, ${tally.failed} could not be applied` : ""}. Next: \`cmtk check\`, then run again.`);
    return 0;
}

/** One read-only request to a target, shown in full: for a person looking around. */
async function probe(manifestFile: string, args: string[], surface = "http"): Promise<number> {
    const [targetName, line] = args;
    const m = loadManifest(manifestFile);
    const target = targetName ? m.targets[targetName] : undefined;
    if (!target) throw new UsageError(`Name a target: ${Object.keys(m.targets).join(", ")}. For example: cmtk probe ${Object.keys(m.targets)[0]} "GET /"`);
    const r = /^([A-Za-z]+)\s+(\/(?!\/)\S*)$/.exec(String(line ?? "").trim());
    if (!r) throw new UsageError('Write the request as one argument, such as "GET /api/items".');
    const method = r[1]!.toUpperCase();
    if (!SAFE_METHODS.has(method)) throw new UsageError(`probe only reads: use GET, HEAD or OPTIONS, not ${method}.`);
    const adapters = adaptersFor(m);
    try {
        const o = await adapters.get(surface).run({ id: "probe", request: { method, path: r[2]!, headers: {}, body: null }, surface }, target, envHeaders(m));
        if (o.error) { console.log(`Error: ${o.error}`); return 2; }
        console.log(`${o.status ?? ""} ${o.headers?.["content-type"] ?? ""}`.trim());
        if (o.effects) console.log(`effects: ${JSON.stringify(o.effects)}`);
        const body = o.body ?? "";
        console.log(body.length > 4000 ? `${body.slice(0, 4000)}\n… ${body.length - 4000} more characters` : body);
        return 0;
    } finally {
        await adapters.closeAll();
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
    const adapter = processAdapter(name, { ...spec, timeout_s: 60 }, path.dirname(manifestFile));
    try {
        const d = (await adapter.describe!().catch((err: Error) => ({ error: err.message }))) as { name?: unknown; kinds?: unknown; error?: string };
        checks.push(["answers describe with a name and its kinds", typeof d?.name === "string" && Array.isArray(d?.kinds), d?.error ?? 'reply {"name":"…","kinds":["…"],"settings":[]}']);
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

main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
        if (err instanceof UsageError || err instanceof ManifestError || err instanceof ConfigError || err instanceof PathError || err instanceof SignoffError) console.error(`cmtk: ${err.message}`);
        else console.error(`cmtk: ${err?.stack ?? err}`);
        process.exit(3);
    },
);

async function dataCommand(args: string[], manifestFile: string, v: Record<string, any>): Promise<number> {
    const [sub, id] = args;
    const m = loadManifest(manifestFile);
    const generators = { cmtk: VERSION, "@faker-js/faker": FAKER_VERSION };
    switch (sub) {
        case "plan": {
            if (!v.schema) throw new UsageError("`cmtk data plan` needs --schema <file>: a JSON Schema or an OpenAPI document inside the project.");
            const seed = v.seed === undefined ? undefined : Number(v.seed);
            const { file, recipe } = planRecipe(m, { schema: v.schema, operation: v.operation, id: v.id, seed, clock: v.clock, locale: v.locale, generators });
            const happy = recipe.rows.filter(isHappy).length;
            const byTechnique = Object.entries(recipe.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.technique]: (acc[r.technique] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(", ");
            console.log(`Recipe ${recipe.id}: ${recipe.fields.length - 1} fields, ${recipe.rows.length} rows (${byTechnique}); ${happy} happy paths (${Math.round((happy / recipe.rows.length) * 100)}%).`);
            for (const n of recipe.notes ?? []) console.log(`  ${n}`);
            for (const f of recipe.fields.filter((x) => x.note && /can't be generated|not honoured/.test(x.note))) console.log(`  ${f.path}: ${f.note}`);
            console.log(`Written: ${file}`);
            console.log(`Next: read it, then \`cmtk data make ${recipe.id}\` to see the rows.`);
            return 0;
        }
        case "make": {
            if (!id) throw new UsageError("`cmtk data make` needs the recipe id.");
            const formats = (v.format ? String(v.format).split(",") : ["json", "csv"]).map((f: string) => f.trim().toLowerCase());
            for (const f of formats) if (!["json", "csv", "xlsx"].includes(f)) throw new UsageError(`Unknown format ${f}: use json, csv or xlsx.`);
            const { folder, manifest } = await makeData(m, id, { formats: formats as DataFormat[], generators });
            console.log(`Made ${manifest.rows} rows (${manifest.valid_rows} valid, ${Math.round(manifest.quotas.happy_share * 100)}% happy paths) in ${folder}/: ${Object.keys(manifest.files).filter((f) => !f.startsWith("rows/")).join(", ")}.`);
            console.log(`Every valid row validates against the schema, and every invalid row breaks it where it says.`);
            if (manifest.quotas.problems.length) { console.log(`Quotas not met: ${manifest.quotas.problems.join("; ")}.`); return 2; }
            console.log(`Next: \`cmtk data cases ${id} --path /api/...\` to draft one case per row.`);
            return 0;
        }
        case "check": {
            if (!id) throw new UsageError("`cmtk data check` needs the recipe id.");
            const { recipe } = loadRecipe(m, id);
            const rows = makeRows(m, recipe);
            const problems = checkQuotas(recipe);
            console.log(`Recipe ${id}: ${rows.length} rows regenerate and check out against the schema.`);
            if (problems.length) { console.log(`Quotas not met: ${problems.join("; ")}.`); return 2; }
            console.log("Quotas met.");
            return 0;
        }
        case "cases": {
            if (!id) throw new UsageError("`cmtk data cases` needs the recipe id.");
            if (v.encoding !== undefined && v.encoding !== "json" && v.encoding !== "form") throw new UsageError("--encoding is json (the row file as the body) or form (its fields as a browser posts a form).");
            if (v.rows !== undefined && !["all", "valid", "invalid"].includes(v.rows)) throw new UsageError("--rows is all, valid or invalid.");
            const take: Record<string, string> = {};
            for (const t of (v.take ?? []) as string[]) {
                const eq = t.indexOf("=");
                if (eq <= 0) throw new UsageError(`--take needs field=selector, such as --take "__RequestVerificationToken=input[name=__RequestVerificationToken]"; got ${JSON.stringify(t)}.`);
                take[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
            }
            if (Object.keys(take).length && !v["before-get"]) throw new UsageError("--take needs --before-get /page: the page the value is taken from.");
            const status = (flag: string) => {
                if (v[flag] === undefined) return undefined;
                const n = Number(v[flag]);
                if (!Number.isInteger(n) || n < 100 || n > 599) throw new UsageError(`--${flag} must be an HTTP status, such as 302.`);
                return n;
            };
            const { file, cases, withoutExpect, leftOut } = writeCases(m, id, {
                path: v.path, method: v.method, requirement: v.requirement, out: v.out, encoding: v.encoding, rows: v.rows,
                onlyRows: v["only-rows"]?.split(",").map((s: string) => s.trim()).filter(Boolean), exceptRows: v["except-rows"]?.split(",").map((s: string) => s.trim()).filter(Boolean),
                before: v["before-get"] ? { get: v["before-get"], ...(Object.keys(take).length ? { take } : {}) } : undefined,
                expectValid: status("expect-valid"), expectInvalid: status("expect-invalid"),
            });
            console.log(`Wrote ${cases.length} draft cases to ${file}${withoutExpect ? `; ${withoutExpect} have no expect: block yet, because no documented status says what the answer should be` : ""}.`);
            for (const line of describeLeftOut(leftOut)) console.log(`Left out, ${line}.`);
            console.log("Next: a person reviews them with `cmtk review`. They are skipped until then.");
            return 0;
        }
        default:
            throw new UsageError("`cmtk data` needs plan, make, check or cases.");
    }
}


