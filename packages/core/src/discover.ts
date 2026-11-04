// cmtk discover: the parity suite's first step. It lists every boundary the legacy system has
// (what it serves, and everything it calls, stores, sends or reads), from the evidence it is given,
// and flags each one that no adapter covers. A boundary nobody listed is a boundary nobody tests.
//
// Sources, any mix of them:
//   - assemblies, read by REA (Reverse Engineer Anything, https://github.com/morluto/rea) without
//     running them: controllers, database, file, mail, queue and HTTP-client calls;
//   - REA's saved output for an assembly (`rea inspect-managed-members <dll> --json`, and
//     `rea inspect-managed-artifact <dll> --json` for its attributes);
//   - C# source, for controllers' [Route] attributes;
//   - configuration files: Web.config, App.config, appsettings.json;
//   - HAR recordings of real use;
//   - modernize's topology.json (from /modernize:map);
//   - what an agent found by reading the code, each with its evidence.
// Nothing here runs the legacy system or changes it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseXml, type XNode } from "./diff.js";
import { cleanUrl } from "./defects.js";
import { inside, ManifestError } from "./manifest.js";
import { isRouteAttribute, joinRoutes, readRouteSources, REA_ROUTE_GAP, sourceMatches, templateFromRea, type ReaAttribute, type SourceController, type SourceRoute } from "./routes.js";
import { BOUNDARY_KINDS, type BoundaryKind, type Manifest } from "./types.js";


export interface Boundary {
    /** Stable across runs: the kind and a slug of the name. */
    id: string;
    kind: BoundaryKind;
    /** in: the system serves it. out: the system calls, stores, sends or reads through it. */
    direction: "in" | "out";
    name: string;
    /** An address, a route, a database, a folder: whatever says where it is. Never a credential. */
    where?: string;
    /** The evidence: which source showed it, and what exactly. */
    found_in: { source: string; detail: string }[];
    /** The adapter that covers it, or undefined when none does. */
    covered_by?: string;
}

export interface FoundInput {
    kind: string;
    name: string;
    where?: string;
    direction?: "in" | "out";
    /** Where it was seen, such as "src/Billing/Mailer.cs:42 calls SmtpClient.Send". Required. */
    evidence: string;
}

export interface DiscoverInput {
    assemblies?: string[];
    reaJson?: string[];
    /** C# files, or folders of them, to read route attributes from. */
    routesFrom?: string[];
    configs?: string[];
    har?: string[];
    topology?: string[];
    found?: FoundInput[];
    /** Who found `found`, such as "agent: Copilot". */
    agent?: string;
    /** Start from nothing instead of adding to the last discovery. */
    fresh?: boolean;
}

