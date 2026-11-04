// `cmtk trend`: read the dated reports of one mode and say what they show together. One clean run can hide
// differences that come and go. Every line here comes from a stored report; nothing is sent, and no report changes.
import fs from "node:fs";
import path from "node:path";

import { datedRuns, HISTORY_MODES, type HistoryMode } from "./history.js";
import { ownedFolder } from "./manifest.js";
import type { ShadowReport } from "./shadow.js";
import type { Manifest, Report } from "./types.js";

export interface TrendRun {
    /** The dated folder: when the run finished, in UTC. */
    run: string;
    verdict: string;
    counts: Record<string, number>;
    partial: boolean;
}

export interface TrendDifference {
    /** A `where` from the reports, with list positions as [*], or a failed check of `cmtk run`. */
    where: string;
    /** new: only in the latest run. keeps coming back: in the latest run and an earlier one. gone: not in the latest run, though it checked this. not checked: the latest run did not reach these cases. */
    state: "new" | "keeps coming back" | "gone" | "not checked";
    runs: number;
    first_seen: string;
    last_seen: string;
    cases: string[];
    /** True when a person accepted every occurrence: approved drift or a known issue. */
    approved: boolean;
}

export interface TrendFlaky {
    case: string;
    passed: number;
    failed: number;
    /** How many times the result changed between one run and the next. */
    flips: number;
    errors: number;
    latest: string;
}

export interface TrendReport {
    tool: "cmtk";
    mode: HistoryMode;
    system: string;
    runs: TrendRun[];
    /** Reports in the history that could not be read: named, never guessed at. */
    unreadable: string[];
    differences: TrendDifference[];
    flaky: TrendFlaky[];
    /** Cases that changed once and stayed changed. A single change cannot be called flaky. */
    fixed: string[];
    regressed: string[];
    /** Drift entries that matched in an earlier run and matched nothing in the latest. */
    drift_stopped_matching: string[];
    drift_never_matched: string[];
    /** Scrub rules in the latest settings that changed nothing in any run that records it. Empty when no run records it. */
    scrubs_never_fired: string[];
    /** The runs whose settings file differs from the run before: a verdict can change because a scrub or a drift entry did. */
    settings_changed: string[];
    summary: string;
}

interface Row {
    run: TrendRun;
    results: Map<string, "pass" | "fail" | "error" | "other">;
    places: { where: string; case: string; approved: boolean }[];
    used: Set<string>;
    unused: string[];
    fired?: Record<string, number>;
    scrubs?: string[];
    sha?: string;
}

const position = (w: string) => w.replace(/\[\d+\]/g, "[*]");
const RESULT: Record<string, "pass" | "fail" | "error"> = { PASS: "pass", MATCH: "pass", DRIFT: "pass", FAIL: "fail", DIFFERENT: "fail", ERROR: "error" };

export function scrubRules(s: { json_paths?: string[]; xml_ignore?: string[]; regex?: { pattern: string }[] } | undefined): string[] {
    return [...(s?.json_paths ?? []).map((p) => `json_path ${p}`), ...(s?.xml_ignore ?? []).map((e) => `xml_ignore ${e}`), ...(s?.regex ?? []).map((r) => `regex ${r.pattern}`)];
}

function fromReport(name: string, r: Report): Row {
    const results = new Map<string, Row["results"] extends Map<string, infer V> ? V : never>();
    const places: Row["places"] = [];
    const used = new Set<string>();
    for (const c of r.cases ?? []) {
        results.set(c.id, RESULT[c.result] ?? "other");
        for (const d of c.differences ?? []) {
            places.push({ where: position(d.where), case: c.id, approved: !!d.drift });
            if (d.drift) used.add(d.drift);
        }
        for (const f of c.failures ?? []) places.push({ where: position(f.check), case: c.id, approved: !!f.known_issue });
    }
    for (const k of r.contracts ?? []) {
        for (const f of k.findings ?? []) {
            if (f.drift) used.add(f.drift);
            if (f.where) places.push({ where: f.where, case: `contract-${k.name}`, approved: !!f.drift });
        }
    }
    return { run: { run: name, verdict: r.verdict, counts: r.counts ?? {}, partial: !!r.partial }, results, places, used, unused: r.unused_drift ?? [], ...(r.scrub_fired ? { fired: r.scrub_fired } : {}), scrubs: scrubRules(r.settings?.scrub), ...(r.settings?.manifest_sha256 ? { sha: r.settings.manifest_sha256 } : {}) };
}

