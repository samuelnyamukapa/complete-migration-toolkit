// The two things the toolkit does:
//   run      one target, every case checked against what its requirement expects
//   compare  the reference and the candidate, every case sent to both and the answers diffed,
//            with approved drift expected and everything else reported
// Both write their evidence and a report into the evidence folder. Neither signs anything.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { httpAdapter, processAdapter, type Adapter } from "./adapters.js";
import { checkContract } from "./contracts.js";
import { cleanUrl } from "./defects.js";
import { compareObservations, scrubberOf } from "./diff.js";
import { coveringDrift } from "./drift.js";
import { checkExpectation } from "./expect.js";
import { loadCases, loadDrift, ManifestError, ownedFolder } from "./manifest.js";
import { renderReport, summarise } from "./report.js";
import type { Case, CaseOutcome, ContractOutcome, Drift, Manifest, MatchLevel, Report, ReportSettings, Target } from "./types.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

function selectCases(manifest: Manifest, only?: string[], acceptedOnly = false): Case[] & { excluded: number } {
    const picked = pick(manifest, only);
    if (!acceptedOnly) return Object.assign(picked, { excluded: 0 });
    return Object.assign(picked.filter((c) => !c.draft), { excluded: picked.filter((c) => c.draft).length });
}

function pick(manifest: Manifest, only?: string[]): Case[] {
    const all = loadCases(manifest);
    for (const c of all) {
        const s = c.surface ?? "http";
        if (s !== "http" && !manifest.adapters[s]) throw new ManifestError(`Case ${c.id} uses surface "${s}", which has no adapter. Add it under \`adapters:\` in cmtk.yaml, or run \`cmtk adapter new ${s}\`.`);
    }
    if (!only?.length) return all;
    const ids = new Set(all.map((c) => c.id));
    const unknown = only.filter((i) => !ids.has(i));
    if (unknown.length) throw new ManifestError(`Unknown case ids: ${unknown.join(", ")}.`);
    return all.filter((c) => only.includes(c.id));
}

const requirementsOf = (c: Case) => (c.requirement === undefined ? [] : Array.isArray(c.requirement) ? c.requirement.map(String) : [String(c.requirement)]);

function base(c: Case): Omit<CaseOutcome, "result"> {
    return { id: c.id, name: c.name ?? `${c.request.method} ${c.request.path}`, request: `${c.request.method} ${c.request.path}`, requirement: requirementsOf(c), surface: c.surface ?? "http" };
}

function unsafe(c: Case, manifest: Manifest, opts: RunOptions) {
    const safe = SAFE_METHODS.has(c.request.method) || c.safe === true;
    return !safe && !(manifest.allow_unsafe_methods && opts.allowUnsafe);
}

const DRAFT_WHY = "a draft: a person accepts it with `cmtk review` before it counts";
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
function evidenceDir(manifest: Manifest, mode: string) {
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
            return final;
        },
        release,
    };
}

const failed = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What produced a report: the settings file and everything in it that hides or approves a difference. */
export function settingsOf(manifest: Manifest, drift: Drift[]): ReportSettings {
    return {
        manifest: path.relative(manifest.root, manifest.file).split(path.sep).join("/"),
        manifest_sha256: crypto.createHash("sha256").update(fs.readFileSync(manifest.file)).digest("hex"),
        match: manifest.match,
        overrides: manifest.overrides,
        scrub: manifest.scrub,
        drift_file: manifest.drift,
        drift_entries: drift.length,
    };
}

/** How a report names a target: its address, or its adapter settings. */
const where = (t: Target) => (t.base_url ? cleanUrl(t.base_url) : undefined) ?? Object.entries(t).filter(([k]) => k !== "name").map(([k, v]) => `${k}=${v}`).join(", ");

const writeJson = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");

function target(manifest: Manifest, name: string | undefined, role: string): Target {
    if (!name) throw new ManifestError(`cmtk.yaml names no ${role} target. Set \`${role}:\` to one of: ${Object.keys(manifest.targets).join(", ")}.`);
    const t = manifest.targets[name];
    if (!t) throw new ManifestError(`No target called ${name}. Targets: ${Object.keys(manifest.targets).join(", ")}.`);
    return t;
}

