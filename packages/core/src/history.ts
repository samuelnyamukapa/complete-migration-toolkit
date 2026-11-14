// Dated evidence and clean-up. The latest run still lives in <evidence>/<mode>, where `cmtk status` and
// `cmtk signoff` read it. A dated run is a copy in <evidence>/history/<mode>/<date and time>.
// Nothing here follows a link: a link is never copied, never counted, and never walked through, and clean-up
// only removes real folders with a dated name inside the evidence folder.
import fs from "node:fs";
import path from "node:path";

import { ManifestError, ownedFolder } from "./manifest.js";
import type { EvidenceHistory, Manifest } from "./types.js";

export const HISTORY_MODES = ["run", "compare", "shadow"] as const;
export type HistoryMode = (typeof HISTORY_MODES)[number];

export const DEFAULT_HISTORY: EvidenceHistory = { dated: false, keep_days: 90, max_mb: 1024 };

/** 2026-11-04T02-17-00Z: sorts by time, and is a legal file name on Windows. A second run in the same second gets -2. */
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-\d+)?$/;

export const stampOf = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

/** The time a dated folder's name holds, or undefined for any other name. */
export function stampTime(name: string): number | undefined {
    const m = STAMP.exec(name);
    if (!m) return undefined;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    return Number.isNaN(t) ? undefined : t;
}

export const historyFolder = (manifest: Manifest) => ownedFolder(manifest, path.join(manifest.evidence, "history"));

const lstat = (p: string) => {
    try { return fs.lstatSync(p); } catch { return undefined; }
};

/** A real folder, and not a link to one. On Windows a junction counts as a link. */
const isRealDir = (p: string) => {
    const s = lstat(p);
    return !!s && s.isDirectory() && !s.isSymbolicLink();
};

/** Regular files and real folders only: a link in the evidence is not evidence. */
function copyTree(from: string, to: string) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) copyTree(a, b);
        else if (e.isFile()) fs.copyFileSync(a, b);
    }
}

/** The size of a folder in bytes. Links are not followed: a link counts for itself. */
export function sizeOf(dir: string): number {
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const s = lstat(p);
        if (!s) continue;
        total += s.isDirectory() && !s.isSymbolicLink() ? sizeOf(p) : s.size;
    }
    return total;
}

/** The dated runs of one mode, oldest first. A link, or a folder with any other name, is not a run. */
export function datedRuns(manifest: Manifest, mode: HistoryMode): { name: string; dir: string; time: number }[] {
    const parent = path.join(historyFolder(manifest), mode);
    if (!isRealDir(parent)) return [];
    const out: { name: string; dir: string; time: number }[] = [];
    for (const name of fs.readdirSync(parent).sort()) {
        const dir = path.join(parent, name);
        const time = stampTime(name);
        if (time !== undefined && isRealDir(dir)) out.push({ name, dir, time });
    }
    return out;
}

/** Copy a finished run into its dated folder, then apply the clean-up rule. Returns the folder and what was removed. */
export function keepDated(manifest: Manifest, mode: HistoryMode, final: string, now = new Date()): { name: string; removed: string[]; warnings: string[] } {
    const parent = path.join(historyFolder(manifest), mode);
    if (lstat(parent)?.isSymbolicLink()) throw new ManifestError(`${path.relative(manifest.root, parent)} is a link, so no dated copy was kept. The evidence folder never follows a link.`);
    fs.mkdirSync(parent, { recursive: true });
    const base = stampOf(now);
    let name = base;
    for (let n = 2; lstat(path.join(parent, name)); n++) name = `${base}-${n}`;
    const work = path.join(parent, `.${name}.partial`);
    fs.rmSync(work, { recursive: true, force: true });
    copyTree(final, work);
    fs.renameSync(work, path.join(parent, name));
    const { removed, warnings } = cleanHistory(manifest, { now });
    return { name, removed, warnings };
}

export interface CleanOptions {
    keepDays?: number;
    keepRuns?: number;
    maxMb?: number;
    dryRun?: boolean;
    now?: Date;
}

/**
 * Remove old dated runs by the rule: older than keep_days, more than keep_runs per mode, then the oldest
 * until the history fits max_mb. The newest run of each mode and a run with a signature in it are always kept.
 * Only real, dated folders are removed. A link is left alone, and what it points to is never touched.
 */
