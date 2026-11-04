// The two things the toolkit does:
//   run      one target, every case checked against what its requirement expects
//   compare  the reference and the candidate, every case sent to both and the answers diffed,
//            with approved drift expected and everything else reported
// Both write their evidence and a report into the evidence folder. Neither signs anything.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { httpAdapter, processAdapter, type Adapter } from "./adapters.js";
import { checkAssemblyContract } from "./assembly.js";
import { checkContract } from "./contracts.js";
import { cleanUrl } from "./defects.js";
import { keepDated, type HistoryMode } from "./history.js";
import { scrubRules } from "./trend.js";
import { compareObservations, scrubberOf } from "./diff.js";
import { coveringDrift } from "./drift.js";
import { checkExpectation } from "./expect.js";
import { knownInReport, loadKnownIssues, markKnown } from "./known.js";
import { loadCases, loadDrift, ManifestError, ownedFolder } from "./manifest.js";
import { safeConfirmed, SAFE_METHODS, writes } from "./methods.js";
import { renderReport, summarise } from "./report.js";
import type { Case, CaseOutcome, ContractOutcome, Drift, KnownIssue, Manifest, MatchLevel, Observation, Report, ReportSettings, ScreenshotFile, Target } from "./types.js";

export { SAFE_METHODS };

export interface RunOptions {
    /** Replay requests that change data. Needs allow_unsafe_methods in cmtk.yaml as well. */
    allowUnsafe?: boolean;
    /** Only these case ids. */
    only?: string[];
    /** Leave draft cases out entirely, as CI does, instead of reporting them as SKIPPED. */
    acceptedOnly?: boolean;
    /** cmtk run: the target to test (default: default_target). */
    target?: string;
    /** Today's date (tests pass a fixed one). */
    date?: string;
    /** Also keep this run in a dated folder, as `evidence_history.dated` does for every run. */
    dated?: boolean;
    /** Where a line about dated evidence goes. Default: standard error. */
    note?: (line: string) => void;
}

const today = () => new Date().toISOString().slice(0, 10);

export function envHeaders(manifest: Manifest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [header, variable] of Object.entries(manifest.headers_from_env)) {
        const value = process.env[variable];
        if (value === undefined) throw new ManifestError(`headers_from_env: the environment variable ${variable} for ${header} is not set.`);
        // The value is never shown, not even here: only what is wrong with it.
        if (/[\0-\x08\x0a-\x1f\x7f]/.test(value)) throw new ManifestError(`headers_from_env: the environment variable ${variable} holds a line break or another control character; set it again without one.`);
        out[header] = value;
    }
    return out;
}

export function matchFor(c: Case, manifest: Manifest): MatchLevel {
    let level = manifest.match;
    const p = c.request.path.split("?")[0]!;
    for (const o of manifest.overrides) if (path.posix.matchesGlob(p, o.path)) level = o.match;
    return c.match ?? level;
}

export function adaptersFor(manifest: Manifest) {
    const cache = new Map<string, Adapter>();
    return {
        get(surface: string): Adapter {
            const s = surface || "http";
            if (!cache.has(s)) {
                if (s === "http") cache.set(s, httpAdapter({ timeoutS: manifest.timeout_s, insecureTls: manifest.insecure_tls, root: manifest.root }));
                else if (manifest.adapters[s]) cache.set(s, processAdapter(s, manifest.adapters[s]!, manifest.root));
                else throw new ManifestError(`No adapter for surface "${s}". Add it under \`adapters:\` in cmtk.yaml, or run \`cmtk adapter new ${s}\`.`);
            }
            return cache.get(s)!;
        },
        async closeAll() {
            for (const a of cache.values()) await a.close?.();
        },
    };
}

function selectCases(manifest: Manifest, mode: "run" | "compare", only?: string[], acceptedOnly = false): Case[] & { excluded: number } {
    const picked = pick(manifest, only);
    if (!acceptedOnly) return Object.assign(picked, { excluded: 0 });
    // A comparison never reads `expect`, so a drafted expectation only holds a case back from `cmtk run`.
    const held = (c: Case) => c.draft || (mode === "run" && c.expect_draft);
    return Object.assign(picked.filter((c) => !held(c)), { excluded: picked.filter(held).length });
}

