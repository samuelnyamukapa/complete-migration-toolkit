// Sign-off: a person accepts or rejects a report. The signature records a fingerprint of every
// evidence file, so a signature on one run never carries over to another, and `cmtk status` can
// tell a current signature from a stale one.
//
// The command asks at a terminal, which keeps agents that follow the rules from signing. It is not
// a lock: anything that can fake a terminal can type a name. Where a signature must be binding,
// keep the evidence folder under version control and require a reviewed commit for SIGNOFF.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Report } from "./types.js";

export const DECISIONS = ["accept", "accept with conditions", "reject"] as const;

export interface Signoff {
    name: string;
    role: string;
    decision: (typeof DECISIONS)[number];
    date: string;
    verdict: Report["verdict"];
    evidence_sha256: string;
}

export class SignoffError extends Error {}

const SKIP = new Set(["REPORT.md", "SIGNOFF.json"]);

/** One fingerprint for every file in the evidence folder except the report text and the signature. */
export function evidenceFingerprint(dir: string): string {
    const files: string[] = [];
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && !(d === dir && SKIP.has(e.name))) files.push(full);
        }
    };
    walk(dir);
    const h = crypto.createHash("sha256");
    for (const f of files.map((f) => path.relative(dir, f).split(path.sep).join("/")).sort()) {
        h.update(f).update("\0").update(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex")).update("\n");
    }
    return h.digest("hex");
}

export type SignoffState =
    | { state: "none" }
    | { state: "signed"; signoff: Signoff }
    | { state: "stale"; signoff: Signoff };

export function signoffState(dir: string): SignoffState {
    const file = path.join(dir, "SIGNOFF.json");
    if (!fs.existsSync(file)) return { state: "none" };
    let s: Signoff;
    try {
        s = JSON.parse(fs.readFileSync(file, "utf8")) as Signoff;
    } catch {
        return { state: "none" };
    }
    return s.evidence_sha256 === evidenceFingerprint(dir) ? { state: "signed", signoff: s } : { state: "stale", signoff: s };
}

export function describeSignoff(st: SignoffState): string {
    if (st.state === "none") return "not signed";
    const s = st.signoff;
    return st.state === "signed" ? `signed by ${s.name} (${s.role}): ${s.decision}, ${s.date}` : `the signature by ${s.name} is for different evidence, so it no longer counts`;
}

/** Record a person's decision on the report in `dir`. */
export function recordSignoff(dir: string, who: { name: string; role: string; decision: string }, date: string): Signoff {
    const json = path.join(dir, "REPORT.json"), md = path.join(dir, "REPORT.md");
    if (!fs.existsSync(json) || !fs.existsSync(md)) throw new SignoffError("There is no report in this folder yet.");
    const report = JSON.parse(fs.readFileSync(json, "utf8")) as Report;
    if (report.verdict === "NO EVIDENCE") throw new SignoffError("This report holds no evidence, so there is nothing to sign. Add cases and run again.");
    const name = who.name.trim(), role = who.role.trim(), decision = who.decision.trim().toLowerCase();
    if (!name || !role || !(DECISIONS as readonly string[]).includes(decision)) throw new SignoffError(`Name, role and one of ${DECISIONS.join(" / ")} are all needed. Nothing was signed.`);
    const s: Signoff = { name, role, decision: decision as Signoff["decision"], date, verdict: report.verdict, evidence_sha256: evidenceFingerprint(dir) };
    const cell = (v: string) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
    const text = fs.readFileSync(md, "utf8")
        .replace(/^\| Name \|.*\|$/m, `| Name | ${cell(name)} |`).replace(/^\| Role \|.*\|$/m, `| Role | ${cell(role)} |`)
        .replace(/^\| Date \|.*\|$/m, `| Date | ${date} |`).replace(/^\| Decision \|.*\|$/m, `| Decision | ${decision} |`)
        .replace(/^\| Evidence \|.*\|$/m, `| Evidence | sha256 ${s.evidence_sha256} |`);
    fs.writeFileSync(path.join(dir, "SIGNOFF.json"), JSON.stringify(s, null, 2) + "\n", "utf8");
    fs.writeFileSync(md, text, "utf8");
    return s;
}
