// Proposals: what an agent may suggest but never decide. A scrub, a drift entry, a defect or a
// change to an expectation is written here as `pending`. Only `cmtk review`, run by a person at a
// keyboard, accepts or rejects it, and only then is it applied, with that person's name on it.
import fs from "node:fs";
import path from "node:path";
import YAML, { isMap, isSeq, type Document, YAMLMap, YAMLSeq } from "yaml";

import { inside, loadCases, loadDrift, ManifestError } from "./manifest.js";
import { parsePath } from "./jsonpath.js";
import type { Case, Expectation, Manifest } from "./types.js";

export const PROPOSAL_KINDS = ["scrub", "drift", "defect", "expectation"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export interface ScrubRule {
    json_path?: string;
    regex?: { pattern: string; replace?: string };
    xml_ignore?: string;
}

export interface Proposal {
    id: string;
    kind: ProposalKind;
    status: "pending" | "accepted" | "rejected";
    /** Why the proposer thinks this is right. */
    reason: string;
    proposed_by: string;
    proposed_on: string;
    /** scrub */
    rule?: ScrubRule;
    /** drift: a case id or "*", and a `where` from a report. expectation: the case to change. */
    case?: string;
    where?: string;
    /** defect */
    title?: string;
    cases?: string[];
    summary?: string;
    /** expectation: the whole new `expect:` block. */
    expect?: Expectation;
    decided_by?: string;
    decided_on?: string;
    decision_note?: string;
    /** What accepting it changed, such as "DRIFT-003 in cmtk/drift.yaml". */
    applied?: string;
}

export type ProposalInput = Omit<Proposal, "id" | "status" | "proposed_on" | "decided_by" | "decided_on" | "decision_note" | "applied">;

const HEADER = "# Proposals from agents. Each one waits for a person: only `cmtk review` accepts or rejects it.\n";

// ---------------------------------------------------------------- YAML files edited in place

/** Edit a YAML file through its document, so comments, order and line endings survive. */
export function editYaml(file: string, fallback: string, fn: (doc: Document) => void): void {
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fallback;
    const crlf = text.includes("\r\n");
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) throw new ManifestError(`${path.basename(file)} is not valid YAML: ${doc.errors[0]!.message}`);
    fn(doc);
    let out = doc.toString({ lineWidth: 0 });
    if (crlf) out = out.replace(/\r?\n/g, "\r\n");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out, "utf8");
}

/** The sequence under `key` (or the root sequence), created if missing. An empty `[]` becomes a block list, so people can read what is added. */
export function seqAt(doc: Document, key: string): YAMLSeq {
    const block = (s: YAMLSeq) => { if (s.flow && s.items.length === 0) s.flow = false; return s; };
    if (isSeq(doc.contents)) return block(doc.contents);
    if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
    const map = doc.contents as YAMLMap;
    const found: unknown = map.get(key, true);
    if (isSeq(found)) return block(found);
    const s = new YAMLSeq();
    map.set(key, s);
    return s;
}

// ---------------------------------------------------------------- reading and adding

export function loadProposals(manifest: Manifest): Proposal[] {
    const file = inside(manifest, manifest.proposals);
    if (!fs.existsSync(file)) return [];
    const doc = YAML.parse(fs.readFileSync(file, "utf8")) as { proposals?: Proposal[] } | Proposal[] | null;
    const list = Array.isArray(doc) ? doc : doc?.proposals ?? [];
    return list.filter((p) => p && typeof p.id === "string");
}