function fromShadow(name: string, r: ShadowReport): Row {
    const results = new Map<string, "pass" | "fail" | "error" | "other">();
    const places: Row["places"] = [];
    const used = new Set<string>();
    for (const e of r.endpoints ?? []) {
        results.set(e.endpoint, e.unexplained ? "fail" : e.errors && !e.matched && !e.drift ? "error" : "pass");
        for (const d of e.differences ?? []) {
            places.push({ where: d.where, case: e.endpoint, approved: !!d.drift });
            if (d.drift) used.add(d.drift);
        }
    }
    const p = r.replay;
    const counts = { SENT: p?.sent ?? 0, MATCHED: p?.matched ?? 0, DRIFT: p?.drift ?? 0, UNEXPLAINED: p?.different ?? 0, ERROR: p?.errors ?? 0, "NOT SENT": p?.not_sent ?? 0, DROPPED: r.capture?.dropped_total ?? 0 };
    return { run: { run: name, verdict: r.verdict, counts, partial: false }, results, places, used, unused: r.unused_drift ?? [], ...(r.scrub_fired ? { fired: r.scrub_fired } : {}), scrubs: scrubRules(r.settings?.scrub), ...(r.settings?.manifest_sha256 ? { sha: r.settings.manifest_sha256 } : {}) };
}

/** Build the trend from dated reports, oldest first. Exported apart so a test can feed it a known series. */
export function trendOf(mode: HistoryMode, system: string, rows: Row[], unreadable: string[]): TrendReport {
    const latest = rows[rows.length - 1];
    const places = new Map<string, { runs: Set<string>; cases: Set<string>; first: string; last: string; approved: boolean }>();
    for (const row of rows) {
        for (const p of row.places) {
            const e = places.get(p.where) ?? { runs: new Set(), cases: new Set(), first: row.run.run, last: row.run.run, approved: true };
            e.runs.add(row.run.run);
            e.cases.add(p.case);
            e.last = row.run.run;
            e.approved &&= p.approved;
            places.set(p.where, e);
        }
    }
    const STATE_ORDER = { new: 0, "keeps coming back": 1, "not checked": 2, gone: 3 };
    const differences: TrendDifference[] = [...places].map(([where, e]) => {
        const inLatest = !!latest && e.runs.has(latest.run.run);
        const checkedInLatest = !!latest && [...e.cases].some((c) => ["pass", "fail"].includes(latest.results.get(c) ?? "") || c.startsWith("contract-"));
        const state: TrendDifference["state"] = inLatest ? (e.runs.size === 1 ? "new" : "keeps coming back") : checkedInLatest ? "gone" : "not checked";
        return { where, state, runs: e.runs.size, first_seen: e.first, last_seen: e.last, cases: [...e.cases].sort(), approved: e.approved };
    }).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || Number(a.approved) - Number(b.approved) || b.runs - a.runs || a.where.localeCompare(b.where));

    const flaky: TrendFlaky[] = [];
    const fixed: string[] = [], regressed: string[] = [];
    const ids = new Set(rows.flatMap((r) => [...r.results.keys()]));
    for (const id of [...ids].sort()) {
        const seq = rows.map((r) => r.results.get(id)).filter((x) => x === "pass" || x === "fail");
        let flips = 0;
        for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) flips++;
        const errors = rows.filter((r) => r.results.get(id) === "error").length;
        if (flips >= 2) flaky.push({ case: id, passed: seq.filter((x) => x === "pass").length, failed: seq.filter((x) => x === "fail").length, flips, errors, latest: latest?.results.get(id) ?? "not in the latest run" });
        else if (flips === 1) (seq[seq.length - 1] === "pass" ? fixed : regressed).push(id);
    }
    flaky.sort((a, b) => b.flips - a.flips || a.case.localeCompare(b.case));

    const everUsed = new Set(rows.flatMap((r) => [...r.used]));
    const unused = latest?.unused ?? [];
    const recorded = rows.filter((r) => r.fired);
    const fired = new Set(recorded.flatMap((r) => Object.entries(r.fired!).filter(([, n]) => n > 0).map(([k]) => k)));
    const settingsChanged: string[] = [];
    for (let i = 1; i < rows.length; i++) if (rows[i]!.sha && rows[i - 1]!.sha && rows[i]!.sha !== rows[i - 1]!.sha) settingsChanged.push(rows[i]!.run.run);

    const open = differences.filter((d) => !d.approved);
    const count = (s: TrendDifference["state"]) => open.filter((d) => d.state === s).length;
    const summary = !rows.length ? "No readable dated runs." : `${rows.length} run${rows.length === 1 ? "" : "s"} from ${rows[0]!.run.run} to ${latest!.run.run}. Latest verdict: ${latest!.run.verdict}. Differences no person accepted: ${count("new")} new, ${count("keeps coming back")} keep coming back, ${count("gone")} gone. ${flaky.length} flaky.`;
    return {
        tool: "cmtk", mode, system, runs: rows.map((r) => r.run), unreadable, differences, flaky, fixed, regressed,
        drift_stopped_matching: unused.filter((d) => everUsed.has(d)).sort(),
        drift_never_matched: unused.filter((d) => !everUsed.has(d)).sort(),
        scrubs_never_fired: recorded.length ? (latest?.scrubs ?? []).filter((s) => !fired.has(s)) : [],
        settings_changed: settingsChanged,
        summary,
    };
}