function pick(manifest: Manifest, only?: string[]): Case[] {
    const all = loadCases(manifest);
    if (!only?.length) return all;
    const ids = new Set(all.map((c) => c.id));
    const unknown = only.filter((i) => !ids.has(i));
    if (unknown.length) throw new ManifestError(`Unknown case ids: ${unknown.join(", ")}.`);
    return all.filter((c) => only.includes(c.id));
}

/** A gap to show, not a reason to stop: the report names the case, and counts it as an error so the result can't pass. */
function noAdapter(c: Case, manifest: Manifest): Pick<CaseOutcome, "result" | "why" | "no_adapter"> | undefined {
    const s = c.surface ?? "http";
    if (s === "http" || Object.hasOwn(manifest.adapters, s)) return undefined;
    return { result: "ERROR", no_adapter: true, why: `surface "${s}" has no adapter, so nothing was sent. Add it under \`adapters:\` in cmtk.yaml: \`cmtk adapter new ${s}\` writes one, and \`cmtk adapter add ${s}\` lets a person install one` };
}

const requirementsOf = (c: Case) => (c.requirement === undefined ? [] : Array.isArray(c.requirement) ? c.requirement.map(String) : [String(c.requirement)]);

function base(c: Case): Omit<CaseOutcome, "result"> {
    return { id: c.id, name: c.name ?? `${c.request.method} ${c.request.path}`, request: `${c.request.method} ${c.request.path}`, requirement: requirementsOf(c), surface: c.surface ?? "http" };
}

/**
 * Held back unless both switches are on. `safe: true` lets a case past them only when a person saw exactly that
 * case in `cmtk review`. A method override, or a body on a read, is a write whatever the method says.
 */
function unsafe(c: Case, manifest: Manifest, opts: RunOptions) {
    return writes(c) && !safeConfirmed(c, manifest.root) && !(manifest.allow_unsafe_methods && opts.allowUnsafe);
}

const unsafeWhy = (c: Case) => (c.safe !== undefined ? `${UNSAFE_WHY}. It is marked \`safe: true\`, but no person has confirmed this exact case: \`cmtk review\` shows it` : UNSAFE_WHY);

/** What an adapter is told. An adapter trusts `safe`, so a mark no person confirmed never reaches it. */
const asSent = (c: Case, manifest: Manifest): Case => {
    if (c.safe === undefined || safeConfirmed(c, manifest.root)) return c;
    const { safe: _safe, ...rest } = c;
    return rest;
};

/** The targets that do not offer a surface. A target that lists no surfaces offers them all. */
const lacking = (surface: string, ...targets: Target[]) => targets.filter((t) => t.surfaces && !t.surfaces.includes(surface)).map((t) => t.name);
const hasNo = (names: string[], surface: string) => `${names.join(" and ")} ${names.length > 1 ? "have" : "has"} no ${surface} surface`;

const NOT_RESET_NOTE = "read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there";
const DRAFT_WHY = "a draft: a person accepts it with `cmtk review` before it counts";
const EXPECT_DRAFT_WHY = "draft expectation: review it with `cmtk review`. It records what the system answered, which a person confirms before it counts";
const UNSAFE_WHY = "changes data: needs allow_unsafe_methods in cmtk.yaml and --allow-unsafe on this run";