export interface Discovery {
    system: string;
    date: string;
    sources: string[];
    boundaries: Boundary[];
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;
const clean = (v: unknown, what: string, max = 500): string => {
    if (typeof v !== "string" || !v.trim()) throw new ManifestError(`${what} is required.`);
    if (CONTROL.test(v)) throw new ManifestError(`${what} holds control characters; write plain text.`);
    return v.trim().slice(0, max);
};
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unnamed";
const rel = (m: Manifest, f: string) => path.relative(m.root, f).split(path.sep).join("/");

// ---------------------------------------------------------------- REA: .NET assemblies

/** Calls into these outside types mean a boundary. Checked in order; the first match wins. */
const CALL_RULES: Array<[RegExp, BoundaryKind, "in" | "out"]> = [
    [/^System\.ServiceModel\.(ServiceHost|ServiceHostBase)$/, "soap", "in"],
    [/^System\.ServiceModel\.(ClientBase`1|ChannelFactory`1)$/, "soap", "out"],
    [/^System\.Net\.Http\.HttpClient$|^System\.Net\.(WebClient|HttpWebRequest|WebRequest)$|^RestSharp\.|^Flurl\./, "outbound-http", "out"],
    [/^System\.Data\.(Entity|SqlClient|OleDb|Odbc)\.|^Microsoft\.Data\.(SqlClient|Sqlite)\.|^Microsoft\.EntityFrameworkCore\.?|^(Npgsql|MySql|MySqlConnector|Oracle|Dapper|MongoDB|StackExchange\.Redis)\b/, "database", "out"],
    [/^System\.IO\.(File|FileInfo|FileStream|Directory|DirectoryInfo|FileSystemWatcher)$|^System\.IO\.Compression\.ZipFile$/, "files", "out"],
    [/^System\.Net\.Mail\.|^(MailKit|MimeKit|SendGrid)\./, "email", "out"],
    [/^System\.Messaging\.|^(RabbitMQ|Confluent\.Kafka|Amazon\.SQS|MassTransit|NServiceBus)\b|^Azure\.Messaging\.|^Microsoft\.Azure\.ServiceBus/, "queue", "out"],
    [/^Twilio\./, "sms", "out"],
    [/^(Stripe|Braintree|PayPal|Adyen|Square)\./, "payments", "out"],
    [/^System\.ServiceProcess\.ServiceBase$|^Microsoft\.Extensions\.Hosting\.BackgroundService$|^(Quartz|Hangfire)\./, "worker", "in"],
    [/^(log4net|NLog|Serilog)\./, "logs", "out"],
];
const MVC = /^System\.Web\.Mvc\.(Controller|ControllerBase)$|^Microsoft\.AspNetCore\.Mvc\.(Controller|ControllerBase)$/;
const WEB_API = /^System\.Web\.Http\.ApiController$/;

interface ReaMembers {
    types?: Array<{ token?: string; full_name?: string }>;
    methods: Array<{ token: string; declaring_type?: string; name?: string }>;
    call_edges: Array<{ caller_token?: string; caller?: string; target_declaring_type?: string }>;
}

/** Is this `rea inspect-managed-artifact` output? It lists attributes, and no methods. */
function attributesOf(raw: unknown): ReaAttribute[] | undefined {
    const n = (raw as any)?.normalized_result ?? raw;
    return Array.isArray(n?.attributes) && !Array.isArray(n?.methods) ? (n.attributes as ReaAttribute[]) : undefined;
}
const assemblyName = (raw: unknown, what: string) => { const j = raw as any; return path.basename(String(j?.subject?.name ?? j?.normalized_result?.artifact?.path ?? what)); };

function readReaMembers(raw: unknown, what: string): { assembly: string; members: ReaMembers } {
    const j = raw as any;
    const n = j?.normalized_result ?? j;
    if (!Array.isArray(n?.methods) || !Array.isArray(n?.call_edges)) {
        throw new ManifestError(`${what} is not the output of \`rea inspect-managed-members <dll> --json\`: it has no methods and call_edges.`);
    }
    const assembly = path.basename(String(j?.subject?.name ?? n?.artifact?.path ?? what));
    return { assembly, members: n as ReaMembers };
}

/** A finding before it is merged: `users` are the types that use it, for matching a connection string to its context. */
type Finding = Omit<Boundary, "id" | "covered_by"> & { users?: string[] };

/** What is known of one controller's routes, from its attributes and its source. */
function routeOf(type: string, n: ReaMembers, attrs: ReaAttribute[] | undefined, src: SourceController | undefined, guess: string): { where: string; evidence?: { source: string; detail: string }[] } {
    const typeToken = (n.types ?? []).find((t) => t.full_name === type)?.token;
    const tokens = new Map((n.methods ?? []).filter((m) => m.declaring_type === type).map((m) => [m.token, m.name ?? ""]));
    const route = (attrs ?? []).filter((a) => isRouteAttribute(a.type_name));
    const onType = route.filter((a) => a.parent_token === typeToken);
    const onMethods = route.filter((a) => a.parent_token !== undefined && tokens.has(a.parent_token));
    const found = [...onType, ...onMethods];
    const srcRoutes: SourceRoute[] = src ? [...src.on_type, ...src.on_methods.flatMap((x) => x.routes)] : [];
    const join = (t: (string | null)[], m: (string | null)[]) => joinRoutes(t, m).join(", ");
    if (!found.length && !srcRoutes.length) {
        return { where: `${guess} (by naming convention; ${attrs ? "it has no [Route] attribute" : "check the real route"})` };
    }
    // REA itself gives the value: nothing else is needed.
    if (found.length) {
        const fromRea = found.map(templateFromRea);
        if (fromRea.every((t) => t !== undefined)) {
            const heads = onType.map((a) => templateFromRea(a) as string);
            return { where: join(heads, onMethods.map((a) => templateFromRea(a) as string)), evidence: [{ source: "REA", detail: `${found.length} route attribute${found.length === 1 ? "" : "s"} decoded` }] };
        }
    }
    if (srcRoutes.length && src) {
        const where = join(src.on_type.map((r) => r.template), src.on_methods.flatMap((x) => x.routes.map((r) => r.template)));
        const at = srcRoutes.map((r) => `${r.file}:${r.line}`).join(", ");
        if (!found.length) {
            if (attrs) return { where: `${where} (from source; the assembly has no such attribute: is the source for this build?)`, evidence: [{ source: "source", detail: `route attributes at ${at}, none in the assembly` }] };
            return { where: `${where} (from source; not checked against a build)`, evidence: [{ source: "source", detail: `route attributes at ${at}` }] };
        }
        const unmatched = found.filter((a) => !srcRoutes.some((s) => sourceMatches(s, a)));
        if (!unmatched.length && srcRoutes.length === found.length) {
            return { where, evidence: [{ source: "source", detail: `route attributes at ${at}, each matching the assembly's attribute by sha256` }] };
        }
        return { where: `${where} (from source; ${unmatched.length || "some"} of ${found.length} attributes in the assembly do not match it: is the source for this build?)`, evidence: [{ source: "source", detail: `route attributes at ${at}` }] };
    }
    return { where: `route attribute present, value not read: ${found.length} on this controller. Pass its source with --routes-from. ${REA_ROUTE_GAP}` };
}

function fromReaMembers(assembly: string, n: ReaMembers, source: string, attrs?: ReaAttribute[], sources: SourceController[] = []): Finding[] {
    const typeOf = new Map(n.methods.map((m) => [m.token, m.declaring_type ?? ""]));
    const callerType = (e: ReaMembers["call_edges"][number]) => {
        const t = (e.caller_token && typeOf.get(e.caller_token)) || "";
        // Compiler-made nested types (<>c, <>c__DisplayClass…) stand for the method that made them.
        return t.startsWith("<") ? "" : t;
    };
    const out: Finding[] = [];
    const controllers = new Map<string, "mvc" | "api">();
    const byKind = new Map<string, { kind: BoundaryKind; direction: "in" | "out"; uses: Map<string, Set<string>> }>();
    for (const e of n.call_edges) {
        const target = e.target_declaring_type ?? "";
        const caller = callerType(e);
        if (!target || !caller) continue;
        if (MVC.test(target)) { if (!controllers.has(caller)) controllers.set(caller, "mvc"); continue; }
        if (WEB_API.test(target)) { controllers.set(caller, "api"); continue; }
        const rule = CALL_RULES.find(([re]) => re.test(target));
        if (!rule) continue;
        const key = `${rule[1]}|${rule[2]}`;
        const k = byKind.get(key) ?? { kind: rule[1], direction: rule[2], uses: new Map() };
        k.uses.set(caller, (k.uses.get(caller) ?? new Set()).add(target));
        byKind.set(key, k);
    }
    for (const [type, style] of [...controllers].sort()) {
        const short = type.split(".").pop()!.replace(/Controller\d*$/, (m) => m.replace("Controller", ""));
        const guess = style === "api" ? `/api/${short.toLowerCase()}` : `/${short}`;
        const route = routeOf(type, n, attrs, sources.find((s) => s.type === type), guess);
        out.push({
            kind: "http", direction: "in", name: type, where: route.where,
            found_in: [{ source, detail: `${type} is ${style === "api" ? "a Web API" : "an MVC"} controller` }, ...(route.evidence ?? [])],
        });
    }
    for (const k of byKind.values()) {
        const users = [...k.uses].sort(([a], [b]) => a.localeCompare(b));
        const short = (t: string) => t.replace(/`\d+$/, "").split(".").pop();
        const listed = users.slice(0, 6).map(([t, targets]) => {
            const ts = [...targets].sort();
            return `${t} (${ts.slice(0, 3).map(short).join(", ")}${ts.length > 3 ? ", …" : ""})`;
        });
        out.push({
            kind: k.kind, direction: k.direction, name: `${assembly}: ${k.kind}`, users: users.map(([t]) => t),
            found_in: [{ source, detail: `used by ${listed.join("; ")}${users.length > 6 ? `; and ${users.length - 6} more types` : ""}` }],
        });
    }
    return out;
}

/** Run REA on one assembly. CMTK_REA can name its command: a path to REA's rea.mjs, or a program. */
export function runRea(file: string, command: "inspect-managed-members" | "inspect-managed-artifact" = "inspect-managed-members"): unknown {
    const set = process.env.CMTK_REA?.trim();
    const [cmd, pre] = set ? (/\.(m?js|cjs)$/i.test(set) ? [process.execPath, [set]] : [set, []]) : [process.platform === "win32" ? "rea.cmd" : "rea", []];
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd as string);
    if (shell && /["%^&|<>!\r\n]/.test(file)) throw new ManifestError(`${file}: the path holds a character the Windows shell would read; rename the file or folder.`);
    const args = [...(pre as string[]), command, shell ? `"${file}"` : file, "--json"];
    const r = spawnSync(cmd as string, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 300_000, shell, windowsHide: true });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT" || (shell && r.status !== 0 && /not recognized/i.test(r.stderr ?? ""))) {
        throw new ManifestError("REA is not installed. Install it with `npm install --global rea-agents` (it needs Node.js 22.19 or later), or set CMTK_REA to its command. Or run `rea inspect-managed-members <dll> --json` elsewhere and pass the saved output with --rea-json.");
    }
    if (r.error) throw new ManifestError(`REA failed on ${path.basename(file)}: ${r.error.message}`);
    if (r.status !== 0) throw new ManifestError(`REA failed on ${path.basename(file)}: ${(r.stderr || r.stdout || "").trim().split("\n")[0]?.slice(0, 300) ?? `exit ${r.status}`}`);
    try {
        return JSON.parse(r.stdout);
    } catch {
        throw new ManifestError(`REA's output for ${path.basename(file)} is not JSON.`);
    }
}

// ---------------------------------------------------------------- configuration files

/** The server and database of a connection string, never its user, password or key. */
export function describeConnection(cs: string): string {
    const parts = new Map<string, string>();
    for (const p of cs.split(";")) {
        const i = p.indexOf("=");
        if (i > 0) parts.set(p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim());
    }
    const server = parts.get("data source") ?? parts.get("server") ?? parts.get("host") ?? parts.get("address") ?? parts.get("addr") ?? parts.get("network address");
    const db = parts.get("initial catalog") ?? parts.get("database");
    if (!server && !db) return /^[a-z]+:\/\//i.test(cs) ? cleanUrl(cs).replace(/\?.*$/, "") : "(not recognised)";
    return [server && `server ${server}`, db && `database ${db}`].filter(Boolean).join(", ");
}

const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const origin = (u: string) => { try { const x = new URL(u); x.username = ""; x.password = ""; return `${x.protocol}//${x.host}`; } catch { return u; } };

function walkXml(n: XNode, visit: (n: XNode, pathTo: string[]) => void, at: string[] = []) {
    const here = [...at, n.local];
    visit(n, here);
    for (const c of n.children) walkXml(c, visit, here);
}

function fromXmlConfig(text: string, source: string): Finding[] {
    const out: Finding[] = [];
    walkXml(parseXml(text), (n, at) => {
        const parent = at[at.length - 2];
        const a = (k: string) => n.attrs.get(k);
        if (parent === "connectionStrings" && n.local === "add" && a("name")) {
            out.push({ kind: "database", direction: "out", name: a("name")!, where: describeConnection(a("connectionString") ?? ""), found_in: [{ source, detail: `connection string "${a("name")}"${a("providerName") ? ` (${a("providerName")})` : ""}` }] });
        } else if (parent === "appSettings" && n.local === "add" && a("key") && a("value")) {
            const v = a("value")!.trim();
            if (URL_RE.test(v)) out.push({ kind: "outbound-http", direction: "out", name: a("key")!, where: origin(v), found_in: [{ source, detail: `appSettings "${a("key")}"` }] });
            else if (/^formatname:|\\private\$\\/i.test(v)) out.push({ kind: "queue", direction: "out", name: a("key")!, where: v, found_in: [{ source, detail: `appSettings "${a("key")}" names a message queue` }] });
            else if (/^\\\\[^\\]+\\[^\\]+/.test(v)) out.push({ kind: "files", direction: "out", name: a("key")!, where: v, found_in: [{ source, detail: `appSettings "${a("key")}" names a file share` }] });
        } else if (n.local === "smtp" && at.includes("mailSettings")) {
            const host = n.children.find((c) => c.local === "network")?.attrs.get("host");
            out.push({ kind: "email", direction: "out", name: "smtp", where: host ?? a("pickupDirectoryLocation") ?? a("deliveryMethod") ?? "(not set)", found_in: [{ source, detail: "system.net/mailSettings/smtp" }] });
        } else if (n.local === "endpoint" && parent === "client" && at.includes("system.serviceModel")) {
            out.push({ kind: "soap", direction: "out", name: a("name") ?? a("contract") ?? "client endpoint", where: a("address") ? origin(a("address")!) : undefined, found_in: [{ source, detail: `WCF client endpoint for ${a("contract") ?? "a contract"}` }] });
        } else if (n.local === "service" && parent === "services" && at.includes("system.serviceModel")) {
            out.push({ kind: "soap", direction: "in", name: a("name") ?? "service", found_in: [{ source, detail: "WCF service" }] });
        }
    });
    return out;
}

function fromJsonConfig(value: unknown, source: string): Finding[] {
    const out: Finding[] = [];
    const walk = (v: unknown, at: string[]) => {
        if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const [k, x] of Object.entries(v)) walk(x, [...at, k]);
            return;
        }
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...at, String(i)])); return; }
        if (typeof v !== "string") return;
        const key = at.join(":");
        if (at.length === 2 && at[0]!.toLowerCase() === "connectionstrings") {
            out.push({ kind: "database", direction: "out", name: at[1]!, where: describeConnection(v), found_in: [{ source, detail: `ConnectionStrings:${at[1]}` }] });
        } else if (URL_RE.test(v.trim())) {
            out.push({ kind: "outbound-http", direction: "out", name: key, where: origin(v.trim()), found_in: [{ source, detail: key }] });
        } else if (/smtp/i.test(key) && /host|server/i.test(at[at.length - 1] ?? "")) {
            out.push({ kind: "email", direction: "out", name: key, where: v, found_in: [{ source, detail: key }] });
        }
    };
    walk(value, []);
    return out;
}

