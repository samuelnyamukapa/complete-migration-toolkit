// `cmtk check`: everything that can be checked without sending a request. Agents run it after
// writing case files; people run it before a run.
import fs from "node:fs";

import { scrubberOf } from "./diff.js";
import { inside, loadCases, loadDrift } from "./manifest.js";
import { loadProposals } from "./proposals.js";
import type { Manifest } from "./types.js";

export interface CheckResult {
    cases: number;
    drafts: string[];
    requirements: number;
    pendingProposals: string[];
    warnings: string[];
}

/** Throws a ManifestError (or ConfigError, PathError) on anything invalid; returns counts and warnings otherwise. */
export function check(manifest: Manifest): CheckResult {
    const cases = loadCases(manifest);
    loadDrift(manifest);
    scrubberOf(manifest);
    const proposals = loadProposals(manifest);
    const warnings: string[] = [];
    for (const c of cases) {
        const s = c.surface ?? "http";
        if (s !== "http" && !manifest.adapters[s]) warnings.push(`${c.id}: surface "${s}" has no adapter in cmtk.yaml.`);
        if (c.requirement === undefined) warnings.push(`${c.id}: names no requirement, so its result is not traced to a story.`);
        if (!c.expect && Object.keys(manifest.targets).length === 1) warnings.push(`${c.id}: has no \`expect:\` block, so \`cmtk run\` skips it.`);
    }
    if (!cases.length) warnings.push(`No case files match ${manifest.cases.join(", ")}.`);
    if (!fs.existsSync(inside(manifest, manifest.evidence))) warnings.push(`${manifest.evidence} does not exist yet: the first run creates it.`);
    return {
        cases: cases.length,
        drafts: cases.filter((c) => c.draft).map((c) => c.id),
        requirements: new Set(cases.flatMap((c) => (c.requirement === undefined ? [] : [c.requirement].flat().map(String)))).size,
        pendingProposals: proposals.filter((p) => p.status === "pending").map((p) => p.id),
        warnings,
    };
}

export function describeCheck(r: CheckResult): string {
    const lines = [
        `Settings and case files are valid: ${r.cases} cases for ${r.requirements} requirements.`,
        r.drafts.length ? `${r.drafts.length} draft cases wait for a person (\`cmtk review\`): ${r.drafts.slice(0, 20).join(", ")}${r.drafts.length > 20 ? ", …" : ""}` : "No draft cases.",
        r.pendingProposals.length ? `${r.pendingProposals.length} proposals wait for a person (\`cmtk review\`): ${r.pendingProposals.join(", ")}` : "No proposals waiting.",
    ];
    for (const w of r.warnings) lines.push(`Warning: ${w}`);
    return lines.join("\n");
}
