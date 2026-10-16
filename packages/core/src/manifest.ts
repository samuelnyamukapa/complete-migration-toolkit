// cmtk.yaml and the case files: read, fill in defaults, and refuse anything unsafe or unclear.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { MATCH_LEVELS, type Case, type Drift, type Manifest, type MatchLevel } from "./types.js";

export class ManifestError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const URL_RE = /^https?:\/\/[^/\s]+/;

export function readStructured(file: string): unknown {
    const text = fs.readFileSync(file, "utf8");
    try {
        return file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
    } catch (err) {
        throw new ManifestError(`${path.basename(file)} is not valid ${file.endsWith(".json") ? "JSON" : "YAML"}: ${(err as Error).message}`);
    }
}

const level = (v: unknown, where: string): MatchLevel => {
    if (v === undefined) return "exact";
    if (!MATCH_LEVELS.includes(v as MatchLevel)) throw new ManifestError(`${where}: match must be one of ${MATCH_LEVELS.join(", ")}.`);
    return v as MatchLevel;
};

export function loadManifest(file: string): Manifest {
    if (!fs.existsSync(file)) throw new ManifestError(`${file} does not exist. Run \`cmtk init\` first.`);
    const raw = readStructured(file) as Record<string, any>;
    if (!raw || typeof raw !== "object") throw new ManifestError("cmtk.yaml must hold a mapping.");
    if (typeof raw.system !== "string" || !NAME.test(raw.system)) throw new ManifestError("`system` must be a name of letters, digits, '.', '-' and '_'.");
    const targets: Manifest["targets"] = {};
    for (const [name, t] of Object.entries((raw.targets ?? {}) as Record<string, any>)) {
        if (!NAME.test(name)) throw new ManifestError(`Target name ${JSON.stringify(name)} must be letters, digits, '.', '-' and '_'.`);
        const url = typeof t === "string" ? t : t?.base_url;
        if (typeof url !== "string" || !URL_RE.test(url)) throw new ManifestError(`targets.${name}.base_url must be an http:// or https:// URL.`);
        targets[name] = { name, base_url: url.replace(/\/+$/, "") };
    }
    if (Object.keys(targets).length === 0) throw new ManifestError("`targets` needs at least one system, such as `candidate: { base_url: http://localhost:5002 }`.");
    const names = Object.keys(targets);
    const pick = (key: string, fallback: string | undefined) => {
        const v = raw[key] ?? fallback;
        if (v !== undefined && !targets[v]) throw new ManifestError(`\`${key}\` names ${JSON.stringify(v)}, which is not in targets (${names.join(", ")}).`);
        return v as string;
    };
    const overrides = ((raw.overrides ?? []) as any[]).map((o, i) => {
        if (!o || typeof o.path !== "string") throw new ManifestError(`overrides[${i}] needs a \`path\` glob, such as "/api/admin/*".`);
        return { path: o.path, match: level(o.match, `overrides[${i}]`) };
    });
    const contracts = ((raw.contracts ?? []) as any[]).map((c, i) => {
        if (!c || typeof c.path !== "string" || !c.path.startsWith("/")) throw new ManifestError(`contracts[${i}] needs a \`path\` starting with '/', served by every target.`);
        return { name: String(c.name ?? c.path), kind: String(c.kind ?? "text"), path: c.path };
    });
    const scrub = raw.scrub ?? {};
    return {
        system: raw.system,
        targets,
        default_target: pick("default_target", names.includes("candidate") ? "candidate" : names[0]),
        reference: pick("reference", names.includes("legacy") ? "legacy" : undefined),
        candidate: pick("candidate", names.includes("candidate") ? "candidate" : undefined),
        match: level(raw.match, "match"),
        overrides,
        scrub: { json_paths: scrub.json_paths ?? [], xml_ignore: scrub.xml_ignore ?? [], regex: scrub.regex ?? [] },
        compare_headers: (raw.compare_headers ?? ["content-type"]).map((h: string) => String(h).toLowerCase()),
        contracts,
        cases: raw.cases ?? ["cmtk/cases/*.yaml"],
        drift: raw.drift ?? "cmtk/drift.yaml",
        evidence: raw.evidence ?? "cmtk/evidence",
        allow_unsafe_methods: raw.allow_unsafe_methods === true,
        headers_from_env: raw.headers_from_env ?? {},
        timeout_s: Number(raw.timeout_s ?? 30),
        insecure_tls: raw.insecure_tls === true,
        adapters: adaptersOf(raw.adapters),
        root: path.dirname(path.resolve(file)),
    };
}