const cell = (v: unknown) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/`/g, "'");

export function renderTrend(t: TrendReport): string {
    const L = [`# Trend report: ${t.system} (${t.mode})`, "", t.summary, "", "Read from the dated reports in the evidence folder. Nothing was sent. Run times are in UTC. Only a person signs a report: this one is not signed.", ""];
    L.push("## Verdict over time", "", "| Run | Verdict | Counts |", "| --- | --- | --- |");
    for (const r of t.runs) L.push(`| ${r.run} | ${cell(r.verdict)}${r.partial ? " (partial run)" : ""} | ${cell(Object.entries(r.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", "))} |`);
    if (t.settings_changed.length) L.push("", `The settings file changed before: ${t.settings_changed.join(", ")}. A verdict can change because a scrub or a drift entry did, so read what changed.`);
    if (t.unreadable.length) L.push("", `Could not be read, so not counted: ${t.unreadable.join(", ")}.`);
    L.push("", "## Differences by where", "");
    if (t.differences.length) {
        L.push("| Where | State | Runs | First seen | Last seen | Accepted by a person | Cases |", "| --- | --- | --- | --- | --- | --- | --- |");
        for (const d of t.differences.slice(0, 500)) L.push(`| \`${cell(d.where)}\` | ${d.state} | ${d.runs} of ${t.runs.length} | ${d.first_seen} | ${d.last_seen} | ${d.approved ? "yes" : "no"} | ${cell(d.cases.slice(0, 5).join(", "))}${d.cases.length > 5 ? `, and ${d.cases.length - 5} more` : ""} |`);
        if (t.differences.length > 500) L.push("", `${t.differences.length - 500} more are in TREND.json.`);
    } else L.push("None in these runs.");
    L.push("", "## Flaky cases", "", "A case whose result changed at least twice: it passes sometimes and fails sometimes.", "");
    if (t.flaky.length) {
        L.push(`| ${t.mode === "shadow" ? "Endpoint" : "Case"} | Passed | Failed | Changes | Errors | Latest |`, "| --- | --- | --- | --- | --- | --- |");
        for (const f of t.flaky) L.push(`| ${cell(f.case)} | ${f.passed} | ${f.failed} | ${f.flips} | ${f.errors} | ${f.latest} |`);
    } else L.push("None.");
    if (t.regressed.length) L.push("", `Started failing and stayed that way: ${cell(t.regressed.join(", "))}.`);
    if (t.fixed.length) L.push("", `Started passing and stayed that way: ${cell(t.fixed.join(", "))}.`);
    L.push("", "## Ledger and settings to check", "");
    const lines = [
        t.drift_stopped_matching.length && `- Drift entries that stopped matching: ${cell(t.drift_stopped_matching.join(", "))}. They matched earlier and match nothing now. A person checks whether they are still needed.`,
        t.drift_never_matched.length && `- Drift entries that have never matched in these runs: ${cell(t.drift_never_matched.join(", "))}.`,
        t.scrubs_never_fired.length && `- Scrub rules that never fired in these runs: ${t.scrubs_never_fired.map((s) => `\`${cell(s)}\``).join(", ")}. A rule that hides nothing may be mistyped, or no longer needed.`,
    ].filter(Boolean) as string[];
    L.push(...(lines.length ? lines : ["Nothing to check."]), "");
    return L.join("\n");
}

/** The mode with the newest dated run. */
function newestMode(manifest: Manifest): HistoryMode | undefined {
    let best: { mode: HistoryMode; time: number } | undefined;
    for (const mode of HISTORY_MODES) {
        const runs = datedRuns(manifest, mode);
        const last = runs[runs.length - 1];
        if (last && (!best || last.time > best.time)) best = { mode, time: last.time };
    }
    return best?.mode;
}

/** cmtk trend: read the dated reports of one mode and write TREND.md and TREND.json. */
export function trend(manifest: Manifest, o: { mode?: HistoryMode; last?: number } = {}): { report: TrendReport; file?: string } {
    const mode = o.mode ?? newestMode(manifest) ?? "compare";
    let runs = datedRuns(manifest, mode);
    if (o.last !== undefined) runs = runs.slice(-o.last);
    const rows: Row[] = [];
    const unreadable: string[] = [];
    for (const r of runs) {
        try {
            const doc = JSON.parse(fs.readFileSync(path.join(r.dir, "REPORT.json"), "utf8"));
            if (typeof doc?.verdict !== "string") throw new Error("no verdict");
            rows.push(mode === "shadow" ? fromShadow(r.name, doc) : fromReport(r.name, doc));
        } catch {
            unreadable.push(r.name);
        }
    }
    const report = trendOf(mode, manifest.system, rows, unreadable);
    if (!rows.length) return { report };
    const dir = ownedFolder(manifest, path.join(manifest.evidence, "trend", mode));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TREND.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "TREND.md"), renderTrend(report), "utf8");
    return { report, file: path.relative(manifest.root, path.join(dir, "TREND.md")).split(path.sep).join("/") };
}