// ---------------------------------------------------------------- HAR and topology

function fromHar(raw: any, source: string, ownHosts: Set<string>): Finding[] {
    const entries: any[] = raw?.log?.entries;
    if (!Array.isArray(entries)) throw new ManifestError(`${source} is not a HAR file: it has no log.entries.`);
    const byOrigin = new Map<string, Set<string>>();
    for (const e of entries) {
        try {
            const u = new URL(String(e?.request?.url));
            const o = `${u.protocol}//${u.host}`;
            byOrigin.set(o, (byOrigin.get(o) ?? new Set()).add(`${String(e.request.method ?? "GET").toUpperCase()} ${u.pathname}`));
        } catch { /* not a URL */ }
    }
    return [...byOrigin].map(([o, paths]) => {
        const own = ownHosts.has(new URL(o).host);
        return {
            kind: own ? "http" as const : "outbound-http" as const, direction: own ? "in" as const : "out" as const, name: o, where: o,
            found_in: [{ source, detail: `${paths.size} distinct request${paths.size === 1 ? "" : "s"}${own ? "" : ", made by the browser"}` }],
        };
    });
}

function fromTopology(raw: any, source: string): Finding[] {
    const out: Finding[] = [];
    if (!raw?.root) throw new ManifestError(`${source} is not modernize's topology.json: it has no root.`);
    const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        const name = String(n.name ?? n.id ?? "");
        if (n.kind === "datastore") out.push({ kind: /file|folder|share|csv|vsam|dataset/i.test(name) ? "files" : "database", direction: "out", name, found_in: [{ source, detail: `data store ${n.id ?? name}` }] });
        if (n.kind === "job") out.push({ kind: "worker", direction: "in", name, found_in: [{ source, detail: `job ${n.id ?? name}` }] });
        if (n.kind === "screen") out.push({ kind: "ui", direction: "in", name, found_in: [{ source, detail: `screen ${n.id ?? name}` }] });
        for (const c of Array.isArray(n.children) ? n.children : []) walk(c);
    };
    walk(raw.root);
    return out;
}

