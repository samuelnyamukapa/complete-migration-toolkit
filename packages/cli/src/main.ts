#!/usr/bin/env node
// cmtk: the Complete Migration Toolkit command. Every command can be run again safely, prints the
// next step, and exits with a code CI can use:
//   0 PASS, PARITY or DRIFT ONLY · 1 FAIL, NO PARITY or UNEXPLAINED DIFFERENCES · 2 INCOMPLETE or NO EVIDENCE · 3 a usage or settings problem
//   4 nothing new failed, but the result has a limit a person must read: PASS WITH KNOWN ISSUES, PARTIAL COMPARISON or NO UNEXPLAINED DIFFERENCES
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import YAML from "yaml";

import {
    acceptDraft, adaptersFor, BOUNDARY_KINDS, casesToYaml, check, compare, ConfigError, confirmExpectation, decideProposal, describeCheck, describeDiscovery, describeProposal, discover, describeSignoff, draftDefects,
    envHeaders, importHar, inside, loadCases, loadManifest, loadProposals, ManifestError, PathError, processAdapter, readStructured, recordSignoff,
    initProject, rejectDraft, rejectExpectation, run, SAFE_METHODS, signoffState, SignoffError, type Case, type Report, type Target, shadow, SHADOW_FORMATS, type ShadowFormat, cleanHistory, HISTORY_MODES, trend, type HistoryMode, planRecipe, makeData, makeRows, loadRecipe, checkQuotas, isHappy, writeCases, describeLeftOut, FAKER_VERSION, type DataFormat, DATA_FORMATS, compareTables, readTables, describeComparison, type Scrubbing, trafficAgainstSchema, loadDataFindings, writeSeed,
} from "@cmtk/core";

