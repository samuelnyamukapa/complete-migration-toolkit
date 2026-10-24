// cmtk.yaml and the case files: read, fill in defaults, and refuse anything unsafe or unclear.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { BOUNDARY_KINDS, MATCH_LEVELS, type Case, type Drift, type Manifest, type MatchLevel, type Request, type Target } from "./types.js";

export class ManifestError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** An http(s) URL with a host, and nothing that could break out of a YAML or shell value. */
export function isBaseUrl(v: unknown): v is string {
    if (typeof v !== "string" || v.length > 500 || /[\s"'`{}\[\],#&*!|>%@\\]|[\u0000-\u001f\u007f-\u009f]/.test(v.replace(/^https?:\/\/[^/]*@/, "https://"))) return false;
    try {
        const u = new URL(v);
        return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
    } catch {
        return false;
    }
}

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
        const spec: Record<string, unknown> = typeof t === "string" ? { base_url: t } : t && typeof t === "object" && !Array.isArray(t) ? t : {};
        if (Object.keys(spec).length === 0) throw new ManifestError(`targets.${name} needs a base_url, such as http://localhost:5002, or settings for its adapter.`);
        const target: Target = { name };
        for (const [k, v] of Object.entries(spec)) {
            if (k === "name") throw new ManifestError(`targets.${name}: \`name\` is set from the key; remove it.`);
            if (!["string", "number", "boolean"].includes(typeof v)) throw new ManifestError(`targets.${name}.${k} must be text, a number or true/false.`);
            target[k] = v as string | number | boolean;
        }
        if (target.base_url !== undefined) {
            if (!isBaseUrl(target.base_url)) throw new ManifestError(`targets.${name}.base_url must be an http:// or https:// URL, such as http://localhost:5002.`);
            target.base_url = target.base_url.replace(/\/+$/, "");
        }
        targets[name] = target;
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
        cases: globsOf(raw.cases),
        drift: pathOf(raw.drift, "drift", "cmtk/drift.yaml"),
        proposals: pathOf(raw.proposals, "proposals", "cmtk/proposals.yaml"),
        explore_requests_per_day: positive(raw.explore_requests_per_day, "explore_requests_per_day", 1000),
        evidence: pathOf(raw.evidence, "evidence", "cmtk/evidence"),
        allow_unsafe_methods: raw.allow_unsafe_methods === true,
        headers_from_env: raw.headers_from_env ?? {},
        timeout_s: positive(raw.timeout_s, "timeout_s", 30),
        insecure_tls: raw.insecure_tls === true,
        adapters: adaptersOf(raw.adapters),
        root: path.dirname(path.resolve(file)),
        file: path.resolve(file),
    };
}

function globsOf(v: unknown): string[] {
    if (v === undefined || v === null) return ["cmtk/cases/*.yaml"];
    const list = typeof v === "string" ? [v] : v;
    if (!Array.isArray(list) || list.length === 0 || !list.every((g) => typeof g === "string" && g.trim())) {
        throw new ManifestError("`cases` must be a glob or a list of globs, such as [cmtk/cases/*.yaml].");
    }
    return list;
}

function pathOf(v: unknown, key: string, fallback: string): string {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string" || !v.trim()) throw new ManifestError(`\`${key}\` must be a path inside the project folder, such as ${fallback}.`);
    return v;
}

function positive(v: unknown, key: string, fallback: number): number {
    if (v === undefined || v === null) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new ManifestError(`\`${key}\` must be a number of seconds above 0.`);
    return n;
}

function adaptersOf(raw: unknown): Manifest["adapters"] {
    const out: Manifest["adapters"] = {};
    for (const [name, spec] of Object.entries((raw ?? {}) as Record<string, any>)) {
        if (!NAME.test(name) || name === "http") throw new ManifestError(`adapters.${name}: the name must be letters, digits, '.', '-' and '_', and not "http" (built in).`);
        if (typeof spec?.command !== "string") throw new ManifestError(`adapters.${name} needs a \`command\`, such as "node".`);
        if (spec.covers !== undefined && (!Array.isArray(spec.covers) || !spec.covers.every((k: unknown) => typeof k === "string" && (BOUNDARY_KINDS as readonly string[]).includes(k)))) {
            throw new ManifestError(`adapters.${name}.covers must be a list of boundary kinds: ${BOUNDARY_KINDS.join(", ")}.`);
        }
        out[name] = { command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], timeout_s: positive(spec.timeout_s, `adapters.${name}.timeout_s`, 300), ...(spec.covers ? { covers: spec.covers } : {}) };
    }
    return out;
}