/** An error that means no answer came at all, as opposed to a bad answer. */
const NO_ANSWER = /^(ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b/;
/** After this many requests in a row get no answer, the rest are not sent: each would only wait out its timeout. */
export const STOP_AFTER_NO_ANSWER = 3;
const STOPPED_WHY = `not run: ${STOP_AFTER_NO_ANSWER} requests in a row got no answer, so the run stopped early. Check the system is up, then run again`;
const noAnswer = (o: { error?: string }) => !!o.error && NO_ANSWER.test(o.error);

/** A run older than this, or whose process has gone, no longer holds the evidence folder. */
const LOCK_STALE_MS = 3 * 60 * 60_000;

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * The evidence is written to a new folder and only replaces the previous one once the run has
 * finished, so a run that stops half way leaves the last complete evidence where it was.
 * One run at a time per folder: a second run would delete the first one's half-written evidence.
 */
export function evidenceDir(manifest: Manifest, mode: HistoryMode, opts: { dated?: boolean; note?: (line: string) => void } = {}) {
    ownedFolder(manifest, manifest.evidence); // never the project folder itself
    const final = ownedFolder(manifest, path.join(manifest.evidence, mode));
    const work = ownedFolder(manifest, path.join(manifest.evidence, `.${mode}.partial`));
    const lock = ownedFolder(manifest, path.join(manifest.evidence, `.${mode}.lock`));
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const mine = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
    try {
        fs.writeFileSync(lock, mine, { flag: "wx" });
    } catch {
        let held: { pid?: number; started?: string } = {};
        try { held = JSON.parse(fs.readFileSync(lock, "utf8")); } catch { /* unreadable: treat as stale */ }
        const age = held.started ? Date.now() - Date.parse(held.started) : Infinity;
        if (typeof held.pid === "number" && alive(held.pid) && age < LOCK_STALE_MS) {
            throw new ManifestError(`Another \`cmtk ${mode}\` is writing ${path.relative(manifest.root, final)} (process ${held.pid}, started ${held.started}). Wait for it to finish, then run again.`);
        }
        fs.writeFileSync(lock, mine);
    }
    const release = () => {
        try { if (fs.readFileSync(lock, "utf8") === mine) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
    };
    try {
        fs.rmSync(work, { recursive: true, force: true });
        fs.mkdirSync(path.join(work, "answers"), { recursive: true });
    } catch (err) {
        release();
        throw err;
    }
    return {
        dir: work,
        commit() {
            fs.rmSync(final, { recursive: true, force: true });
            fs.renameSync(work, final);
            if (opts.dated || manifest.evidence_history.dated) {
                const note = opts.note ?? ((line: string) => { process.stderr.write(`${line}\n`); });
                // The run has finished and its evidence is in place, so a problem here is said out loud and costs only the copy.
                try {
                    const kept = keepDated(manifest, mode, final);
                    note(`Kept a dated copy: ${path.join(manifest.evidence, "history", mode, kept.name).split(path.sep).join("/")}.`);
                    if (kept.removed.length) note(`Removed old dated runs by the clean-up rule: ${kept.removed.join(", ")}.`);
                    for (const w of kept.warnings) note(`Warning: ${w}`);
                } catch (err) {
                    note(`Warning: no dated copy was kept: ${(err as Error).message}`);
                }
            }
            return final;
        },
        release,
    };
}

const failed = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What produced a report: the settings file and everything in it that hides or approves a difference. */
export function settingsOf(manifest: Manifest, drift: Drift[], known?: KnownIssue[]): ReportSettings {
    return {
        manifest: path.relative(manifest.root, manifest.file).split(path.sep).join("/"),
        manifest_sha256: crypto.createHash("sha256").update(fs.readFileSync(manifest.file)).digest("hex"),
        match: manifest.match,
        overrides: manifest.overrides,
        scrub: manifest.scrub,
        ...(manifest.visual_tolerance ? { visual_tolerance: manifest.visual_tolerance } : {}),
        drift_file: manifest.drift,
        drift_entries: drift.length,
        ...(known ? { known_issues_file: manifest.known_issues, known_issues_entries: known.length } : {}),
    };
}

/** How a report names a target: its address, or its adapter settings. */
const where = (t: Target) => (t.base_url ? cleanUrl(t.base_url) : undefined) ?? Object.entries(t).filter(([k]) => k !== "name" && k !== "surfaces").map(([k, v]) => `${k}=${v}`).join(", ");

const writeJson = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");

/**
 * An answer as it goes into the evidence: screenshots become files beside it, with their names and
 * fingerprints in the answer. Without `dir` they are only left out, as for an exploration log.
 */
export function evidenceOf(obs: Observation, dir?: string, stem?: string): Omit<Observation, "screenshots"> & { screenshots?: ScreenshotFile[] } {
    const { screenshots, ...rest } = obs;
    if (!screenshots?.length) return rest;
    if (!dir || !stem) return rest;
    return {
        ...rest,
        screenshots: screenshots.map((s, i) => {
            const bytes = Buffer.from(String(s.png_base64), "base64");
            const file = `${stem}.screen-${String(i + 1).padStart(2, "0")}.png`;
            fs.writeFileSync(path.join(dir, file), bytes);
            return { page: String(s.page), file, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
        }),
    };
}

/** Adds up what adapters say about model calls. A case on an adapter that does not say is counted as not known, never as zero. */
function modelCalls() {
    const tally = { total: 0, cases_not_counted: 0 };
    return {
        tally,
        add(surface: string, obs: Observation) {
            if (surface === "http") return;
            if (typeof obs.model_calls === "number" && Number.isInteger(obs.model_calls) && obs.model_calls >= 0) tally.total += obs.model_calls;
            else tally.cases_not_counted++;
        },
    };
}

function target(manifest: Manifest, name: string | undefined, role: string): Target {
    if (!name) throw new ManifestError(`cmtk.yaml names no ${role} target. Set \`${role}:\` to one of: ${Object.keys(manifest.targets).join(", ")}.`);
    const t = manifest.targets[name];
    if (!t) throw new ManifestError(`No target called ${name}. Targets: ${Object.keys(manifest.targets).join(", ")}.`);
    return t;
}

/** cmtk run: one target, checked against expectations. */
export async function run(manifest: Manifest, opts: RunOptions = {}): Promise<Report> {
    const t = target(manifest, opts.target ?? manifest.default_target, "default_target");
    const selected = selectCases(manifest, "run", opts.only, opts.acceptedOnly);
    const compareOnly = (c: Case) => manifest.compare_only_surfaces.includes(c.surface ?? "http");
    const cases = selected.filter((c) => !compareOnly(c));
    const leftOut = selected.length - cases.length;
    // A bad ledger stops the run here, before any evidence is touched. An entry for another target does not apply.
    const known = loadKnownIssues(manifest).filter((k) => !k.target || k.target === t.name);
    const extra = envHeaders(manifest);
    const adapters = adaptersFor(manifest);
    const ev = evidenceDir(manifest, "run", opts);
    try {
        const dir = ev.dir;
        const out: CaseOutcome[] = [];
        const models = modelCalls();
        let silent = 0; // requests in a row with no answer
        try {
            for (const c of cases) {
                const b = base(c);
                const gap = noAdapter(c, manifest);
                if (gap) { out.push({ ...b, ...gap }); continue; }
                const missing = lacking(b.surface, t);
                if (missing.length) { out.push({ ...b, result: "SKIPPED", why: `not run: ${hasNo(missing, b.surface)}` }); continue; }
                if (c.expect_draft) { out.push({ ...b, result: "SKIPPED", why: EXPECT_DRAFT_WHY }); continue; }
                if (c.draft) { out.push({ ...b, result: "SKIPPED", why: DRAFT_WHY }); continue; }
                if (!c.expect) { out.push({ ...b, result: "SKIPPED", why: "no `expect:` block, so there is nothing to check on one system" }); continue; }
                if (unsafe(c, manifest, opts)) { out.push({ ...b, result: "SKIPPED", why: unsafeWhy(c) }); continue; }
                if (silent >= STOP_AFTER_NO_ANSWER) { out.push({ ...b, result: "SKIPPED", why: STOPPED_WHY }); continue; }
                try {
                    const obs = await adapters.get(b.surface).run(asSent(c, manifest), t, extra);
                    writeJson(path.join(dir, "answers", `${c.id}.json`), evidenceOf(obs, path.join(dir, "answers"), c.id));
                    models.add(b.surface, obs);
                    silent = noAnswer(obs) ? silent + 1 : 0;
                    const sent = { ...(obs.inputs?.length ? { inputs: obs.inputs } : {}), ...(obs.before ? { before: obs.before } : {}) };
                    if (obs.error) { out.push({ ...b, ...sent, result: "ERROR", why: obs.error }); continue; }
                    const failures = checkExpectation(c.expect, obs);
                    const accepted = markKnown(c.id, failures, known);
                    out.push({ ...b, ...sent, result: failures.length ? "FAIL" : "PASS", ...(failures.length ? { failures } : {}), ...(accepted ? { known_issues: accepted } : {}), ...(obs.truncated ? { truncated: true as const, note: "the answer was over 5 MB; only the first 5 MB were checked" } : {}) });
                } catch (err) {
                    out.push({ ...b, result: "ERROR", why: failed(err) });
                }
            }
        } finally {
            await adapters.closeAll();
        }
        const report = summarise({ mode: "run", manifest, targets: { [t.name]: where(t) }, cases: out, contracts: [], drift: [], usedDrift: new Set(), date: opts.date ?? today(), partial: !!opts.only?.length, settings: settingsOf(manifest, [], known), modelCalls: models.tally, excludedDrafts: selected.excluded, excludedCompareOnly: leftOut, compareOnlySurfaces: manifest.compare_only_surfaces, known: knownInReport(known, out, new Set(loadCases(manifest).map((c) => c.id))) });
        writeJson(path.join(dir, "REPORT.json"), report);
        fs.writeFileSync(path.join(dir, "REPORT.md"), renderReport(report), "utf8");
        ev.commit();
        return report;
    } finally {
        ev.release();
    }
}

/** cmtk compare: the reference and the candidate, answer by answer. */
export async function compare(manifest: Manifest, opts: RunOptions = {}): Promise<Report> {
    const ref = target(manifest, manifest.reference, "reference");
    const cand = target(manifest, manifest.candidate, "candidate");
    if (ref.name === cand.name) throw new ManifestError("The reference and the candidate are the same target; comparing needs two systems.");
    const cases = selectCases(manifest, "compare", opts.only, opts.acceptedOnly);
    const drift = loadDrift(manifest);
    scrubberOf(manifest); // a bad scrub rule stops the run here, before any evidence is touched
    const extra = envHeaders(manifest);
    const adapters = adaptersFor(manifest);
    const ev = evidenceDir(manifest, "compare", opts);
    try {
        const dir = ev.dir;
        const used = new Set<string>();
        const fired = new Map<string, number>(scrubRules(manifest.scrub).map((rule) => [rule, 0]));
        const contracts: ContractOutcome[] = [];
        const out: CaseOutcome[] = [];
        const models = modelCalls();
        let silent = 0; // cases in a row where a system gave no answer
        const asked = new Map<string, boolean>();
        const asksForResetBeforeReads = async (surface: string, adapter: Adapter) => {
            if (!asked.has(surface)) {
                // Only a clear yes counts. An adapter that can't say gets no reset, which at worst shows a difference.
                const d = await adapter.describe?.().catch(() => undefined) as { reset_before_reads?: unknown } | undefined;
                asked.set(surface, d?.reset_before_reads === true);
            }
            return asked.get(surface)!;
        };
        try {
            const http = adapters.get("http");
            for (const k of manifest.contracts) {
                if (k.kind === "assembly") {
                    // Read from files through REA, so neither system needs to be up, and neither is run.
                    const outcome = checkAssemblyContract(manifest, k);
                    for (const f of outcome.findings) {
                        const hit = f.where ? coveringDrift(drift, `contract-${k.name}`, f.where) : undefined;
                        if (hit) { f.drift = hit.id; used.add(hit.id); }
                    }
                    contracts.push(outcome);
                    continue;
                }
                const missing = lacking("http", ref, cand);
                if (missing.length) { contracts.push({ name: k.name, kind: k.kind, result: "NOT COMPARABLE", findings: [{ breaking: null, what: `not comparable: ${hasNo(missing, "http")}` }] }); continue; }
                const probe: Case = { id: `contract-${k.name}`, request: { method: "GET", path: k.path } };
                const [a, b] = [await http.run(probe, ref, extra), await http.run(probe, cand, extra)];
                const slug = k.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
                if (a.body !== undefined) fs.writeFileSync(path.join(dir, "answers", `contract-${slug}.reference.txt`), a.body, "utf8");
                if (b.body !== undefined) fs.writeFileSync(path.join(dir, "answers", `contract-${slug}.candidate.txt`), b.body, "utf8");
                const outcome = checkContract(k, a, b);
                for (const f of outcome.findings) {
                    const hit = f.where ? coveringDrift(drift, `contract-${k.name}`, f.where) : undefined;
                    if (hit) { f.drift = hit.id; used.add(hit.id); }
                }
                contracts.push(outcome);
            }
            for (const c of cases) {
                const b: Omit<CaseOutcome, "result"> & { match: MatchLevel } = { ...base(c), match: matchFor(c, manifest) };
                const gap = noAdapter(c, manifest);
                if (gap) { out.push({ ...b, ...gap }); continue; }
                if (c.draft) { out.push({ ...b, result: "SKIPPED", why: DRAFT_WHY }); continue; }
                const missing = lacking(b.surface, ref, cand);
                if (missing.length) { out.push({ ...b, result: "NOT COMPARABLE", why: `not comparable: ${hasNo(missing, b.surface)}` }); continue; }
                if (unsafe(c, manifest, opts)) { out.push({ ...b, result: "SKIPPED", why: unsafeWhy(c) }); continue; }
                if (silent >= STOP_AFTER_NO_ANSWER) { out.push({ ...b, result: "SKIPPED", why: STOPPED_WHY }); continue; }
                try {
                    const adapter = adapters.get(b.surface);
                    // A reset is for a case that changes something. Before a read it would wipe the very state the read came to compare.
                    const reads = !writes(c) || safeConfirmed(c, manifest.root);
                    const clean = !!adapter.reset && (!reads || await asksForResetBeforeReads(b.surface, adapter));
                    if (clean) { await adapter.reset!(ref); await adapter.reset!(cand); }
                    if (adapter.reset && !clean) b.note = NOT_RESET_NOTE;
                    const sent = asSent(c, manifest);
                    const ra = await adapter.run(sent, ref, extra);
                    const rb = await adapter.run(sent, cand, extra);
                    writeJson(path.join(dir, "answers", `${c.id}.reference.json`), evidenceOf(ra, path.join(dir, "answers"), `${c.id}.reference`));
                    writeJson(path.join(dir, "answers", `${c.id}.candidate.json`), evidenceOf(rb, path.join(dir, "answers"), `${c.id}.candidate`));
                    models.add(b.surface, ra);
                    models.add(b.surface, rb);
                    silent = noAnswer(ra) || noAnswer(rb) ? silent + 1 : 0;
                    if (ra.inputs?.length) b.inputs = ra.inputs;
                    if (ra.before) b.before = ra.before;
                    if (ra.error || rb.error) {
                        out.push({ ...b, result: "ERROR", why: [ra.error && `reference: ${ra.error}`, rb.error && `candidate: ${rb.error}`].filter(Boolean).join("; ") });
                        continue;
                    }
                    const diffs = compareObservations(ra, rb, manifest, b.match, fired);
                    for (const d of diffs) {
                        const hit = coveringDrift(drift, c.id, d.where);
                        if (hit) { d.drift = hit.id; used.add(hit.id); }
                    }
                    const open = diffs.filter((d) => !d.drift);
                    out.push({
                        ...b,
                        result: open.length ? "DIFFERENT" : diffs.length ? "DRIFT" : "MATCH",
                        ...(diffs.length ? { differences: diffs } : {}),
                        ...(ra.truncated || rb.truncated ? { truncated: true as const, note: [b.note, "an answer was over 5 MB; only the first 5 MB were compared"].filter(Boolean).join("; ") } : {}),
                    });
                } catch (err) {
                    out.push({ ...b, result: "ERROR", why: failed(err) });
                }
            }
        } finally {
            await adapters.closeAll();
        }
        const report = summarise({ mode: "compare", manifest, targets: { [ref.name]: where(ref), [cand.name]: where(cand) }, cases: out, contracts, drift, usedDrift: used, date: opts.date ?? today(), partial: !!opts.only?.length, settings: settingsOf(manifest, drift), modelCalls: models.tally, excludedDrafts: cases.excluded, surfaces: { [ref.name]: ref.surfaces, [cand.name]: cand.surfaces }, ...(fired.size ? { scrubFired: Object.fromEntries(fired) } : {}) });
        writeJson(path.join(dir, "REPORT.json"), report);
        fs.writeFileSync(path.join(dir, "REPORT.md"), renderReport(report), "utf8");
        ev.commit();
        return report;
    } finally {
        ev.release();
    }
}