function adaptersOf(raw: unknown): Manifest["adapters"] {
    const out: Manifest["adapters"] = {};
    for (const [name, spec] of Object.entries((raw ?? {}) as Record<string, any>)) {
        if (!NAME.test(name) || name === "http") throw new ManifestError(`adapters.${name}: the name must be letters, digits, '.', '-' and '_', and not "http" (built in).`);
        if (typeof spec?.command !== "string") throw new ManifestError(`adapters.${name} needs a \`command\`, such as "node".`);
        out[name] = { command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [] };
    }
    return out;
}

/** Resolve a path from the manifest, refusing anything that leaves the project folder. */
export function inside(manifest: Pick<Manifest, "root">, rel: string): string {
    const full = path.resolve(manifest.root, rel);
    const r = path.relative(manifest.root, full);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new ManifestError(`${rel} is outside the project folder.`);
    return full;
}

function caseFiles(manifest: Manifest): string[] {
    const out = new Set<string>();
    for (const pattern of manifest.cases) {
        for (const f of fs.globSync(pattern, { cwd: manifest.root })) out.add(path.normalize(f));
    }
    return [...out].sort();
}

export function loadCases(manifest: Manifest): Case[] {
    const all: Case[] = [];
    const seen = new Set<string>();
    for (const rel of caseFiles(manifest)) {
        const doc = readStructured(inside(manifest, rel)) as any;
        const list = Array.isArray(doc) ? doc : doc?.cases;
        if (!Array.isArray(list)) throw new ManifestError(`${rel} must hold a list of cases (or \`cases:\` with a list).`);
        for (const [i, c] of list.entries()) {
            const where = `${rel} case ${i + 1}`;
            if (!c || typeof c.id !== "string" || !NAME.test(c.id)) throw new ManifestError(`${where}: \`id\` must be letters, digits, '.', '-' and '_'.`);
            if (seen.has(c.id)) throw new ManifestError(`${where}: the id ${c.id} is used twice.`);
            seen.add(c.id);
            const req = typeof c.request === "string" ? parseRequestLine(c.request, where) : c.request;
            if (!req || typeof req.path !== "string" || !req.path.startsWith("/") || req.path.startsWith("//")) {
                throw new ManifestError(`${where}: \`request.path\` must start with a single '/': a path, never a host.`);
            }
            if (c.match !== undefined) level(c.match, where);
            all.push({ ...c, request: { method: String(req.method ?? "GET").toUpperCase(), path: req.path, headers: req.headers ?? {}, body: req.body ?? null }, file: rel });
        }
    }
    return all;
}

/** "POST /api/orders" as a request. */
function parseRequestLine(line: string, where: string) {
    const m = /^([A-Za-z]+)\s+(\S+)$/.exec(line.trim());
    if (!m) throw new ManifestError(`${where}: \`request\` written as one line must look like "GET /api/items".`);
    return { method: m[1]!, path: m[2]! };
}

export function loadDrift(manifest: Manifest): Drift[] {
    const file = inside(manifest, manifest.drift);
    if (!fs.existsSync(file)) return [];
    const doc = readStructured(file) as any;
    const list = Array.isArray(doc) ? doc : doc?.drift ?? [];
    return (list as any[]).map((d, i) => {
        for (const k of ["id", "where", "reason", "approved_by"]) {
            if (typeof d?.[k] !== "string" || !d[k].trim()) throw new ManifestError(`${manifest.drift} entry ${i + 1}: \`${k}\` is required. Only a named person approves drift.`);
        }
        return { id: d.id, case: d.case ?? "*", where: d.where, reason: d.reason, approved_by: d.approved_by, ...(d.date ? { date: String(d.date) } : {}) };
    });
}

export const STARTER_MANIFEST = (system: string, reference: string | undefined, candidate: string) => `# Complete Migration Toolkit: one system under test.
# Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit/blob/main/docs/MANIFEST.md
system: ${system}

targets:
${reference ? `  legacy:    { base_url: ${reference} }   # the reference: today's system\n` : ""}  candidate: { base_url: ${candidate} }   # the system under test

# How strict \`cmtk compare\` is: exact | semantic | contract. Loosen per path with overrides.
match: exact
overrides: []
#  - { path: "/api/admin/*", match: semantic }

scrub:
  json_paths: []   # values that change on every call, such as "$..generatedAt"
  xml_ignore: []
  regex: []

compare_headers: [content-type]

contracts: []
#  - { name: catalog-api, kind: openapi, path: /swagger/v1/swagger.json }
#  - { name: billing-soap, kind: wsdl, path: /Billing.svc?singleWsdl }

cases: [cmtk/cases/*.yaml]
drift: cmtk/drift.yaml        # approved differences, each with a named approver
evidence: cmtk/evidence

allow_unsafe_methods: false   # POST, PUT, PATCH, DELETE only against disposable test data
headers_from_env: {}          # e.g. { Authorization: CMTK_TOKEN }: read at run time, never stored
timeout_s: 30
`;