const within = (root: string, full: string) => {
    const r = path.relative(root, full);
    return r === "" || !(r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r));
};

/**
 * Resolve a path from the manifest, refusing anything that leaves the project folder, in text or
 * through a link: the deepest part that exists is resolved to its real location first.
 */
export function inside(manifest: Pick<Manifest, "root">, rel: string): string {
    const full = path.resolve(manifest.root, rel);
    if (!within(manifest.root, full)) throw new ManifestError(`${rel} is outside the project folder.`);
    let existing = full;
    const rest: string[] = [];
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) { rest.unshift(path.basename(existing)); existing = path.dirname(existing); }
    const real = path.join(fs.realpathSync.native(existing), ...rest);
    if (!within(fs.realpathSync.native(manifest.root), real)) throw new ManifestError(`${rel} leads outside the project folder through a link (to ${real}).`);
    return full;
}

/** A folder the toolkit may empty and rewrite: inside the project and never the project folder itself. */
export function ownedFolder(manifest: Pick<Manifest, "root">, rel: string): string {
    const full = inside(manifest, rel);
    if (path.relative(manifest.root, full) === "") throw new ManifestError(`${rel} is the project folder itself; the toolkit only rewrites a folder of its own, such as cmtk/evidence.`);
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
    const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i; // file names Windows refuses
    for (const rel of caseFiles(manifest)) {
        const doc = readStructured(inside(manifest, rel)) as any;
        const list = Array.isArray(doc) ? doc : doc?.cases;
        if (!Array.isArray(list)) throw new ManifestError(`${rel} must hold a list of cases (or \`cases:\` with a list).`);
        for (const [i, c] of list.entries()) {
            const where = `${rel} case ${i + 1}`;
            if (!c || typeof c.id !== "string" || !NAME.test(c.id)) throw new ManifestError(`${where}: \`id\` must be letters, digits, '.', '-' and '_'.`);
            if (seen.has(c.id.toLowerCase())) throw new ManifestError(`${where}: the id ${c.id} is used twice (ids must differ by more than upper and lower case, because evidence files are named after them).`);
            if (RESERVED.test(c.id)) throw new ManifestError(`${where}: ${c.id} cannot be an id, because Windows cannot create a file with that name.`);
            seen.add(c.id.toLowerCase());
            const req = typeof c.request === "string" ? parseRequestLine(c.request, where) : c.request;
            if (!req || typeof req.path !== "string" || !req.path.startsWith("/") || req.path.startsWith("//")) {
                throw new ManifestError(`${where}: \`request.path\` must start with a single '/': a path, never a host.`);
            }
            if (c.match !== undefined) level(c.match, where);
            if (c.draft !== undefined && typeof c.draft !== "boolean") throw new ManifestError(`${where}: \`draft\` must be true or false.`);
            const method = String(req.method ?? "GET").toUpperCase();
            if (!/^[A-Z]+$/.test(method)) throw new ManifestError(`${where}: the method ${JSON.stringify(req.method)} must be letters only, such as GET or POST.`);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = String(v);
            let body: string | null = null;
            if (typeof req.body === "string") body = req.body;
            else if (req.body !== undefined && req.body !== null) {
                body = JSON.stringify(req.body); // a YAML mapping or list is sent as JSON
                if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
            }
            const request: Request = { method, path: req.path, headers, body };
            if (req.body_file !== undefined) {
                if (body !== null) throw new ManifestError(`${where}: give \`body\` or \`body_file\`, not both.`);
                if (typeof req.body_file !== "string" || !req.body_file.trim()) throw new ManifestError(`${where}: \`body_file\` must be a file inside the project folder.`);
                inside(manifest, req.body_file); // refuses a path outside the project; existence is checked when the case runs
                request.body_file = req.body_file;
            }
            if (req.files !== undefined) {
                if (body !== null || request.body_file) throw new ManifestError(`${where}: \`files\` is a multipart body, so give no \`body\` or \`body_file\` with it.`);
                if (!Array.isArray(req.files) || !req.files.length) throw new ManifestError(`${where}: \`files\` must be a list of { field, path, filename?, content_type? }.`);
                request.files = req.files.map((f: any, j: number) => {
                    if (!f || typeof f.field !== "string" || !f.field.trim() || typeof f.path !== "string" || !f.path.trim()) throw new ManifestError(`${where}: files[${j}] needs \`field\` and \`path\`.`);
                    if (/[\r\n"]/.test(f.field) || /[\r\n"]/.test(String(f.filename ?? ""))) throw new ManifestError(`${where}: files[${j}]: a field or file name cannot hold quotes or line breaks.`);
                    inside(manifest, f.path);
                    return { field: f.field, path: f.path, ...(f.filename ? { filename: String(f.filename) } : {}), ...(f.content_type ? { content_type: String(f.content_type) } : {}) };
                });
            }
            if (req.body_form !== undefined) {
                if (body !== null || request.body_file) throw new ManifestError(`${where}: \`body_form\` is the body, so give no \`body\` or \`body_file\` with it.`);
                if (typeof req.body_form === "string") {
                    if (!req.body_form.trim()) throw new ManifestError(`${where}: \`body_form\` must be a JSON file inside the project folder, or a mapping of fields.`);
                    inside(manifest, req.body_form);
                    request.body_form = req.body_form;
                } else if (req.body_form && typeof req.body_form === "object" && !Array.isArray(req.body_form)) {
                    for (const [k, v] of Object.entries(req.body_form)) {
                        const bad = formValueProblem(v);
                        if (bad) throw new ManifestError(`${where}: body_form.${k} ${bad}.`);
                    }
                    request.body_form = req.body_form;
                } else throw new ManifestError(`${where}: \`body_form\` must be a JSON file inside the project folder, or a mapping of fields.`);
            }
            if (req.before !== undefined) {
                const b = req.before;
                if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.get !== "string" || !b.get.startsWith("/") || b.get.startsWith("//")) {
                    throw new ManifestError(`${where}: \`before\` must be { get: /a/path, take?: { field: selector } }: a path on the same target, never a host.`);
                }
                if (b.take !== undefined) {
                    if (!b.take || typeof b.take !== "object" || Array.isArray(b.take)) throw new ManifestError(`${where}: \`before.take\` must map a form field to a selector.`);
                    for (const [k, v] of Object.entries(b.take)) {
                        if (typeof v !== "string" || !v.trim()) throw new ManifestError(`${where}: before.take.${k} must be a selector such as input[name=${k}].`);
                        if (!request.body_form && !request.files) throw new ManifestError(`${where}: \`before.take\` puts ${k} into a form, so the case needs \`body_form\` or \`files\`.`);
                    }
                }
                request.before = { get: b.get, ...(b.take ? { take: b.take } : {}) };
            }
            all.push({ ...c, request, file: rel });
        }
    }
    return all;
}

