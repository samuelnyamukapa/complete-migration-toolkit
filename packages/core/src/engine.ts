// The two things the toolkit does:
//   run      one target, every case checked against what its requirement expects
//   compare  the reference and the candidate, every case sent to both and the answers diffed,
//            with approved drift expected and everything else reported
// Both write their evidence and a report into the evidence folder. Neither signs anything.
import fs from "node:fs";
import path from "node:path";

import { httpAdapter, processAdapter, type Adapter } from "./adapters.js";
import { checkContract } from "./contracts.js";
import { compareObservations } from "./diff.js";
import { coveringDrift } from "./drift.js";
import { checkExpectation } from "./expect.js";
import { inside, loadCases, loadDrift, ManifestError } from "./manifest.js";
import { renderReport, summarise } from "./report.js";
import type { Case, CaseOutcome, ContractOutcome, Manifest, MatchLevel, Report, Target } from "./types.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RunOptions {
    /** Replay requests that change data. Needs allow_unsafe_methods in cmtk.yaml as well. */
    allowUnsafe?: boolean;
    /** Only these case ids. */
    only?: string[];
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

function adaptersFor(manifest: Manifest) {
    const cache = new Map<string, Adapter>();
    return {
        get(surface: string): Adapter {
            const s = surface || "http";
            if (!cache.has(s)) {
                if (s === "http") cache.set(s, httpAdapter({ timeoutS: manifest.timeout_s, insecureTls: manifest.insecure_tls }));
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

function selectCases(manifest: Manifest, only?: string[]): Case[] {
    const all = loadCases(manifest);
    if (!only?.length) return all;
    const ids = new Set(all.map((c) => c.id));
    const unknown = only.filter((i) => !ids.has(i));
    if (unknown.length) throw new ManifestError(`Unknown case ids: ${unknown.join(", ")}.`);
    return all.filter((c) => only.includes(c.id));
}

const requirementsOf = (c: Case) => (c.requirement === undefined ? [] : Array.isArray(c.requirement) ? c.requirement.map(String) : [String(c.requirement)]);

function base(c: Case): Omit<CaseOutcome, "result"> {
    return { id: c.id, name: c.name ?? `${c.request.method} ${c.request.path}`, requirement: requirementsOf(c), surface: c.surface ?? "http" };
}

function unsafe(c: Case, manifest: Manifest, opts: RunOptions) {
    const safe = SAFE_METHODS.has(c.request.method) || c.safe === true;
    return !safe && !(manifest.allow_unsafe_methods && opts.allowUnsafe);
}

const UNSAFE_WHY = "changes data: needs allow_unsafe_methods in cmtk.yaml and --allow-unsafe on this run";

function evidenceDir(manifest: Manifest, mode: string): string {
    const dir = inside(manifest, path.join(manifest.evidence, mode));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "answers"), { recursive: true });
    return dir;
}

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
    const cases = selectCases(manifest, opts.only);
    const extra = envHeaders(manifest);
    const adapters = adaptersFor(manifest);
    const dir = evidenceDir(manifest, "run");
    const out: CaseOutcome[] = [];
    try {
        for (const c of cases) {
            const b = base(c);
            if (!c.expect) { out.push({ ...b, result: "SKIPPED", why: "no `expect:` block, so there is nothing to check on one system" }); continue; }
            if (unsafe(c, manifest, opts)) { out.push({ ...b, result: "SKIPPED", why: UNSAFE_WHY }); continue; }
            const obs = await adapters.get(b.surface).run(c, t, extra);
            writeJson(path.join(dir, "answers", `${c.id}.json`), obs);
            if (obs.error) { out.push({ ...b, result: "ERROR", why: obs.error }); continue; }
            const failures = checkExpectation(c.expect, obs);
            out.push({ ...b, result: failures.length ? "FAIL" : "PASS", ...(failures.length ? { failures } : {}), ...(obs.truncated ? { note: "the answer was over 5 MB; only the first 5 MB were checked" } : {}) });
        }
    } finally {
        await adapters.closeAll();
    }
    const report = summarise({ mode: "run", manifest, targets: { [t.name]: t.base_url }, cases: out, contracts: [], drift: [], usedDrift: new Set(), date: opts.date ?? today(), partial: !!opts.only?.length });
    writeJson(path.join(dir, "REPORT.json"), report);
    fs.writeFileSync(path.join(dir, "REPORT.md"), renderReport(report), "utf8");
    return report;
}

/** cmtk compare: the reference and the candidate, answer by answer. */
export async function compare(manifest: Manifest, opts: RunOptions = {}): Promise<Report> {
    const ref = target(manifest, manifest.reference, "reference");
    const cand = target(manifest, manifest.candidate, "candidate");
    if (ref.name === cand.name) throw new ManifestError("The reference and the candidate are the same target; comparing needs two systems.");
    const cases = selectCases(manifest, opts.only);
    const drift = loadDrift(manifest);
    const extra = envHeaders(manifest);
    const adapters = adaptersFor(manifest);
    const dir = evidenceDir(manifest, "compare");
    const used = new Set<string>();
    const contracts: ContractOutcome[] = [];
    const out: CaseOutcome[] = [];
    try {
        const http = adapters.get("http");
        for (const k of manifest.contracts) {
            const probe: Case = { id: `contract-${k.name}`, request: { method: "GET", path: k.path } };
            const [a, b] = [await http.run(probe, ref, extra), await http.run(probe, cand, extra)];
            const slug = k.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
            if (a.body !== undefined) fs.writeFileSync(path.join(dir, "answers", `contract-${slug}.reference.txt`), a.body, "utf8");
            if (b.body !== undefined) fs.writeFileSync(path.join(dir, "answers", `contract-${slug}.candidate.txt`), b.body, "utf8");
            contracts.push(checkContract(k, a, b));
        }
        for (const c of cases) {
            const b = { ...base(c), match: matchFor(c, manifest) };
            if (unsafe(c, manifest, opts)) { out.push({ ...b, result: "SKIPPED", why: UNSAFE_WHY }); continue; }
            const adapter = adapters.get(b.surface);
            if (adapter.reset) { await adapter.reset(ref); await adapter.reset(cand); }
            const ra = await adapter.run(c, ref, extra);
            const rb = await adapter.run(c, cand, extra);
            writeJson(path.join(dir, "answers", `${c.id}.reference.json`), ra);
            writeJson(path.join(dir, "answers", `${c.id}.candidate.json`), rb);
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
        }
    } finally {
        await adapters.closeAll();
    }
    const report = summarise({ mode: "compare", manifest, targets: { [ref.name]: ref.base_url, [cand.name]: cand.base_url }, cases: out, contracts, drift, usedDrift: used, date: opts.date ?? today(), partial: !!opts.only?.length });
    writeJson(path.join(dir, "REPORT.json"), report);
    fs.writeFileSync(path.join(dir, "REPORT.md"), renderReport(report), "utf8");
    return report;
}