export function cleanHistory(manifest: Manifest, o: CleanOptions = {}): { removed: string[]; kept: number; bytes: number; warnings: string[] } {
    const rule = manifest.evidence_history;
    const keepDays = o.keepDays ?? rule.keep_days;
    const keepRuns = o.keepRuns ?? rule.keep_runs;
    const maxBytes = (o.maxMb ?? rule.max_mb) * 1024 * 1024;
    const now = (o.now ?? new Date()).getTime();
    const root = historyFolder(manifest);
    const warnings: string[] = [];
    if (!isRealDir(root)) return { removed: [], kept: 0, bytes: 0, warnings };
    for (const mode of fs.readdirSync(root)) {
        const p = path.join(root, mode);
        if (lstat(p)?.isSymbolicLink()) warnings.push(`history/${mode} is a link. It was not followed, and nothing it points to was touched.`);
        else if (isRealDir(p)) {
            for (const name of fs.readdirSync(p)) {
                if (stampTime(name) !== undefined && lstat(path.join(p, name))?.isSymbolicLink()) warnings.push(`history/${mode}/${name} is a link. It was not followed, and nothing it points to was touched.`);
            }
        }
    }
    const runs = HISTORY_MODES.flatMap((mode) => {
        const list = datedRuns(manifest, mode);
        return list.map((r, i) => ({ ...r, mode, label: `${mode}/${r.name}`, newest: i === list.length - 1, fromNewest: list.length - 1 - i, bytes: sizeOf(r.dir), signed: fs.existsSync(path.join(r.dir, "SIGNOFF.json")) }));
    }).sort((a, b) => a.time - b.time || a.label.localeCompare(b.label));
    const removing = new Set<string>();
    for (const r of runs) {
        if (r.newest || r.signed) continue;
        if (keepDays !== undefined && now - r.time > keepDays * 86_400_000) removing.add(r.label);
        if (keepRuns !== undefined && r.fromNewest >= keepRuns) removing.add(r.label);
    }
    let total = runs.filter((r) => !removing.has(r.label)).reduce((n, r) => n + r.bytes, 0);
    for (const r of runs) {
        if (total <= maxBytes) break;
        if (r.newest || r.signed || removing.has(r.label)) continue;
        removing.add(r.label);
        total -= r.bytes;
    }
    if (total > maxBytes) warnings.push(`The history is ${Math.ceil(total / 1024 / 1024)} MB, over the limit of ${o.maxMb ?? rule.max_mb} MB. What is left is the newest run of each mode and signed runs, which are always kept.`);
    if (!o.dryRun) {
        for (const r of runs) {
            // Checked again here, right before the removal. fs.rmSync removes a link inside a run, never what it points to.
            if (removing.has(r.label) && isRealDir(r.dir)) fs.rmSync(r.dir, { recursive: true, force: true });
        }
    }
    return { removed: runs.filter((r) => removing.has(r.label)).map((r) => r.label), kept: runs.length - removing.size, bytes: total, warnings };
}

/** Read `evidence_history:` from cmtk.yaml. */
export function historyOf(raw: unknown): EvidenceHistory {
    if (raw === undefined || raw === null) return { ...DEFAULT_HISTORY };
    if (typeof raw !== "object" || Array.isArray(raw)) throw new ManifestError("`evidence_history` must be a mapping, such as { dated: true, keep_days: 30, max_mb: 500 }.");
    const r = raw as Record<string, unknown>;
    if (r.dated !== undefined && typeof r.dated !== "boolean") throw new ManifestError("`evidence_history.dated` must be true or false.");
    const num = (k: "keep_days" | "keep_runs" | "max_mb") => {
        if (r[k] === undefined || r[k] === null) return undefined;
        const n = Number(r[k]);
        if (!Number.isFinite(n) || n <= 0) throw new ManifestError(`\`evidence_history.${k}\` must be a number above 0.`);
        return n;
    };
    const keepDays = num("keep_days"), keepRuns = num("keep_runs"), maxMb = num("max_mb");
    return { dated: r.dated === true, keep_days: keepDays ?? DEFAULT_HISTORY.keep_days, ...(keepRuns ? { keep_runs: keepRuns } : {}), max_mb: maxMb ?? DEFAULT_HISTORY.max_mb };
}