/** Why a value cannot be a form field, or undefined when it can. */
export function formValueProblem(v: unknown): string | undefined {
    const scalar = (x: unknown) => x === null || ["string", "number", "boolean"].includes(typeof x);
    if (scalar(v)) return undefined;
    if (Array.isArray(v)) return v.every(scalar) ? undefined : "is a list with a nested value; a form field holds text, a number, a boolean, null, or a list of those";
    return "is an object; a form field holds text, a number, a boolean, null, or a list of those (sent as repeated fields)";
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

/** Settings for testing one system against its requirements: nothing about migrations. */
const TESTER_MANIFEST = (system: string, candidate: string) => `# Complete Migration Toolkit: test one system against its requirements.
# Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit/blob/main/docs/TESTER-RUNBOOK.md
system: ${system}

targets:
  candidate: { base_url: ${JSON.stringify(candidate)} }   # the system under test

cases: [cmtk/cases/*.yaml]    # one case per acceptance criterion; agents' drafts wait for \`cmtk review\`
evidence: cmtk/evidence

allow_unsafe_methods: false   # POST, PUT, PATCH, DELETE only against disposable test data
headers_from_env: {}          # e.g. { Authorization: CMTK_TOKEN }: read at run time, never stored
timeout_s: 30
`;

export const STARTER_MANIFEST = (system: string, reference: string | undefined, candidate: string) => reference ? MIGRATION_MANIFEST(system, reference, candidate) : TESTER_MANIFEST(system, candidate);

const MIGRATION_MANIFEST = (system: string, reference: string, candidate: string) => `# Complete Migration Toolkit: one system under test.
# Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit/blob/main/docs/MANIFEST.md
system: ${system}

targets:
  legacy:    { base_url: ${JSON.stringify(reference)} }   # the reference: today's system
  candidate: { base_url: ${JSON.stringify(candidate)} }   # the system under test

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