import { commitInstall, describeInstall, describeList, listAdapters, prepareInstall, RegistryError } from "./registry.js";

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
  cmtk import-har <file.har>... [--include <regex>] [--exclude <regex>] [--out <file>] [--draft-expect]
                                                                    turn recorded traffic into cases
                                                                    (--draft-expect drafts each expect: from the recorded status and
                                                                    content type; \`cmtk run\` skips it until a person confirms it)
  cmtk run [--target <name>] [--only <id,id>] [--allow-unsafe] [--accepted-only] [--dated]
                                                                    check one system against each case's expect: block
                                                                    (--accepted-only leaves draft cases out, as in CI)
  cmtk compare [--only <id,id>] [--allow-unsafe] [--dated]          send each case to the reference and the candidate, and diff
                                                                    (--dated also keeps this run in a dated folder, for \`cmtk trend\`)
  cmtk shadow --from <file>... [--format auto|clf|w3c|jsonl] [--sample 0.1] [--seed <n>] [--rate 5] [--max 1000]
              [--include <regex>] [--exclude <regex>] [--keep-header <name>]... [--redact <regex>]... [--keep-values] [--capture-only] [--dated]
                                                                    replay GET, HEAD and OPTIONS requests from a log to both systems, and diff
                                                                    (everything else is dropped and counted; not a proxy)
  cmtk trend [--mode run|compare|shadow] [--last <n>]               across dated runs: the verdict over time, differences by where, flaky cases,
                                                                    drift that stopped matching, scrubs that never fired
  cmtk trend clean [--keep-days <n>] [--keep-runs <n>] [--max-mb <n>] [--dry-run]
                                                                    remove old dated runs. Never follows a link
  cmtk status                                                       the latest verdicts
  cmtk check                                                        check settings and case files; sends nothing
  cmtk discover [--assembly <dll>]... [--rea-json <file>]... [--routes-from <file or folder of C#>]... [--config <file>]... [--har <file>]... [--topology <file>]... [--fresh]
                                                                    list every boundary of the legacy system, and flag the uncovered ones
                                                                    (--assembly needs REA: npm install --global rea-agents)
  cmtk review                                                       a person accepts or rejects draft cases and proposals
  cmtk defects run|compare                                          draft defects from the latest report
  cmtk probe <target> "GET /path" [--surface <name>]                send one read-only request and show the answer
  cmtk data plan --schema <file> [--operation "POST /path"] [--id <name>] [--seed <n>] [--clock <iso>] [--locale <loc>]
                                                                    compile a test-data recipe from a JSON Schema or an OpenAPI operation
                       an XSD or a single-file WSDL works as the schema too, with --operation naming an element or an operation, [--soap 1.1|1.2] [--soap-action <uri>];
                       a copybook (.cpy) too: [--record-encoding cp037|ascii]; CSV: [--csv-delimiter ;] [--csv-no-header] [--csv-no-bom] [--csv-lf]
  cmtk data make <id> [--format json,csv,xlsx,fixed,edge-csv,edge-xlsx,edge-fixed]
                                                                    regenerate the rows from the recipe, check them, write the files
  cmtk data diff <a> <b> --key <col,col> [--as csv|xlsx|fixed] [--epsilon 0.01] [--scrub dates,guids] [--copybook <file>] [--csv-delimiter ;] [--formulas value|formula] [--ignore col,col] [--no-fold-empty]
                                                                    compare two files by what they mean, never by their bytes
  cmtk data check <id>                                              check a recipe's rows and quotas without writing files
  cmtk data seed --ddl <script.sql> [--virtual-keys <file>] [--id <name>] [--seed <n>] [--rows <n>]
                                                                    one SQL script to seed both systems, with load order and control totals; cmtk never runs it
  cmtk data reconcile <a.csv> <b.csv>                               compare control totals from two sides
  cmtk data traffic <id> --har <file> [--path /x] [--method POST]   what recorded traffic says against the schema: paths and counts, never values
  cmtk data cases <id> [--path /api/x] [--requirement <id>] [--out <file>]
                       [--encoding form] [--before-get /page] [--take field=selector]...
                       [--expect-valid 302] [--expect-invalid 200] [--rows valid|invalid]
                       [--only-rows name,name] [--except-rows name,name]
                                                                    one draft case per row, each sending its row from a file
  cmtk signoff run|compare                                          a person signs a report, at a terminal (never an agent)
  cmtk adapter new <name> [--lang node|csharp]                      write a new adapter from a template (default: node)
  cmtk adapter check <name> [--target <name>]                       the conformance kit, on a dummy target or one from cmtk.yaml
  cmtk adapter add <name> [--registry <name, url or folder>] [--pin <tag, branch or commit>]
                                                                    a person installs an adapter from a registry, at a terminal (never an agent)
  cmtk adapter list                                                 the adapters here, and each one's level

Options:
  --manifest <file>   default: cmtk.yaml in the current folder
  --json              print the report as JSON

Exit codes: 0 PASS, PARITY or DRIFT ONLY · 1 FAIL, NO PARITY or UNEXPLAINED DIFFERENCES · 2 INCOMPLETE or NO EVIDENCE · 3 usage or settings problem
            4 nothing new failed, but read the limit: PASS WITH KNOWN ISSUES, PARTIAL COMPARISON or NO UNEXPLAINED DIFFERENCES.
Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit`;

class UsageError extends Error {}

/**
 * Nothing new failed, but the result is not a plain pass. Not 0: a pipeline written before this verdict
 * stops and a person looks, and one that accepts it says so. Not 1: it is told apart from a new failure.
 */
const EXIT_QUALIFIED = 4;

const exitFor = (v: Report["verdict"]) => (v === "PASS" || v === "PARITY" || v === "DRIFT ONLY" ? 0 : v === "FAIL" || v === "NO PARITY" ? 1 : v === "PASS WITH KNOWN ISSUES" || v === "PARTIAL COMPARISON" ? EXIT_QUALIFIED : 2);

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
        console.log(`  ${c.known_issues ? `FAIL (known issue ${c.known_issues.join(", ")})` : c.result} ${c.id} ${c.name}: ${first}`);
    }
    for (const n of r.no_adapter ?? []) console.log(`  No adapter for surface ${n.surface}, so nothing was sent for: ${n.cases.join(", ")}`);
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
            "draft-expect": { type: "boolean", default: false },
            candidate: { type: "string" },
            legacy: { type: "string" },
            system: { type: "string" },
            include: { type: "string" },
            exclude: { type: "string" },
            out: { type: "string" },
            surface: { type: "string" },
            assembly: { type: "string", multiple: true },
            "rea-json": { type: "string", multiple: true },
            "routes-from": { type: "string", multiple: true },
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
            "only-rows": { type: "string" },
            "except-rows": { type: "string" },
            lang: { type: "string" },
            registry: { type: "string" },
            pin: { type: "string" },
            dated: { type: "boolean", default: false },
            mode: { type: "string" },
            last: { type: "string" },
            "keep-days": { type: "string" },
            "keep-runs": { type: "string" },
            "max-mb": { type: "string" },
            "dry-run": { type: "boolean", default: false },
            from: { type: "string", multiple: true },
            sample: { type: "string" },
            rate: { type: "string" },
            max: { type: "string" },
            "keep-header": { type: "string", multiple: true },
            redact: { type: "string", multiple: true },
            "keep-values": { type: "boolean", default: false },
            "capture-only": { type: "boolean", default: false },
            "record-encoding": { type: "string" },
            soap: { type: "string" },
            ddl: { type: "string" },
            "virtual-keys": { type: "string" },
            rows: { type: "string" },
            "soap-action": { type: "string" },
            "csv-delimiter": { type: "string" },
            "csv-no-header": { type: "boolean", default: false },
            "csv-no-bom": { type: "boolean", default: false },
            "csv-lf": { type: "boolean", default: false },
            key: { type: "string" },
            as: { type: "string" },
            epsilon: { type: "string" },
            scrub: { type: "string" },
            copybook: { type: "string" },
            formulas: { type: "string" },
            ignore: { type: "string" },
            "no-fold-empty": { type: "boolean", default: false },
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
            const res = importHar(rest.map((f) => path.resolve(f)), { include: values.include, exclude: values.exclude, existing, draftExpect: values["draft-expect"] });
            const out = inside(manifest, values.out ?? "cmtk/cases/har.yaml");
            if (fs.existsSync(out)) throw new UsageError(`${path.relative(process.cwd(), out)} already exists; pass --out <new file>.`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, casesToYaml(res.cases, values["draft-expect"] ? "Imported from HAR recordings. Each drafted expect: is what the system answered, not the requirement: `cmtk review` confirms it, and `cmtk run` skips the case until then." : undefined), "utf8");
            console.log(`Added ${res.cases.length} cases to ${path.relative(process.cwd(), out)}; skipped ${res.skipped} (static files, filtered or duplicates).`);
            if (res.droppedHeaders.length) console.log(`Dropped these headers from every case: ${res.droppedHeaders.join(", ")}. Credentials come from headers_from_env at run time.`);
            if (res.redacted.length) console.log(`Replaced credential-like values with REDACTED in ${res.redacted.length} case${res.redacted.length === 1 ? "" : "s"} (${res.redacted.slice(0, 10).join(", ")}${res.redacted.length > 10 ? ", …" : ""}). Give those cases test values before they run.`);
            if (values["draft-expect"]) {
                console.log(`Drafted an expectation for ${res.drafted.length} case${res.drafted.length === 1 ? "" : "s"}, from the recorded status and content type only. No body text and no other header was copied.`);
                if (res.noAnswer.length) console.log(`The recording holds no answer for ${res.noAnswer.join(", ")}: write those expectations by hand.`);
                console.log("Next: a person confirms each one with `cmtk review`. `cmtk run` skips those cases until then.");
                return 0;
            }
            console.log("Next: name each case's requirement, add `expect:` checks for `cmtk run`, then run it.");
            return 0;
        }
        case "run":
        case "compare": {
            const manifest = loadManifest(manifestFile);
            const report = cmd === "run"
                ? await run(manifest, { target: values.target, only, allowUnsafe: values["allow-unsafe"], acceptedOnly: values["accepted-only"], dated: values.dated })
                : await compare(manifest, { only, allowUnsafe: values["allow-unsafe"], acceptedOnly: values["accepted-only"], dated: values.dated });
            printReport(report, values.json!, manifest.root, manifest.evidence);
            return exitFor(report.verdict);
        }
        case "shadow": return shadowCommand(manifestFile, values);
        case "trend": return trendCommand(manifestFile, rest, values);
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
            const shadowFile = path.join(manifest.root, manifest.evidence, "shadow", "REPORT.json");
            if (fs.existsSync(shadowFile)) {
                any = true;
                const r = JSON.parse(fs.readFileSync(shadowFile, "utf8")) as { verdict: string; date: string };
                console.log(`shadow: ${r.verdict} on ${r.date}`);
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
            const { file, discovery } = discover(m, { assemblies: values.assembly, reaJson: values["rea-json"], routesFrom: values["routes-from"], configs: values.config, har: values.har, topology: values.topology, fresh: values.fresh });
            if (values.json) { console.log(JSON.stringify(discovery, null, 2)); return 0; }
            console.log(`Boundaries for ${discovery.system}: ${describeDiscovery(discovery)}`);
            for (const b of discovery.boundaries.filter((x) => !x.covered_by)) console.log(`  uncovered ${b.kind} ${b.direction}: ${b.name}${b.where ? ` (${b.where})` : ""}`);
            for (const n of discovery.notes ?? []) console.log(`Note: ${n}`);
            console.log(`Inventory: ${path.relative(process.cwd(), path.join(m.root, file))}`);
            console.log(discovery.boundaries.some((x) => !x.covered_by) ? "Next: for each uncovered kind, add an adapter (`cmtk adapter new <name>` or `cmtk adapter add <name>`, then `covers:` in cmtk.yaml) or have a person record why it is out of scope." : "Next: write cases for each boundary, then `cmtk compare`.");
            return 0;
        }
        case "probe": return probe(manifestFile, rest, values.surface);
        case "adapter": return adapterCommand(rest, manifestFile, values);
        case "data": return dataCommand(rest, manifestFile, values);
        default:
            throw new UsageError(`Unknown command ${cmd}. Run \`cmtk help\`.`);
    }
}

