// Draft defects from a report: one per cause, with the steps, what was expected, what came back
// and the evidence. A person checks a draft and files it; nothing here files anything.
import fs from "node:fs";
import path from "node:path";

import { looksSecret, redactBody } from "./har.js";
import { inside, loadCases, ManifestError } from "./manifest.js";
import { loadProposals } from "./proposals.js";
import type { Case, Manifest, Report } from "./types.js";

export interface DefectDraft {
    id: string;
    title: string;
    requirements: string[];
    cases: string[];
    steps: string[];
    /** Why the failure matters, from the case's note, when the case has one. */
    why?: string;
    expected: string;
    actual: string;
    evidence: string[];
    source: "run" | "compare" | "triage";
}

const REMOVED = "[removed]";

/** A function that takes every credential we know of, and anything shaped like one, out of text. */
export function redactor(manifest: Manifest): (s: string) => string {
    const known = Object.values(manifest.headers_from_env).map((v) => process.env[v]).filter((v): v is string => !!v && v.length >= 4);
    return (s: string) => {
        let out = s;
        for (const v of known) out = out.split(v).join(REMOVED);
        return out
            .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REMOVED}`)
            .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, REMOVED)
            .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, REMOVED);
    };
}

const norm = (where: string) => where.replace(/\[\d+\]/g, "[*]");

/** From a case's note: its "Why it looks wrong:" line when it has one, otherwise the whole note. */
function whyOf(c: Case | undefined): string | undefined {
    const note = (c?.note ?? c?.draft_note)?.trim();
    if (!note) return undefined;
    const line = /^Why it looks wrong:\s*(.+)$/im.exec(note)?.[1]?.trim();
    return (line ?? note).slice(0, 1000);
}

/** A path with credential-like query values removed. */
function cleanPath(p: string, clean: (s: string) => string): string {
    const q = p.indexOf("?");
    if (q < 0) return clean(p);
    const params = new URLSearchParams(p.slice(q + 1));
    for (const k of [...new Set(params.keys())]) if (looksSecret(k)) params.set(k, REMOVED);
    return clean(`${p.slice(0, q)}?${params.toString()}`);
}

/** A target's address without any user name or password in it. */
export function cleanUrl(u: string): string {
    try {
        const url = new URL(u);
        if (!url.username && !url.password) return u;
        url.username = "";
        url.password = "";
        return url.toString().replace(/\/$/, "");
    } catch {
        return u.replace(/\/\/[^/@]*@/, "//");
    }
}

function stepsFor(c: Case | undefined, target: string, clean: (s: string) => string): string[] {
    if (!c) return ["(the case is no longer in the case files)"];
    const headers = Object.entries(c.request.headers ?? {}).map(([k, v]) => `${k}: ${looksSecret(k, "header") ? REMOVED : clean(v)}`);
    const contentType = Object.entries(c.request.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    return [
        `Send \`${c.request.method} ${cleanPath(c.request.path, clean)}\` to ${target}${c.surface && c.surface !== "http" ? ` through the ${c.surface} adapter` : ""}.`,
        ...(headers.length ? [`With headers: ${headers.join("; ")}.`] : []),
        ...(c.request.body ? [`With the body: ${clean(redactBody(String(c.request.body), contentType)[0]).slice(0, 500)}`] : []),
    ];
}