/** Control characters (terminal escapes among them) could make a person see something other than what is applied. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

const text = (v: unknown, what: string, max = 2000): string => {
    if (typeof v !== "string" || !v.trim()) throw new ManifestError(`${what} is required.`);
    if (v.length > max) throw new ManifestError(`${what} is longer than ${max} characters.`);
    if (CONTROL.test(v)) throw new ManifestError(`${what} holds control characters; write plain text.`);
    return v.trim();
};

/** Any text shown to a person, made safe for a terminal. */
export const plain = (v: unknown): string => String(v ?? "").replace(new RegExp(CONTROL.source, "g"), (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function checkScrub(rule: unknown): ScrubRule {
    const r = (rule ?? {}) as ScrubRule;
    const given = [r.json_path, r.regex, r.xml_ignore].filter((v) => v !== undefined).length;
    if (given !== 1) throw new ManifestError("A scrub proposal needs exactly one rule: json_path, regex or xml_ignore.");
    if (r.json_path !== undefined) parsePath(text(r.json_path, "rule.json_path", 200));
    if (r.regex !== undefined) {
        try {
            new RegExp(text(r.regex.pattern, "rule.regex.pattern", 500));
        } catch (err) {
            throw new ManifestError(`rule.regex.pattern is not a valid regular expression: ${(err as Error).message}`);
        }
    }
    if (r.xml_ignore !== undefined && !/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(r.xml_ignore)) throw new ManifestError("rule.xml_ignore must be an XML element name.");
    return r;
}

const EXPECT_KEYS = new Set(["status", "headers", "json", "body_contains", "body_excludes"]);

export function addProposal(manifest: Manifest, input: ProposalInput, date: string): Proposal {
    if (!PROPOSAL_KINDS.includes(input.kind)) throw new ManifestError(`kind must be one of ${PROPOSAL_KINDS.join(", ")}.`);
    if ("approved_by" in (input as object) || "decided_by" in (input as object)) throw new ManifestError("A proposal cannot carry an approval: only a person decides, with `cmtk review`.");
    const ids = new Set(loadCases(manifest).map((c) => c.id));
    const known = (id: unknown, what: string) => {
        const v = text(id, what, 100);
        if (!ids.has(v)) throw new ManifestError(`${what}: there is no case ${v}.`);
        return v;
    };
    const p: Proposal = {
        id: "",
        kind: input.kind,
        status: "pending",
        reason: text(input.reason, "reason"),
        proposed_by: text(input.proposed_by, "proposed_by", 100),
        proposed_on: date,
    };
    if (input.kind === "scrub") p.rule = checkScrub(input.rule);
    if (input.kind === "drift") {
        p.case = input.case === undefined || input.case === "*" ? "*" : known(input.case, "case");
        p.where = text(input.where, "where", 500);
        if (p.where.replace(/[*$.[\]\s:]/g, "").length < 2) throw new ManifestError("`where` must name a place from a report, such as $.items[*].price or header:content-type; a wildcard alone would approve everything.");
    }
    if (input.kind === "defect") {
        p.title = text(input.title, "title", 200);
        if (!Array.isArray(input.cases) || input.cases.length === 0) throw new ManifestError("A defect proposal names at least one case in `cases`.");
        p.cases = input.cases.map((c, i) => known(c, `cases[${i}]`));
        if (input.summary !== undefined) p.summary = text(input.summary, "summary", 4000);
    }
    if (input.kind === "expectation") {
        p.case = known(input.case, "case");
        const e = input.expect as Record<string, unknown> | undefined;
        if (!e || typeof e !== "object" || Array.isArray(e) || !Object.keys(e).length || !Object.keys(e).every((k) => EXPECT_KEYS.has(k))) {
            throw new ManifestError(`expect must be an \`expect:\` block using ${[...EXPECT_KEYS].join(", ")}.`);
        }
        p.expect = e as Expectation;
    }
    const existing = loadProposals(manifest);
    const key = (x: Proposal) => JSON.stringify([x.kind, x.case, x.where, x.rule, x.title, x.cases, x.expect]);
    const same = existing.find((x) => x.status === "pending" && key(x) === key(p));
    if (same) throw new ManifestError(`The same proposal is already waiting for a person: ${same.id}.`);
    p.id = `P-${String(1 + Math.max(0, ...existing.map((x) => Number(/^P-(\d+)$/.exec(x.id)?.[1] ?? 0)))).padStart(3, "0")}`;
    editYaml(inside(manifest, manifest.proposals), HEADER + "proposals: []\n", (doc) => {
        seqAt(doc, "proposals").add(doc.createNode(JSON.parse(JSON.stringify(p))));
    });
    return p;
}

// ---------------------------------------------------------------- deciding (only from `cmtk review`)

/** How a proposal reads to the person deciding it. */
export function describeProposal(p: Proposal): string {
    const q = (v: unknown) => JSON.stringify(v ?? null); // quoted and escaped: exactly what would be applied
    const lines = [`${plain(p.id)}  ${plain(p.kind)}, proposed by ${plain(p.proposed_by)} on ${plain(p.proposed_on)}`];
    if (p.kind === "scrub") lines.push(`  hide on every run: ${q(p.rule)}`);
    if (p.kind === "drift") lines.push(`  approve the difference at ${q(p.where)} for ${p.case === "*" ? "EVERY case" : `case ${q(p.case)}`}`);
    if (p.kind === "defect") lines.push(`  defect: ${q(p.title)}`, `  cases: ${q(p.cases)}`, ...(p.summary ? [`  summary: ${plain(p.summary)}`] : []));
    if (p.kind === "expectation") lines.push(`  change what case ${q(p.case)} expects to: ${q(p.expect)}`);
    lines.push(`  why: ${plain(p.reason)}`);
    return lines.join("\n");
}

function setStatus(manifest: Manifest, id: string, fields: Partial<Proposal>) {
    editYaml(inside(manifest, manifest.proposals), HEADER + "proposals: []\n", (doc) => {
        const item = seqAt(doc, "proposals").items.find((n) => isMap(n) && n.get("id") === id) as YAMLMap | undefined;
        if (!item) throw new ManifestError(`There is no proposal ${id}.`);
        for (const [k, v] of Object.entries(fields)) item.set(k, v);
    });
}

function caseFileOf(manifest: Manifest, caseId: string): { c: Case; file: string } {
    const c = loadCases(manifest).find((x) => x.id === caseId);
    if (!c?.file) throw new ManifestError(`There is no case ${caseId}.`);
    return { c, file: inside(manifest, c.file) };
}

function caseNode(doc: Document, caseId: string): { seq: YAMLSeq; index: number; node: YAMLMap } {
    const seq = seqAt(doc, "cases");
    const index = seq.items.findIndex((n) => isMap(n) && n.get("id") === caseId);
    if (index < 0) throw new ManifestError(`Case ${caseId} is not in its file any more.`);
    return { seq, index, node: seq.items[index] as YAMLMap };
}

/**
 * A person's decision. `person` must come from a person at a keyboard: the CLI's `cmtk review`
 * is the only caller, and the MCP server offers no way to reach this.
 */
export function decideProposal(manifest: Manifest, id: string, accept: boolean, person: string, date: string, note?: string, shown?: Proposal): Proposal {
    const p = loadProposals(manifest).find((x) => x.id === id);
    if (!p) throw new ManifestError(`There is no proposal ${id}.`);
    if (p.status !== "pending") throw new ManifestError(`${id} was already ${p.status}.`);
    if (shown && JSON.stringify(p) !== JSON.stringify(shown)) throw new ManifestError(`${id} changed after it was shown to you. Nothing was applied; run \`cmtk review\` again.`);
    const who = text(person, "Your name", 100);
    if (!accept) {
        setStatus(manifest, id, { status: "rejected", decided_by: who, decided_on: date, ...(note ? { decision_note: note } : {}) });
        return { ...p, status: "rejected", decided_by: who, decided_on: date };
    }
    let applied = "";
    if (p.kind === "scrub") {
        editYaml(manifest.file, "", (doc) => {
            const root = doc.contents as YAMLMap;
            let scrub = root.get("scrub", true) as YAMLMap | undefined;
            if (!isMap(scrub)) { scrub = new YAMLMap(); root.set("scrub", scrub); }
            const [key, value] = p.rule!.json_path !== undefined ? ["json_paths", p.rule!.json_path] : p.rule!.regex ? ["regex", p.rule!.regex] : ["xml_ignore", p.rule!.xml_ignore];
            const found: unknown = scrub.get(key, true);
            const list = isSeq(found) ? found : new YAMLSeq();
            if (!isSeq(found)) scrub.set(key, list);
            list.add(doc.createNode(value));
        });
        applied = `scrub rule added to ${path.basename(manifest.file)}`;
    }
    if (p.kind === "drift") {
        const ledger = loadDrift(manifest);
        const next = `DRIFT-${String(1 + Math.max(0, ...ledger.map((d) => Number(/^DRIFT-(\d+)$/.exec(d.id)?.[1] ?? 0)))).padStart(3, "0")}`;
        editYaml(inside(manifest, manifest.drift), "# Approved drift: each entry names the person who approved it.\ndrift: []\n", (doc) => {
            seqAt(doc, "drift").add(doc.createNode({ id: next, case: p.case, where: p.where, reason: p.reason, approved_by: who, date }));
        });
        applied = `${next} in ${manifest.drift}`;
    }
    if (p.kind === "defect") applied = "listed by `cmtk defects compare`";
    if (p.kind === "expectation") {
        const { file } = caseFileOf(manifest, p.case!);
        editYaml(file, "", (doc) => {
            const { node } = caseNode(doc, p.case!);
            node.set("expect", doc.createNode(p.expect));
            node.set("expect_changed_by", who);
            node.set("expect_changed_on", date);
        });
        applied = `case ${p.case} now expects the proposed block`;
    }
    setStatus(manifest, id, { status: "accepted", decided_by: who, decided_on: date, applied, ...(note ? { decision_note: note } : {}) });
    return { ...p, status: "accepted", decided_by: who, decided_on: date, applied };
}

// ---------------------------------------------------------------- draft cases

export function acceptDraft(manifest: Manifest, caseId: string, person: string, date: string, shown?: Case): void {
    const who = text(person, "Your name", 100);
    const { c, file } = caseFileOf(manifest, caseId);
    if (!c.draft) throw new ManifestError(`${caseId} is not a draft.`);
    if (shown && JSON.stringify(c) !== JSON.stringify(shown)) throw new ManifestError(`${caseId} changed after it was shown to you. Nothing was accepted; run \`cmtk review\` again.`);
    editYaml(file, "", (doc) => {
        const { node } = caseNode(doc, caseId);
        node.delete("draft");
        node.delete("draft_note");
        // The drafter's note says where the case came from and what it depends on: keep it.
        if (c.draft_note) node.set("note", c.draft_note);
        node.set("accepted_by", who);
        node.set("accepted_on", date);
    });
}

/** Take a rejected draft out of its file, and keep it with the reason in cmtk/rejected.yaml. */
export function rejectDraft(manifest: Manifest, caseId: string, person: string, date: string, reason: string): void {
    const who = text(person, "Your name", 100);
    const why = text(reason, "A reason", 1000);
    const { c, file } = caseFileOf(manifest, caseId);
    if (!c.draft) throw new ManifestError(`${caseId} is not a draft.`);
    // Keep the record first, so a failure can never lose the draft.
    const { file: _f, ...kept } = c;
    const rejected = inside(manifest, path.join(path.dirname(manifest.proposals), "rejected.yaml"));
    editYaml(rejected, "# Draft cases a person rejected, with the reason. Kept so the same draft is not proposed again.\nrejected: []\n", (doc) => {
        seqAt(doc, "rejected").add(doc.createNode({ ...kept, rejected_by: who, rejected_on: date, rejected_because: why }));
    });
    editYaml(file, "", (doc) => {
        const { seq, index } = caseNode(doc, caseId);
        seq.items.splice(index, 1);
    });
}