// ---------------------------------------------------------------- the inventory

function coveredBy(b: Pick<Boundary, "kind" | "direction">, m: Manifest): string | undefined {
    if (b.direction === "in" && (b.kind === "http" || b.kind === "soap")) return "http (built in)";
    for (const [name, a] of Object.entries(m.adapters)) if (name === b.kind || (a.covers ?? []).includes(b.kind)) return name;
    return undefined;
}

export function discoveryFolder(m: Manifest): string {
    return inside(m, path.join(path.dirname(m.proposals), "discovery"));
}

export function loadDiscovery(m: Manifest): Discovery | undefined {
    const f = path.join(discoveryFolder(m), "boundaries.json");
    if (!fs.existsSync(f)) return undefined;
    const d = JSON.parse(fs.readFileSync(f, "utf8")) as Discovery;
    for (const b of d.boundaries) b.covered_by = coveredBy(b, m); // adapters may have changed since
    return d;
}

export function discover(m: Manifest, input: DiscoverInput, date = new Date().toISOString().slice(0, 10)): { file: string; discovery: Discovery } {
    const found: Finding[] = [];
    const sources: string[] = [];
    const file = (f: string, what: string) => {
        const full = inside(m, f);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ManifestError(`${what} ${f} does not exist.`);
        return full;
    };
    const routeSources: SourceController[] = [];
    for (const f of input.routesFrom ?? []) {
        const full = inside(m, f);
        if (!fs.existsSync(full)) throw new ManifestError(`The source ${f} does not exist.`);
        routeSources.push(...readRouteSources(full, (x) => rel(m, x)));
        sources.push(`C# source ${rel(m, full)}`);
    }
    const seenControllers = new Set<string>();
    const fromRea = (assembly: string, members: ReaMembers, source: string, attrs?: ReaAttribute[]) => {
        const out = fromReaMembers(assembly, members, source, attrs, routeSources);
        for (const x of out) if (x.kind === "http") seenControllers.add(x.name);
        found.push(...out);
    };
    for (const f of input.assemblies ?? []) {
        const full = file(f, "The assembly");
        const { assembly, members } = readReaMembers(runRea(full), rel(m, full));
        // Older versions of REA may not have this command: the routes then fall back, and say so.
        let attrs: ReaAttribute[] | undefined;
        try { attrs = attributesOf(runRea(full, "inspect-managed-artifact")); } catch { attrs = undefined; }
        fromRea(assembly, members, `REA: ${rel(m, full)}`, attrs);
        sources.push(`REA on ${rel(m, full)}`);
    }
    // Saved output: a member inventory, and an artifact inspection with its attributes, in either order.
    const saved = (input.reaJson ?? []).map((f) => { const full = file(f, "REA's output"); return { full, raw: JSON.parse(fs.readFileSync(full, "utf8")) as unknown }; });
    const savedAttrs = new Map<string, ReaAttribute[]>();
    for (const s of saved) {
        const attrs = attributesOf(s.raw);
        if (attrs) { savedAttrs.set(assemblyName(s.raw, rel(m, s.full)), attrs); sources.push(`REA's saved output ${rel(m, s.full)}`); }
    }
    for (const s of saved) {
        if (attributesOf(s.raw)) continue;
        const { assembly, members } = readReaMembers(s.raw, rel(m, s.full));
        fromRea(assembly, members, `REA: ${rel(m, s.full)}`, savedAttrs.get(assembly));
        sources.push(`REA's saved output ${rel(m, s.full)}`);
    }
    // A controller only the source shows is a boundary too, and says that no build confirmed it.
    for (const s of routeSources) {
        if (!s.controller || seenControllers.has(s.type)) continue;
        const onMethods = s.on_methods.flatMap((x) => x.routes.map((r) => r.template));
        const routes = joinRoutes(s.on_type.map((r) => r.template), onMethods);
        const at = [...s.on_type, ...s.on_methods.flatMap((x) => x.routes)][0];
        found.push({ kind: "http", direction: "in", name: s.type, where: routes.length ? `${routes.join(", ")} (from source; not checked against a build)` : "(no route attribute in the source)", found_in: [{ source: "source", detail: at ? `${at.file}:${at.line}` : `${s.type} looks like a controller` }] });
    }
    for (const f of input.configs ?? []) {
        const full = file(f, "The settings file");
        const text = fs.readFileSync(full, "utf8").replace(/^﻿/, "");
        found.push(...(/\.json$/i.test(full) ? fromJsonConfig(JSON.parse(text), rel(m, full)) : fromXmlConfig(text, rel(m, full))));
        sources.push(rel(m, full));
    }
    const ownHosts = new Set(Object.values(m.targets).flatMap((t) => { try { return t.base_url ? [new URL(t.base_url).host] : []; } catch { return []; } }));
    for (const f of input.har ?? []) {
        const full = file(f, "The HAR file");
        found.push(...fromHar(JSON.parse(fs.readFileSync(full, "utf8")), rel(m, full), ownHosts));
        sources.push(rel(m, full));
    }
    for (const f of input.topology ?? []) {
        const full = file(f, "The topology file");
        found.push(...fromTopology(JSON.parse(fs.readFileSync(full, "utf8")), rel(m, full)));
        sources.push(rel(m, full));
    }
    if (input.found?.length) {
        const who = clean(input.agent, "The agent's name", 100);
        for (const [i, x] of input.found.entries()) {
            const kind = clean(x.kind, `found[${i}].kind`, 40);
            if (!(BOUNDARY_KINDS as readonly string[]).includes(kind)) throw new ManifestError(`found[${i}].kind must be one of: ${BOUNDARY_KINDS.join(", ")}.`);
            found.push({
                kind: kind as BoundaryKind, direction: x.direction === "in" ? "in" : x.direction === "out" ? "out" : kind === "http" || kind === "soap" || kind === "worker" || kind === "ui" ? "in" : "out",
                name: clean(x.name, `found[${i}].name`, 200), ...(x.where ? { where: cleanUrl(clean(x.where, `found[${i}].where`, 300)) } : {}),
                found_in: [{ source: `agent: ${who.replace(/^agent:\s*/i, "")}`, detail: clean(x.evidence, `found[${i}].evidence`, 500) }],
            });
        }
        sources.push(`findings from agent ${who.replace(/^agent:\s*/i, "")}`);
    }
    if (!sources.length) throw new ManifestError("Give discover something to read: --assembly, --rea-json, --routes-from, --config, --har or --topology (or findings, from an agent).");

    // An Entity Framework context reads its connection string by its own name: fold what REA saw into
    // the connection string from the settings, rather than listing one database twice.
    for (const db of found.filter((f) => f.kind === "database" && f.users)) {
        const named = found.find((f) => f.kind === "database" && !f.users && db.users!.some((u) => u.split(".").pop() === f.name));
        if (named) { named.found_in.push(...db.found_in); found.splice(found.indexOf(db), 1); }
    }
    const previous = input.fresh ? undefined : loadDiscovery(m);
    const byId = new Map<string, Boundary>((previous?.boundaries ?? []).map((b) => [b.id, b]));
    for (const f of found) {
        const id = `${f.kind}:${slug(f.name)}`;
        const b = byId.get(id) ?? { id, kind: f.kind, direction: f.direction, name: f.name, found_in: [] };
        if (!b.where && f.where) b.where = f.where;
        for (const e of f.found_in) if (!b.found_in.some((x) => x.source === e.source && x.detail === e.detail)) b.found_in.push(e);
        byId.set(id, b);
    }
    const boundaries = [...byId.values()].map((b) => ({ ...b, covered_by: coveredBy(b, m) }))
        .sort((a, b) => Number(!!a.covered_by) - Number(!!b.covered_by) || BOUNDARY_KINDS.indexOf(a.kind) - BOUNDARY_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));
    const discovery: Discovery = { system: m.system, date, sources: [...new Set([...(previous?.sources ?? []), ...sources])], boundaries };
    const dir = discoveryFolder(m);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "boundaries.json"), JSON.stringify(discovery, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "BOUNDARIES.md"), renderDiscovery(discovery), "utf8");
    return { file: rel(m, path.join(dir, "BOUNDARIES.md")), discovery };
}

