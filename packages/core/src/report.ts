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
    const { verdict, reason, next } = decide(x, counts);

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
        unused_drift: unusedDrift(x),
        suggested_scrubs: x.mode === "compare" ? noise(x.cases) : [],
        partial: x.partial,
        reason,
        next,
    };
}

/** On a partial run only entries for cases that ran can be called unused. */
function unusedDrift(x: { cases: CaseOutcome[]; drift: Drift[]; usedDrift: Set<string>; partial: boolean }) {
    const ran = new Set(x.cases.map((c) => c.id));
    return x.drift.filter((d) => !x.usedDrift.has(d.id) && (!x.partial || ran.has(d.case))).map((d) => d.id).sort();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function decide(x: { mode: "run" | "compare"; cases: CaseOutcome[]; contracts: ContractOutcome[]; targets: Record<string, string>; partial: boolean }, counts: Record<string, number>) {
    const ran = x.cases.filter((c) => c.result !== "SKIPPED" && c.result !== "ERROR").length;
    const errored = x.cases.filter((c) => c.result === "ERROR");
    const skipped = x.cases.filter((c) => c.result === "SKIPPED");
    const again = `\`cmtk ${x.mode}\` again`;
    const why = () => {
        const first = errored[0] ?? skipped[0];
        if (!first) return "";
        const refused = errored.some((c) => /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(c.why ?? ""));
        return refused ? `a system did not answer (${first.why}). Start it, or correct its base_url in cmtk.yaml, then run ${again}.`
            : `${first.id}: ${first.why}. Fix that, then run ${again}.`;
    };
    const notRun = () => [errored.length && `${plural(errored.length, "case")} could not run`, skipped.length && `${plural(skipped.length, "case")} were skipped`].filter(Boolean).join(" and ");

    if (x.mode === "run") {
        if (x.cases.length === 0) return { verdict: "NO EVIDENCE" as Verdict, reason: "There are no cases.", next: "add cases (cmtk/cases/*.yaml, or `cmtk import-har`), then `cmtk run`." };
        if (counts.FAIL) return { verdict: "FAIL" as Verdict, reason: `${plural(counts.FAIL, "case")} failed.`, next: "fix what failed (or correct an expectation with the person who owns the requirement), then `cmtk run` again." };
        if (ran === 0) return { verdict: "NO EVIDENCE" as Verdict, reason: `No case ran: ${notRun()}.`, next: why() };
        if (errored.length || skipped.length) return { verdict: "INCOMPLETE" as Verdict, reason: `${notRun()}.`, next: why() };
        if (x.partial) return { verdict: "INCOMPLETE" as Verdict, reason: `Only the ${plural(ran, "case")} named with --only ran, and all passed.`, next: "run every case with `cmtk run` before anyone signs." };
        return { verdict: "PASS" as Verdict, reason: `All ${plural(ran, "case")} passed.`, next: "a person reviews the report and signs it with `cmtk signoff run`." };
    }

    const openFindings = x.contracts.flatMap((k) => k.findings.filter((f) => f.where && !f.drift));
    const approvedFindings = x.contracts.flatMap((k) => k.findings.filter((f) => f.drift));
    const contractErrors = x.contracts.filter((k) => k.result === "ERROR");
    if (counts.DIFFERENT || openFindings.length) {
        const parts = [counts.DIFFERENT && `${plural(counts.DIFFERENT, "case")} answered differently`, openFindings.length && `${plural(openFindings.length, "contract change")} not approved`].filter(Boolean);
        return { verdict: "NO PARITY" as Verdict, reason: `${parts.join(" and ")}.`, next: "for each difference: scrub it if it is noise, approve it as drift in the drift ledger (a named person), or fix the candidate. Then `cmtk compare` again." };
    }
    if (x.cases.length === 0) {
        return { verdict: "NO EVIDENCE" as Verdict, reason: x.contracts.length ? "Only the contracts were checked; there are no cases to compare behaviour." : "There are no cases and no contracts.", next: "add cases (cmtk/cases/*.yaml, or `cmtk import-har`), then `cmtk compare`." };
    }
    if (ran === 0) return { verdict: "NO EVIDENCE" as Verdict, reason: `No case ran: ${notRun()}.`, next: why() };
    if (errored.length || skipped.length || contractErrors.length) {
        const parts = [notRun(), contractErrors.length && `${plural(contractErrors.length, "contract")} could not be checked`].filter(Boolean);
        return { verdict: "INCOMPLETE" as Verdict, reason: `${parts.join(" and ")}.`, next: why() || `see the contracts table (${contractErrors[0]?.findings[0]?.what ?? ""}), fix that, then \`cmtk compare\` again.` };
    }
    const drifted = counts.DRIFT || approvedFindings.length;
    if (x.partial) return { verdict: "INCOMPLETE" as Verdict, reason: `Only the ${plural(ran, "case")} named with --only ran, with no unapproved differences.`, next: "compare every case with `cmtk compare` before anyone signs." };
    return drifted
        ? { verdict: "DRIFT ONLY" as Verdict, reason: "Every difference is approved drift.", next: "a person reviews the report and signs it with `cmtk signoff compare`." }
        : { verdict: "PARITY" as Verdict, reason: "No differences at all.", next: "a person reviews the report and signs it with `cmtk signoff compare`." };
}

const cell = (v: unknown) => String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/`/g, "'");

export function renderReport(r: Report): string {
    const L: string[] = [];
    const title = r.mode === "run" ? "Test report" : "Comparison report";
    L.push(`# ${title}: ${r.system}`, "", `**Verdict: ${r.verdict}**${r.partial ? " (partial run: only some cases)" : ""}`, "", r.reason, "", `Next: ${r.next}`, "");
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
            for (const k of r.contracts) L.push(`| ${cell(k.name)} | ${cell(k.kind)} | ${k.result} | ${cell(k.findings.map((f) => `${f.what}${f.drift ? ` (approved: ${f.drift})` : ""}`).join("; ") || "none")} |`);
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
    L.push("", "## Sign-off", "", "A person fills this in with `cmtk signoff`; an agent never does. The evidence fingerprint ties the signature to the files in this folder, and running again clears it, because the evidence has changed.", "",
        "| | |", "|---|---|", "| Name | ________________ |", "| Role | ________________ |", "| Date | __________ |", "| Decision | accept / accept with conditions / reject |", "| Evidence | (fingerprint written at sign-off) |", "");
    return L.join("\n");
}
