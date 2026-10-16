// Verdicts and the report a person reads and signs. The numbers come from the run; nobody types them.
import type { CaseOutcome, ContractOutcome, Drift, Manifest, Report, Verdict } from "./types.js";

const NOISE: [string, RegExp][] = [
    ["a GUID", /^"?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"?$/],
    ["a timestamp", /^"?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/],
    ["a /Date()/ value", /^"?\\?\/Date\(\d+/],
];

function noise(cases: CaseOutcome[]) {
    const byWhere = new Map<string, { reference: string; candidate: string }[]>();
    for (const c of cases) {
        for (const d of c.differences ?? []) {
            if (d.drift) continue;
            const k = d.where.replace(/\[\d+\]/g, "[*]");
            byWhere.set(k, [...(byWhere.get(k) ?? []), d]);
        }
    }
    const out: Report["suggested_scrubs"] = [];
    for (const [where, ds] of [...byWhere].sort()) {
        const hit = NOISE.find(([, rx]) => ds.every((d) => rx.test(d.reference) && rx.test(d.candidate)));
        if (hit) out.push({ where, cases: ds.length, why: `both sides hold ${hit[0]} that changes on every call` });
    }
    return out;
}

export function summarise(x: {
    mode: "run" | "compare";
    manifest: Manifest;
    targets: Record<string, string>;
    cases: CaseOutcome[];
    contracts: ContractOutcome[];
    drift: Drift[];
    usedDrift: Set<string>;
    date: string;
    partial: boolean;
}): Report {
    const counts: Record<string, number> = {};
    const keys = x.mode === "run" ? ["PASS", "FAIL", "SKIPPED", "ERROR"] : ["MATCH", "DRIFT", "DIFFERENT", "SKIPPED", "ERROR"];
    for (const k of keys) counts[k] = x.cases.filter((c) => c.result === k).length;
    const breaking = x.contracts.some((c) => c.result === "BREAKING");
    const review = x.contracts.some((c) => c.result === "REVIEW" || c.result === "ERROR");
    const ran = x.cases.filter((c) => c.result !== "SKIPPED" && c.result !== "ERROR").length;
    let verdict: Verdict;
    if (x.mode === "run") {
        verdict = counts.FAIL ? "FAIL" : ran === 0 ? "NO EVIDENCE" : counts.SKIPPED || counts.ERROR ? "INCOMPLETE" : "PASS";
    } else if (breaking || counts.DIFFERENT) verdict = "NO PARITY";
    else if (ran === 0 && x.contracts.length === 0) verdict = "NO EVIDENCE";
    else if (counts.SKIPPED || counts.ERROR || review) verdict = "INCOMPLETE";
    else if (ran === 0) verdict = "NO EVIDENCE";
    else verdict = counts.DRIFT ? "DRIFT ONLY" : "PARITY";

    const reqs = new Map<string, { cases: number; passed: number; failed: number; other: number }>();
    for (const c of x.cases) {
        for (const r of c.requirement.length ? c.requirement : ["(no requirement named)"]) {
            const e = reqs.get(r) ?? { cases: 0, passed: 0, failed: 0, other: 0 };
            e.cases++;
            if (c.result === "PASS" || c.result === "MATCH" || c.result === "DRIFT") e.passed++;
            else if (c.result === "FAIL" || c.result === "DIFFERENT") e.failed++;
            else e.other++;
            reqs.set(r, e);
        }
    }
    return {
        tool: "cmtk",
        mode: x.mode,
        system: x.manifest.system,
        date: x.date,
        verdict,
        targets: x.targets,
        counts,
        cases: x.cases,
        contracts: x.contracts,
        requirements: [...reqs].map(([requirement, v]) => ({ requirement, ...v })).sort((a, b) => a.requirement.localeCompare(b.requirement)),
        unused_drift: x.drift.map((d) => d.id).filter((id) => !x.usedDrift.has(id)).sort(),
        suggested_scrubs: x.mode === "compare" ? noise(x.cases) : [],
        partial: x.partial,
    };
}

const cell = (v: unknown) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/`/g, "'");

export function renderReport(r: Report): string {
    const L: string[] = [];
    const title = r.mode === "run" ? "Test report" : "Comparison report";
    L.push(`# ${title}: ${r.system}`, "", `**Verdict: ${r.verdict}**${r.partial ? " (partial run: only some cases)" : ""}`, "");
    L.push(`- Date: ${r.date}`);
    for (const [name, url] of Object.entries(r.targets)) L.push(`- ${name}: \`${url}\``);
    L.push(`- Cases: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}`, "");
    L.push("Written by `cmtk " + r.mode + "` from the files in this folder. Do not edit the numbers: run it again.", "");

    L.push("## Requirements", "", "| Requirement | Cases | Passed | Failed | Not run |", "| --- | --- | --- | --- | --- |");
    for (const q of r.requirements) L.push(`| ${cell(q.requirement)} | ${q.cases} | ${q.passed} | ${q.failed} | ${q.other} |`);
    if (r.requirements.length === 0) L.push("| (no cases) | 0 | 0 | 0 | 0 |");

    if (r.mode === "compare") {
        L.push("", "## Contracts", "");
        if (r.contracts.length) {
            L.push("| Contract | Kind | Result | Findings |", "| --- | --- | --- | --- |");
            for (const k of r.contracts) L.push(`| ${cell(k.name)} | ${cell(k.kind)} | ${k.result} | ${cell(k.findings.map((f) => f.what).join("; ") || "none")} |`);
        } else L.push("No contracts are listed in cmtk.yaml, so none were checked.");
    }

    L.push("", "## Cases", "", r.mode === "compare" ? "| Case | Request | Level | Result |" : "| Case | Request | Requirement | Result |", "| --- | --- | --- | --- |");
    for (const c of r.cases) {
        const mid = r.mode === "compare" ? c.match ?? "" : c.requirement.join(", ") || "—";
        L.push(`| ${c.id} | ${cell(c.name)} | ${cell(mid)} | ${c.result}${c.why ? ` — ${cell(c.why)}` : ""} |`);
    }

    const fails = r.cases.flatMap((c) => (c.failures ?? []).map((f) => [c.id, f] as const));
    if (fails.length) {
        L.push("", "## Failures", "", "| Case | Check | Expected | Actual |", "| --- | --- | --- | --- |");
        for (const [id, f] of fails.slice(0, 500)) L.push(`| ${id} | \`${cell(f.check)}\` | ${cell(f.expected)} | ${cell(f.actual)} |`);
    }
    const diffs = r.cases.flatMap((c) => (c.differences ?? []).map((d) => [c.id, d] as const));
    if (diffs.length) {
        const [a, b] = Object.keys(r.targets);
        L.push("", "## Differences", "", `| Case | Where | ${a} | ${b} | Approved drift |`, "| --- | --- | --- | --- | --- |");
        for (const [id, d] of diffs.slice(0, 500)) L.push(`| ${id} | \`${cell(d.where)}\` | ${cell(d.reference)} | ${cell(d.candidate)} | ${d.drift ?? "—"} |`);
        if (diffs.length > 500) L.push("", `${diffs.length - 500} more are in REPORT.json.`);
    }
    if (r.suggested_scrubs.length) {
        L.push("", "## Probably noise", "", "These look like values that change on every call. A person decides whether to scrub them: a scrub hides them from every later run.", "",
            "| Where | Cases | Why |", "| --- | --- | --- |");
        for (const s of r.suggested_scrubs) L.push(`| \`${cell(s.where)}\` | ${s.cases} | ${s.why} |`);
    }
    if (r.unused_drift.length) L.push("", "## Drift that matched nothing", "", `These approved differences no longer occur; check whether they are still needed: ${r.unused_drift.join(", ")}.`);
    L.push("", "## Sign-off", "", "A person fills this in; an agent never does. Running again clears it, because the evidence has changed.", "",
        "| | |", "|---|---|", "| Name | ________________ |", "| Role | ________________ |", "| Date | __________ |", "| Decision | accept / accept with conditions / reject |", "");
    return L.join("\n");
}
