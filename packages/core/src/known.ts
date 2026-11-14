// The known-issues ledger: failures of `cmtk run` a named person accepted, such as a legacy defect that
// must stay until a migration is done. An entry never hides a failure: the case still reads FAIL, and the
// report names the entry. It covers one case and only the failures it describes, so anything new is still FAIL.
import fs from "node:fs";

import { inside, ManifestError, readStructured } from "./manifest.js";
import { looksLikeAgent } from "./people.js";
import type { CaseOutcome, Failure, KnownFailure, KnownIssue, KnownIssueInReport, Manifest } from "./types.js";

export const KNOWN_ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** What fails, as a report words it. Numbers are accepted, so `actual: 404` needs no quotes. */
export function knownFails(raw: unknown, where: string): KnownFailure[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new ManifestError(`${where}: \`fails\` must list what fails, each as { check, expected?, actual? } copied from the report.`);
    return raw.map((f: any, i) => {
        if (typeof f?.check !== "string" || !f.check.trim() || f.check.includes("*")) throw new ManifestError(`${where}: fails[${i}] needs \`check\`, copied from the report, such as status or $.count. A wildcard is not allowed: an entry names one failure.`);
        const out: KnownFailure = { check: f.check };
        for (const k of ["expected", "actual"] as const) {
            if (f[k] === undefined || f[k] === null) continue;
            if (!["string", "number", "boolean"].includes(typeof f[k])) throw new ManifestError(`${where}: fails[${i}].${k} must be text, copied from the report.`);
            out[k] = String(f[k]);
        }
        // Without this an entry accepts any failure at that check, and "a failure the entry does not describe is still FAIL" stops being true.
        // A body's text can't be copied whole, so `check: body` may say what it wanted instead.
        const says = (v: string | undefined) => v !== undefined && !!v.trim();
        if (!says(out.actual) && !(out.check === "body" && says(out.expected))) throw new ManifestError(`${where}: fails[${i}] must say how it fails: copy \`actual\` from the report${out.check === "body" ? ", or for a body give `expected`" : ""}. Without it the entry would accept any failure at ${out.check}.`);
        return out;
    });
}

export function loadKnownIssues(manifest: Manifest): KnownIssue[] {
    const file = inside(manifest, manifest.known_issues);
    if (!fs.existsSync(file)) return [];
    const doc = readStructured(file) as any;
    const list = Array.isArray(doc) ? doc : doc?.known_issues ?? [];
    if (!Array.isArray(list)) throw new ManifestError(`${manifest.known_issues} must hold \`known_issues:\` with a list.`);
    const seen = new Set<string>();
    return list.map((k: any, i: number) => {
        const where = `${manifest.known_issues} entry ${i + 1}`;
        for (const f of ["id", "case", "reason", "accepted_by"]) {
            if (typeof k?.[f] !== "string" || !k[f].trim()) throw new ManifestError(`${where}: \`${f}\` is required. Only a named person accepts a known issue.`);
        }
        if (!KNOWN_ISSUE_ID.test(k.id)) throw new ManifestError(`${where}: \`id\` must be letters, digits, '.', '-' and '_'.`);
        if (seen.has(k.id)) throw new ManifestError(`${where}: the id ${k.id} is used twice.`);
        seen.add(k.id);
        if (k.case.includes("*")) throw new ManifestError(`${where}: \`case\` must name one case. A known issue never covers every case.`);
        if (looksLikeAgent(k.accepted_by)) throw new ManifestError(`${where}: \`accepted_by\` must name a person, not an agent. An agent proposes with cmtk_propose, and a person accepts with \`cmtk review\`.`);
        if (k.target !== undefined && !manifest.targets[k.target]) throw new ManifestError(`${where}: \`target\` names ${JSON.stringify(k.target)}, which is not in targets (${Object.keys(manifest.targets).join(", ")}).`);
        return {
            id: k.id, case: k.case, fails: knownFails(k.fails, where), reason: k.reason, accepted_by: k.accepted_by,
            ...(k.date ? { date: String(k.date) } : {}), ...(k.target ? { target: k.target } : {}),
        };
    });
}

const covers = (k: KnownFailure, f: Failure) => k.check === f.check && (k.expected === undefined || k.expected === f.expected) && (k.actual === undefined || k.actual === f.actual);

/**
 * Note on each failure the entry that accepts it. Returns the entries' ids only when every failure is
 * accepted: one failure nobody accepted keeps the whole case an ordinary FAIL.
 */
export function markKnown(caseId: string, failures: Failure[], entries: KnownIssue[]): string[] | undefined {
    const mine = entries.filter((k) => k.case === caseId);
    for (const f of failures) {
        const hit = mine.find((k) => k.fails.some((x) => covers(x, f)));
        if (hit) f.known_issue = hit.id;
    }
    return failures.length && failures.every((f) => f.known_issue) ? [...new Set(failures.map((f) => f.known_issue!))].sort() : undefined;
}

/** Each entry as this run found it. An entry is only called stale when its case was checked, or no longer exists. */
export function knownInReport(entries: KnownIssue[], outcomes: CaseOutcome[], allCaseIds: Set<string>): KnownIssueInReport[] {
    return entries.map((k) => {
        const o = outcomes.find((c) => c.id === k.case);
        if (!o) return { ...k, state: allCaseIds.has(k.case) ? "not checked" as const : "no longer fails" as const };
        if (o.result !== "PASS" && o.result !== "FAIL") return { ...k, state: "not checked" as const };
        return { ...k, state: o.failures?.some((f) => f.known_issue === k.id) ? "still fails" as const : "no longer fails" as const };
    });
}