const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function describeDiscovery(d: Discovery): string {
    const open = d.boundaries.filter((b) => !b.covered_by);
    return `${d.boundaries.length} boundar${d.boundaries.length === 1 ? "y" : "ies"}: ${d.boundaries.length - open.length} covered by an adapter, ${open.length} uncovered.`;
}

export function renderDiscovery(d: Discovery): string {
    const open = d.boundaries.filter((b) => !b.covered_by);
    const L = [`# Boundaries: ${d.system}`, "",
        `Written by \`cmtk discover\` on ${d.date}. ${describeDiscovery(d)}`, "",
        "A boundary is anything the system serves, or calls, stores, sends or reads through. Each one needs cases, and an adapter to run them, before parity can be claimed for it. Run `cmtk discover` again after adding a source or an adapter.", "",
        `Sources: ${d.sources.join("; ")}.`, "",
        "| Boundary | Kind | Direction | Where | Covered by | Found in |", "|---|---|---|---|---|---|"];
    for (const b of d.boundaries) {
        L.push(`| ${cell(b.name)} | ${b.kind} | ${b.direction} | ${cell(b.where)} | ${b.covered_by ? cell(b.covered_by) : "**uncovered**"} | ${cell(b.found_in.map((f) => `${f.source}: ${f.detail}`).join("; "))} |`);
    }
    L.push("");
    if (open.length) {
        L.push("## Uncovered", "", "No adapter covers these, so no case can check them yet. For each kind, either:",
            "- write an adapter with `cmtk adapter new <name>` and list the kind under its `covers` in `cmtk.yaml`; or",
            "- have a person record why it is out of scope.", "");
        for (const k of [...new Set(open.map((b) => b.kind))]) L.push(`- **${k}**: ${open.filter((b) => b.kind === k).map((b) => cell(b.name)).join(", ")}`);
        L.push("");
    }
    L.push("## Limits", "",
        "- Assemblies are read by REA, never run. Calls made through reflection, dependency injection resolved at run time, or configuration may be missed.",
        "- A controller's route comes from its [Route] attributes, read from its source with `--routes-from` and proved against the build by REA's sha256. REA does not give an attribute's value, so without the source a controller with an attribute says so, and only a controller with no attribute keeps a guess from its name.",
        "- Discovery lists what its sources show. It never proves that nothing else exists: add sources (configuration, recordings, the map) until the list stops growing.", "");
    return L.join("\n");
}