/** cmtk run: one target, checked against expectations. */
export async function run(manifest: Manifest, opts: RunOptions = {}): Promise<Report> {
    const t = target(manifest, opts.target ?? manifest.default_target, "default_target");
    const cases = selectCases(manifest, opts.only, opts.acceptedOnly);
    const extra = envHeaders(manifest);
    const adapters = adaptersFor(manifest);
    const ev = evidenceDir(manifest, "run");
    try {
        const dir = ev.dir;
        const out: CaseOutcome[] = [];
        let silent = 0; // requests in a row with no answer
        try {
            for (const c of cases) {
                const b = base(c);
                if (c.draft) { out.push({ ...b, result: "SKIPPED", why: DRAFT_WHY }); continue; }
                if (!c.expect) { out.push({ ...b, result: "SKIPPED", why: "no `expect:` block, so there is nothing to check on one system" }); continue; }
                if (unsafe(c, manifest, opts)) { out.push({ ...b, result: "SKIPPED", why: UNSAFE_WHY }); continue; }
                if (silent >= STOP_AFTER_NO_ANSWER) { out.push({ ...b, result: "SKIPPED", why: STOPPED_WHY }); continue; }
                try {
                    const obs = await adapters.get(b.surface).run(c, t, extra);
                    writeJson(path.join(dir, "answers", `${c.id}.json`), obs);
                    silent = noAnswer(obs) ? silent + 1 : 0;
                    const sent = { ...(obs.inputs?.length ? { inputs: obs.inputs } : {}), ...(obs.before ? { before: obs.before } : {}) };
                    if (obs.error) { out.push({ ...b, ...sent, result: "ERROR", why: obs.error }); continue; }
                    const failures = checkExpectation(c.expect, obs);
                    out.push({ ...b, ...sent, result: failures.length ? "FAIL" : "PASS", ...(failures.length ? { failures } : {}), ...(obs.truncated ? { note: "the answer was over 5 MB; only the first 5 MB were checked" } : {}) });
                } catch (err) {
                    out.push({ ...b, result: "ERROR", why: failed(err) });
                }
            }
        } finally {
            await adapters.closeAll();
        }
        const report = summarise({ mode: "run", manifest, targets: { [t.name]: where(t) }, cases: out, contracts: [], drift: [], usedDrift: new Set(), date: opts.date ?? today(), partial: !!opts.only?.length, settings: settingsOf(manifest, []), excludedDrafts: cases.excluded });
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
    const cases = selectCases(manifest, opts.only, opts.acceptedOnly);
    const drift = loadDrift(manifest);
    scrubberOf(manifest); // a bad scrub rule stops the run here, before any evidence is touched
    const extra = envHeaders(manifest);
    const adapters = adaptersFor(manifest);
    const ev = evidenceDir(manifest, "compare");
    try {
        const dir = ev.dir;
        const used = new Set<string>();
        const contracts: ContractOutcome[] = [];
        const out: CaseOutcome[] = [];
        let silent = 0; // cases in a row where a system gave no answer
        try {
            const http = adapters.get("http");
            for (const k of manifest.contracts) {
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
                if (c.draft) { out.push({ ...b, result: "SKIPPED", why: DRAFT_WHY }); continue; }
                if (unsafe(c, manifest, opts)) { out.push({ ...b, result: "SKIPPED", why: UNSAFE_WHY }); continue; }
                if (silent >= STOP_AFTER_NO_ANSWER) { out.push({ ...b, result: "SKIPPED", why: STOPPED_WHY }); continue; }
                try {
                    const adapter = adapters.get(b.surface);
                    if (adapter.reset) { await adapter.reset(ref); await adapter.reset(cand); }
                    const ra = await adapter.run(c, ref, extra);
                    const rb = await adapter.run(c, cand, extra);
                    writeJson(path.join(dir, "answers", `${c.id}.reference.json`), ra);
                    writeJson(path.join(dir, "answers", `${c.id}.candidate.json`), rb);
                    silent = noAnswer(ra) || noAnswer(rb) ? silent + 1 : 0;
                    if (ra.inputs?.length) b.inputs = ra.inputs;
                    if (ra.before) b.before = ra.before;
                    if (ra.error || rb.error) {
                        out.push({ ...b, result: "ERROR", why: [ra.error && `reference: ${ra.error}`, rb.error && `candidate: ${rb.error}`].filter(Boolean).join("; ") });
                        continue;
                    }
                    const diffs = compareObservations(ra, rb, manifest, b.match);
                    for (const d of diffs) {
                        const hit = coveringDrift(drift, c.id, d.where);
                        if (hit) { d.drift = hit.id; used.add(hit.id); }
                    }
                    const open = diffs.filter((d) => !d.drift);
                    out.push({
                        ...b,
                        result: open.length ? "DIFFERENT" : diffs.length ? "DRIFT" : "MATCH",
                        ...(diffs.length ? { differences: diffs } : {}),
                        ...(ra.truncated || rb.truncated ? { note: "an answer was over 5 MB; only the first 5 MB were compared" } : {}),
                    });
                } catch (err) {
                    out.push({ ...b, result: "ERROR", why: failed(err) });
                }
            }
        } finally {
            await adapters.closeAll();
        }
        const report = summarise({ mode: "compare", manifest, targets: { [ref.name]: where(ref), [cand.name]: where(cand) }, cases: out, contracts, drift, usedDrift: used, date: opts.date ?? today(), partial: !!opts.only?.length, settings: settingsOf(manifest, drift), excludedDrafts: cases.excluded });
        writeJson(path.join(dir, "REPORT.json"), report);
        fs.writeFileSync(path.join(dir, "REPORT.md"), renderReport(report), "utf8");
        ev.commit();
        return report;
    } finally {
        ev.release();
    }
}