/** Read a log, clean it, replay it. The verdict never says parity: it covers a sample of read-only traffic, so a clean result exits 4. */
async function shadowCommand(manifestFile: string, v: Record<string, any>): Promise<number> {
    if (!v.from?.length) throw new UsageError("`cmtk shadow` needs --from <file>: an access log or a mirror file.");
    if (v.format !== undefined && !(SHADOW_FORMATS as readonly string[]).includes(v.format)) throw new UsageError(`--format must be one of ${SHADOW_FORMATS.join(", ")}.`);
    const num = (name: string) => (v[name] === undefined ? undefined : Number(v[name]));
    const m = loadManifest(manifestFile);
    const r = await shadow(m, {
        from: (v.from as string[]).map((f) => path.resolve(f)), format: v.format as ShadowFormat | undefined, sample: num("sample"), seed: num("seed"), rate: num("rate"), max: num("max"),
        include: v.include, exclude: v.exclude, keepHeaders: v["keep-header"], redact: v.redact, keepValues: v["keep-values"], captureOnly: v["capture-only"], dated: v.dated, note: (line) => console.error(line),
    });
    if (v.json) console.log(JSON.stringify(r, null, 2));
    else {
        console.log(`Shadow verdict for ${r.system}: ${r.verdict}`);
        console.log(`Read ${r.capture.lines} lines: ${r.capture.kept} kept, ${r.capture.dropped_total} dropped because they could change data${r.capture.dropped_total ? ` (${Object.entries(r.capture.dropped).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}, ${r.capture.unreadable} unreadable, ${r.capture.filtered + r.capture.sampled_out + r.capture.over_limit} left out.`);
        console.log(`Sent ${r.replay.sent} to both systems: ${r.replay.matched} matched, ${r.replay.drift} approved drift, ${r.replay.different} unexplained, ${r.replay.errors} errors, ${r.replay.not_sent} not sent.`);
        for (const e of r.endpoints.filter((x) => x.unexplained).slice(0, 20)) console.log(`  ${e.endpoint}: ${e.unexplained} of ${e.requests} unexplained, at ${e.differences.filter((d) => !d.drift).slice(0, 3).map((d) => d.where).join(", ")}`);
        console.log(`Report: ${path.relative(process.cwd(), path.join(m.root, m.evidence, "shadow", "REPORT.md"))}`);
        console.log(r.reason);
        console.log(`Next: ${r.next}`);
    }
    if (r.capture_only) return 0;
    return r.verdict === "UNEXPLAINED DIFFERENCES" ? 1 : r.verdict === "NO UNEXPLAINED DIFFERENCES" ? EXIT_QUALIFIED : 2;
}

/** Read the dated reports. It sends nothing and changes no report. With `clean`, it removes old dated runs by the rule. */
async function trendCommand(manifestFile: string, args: string[], v: Record<string, any>): Promise<number> {
    const number = (name: string) => {
        if (v[name] === undefined) return undefined;
        const n = Number(v[name]);
        if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a number above 0.`);
        return n;
    };
    const m = loadManifest(manifestFile);
    if (args[0] === "clean") {
        const r = cleanHistory(m, { keepDays: number("keep-days"), keepRuns: number("keep-runs"), maxMb: number("max-mb"), dryRun: v["dry-run"] });
        if (v.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
        console.log(`${v["dry-run"] ? "Would remove" : "Removed"} ${r.removed.length} dated run${r.removed.length === 1 ? "" : "s"}${r.removed.length ? `: ${r.removed.join(", ")}` : ""}. ${r.kept} kept, ${Math.ceil(r.bytes / 1024 / 1024)} MB.`);
        for (const w of r.warnings) console.log(`Warning: ${w}`);
        return 0;
    }
    if (args.length) throw new UsageError("`cmtk trend` takes only `clean`, or no word at all.");
    if (v.mode !== undefined && !(HISTORY_MODES as readonly string[]).includes(v.mode)) throw new UsageError(`--mode must be one of ${HISTORY_MODES.join(", ")}.`);
    const { report, file } = trend(m, { mode: v.mode as HistoryMode | undefined, last: number("last") });
    if (v.json) { console.log(JSON.stringify(report, null, 2)); return report.runs.length ? 0 : 2; }
    if (!report.runs.length) {
        console.log(`No dated runs for ${report.mode} yet${report.unreadable.length ? `, and ${report.unreadable.length} could not be read` : ""}. Next: \`cmtk ${report.mode === "shadow" ? "shadow --from <file>" : report.mode} --dated\`, or set evidence_history: { dated: true } in cmtk.yaml.`);
        return 2;
    }
    console.log(report.summary);
    for (const d of report.differences.filter((x) => !x.approved && x.state !== "gone").slice(0, 10)) console.log(`  ${d.state}: ${d.where} (${d.runs} of ${report.runs.length} runs)`);
    for (const f of report.flaky.slice(0, 10)) console.log(`  flaky: ${f.case} (passed ${f.passed}, failed ${f.failed})`);
    if (report.drift_stopped_matching.length) console.log(`  drift that stopped matching: ${report.drift_stopped_matching.join(", ")}`);
    if (report.scrubs_never_fired.length) console.log(`  scrubs that never fired: ${report.scrubs_never_fired.join(", ")}`);
    console.log(`Report: ${path.relative(process.cwd(), path.join(m.root, file!))}`);
    return 0;
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
    if (report.scope && !report.scope.whole) console.log(`Your signature covers only what was compared. ${report.scope.statement}`);
    for (const k of report.known_issues ?? []) if (k.state === "still fails") console.log(`Known issue ${k.id} still fails on case ${k.case}: accepted by ${k.accepted_by}. Your signature covers this report with that failure in it. ${k.reason}`);
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
    const drafted = loadCases(m).filter((c) => c.expect_draft && !c.draft);
    const pending = loadProposals(m).filter((p) => p.status === "pending");
    if (!drafts.length && !drafted.length && !pending.length) { console.log("Nothing to review: no draft cases, no drafted expectations and no proposals."); return 0; }
    console.log(`${drafts.length} draft case${drafts.length === 1 ? "" : "s"}, ${drafted.length} drafted expectation${drafted.length === 1 ? "" : "s"} and ${pending.length} proposal${pending.length === 1 ? "" : "s"} to review.`);
    console.log("For each: a = accept, r = reject (you give a reason), s = skip for now, q = stop.");
    console.log("A = accept this draft and every remaining draft in the same file (you confirm first): for the cases a recipe generated, once you have read the recipe.");
    console.log("A drafted expectation records what the system answered, not what the requirement says, so you confirm each one on its own.\n");
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
                const rest = drafts.filter((d) => d.file === c.file && !done.has(d.id) && !d.expect_draft);
                let v = await ask(!c.expect_draft && rest.length > 1);
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
            ...drafted.map((c) => async () => {
                const { file: _file, expect_draft: _d, ...shown } = c;
                console.log(`\nDrafted expectation for case ${c.id} in ${c.file}. It is what the system answered in the recording; accept it only if that is what should happen:\n${YAML.stringify(shown, { lineWidth: 0 }).trimEnd().replace(/^/gm, "  ")}`);
                const v = await ask();
                if (v === "q") return false;
                if (v === "a") { confirmExpectation(m, c.id, name, date, c); tally.accepted++; }
                if (v === "r") { rejectExpectation(m, c.id, name, date, (await rl.question("Why reject it? The case stays, with no expectation. ")).trim() || "no reason given", c); tally.rejected++; }
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

/** Copy a template, filling in the name. npm leaves `.gitignore` out of a package, so templates hold it as `gitignore`. */
function writeTemplate(tpl: string, dir: string, name: string) {
    fs.mkdirSync(dir, { recursive: true });
    for (const e of fs.readdirSync(tpl, { withFileTypes: true })) {
        const to = path.join(dir, e.name === "gitignore" ? ".gitignore" : e.name.replaceAll("__NAME__", name));
        if (e.isDirectory()) writeTemplate(path.join(tpl, e.name), to, name);
        else fs.writeFileSync(to, fs.readFileSync(path.join(tpl, e.name), "utf8").replaceAll("__NAME__", name), "utf8");
    }
}

async function adapterCommand(args: string[], manifestFile: string, values: { lang?: string; target?: string; registry?: string; pin?: string; json?: boolean }): Promise<number> {
    const [sub, name] = args;
    const lang = values.lang ?? "node";
    if (sub === "list") return adapterList(manifestFile, values.json === true);
    // Before anything else, the name included: a script learns nothing and fetches nothing.
    if (sub === "add" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new UsageError("Installing an adapter runs someone else's code, so a person says yes at a keyboard: run `cmtk adapter add` in a terminal yourself. Agents and scripts do not install.");
    }
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || name === "http") throw new UsageError("Give the adapter a name of letters, digits, '.', '-' and '_' (not http, which is built in).");
    const root = path.dirname(manifestFile);
    const dir = path.join(root, "adapters", name);
    if (sub === "new") {
        if (lang !== "node" && lang !== "csharp") throw new UsageError(`--lang must be node or csharp, not ${lang}.`);
        if (fs.existsSync(dir)) throw new UsageError(`adapters/${name} already exists.`);
        writeTemplate(path.join(HERE, "..", "templates", `adapter-${lang}`), dir, name);
        if (lang === "csharp") {
            console.log(`Wrote adapters/${name}/. Next: write Run() in Adapter.cs, then \`dotnet build -c Release adapters/${name}\` and \`cmtk adapter check ${name}\`.`);
            console.log(`Register it in cmtk.yaml:\n  adapters:\n    ${name}: { command: dotnet, args: [adapters/${name}/bin/Release/net8.0/${name}.dll] }`);
            return 0;
        }
        console.log(`Wrote adapters/${name}/. Next: write run() in index.mjs, then \`cmtk adapter check ${name}\`.`);
        console.log(`Register it in cmtk.yaml:\n  adapters:\n    ${name}: { command: node, args: [adapters/${name}/index.mjs] }`);
        return 0;
    }
    if (sub === "check") return adapterCheck(name, dir, manifestFile, values.target);
    if (sub === "add") return adapterAdd(name, root, manifestFile, values.registry, values.pin);
    throw new UsageError("`cmtk adapter` takes `new <name>`, `check <name>`, `add <name>` or `list`.");
}

function adapterList(manifestFile: string, json: boolean): number {
    const registered = fs.existsSync(manifestFile) ? loadManifest(manifestFile).adapters : {};
    const rows = listAdapters(path.dirname(manifestFile), registered);
    if (json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
    for (const line of describeList(rows)) console.log(line);
    console.log("\nLevels: experimental passes the conformance kit; verified was used on one real project; core ships with the toolkit and has real use behind it. For an adapter from a registry, the level is what that registry says: `cmtk adapter check <name>` proves the kit here.");
    const changed = rows.filter((r) => r.state === "CHANGED since install" || r.state === "MISSING").map((r) => r.name);
    if (changed.length) console.log(`Warning: ${changed.join(", ")} no longer match what a person approved. Read the changes, or remove the folder and its entry in adapters/installed.yaml and add it again.`);
    return 0;
}

/** The toolkit's own adapters folder, in a clone. Only this registry may list a core adapter. */
const TOOLKIT_ADAPTERS = path.resolve(HERE, "..", "..", "..", "adapters");

/** A person at the keyboard reads where an adapter comes from, and says yes. There is no flag or variable for this. */
async function adapterAdd(name: string, root: string, manifestFile: string, registry: string | undefined, pin: string | undefined): Promise<number> {
    const named = fs.existsSync(manifestFile) ? loadManifest(manifestFile).adapter_registries : {};
    const chosen = registry === undefined ? undefined : Object.hasOwn(named, registry) ? { list: [named[registry]!], base: root } : { list: [registry], base: process.cwd() };
    if (!chosen && !Object.keys(named).length) throw new UsageError("Name a registry: --registry <url or folder>, or list yours under `adapter_registries:` in cmtk.yaml. cmtk has no default registry, so it never fetches from somewhere you did not name.");
    const prepared = prepareInstall({ name, root, registries: chosen?.list ?? Object.values(named), base: chosen?.base ?? root, pin, toolkitAdapters: TOOLKIT_ADAPTERS });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string | null>((resolve) => {
        rl.once("close", () => resolve(null));
        rl.question(q).then((a) => resolve(a), () => resolve(null));
    });
    try {
        for (const line of describeInstall(prepared)) console.log(line);
        const person = (await ask("\nYour full name: "))?.trim();
        if (!person || person.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(person) || /^agent\b/i.test(person)) {
            console.log("A person's name of up to 100 characters is needed: it goes beside this install. Nothing was installed.");
            return 3;
        }
        const yes = (await ask(`Type yes to install ${name}, anything else to stop: `))?.trim().toLowerCase();
        if (yes !== "yes") { console.log("Nothing was installed."); return 0; }
        commitInstall(prepared, root, person, new Date().toISOString().slice(0, 10));
        console.log(`Installed adapters/${name}${prepared.commit ? `, pinned to commit ${prepared.commit}` : `, pinned to ${prepared.fingerprint}`}. Recorded in adapters/installed.yaml.`);
        const covers = prepared.entry.kinds.filter((k) => (BOUNDARY_KINDS as readonly string[]).includes(k));
        const also = covers.length ? `, covers: [${covers.join(", ")}]` : "";
        if (prepared.files.some((f) => f.endsWith(".csproj") && !f.includes("/"))) {
            console.log(`Next: read the code, then \`dotnet build -c Release adapters/${name}\` and \`cmtk adapter check ${name}\`. Register the built program in cmtk.yaml; its README shows how.`);
        } else if (prepared.files.includes("index.mjs")) {
            console.log(`Next: read the code, then \`cmtk adapter check ${name}\`. Register it in cmtk.yaml:\n  adapters:\n    ${name}: { command: node, args: [adapters/${name}/index.mjs]${also} }`);
        } else console.log(`Next: read the code and its README, register it in cmtk.yaml, then \`cmtk adapter check ${name}\`.`);
        return 0;
    } finally {
        rl.close();
        prepared.cleanup();
    }
}

/** How to start a C# adapter nobody has registered: its build, which must not be older than its code. */
function builtCsharpAdapter(name: string, dir: string): { command: string; args: string[] } | undefined {
    const top = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const project = top.find((f) => f.endsWith(".csproj"));
    if (!project) return undefined;
    const stem = project.slice(0, -".csproj".length);
    const release = path.join(dir, "bin", "Release");
    const frameworks = fs.existsSync(release) ? fs.readdirSync(release) : [];
    const built = frameworks.map((f) => path.join(release, f, `${stem}.dll`)).find((f) => fs.existsSync(f));
    const build = `Run: dotnet build -c Release adapters/${name}`;
    if (!built) throw new UsageError(`adapters/${name} has not been built. ${build}`);
    const code = top.filter((f) => f.endsWith(".cs") || f.endsWith(".csproj"));
    const newer = code.find((f) => fs.statSync(path.join(dir, f)).mtimeMs > fs.statSync(built).mtimeMs);
    if (newer) throw new UsageError(`adapters/${name}/${newer} is newer than the build. ${build}`);
    return { command: "dotnet", args: [built] };
}

/** The conformance kit: an adapter is usable when every check here passes. */
async function adapterCheck(name: string, dir: string, manifestFile: string, targetName?: string): Promise<number> {
    let spec: { command: string; args: string[] } | undefined;
    if (targetName !== undefined && !fs.existsSync(manifestFile)) throw new UsageError(`--target ${targetName} needs a cmtk.yaml that sets it; ${manifestFile} does not exist.`);
    if (fs.existsSync(manifestFile)) {
        const m = loadManifest(manifestFile);
        if (m.adapters[name]) spec = { command: m.adapters[name]!.command, args: m.adapters[name]!.args ?? [] };
    }
    spec ??= builtCsharpAdapter(name, dir) ?? { command: process.execPath, args: [path.join(dir, "index.mjs")] };
    const samplesFile = path.join(dir, "samples", "cases.yaml");
    const doc = fs.existsSync(samplesFile) ? (readStructured(samplesFile) as { cases?: Case[]; check_target?: Record<string, string | number | boolean> }) : {};
    const samples = doc.cases ?? [];
    const secret = `cmtk-check-${Math.random().toString(36).slice(2)}`;
    // A dummy target by default, with any settings the samples give. With --target, a real one from cmtk.yaml, for an adapter whose settings say where its capture server or sandbox is.
    let target: Target = { ...doc.check_target, name: "check", base_url: "http://127.0.0.1:9" };
    if (targetName !== undefined) {
        const named = loadManifest(manifestFile).targets[targetName];
        if (!named) throw new UsageError(`--target ${targetName} is not in the targets of ${path.basename(manifestFile)}.`);
        target = named;
    }
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
        if (err instanceof UsageError || err instanceof ManifestError || err instanceof ConfigError || err instanceof PathError || err instanceof SignoffError || err instanceof RegistryError) console.error(`cmtk: ${err.message}`);
        else console.error(`cmtk: ${err?.stack ?? err}`);
        process.exit(3);
    },
);

function soapVersion(s: string): "1.1" | "1.2" {
    if (s !== "1.1" && s !== "1.2") throw new UsageError("--soap is 1.1 or 1.2.");
    return s;
}

function recordEncoding(s: string): "cp037" | "ascii" {
    if (s !== "cp037" && s !== "ascii") throw new UsageError("--record-encoding is cp037 or ascii.");
    return s;
}

async function dataCommand(args: string[], manifestFile: string, v: Record<string, any>): Promise<number> {
    const [sub, id] = args;
    const m = loadManifest(manifestFile);
    const generators = { cmtk: VERSION, "@faker-js/faker": FAKER_VERSION };
    switch (sub) {
        case "plan": {
            if (!v.schema) throw new UsageError("`cmtk data plan` needs --schema <file>: a JSON Schema or an OpenAPI document inside the project.");
            const seed = v.seed === undefined ? undefined : Number(v.seed);
            const { file, recipe } = planRecipe(m, {
                schema: v.schema, operation: v.operation, id: v.id, seed, clock: v.clock, locale: v.locale, generators,
                ...(v["record-encoding"] ? { recordEncoding: recordEncoding(v["record-encoding"]) } : {}),
                ...(v.soap ? { soap: { version: soapVersion(v.soap), ...(v["soap-action"] ? { action: v["soap-action"] } : {}) } } : {}),
                ...(v["csv-delimiter"] || v["csv-no-header"] || v["csv-no-bom"] || v["csv-lf"] ? { csv: { ...(v["csv-delimiter"] ? { delimiter: v["csv-delimiter"] } : {}), ...(v["csv-no-header"] ? { header: false } : {}), ...(v["csv-no-bom"] ? { bom: false } : {}), ...(v["csv-lf"] ? { line_ending: "lf" as const } : {}) } } : {}),
            });
            const happy = recipe.rows.filter(isHappy).length;
            const byTechnique = Object.entries(recipe.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.technique]: (acc[r.technique] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(", ");
            console.log(`Recipe ${recipe.id}: ${recipe.fields.length - 1} fields, ${recipe.rows.length} rows (${byTechnique}); ${happy} happy paths (${Math.round((happy / recipe.rows.length) * 100)}%).`);
            for (const n of recipe.notes ?? []) console.log(`  ${n}`);
            const low = recipe.fields.filter((f) => f.low_confidence);
            if (low.length) console.log(`  Low confidence, because the schema says nothing about them: ${low.map((f) => f.path).join(", ")}.`);
            for (const f of recipe.fields.filter((x) => x.note && /can't be generated|not honoured/.test(x.note))) console.log(`  ${f.path}: ${f.note}`);
            console.log(`Written: ${file}`);
            console.log(`Next: read it, then \`cmtk data make ${recipe.id}\` to see the rows.`);
            return 0;
        }
        case "make": {
            if (!id) throw new UsageError("`cmtk data make` needs the recipe id.");
            const formats = (v.format ? String(v.format).split(",") : ["json", "csv"]).map((f: string) => f.trim().toLowerCase());
            for (const f of formats) if (!(DATA_FORMATS as readonly string[]).includes(f)) throw new UsageError(`Unknown format ${f}: use ${DATA_FORMATS.join(", ")}.`);
            const { folder, manifest } = await makeData(m, id, { formats: formats as DataFormat[], generators });
            console.log(`Made ${manifest.rows} rows (${manifest.valid_rows} valid, ${Math.round(manifest.quotas.happy_share * 100)}% happy paths) in ${folder}/: ${Object.keys(manifest.files).filter((f) => !f.startsWith("rows/")).join(", ")}.`);
            console.log(`Every valid row validates against the schema, and every invalid row breaks it where it says.`);
            if (manifest.edge_files?.length) console.log(`${manifest.edge_files.length} edge files, each labelled in ${folder}/DATA.md.`);
            if (manifest.fixed) console.log(`${manifest.fixed.records} fixed-width records of ${manifest.fixed.record_size} bytes in ${manifest.fixed.encoding}; ${manifest.fixed.left_out.length} rows left out, listed in ${folder}/DATA.md.`);
            for (const x of manifest.not_written ?? []) console.log(`Not written: ${x.format}: ${x.why}.`);
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
            const open = loadDataFindings(m, id);
            if (open.length) console.log(`${open.length} findings are open for a person, in cmtk/data/${id}.findings.yaml.`);
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
        case "seed": {
            if (!v.ddl) throw new UsageError("`cmtk data seed` needs --ddl <script.sql>: a T-SQL script of the legacy schema, inside the project.");
            const seed = v.seed === undefined ? undefined : Number(v.seed);
            if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) throw new UsageError("--seed must be a whole number.");
            const count = v.rows === undefined ? undefined : Number(v.rows);
            if (count !== undefined && (!Number.isInteger(count) || count < 0)) throw new UsageError("--rows must be a whole number.");
            const { folder, manifest } = writeSeed(m, { ddl: v.ddl, virtualKeys: v["virtual-keys"], id: v.id, ...(seed !== undefined ? { seed } : {}), ...(count !== undefined ? { rows: count } : {}) });
            console.log(`Seed for ${manifest.tables.length} tables, ${manifest.tables.reduce((n, t) => n + t.rows, 0)} rows, in ${folder}/.`);
            console.log(`Load order: ${manifest.load_order.join(", ")}.`);
            for (const d of manifest.deferred_keys) console.log(`Deferred, to break a cycle: ${d}.`);
            for (const k of manifest.virtual_keys) console.log(`Virtual key: ${k}.`);
            for (const n of manifest.notes) console.log(`Note: ${n}`);
            console.log("cmtk does not run it. Next: load seed.sql into both disposable test databases, run control-totals.sql on each, save each result as CSV, then `cmtk data reconcile`.");
            return 0;
        }
        case "reconcile": {
            const [a, b] = args.slice(1);
            if (!a || !b) throw new UsageError("`cmtk data reconcile` needs two CSV files of control totals.");
            const c = compareTables(readTables(inside(m, a), { as: "csv" }), readTables(inside(m, b), { as: "csv" }), { key: ["table", "column", "measure"], epsilon: 0.000002 });
            if (v.json) console.log(JSON.stringify(c, null, 2));
            else for (const line of describeComparison(c)) console.log(line);
            return c.same ? 0 : 1;
        }
        case "traffic": {
            if (!id) throw new UsageError("`cmtk data traffic` needs the recipe id.");
            if (!v.har?.length) throw new UsageError("`cmtk data traffic` needs --har <file>.");
            const { requests, disagreements } = trafficAgainstSchema(m, id, v.har[0], { path: v.path, method: v.method });
            console.log(`${requests} recorded request${requests === 1 ? "" : "s"} read.`);
            for (const d of disagreements) console.log(`  ${d.field}: ${d.says} ${d.requests} request${d.requests === 1 ? "" : "s"}.`);
            if (!disagreements.length) console.log("The recording and the schema agree, for what the recording holds. That is not coverage.");
            return 0;
        }
        case "diff": {
            const [a, b] = args.slice(1);
            if (!a || !b) throw new UsageError("`cmtk data diff` needs two files.");
            const list = (s: unknown) => (s === undefined ? [] : String(s).split(",").map((x) => x.trim()).filter(Boolean));
            if (v.as !== undefined && !["csv", "xlsx", "fixed"].includes(v.as)) throw new UsageError("--as is csv, xlsx or fixed.");
            if (v.formulas !== undefined && !["value", "formula"].includes(v.formulas)) throw new UsageError("--formulas is value or formula.");
            const scrub = list(v.scrub);
            for (const s of scrub) if (s !== "dates" && s !== "guids") throw new UsageError("--scrub takes dates and guids.");
            const epsilon = v.epsilon === undefined ? undefined : Number(v.epsilon);
            if (epsilon !== undefined && !(epsilon >= 0)) throw new UsageError("--epsilon must be a number, zero or more.");
            const read = { as: v.as, delimiter: v["csv-delimiter"], copybook: v.copybook ? inside(m, v.copybook) : undefined, record_encoding: v["record-encoding"] ? recordEncoding(v["record-encoding"]) : undefined, formulas: v.formulas };
            const c = compareTables(readTables(inside(m, a), read), readTables(inside(m, b), read), { key: list(v.key), ...(epsilon !== undefined ? { epsilon } : {}), scrub: scrub as Scrubbing[], ignore: list(v.ignore), fold_empty: !v["no-fold-empty"] });
            if (v.json) console.log(JSON.stringify(c, null, 2));
            else for (const line of describeComparison(c)) console.log(line);
            return c.same ? 0 : 1;
        }
        default:
            throw new UsageError("`cmtk data` needs plan, make, check, cases, diff, traffic, seed or reconcile.");
    }
}


