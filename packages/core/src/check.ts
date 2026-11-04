// `cmtk check`: everything that can be checked without sending a request. Agents run it after
// writing case files; people run it before a run.
import fs from "node:fs";

import { describeDiscovery, loadDiscovery } from "./discover.js";
import { scrubberOf } from "./diff.js";
import { loadKnownIssues } from "./known.js";
import { inside, loadCases, loadDrift } from "./manifest.js";
import { loadProposals, unconfirmedSafe } from "./proposals.js";
import type { Manifest } from "./types.js";

export interface CheckResult {
    cases: number;
    drafts: string[];
    /** Cases whose `expect:` was drafted from a recording and waits for a person. */
    draftExpectations: string[];
    requirements: number;
    pendingProposals: string[];
    /** From the last `cmtk discover`, if there was one. */
    discovery?: string;
    warnings: string[];
}

/** Throws a ManifestError (or ConfigError, PathError) on anything invalid; returns counts and warnings otherwise. */
export function check(manifest: Manifest): CheckResult {
    const cases = loadCases(manifest);
    loadDrift(manifest);
    const known = loadKnownIssues(manifest);
    scrubberOf(manifest);
    const proposals = loadProposals(manifest);
    const warnings: string[] = [];
    for (const c of cases) {
        const s = c.surface ?? "http";
        if (s !== "http" && !manifest.adapters[s]) warnings.push(`${c.id}: surface "${s}" has no adapter in cmtk.yaml.`);
        if (s === "http" && ["journey", "structure", "visual"].includes(c.match ?? "")) warnings.push(`${c.id}: match \`${c.match}\` needs an adapter that reports it, and http does not, so \`cmtk compare\` reports a difference.`);
        if (c.requirement === undefined) warnings.push(`${c.id}: names no requirement, so its result is not traced to a story.`);
        if (!c.expect && Object.keys(manifest.targets).length === 1) warnings.push(`${c.id}: has no \`expect:\` block, so \`cmtk run\` skips it.`);
        if (typeof c.journey?.script === "string" && !fs.existsSync(inside(manifest, c.journey.script))) warnings.push(`${c.id}: the script ${c.journey.script} does not exist, so the case will error.`);
        for (const f of [c.request.body_file, typeof c.request.body_form === "string" ? c.request.body_form : undefined, ...(c.request.files ?? []).map((x) => x.path)].filter((x): x is string => !!x)) {
            if (!fs.existsSync(inside(manifest, f))) warnings.push(`${c.id}: the input file ${f} does not exist, so the case will error.`);
        }
    }
    for (const c of unconfirmedSafe(manifest, cases)) warnings.push(`${c.id}: says safe: true, but no person has confirmed this exact case, so it needs both switches. \`cmtk review\` shows it.`);
    const pair = [manifest.targets[manifest.reference], manifest.targets[manifest.candidate]].filter((t) => t?.surfaces);
    const counted = new Map<string, number>();
    for (const c of cases) counted.set(c.surface ?? "http", (counted.get(c.surface ?? "http") ?? 0) + 1);
    for (const [s, n] of [...counted].sort()) {
        const missing = pair.filter((t) => !t!.surfaces!.includes(s)).map((t) => t!.name);
        if (missing.length) warnings.push(`${n} case${n === 1 ? "" : "s"} on ${s}: ${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} no ${s} surface, so \`cmtk compare\` reports ${n === 1 ? "it" : "them"} as not comparable.`);
    }
    const ids = new Set(cases.map((c) => c.id));
    for (const k of known) {
        if (!ids.has(k.case)) warnings.push(`known issue ${k.id}: there is no case ${k.case}.`);
        if (k.fails.some((f) => f.actual === undefined && f.expected === undefined)) warnings.push(`known issue ${k.id}: one of its failures accepts any answer at that check, so a new way of failing there would be hidden. Copy \`expected\` or \`actual\` from the report.`);
    }
    for (const k of manifest.contracts) {
        if (!k.assembly) continue;
        for (const f of [k.assembly.legacy, k.assembly.candidate]) if (!fs.existsSync(inside(manifest, f))) warnings.push(`contract ${k.name}: ${f} does not exist, so the comparison will report an error.`);
    }
    if (!cases.length) warnings.push(`No case files match ${manifest.cases.join(", ")}.`);
    if (!fs.existsSync(inside(manifest, manifest.evidence))) warnings.push(`${manifest.evidence} does not exist yet: the first run creates it.`);
    const d = loadDiscovery(manifest);
    for (const b of d?.boundaries.filter((x) => !x.covered_by) ?? []) warnings.push(`boundary ${b.name} (${b.kind}) is uncovered: no adapter covers ${b.kind}.`);
    return {
        cases: cases.length,
        drafts: cases.filter((c) => c.draft).map((c) => c.id),
        draftExpectations: cases.filter((c) => c.expect_draft).map((c) => c.id),
        requirements: new Set(cases.flatMap((c) => (c.requirement === undefined ? [] : [c.requirement].flat().map(String)))).size,
        pendingProposals: proposals.filter((p) => p.status === "pending").map((p) => p.id),
        ...(d ? { discovery: `Boundaries (cmtk discover, ${d.date}): ${describeDiscovery(d)}` } : {}),
        warnings,
    };
}

export function describeCheck(r: CheckResult): string {
    const lines = [
        `Settings and case files are valid: ${r.cases} cases for ${r.requirements} requirements.`,
        r.drafts.length ? `${r.drafts.length} draft cases wait for a person (\`cmtk review\`): ${r.drafts.slice(0, 20).join(", ")}${r.drafts.length > 20 ? ", …" : ""}` : "No draft cases.",
        ...(r.draftExpectations.length ? [`${r.draftExpectations.length} drafted expectations wait for a person (\`cmtk review\`), and \`cmtk run\` skips those cases until then: ${r.draftExpectations.slice(0, 20).join(", ")}${r.draftExpectations.length > 20 ? ", …" : ""}`] : []),
        r.pendingProposals.length ? `${r.pendingProposals.length} proposals wait for a person (\`cmtk review\`): ${r.pendingProposals.join(", ")}` : "No proposals waiting.",
        ...(r.discovery ? [r.discovery] : []),
    ];
    for (const w of r.warnings) lines.push(`Warning: ${w}`);
    return lines.join("\n");
}