export function draftDefects(manifest: Manifest, mode: "run" | "compare"): { file: string; drafts: DefectDraft[] } {
    const dir = inside(manifest, path.join(manifest.evidence, mode));
    const reportFile = path.join(dir, "REPORT.json");
    if (!fs.existsSync(reportFile)) throw new ManifestError(`There is no ${mode} report yet. Run \`cmtk ${mode}\` first.`);
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as Report;
    const clean = redactor(manifest);
    const cases = new Map(loadCases(manifest).map((c) => [c.id, c]));
    const [targetName, targetWhere] = Object.entries(report.targets).at(-1) ?? ["the target", ""];
    const target = `${targetName}${targetWhere ? ` (${clean(cleanUrl(targetWhere))})` : ""}`;
    const groups = new Map<string, { title: string; ids: string[]; expected: string; actual: string }>();

    for (const c of report.cases) {
        if (mode === "run" && c.result === "FAIL") {
            const f = c.failures ?? [];
            const key = f.map((x) => `${norm(x.check)}|${x.expected}|${x.actual}`).join("\n");
            const g = groups.get(key) ?? {
                title: f.length === 1 ? `${f[0]!.check}: expected ${f[0]!.expected}, got ${f[0]!.actual}` : `${f.length} checks fail, first ${f[0]?.check}: expected ${f[0]?.expected}, got ${f[0]?.actual}`,
                ids: [], expected: f.map((x) => `- \`${x.check}\`: ${x.expected}`).join("\n"), actual: f.map((x) => `- \`${x.check}\`: ${x.actual}`).join("\n"),
            };
            g.ids.push(c.id);
            groups.set(key, g);
        }
        if (mode === "compare" && c.result === "DIFFERENT") {
            const open = (c.differences ?? []).filter((d) => !d.drift);
            const key = [...new Set(open.map((d) => norm(d.where)))].sort().join("\n");
            const first = open[0]!;
            const g = groups.get(key) ?? {
                title: open.length === 1 ? `${first.where} differs from the reference: ${first.reference} vs ${first.candidate}` : `${open.length} differences from the reference, first at ${first.where}`,
                ids: [],
                expected: open.map((d) => `- \`${d.where}\`: ${d.reference} (as the reference answers)`).join("\n"),
                actual: open.map((d) => `- \`${d.where}\`: ${d.candidate}`).join("\n"),
            };
            g.ids.push(c.id);
            groups.set(key, g);
        }
    }
    const answer = (id: string) => (mode === "run" ? [`answers/${id}.json`] : [`answers/${id}.reference.json`, `answers/${id}.candidate.json`]);
    // A case's name says what is wrong in words; the check that failed is in Expected and Actual.
    const named = (ids: string[]) => {
        const names = ids.map((id) => cases.get(id)?.name?.trim());
        return names.every((n) => n && n === names[0]) ? names[0] : undefined;
    };
    const drafts: DefectDraft[] = [...groups.values()].map((g, i) => ({
        id: `D-${String(i + 1).padStart(2, "0")}`,
        title: clean(named(g.ids) ?? g.title).slice(0, 200) + (g.ids.length > 1 ? ` (${g.ids.length} cases)` : ""),
        requirements: [...new Set(g.ids.flatMap((id) => report.cases.find((c) => c.id === id)?.requirement ?? []))],
        cases: g.ids,
        steps: stepsFor(cases.get(g.ids[0]!), target, clean),
        ...(whyOf(cases.get(g.ids[0]!)) ? { why: clean(whyOf(cases.get(g.ids[0]!))!) } : {}),
        expected: clean(g.expected),
        actual: clean(g.actual),
        evidence: g.ids.flatMap(answer),
        source: mode,
    }));
    if (mode === "compare") {
        for (const p of loadProposals(manifest).filter((x) => x.kind === "defect" && x.status === "accepted")) {
            drafts.push({
                id: `D-${String(drafts.length + 1).padStart(2, "0")}`, title: clean(p.title ?? p.id), requirements: [], cases: p.cases ?? [],
                steps: stepsFor(cases.get(p.cases?.[0] ?? ""), target, clean), expected: "(see the summary)", actual: clean(p.summary ?? p.reason),
                evidence: (p.cases ?? []).flatMap(answer), source: "triage",
            });
        }
    }
    const L = [`# Draft defects: ${report.system}`, "",
        `From \`cmtk ${mode}\` on ${report.date} (verdict ${report.verdict}). Each draft groups the cases that fail the same way.`,
        "A person checks each one and files it. Nothing here has been filed.", ""];
    for (const d of drafts) {
        L.push(`## ${d.id}: ${d.title}`, "",
            `- Requirements: ${d.requirements.join(", ") || "(none named)"}`,
            `- Cases: ${d.cases.join(", ")}`,
            `- Found by: ${d.source === "triage" ? "triage of a comparison, accepted by a person" : `\`cmtk ${mode}\``} on ${report.date}`, "",
            "### Steps to reproduce", "", ...d.steps.map((s, i) => `${i + 1}. ${s}`), "",
            ...(d.why ? ["### Why it matters", "", d.why, ""] : []),
            "### Expected", "", d.expected, "", "### Actual", "", d.actual, "",
            "### Evidence", "", ...d.evidence.map((e) => `- \`${path.join(path.relative(manifest.root, dir), e).split(path.sep).join("/")}\``), "");
    }
    if (!drafts.length) L.push("No defects: nothing failed.", "");
    fs.writeFileSync(path.join(dir, "DEFECTS.md"), L.join("\n"), "utf8");
    fs.writeFileSync(path.join(dir, "DEFECTS.json"), JSON.stringify(drafts, null, 2) + "\n", "utf8");
    return { file: path.relative(manifest.root, path.join(dir, "DEFECTS.md")), drafts };
}
