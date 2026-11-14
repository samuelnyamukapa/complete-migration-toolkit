// Real routes for controllers, from [Route] attributes. A guess from the name is kept only where a
// controller has no attribute at all.
//
// What REA gives (6.8.0, `rea inspect-managed-artifact <dll> --json`): for each attribute, its type, its
// parent, `value_length` and `value_sha256`. It gives no bytes, and it fills `decoded_fixed_string` only for
// TargetFrameworkAttribute. So a template can't be read from REA's output today. Two ways round that:
//   - if REA starts giving the bytes (`value_hex`, `value_base64`) or fills `decoded_fixed_string` for every
//     attribute, they are read here, with the bytes checked against `value_sha256`;
//   - otherwise the template is read from the C# source (`--routes-from`), and REA's digest then proves or
//     disproves that the source matches the build: the attribute's bytes are fully determined by its arguments.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** One [Route]-like attribute on a type or method, as REA lists it. */
export interface ReaAttribute {
    parent_token?: string;
    type_name?: string | null;
    value_length?: number;
    value_sha256?: string;
    decoded_fixed_string?: string | null;
    /** Not given by REA 6.8.0. Read if a later version does. */
    value_hex?: string;
    value_base64?: string;
}

/** A route attribute written in source. */
export interface SourceRoute {
    attribute: string;
    template: string | null;
    /** Named arguments, in order, as far as they can be encoded. `undefined` means one could not be read. */
    named?: { name: string; value: string | number }[];
    file: string;
    line: number;
}

export interface SourceController {
    /** The type's full name. */
    type: string;
    /** Whether its base type looks like a controller. */
    controller: boolean;
    on_type: SourceRoute[];
    on_methods: { method: string; routes: SourceRoute[] }[];
}

const ROUTE_ATTR = /(^|\.)(Route|RoutePrefix|HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|HttpHead|HttpOptions|AcceptVerbs)Attribute$/;
const SOURCE_ATTR = /^(?:[\w.]+\.)?(Route|RoutePrefix|HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|HttpHead|HttpOptions)(?:Attribute)?$/;

export const isRouteAttribute = (name: string | null | undefined) => !!name && ROUTE_ATTR.test(name);

const compressed = (n: number) => (n < 0x80 ? [n] : n < 0x4000 ? [0x80 | (n >> 8), n & 0xff] : [0xc0 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const serString = (s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from(compressed(b.length)), b]); };

/**
 * An attribute's value bytes (ECMA-335 II.23.3): a 0x0001 prolog, the template as a length-prefixed string,
 * then the count of named arguments and each one. Named arguments are taken to be properties, as Route's are.
 */
export function encodeRouteValue(template: string | null, named: { name: string; value: string | number }[] = []): Buffer {
    const parts: Buffer[] = [Buffer.from([1, 0])];
    if (template !== null) parts.push(serString(template));
    parts.push(Buffer.from([named.length & 0xff, named.length >> 8]));
    for (const n of named) {
        const isText = typeof n.value === "string";
        parts.push(Buffer.from([0x54, isText ? 0x0e : 0x08]), serString(n.name));
        if (isText) parts.push(serString(n.value as string));
        else { const i = Buffer.alloc(4); i.writeInt32LE(n.value as number); parts.push(i); }
    }
    return Buffer.concat(parts);
}

/** The template from an attribute's value bytes, or undefined if they don't start with one string. */
export function decodeRouteValue(b: Buffer): string | undefined {
    if (b.length < 3 || b.readUInt16LE(0) !== 1 || b[2] === 0xff) return undefined;
    const lead = b[2]!;
    const [len, width] = lead < 0x80 ? [lead, 1] : lead < 0xc0 ? [((lead & 0x3f) << 8) | (b[3] ?? 0), 2] : [((lead & 0x1f) << 24) | ((b[3] ?? 0) << 16) | ((b[4] ?? 0) << 8) | (b[5] ?? 0), 4];
    if (2 + width + len > b.length) return undefined;
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(2 + width, 2 + width + len));
    } catch {
        return undefined;
    }
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** The template REA's output itself gives, if it gives one. Bytes that don't match REA's digest are not believed. */
export function templateFromRea(a: ReaAttribute): string | undefined {
    if (typeof a.decoded_fixed_string === "string") return a.decoded_fixed_string;
    const raw = a.value_hex ? Buffer.from(a.value_hex, "hex") : a.value_base64 ? Buffer.from(a.value_base64, "base64") : undefined;
    if (!raw || (a.value_sha256 && sha(raw) !== a.value_sha256)) return undefined;
    return decodeRouteValue(raw);
}

/** Does this source attribute produce exactly these bytes? */
export function sourceMatches(s: SourceRoute, a: ReaAttribute): boolean {
    if (s.named === undefined || !a.value_sha256) return false;
    const b = encodeRouteValue(s.template, s.named);
    return b.length === a.value_length && sha(b) === a.value_sha256;
}

// ---------------------------------------------------------------- C# source

/** Blank out comments, keeping strings and line numbers. */
function withoutComments(text: string): string {
    return text.replace(/@"(?:[^"]|"")*"|"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("/") ? m.replace(/[^\n]/g, " ") : m));
}

const STRING = /^\s*(?:@"((?:[^"]|"")*)"|"((?:[^"\\\n]|\\.)*)")/;
const unString = (m: RegExpExecArray) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!.replace(/\\(.)/g, "$1"));

function parseArgs(args: string): { template: string | null; named?: SourceRoute["named"] } {
    let rest = args;
    let template: string | null = null;
    const first = STRING.exec(rest);
    if (first) { template = unString(first); rest = rest.slice(first[0].length).replace(/^\s*,/, ""); }
    else if (rest.trim() && !/^\s*\w+\s*=/.test(rest)) return { template: null }; // a constant or an expression: can't be read here
    const named: NonNullable<SourceRoute["named"]> = [];
    while (rest.trim()) {
        const n = /^\s*(\w+)\s*=/.exec(rest);
        if (!n) return { template };
        rest = rest.slice(n[0].length);
        const s = STRING.exec(rest);
        const i = /^\s*(-?\d+)/.exec(rest);
        if (s) { named.push({ name: n[1]!, value: unString(s) }); rest = rest.slice(s[0].length); }
        else if (i) { named.push({ name: n[1]!, value: Number(i[1]) }); rest = rest.slice(i[0].length); }
        else return { template };
        rest = rest.replace(/^\s*,/, "");
    }
    return { template, named };
}

/** Controllers and their route attributes in one C# file. Reads text only; nothing is compiled or run. */
export function readRoutesFromSource(text: string, file: string): SourceController[] {
    const src = withoutComments(text);
    const out: SourceController[] = [];
    const lineAt = (i: number) => src.slice(0, i).split("\n").length;
    // Tokens that matter, in order: namespace, type declarations, attributes, methods and braces.
    const re = /\bnamespace\s+([\w.]+)\s*([;{])|\b(?:class|record|struct|interface)\s+(\w+)(?:<[^>{]*>)?\s*(?::\s*([^{;]+?))?\s*(?:where\s[^{]*)?\{|\[\s*((?:[\w.]+\s*(?:\((?:[^()"]|"(?:[^"\\\n]|\\.)*"|@"(?:[^"]|"")*")*\))?\s*,?\s*)+)\]|\b(?:public|protected|internal|private)\s+(?:(?:static|virtual|override|async|sealed|new|abstract|partial|extern)\s+)*[\w<>[\],.?\s]+?\s+(\w+)\s*(?:<[^>(]*>)?\s*\(|[{}]|"(?:[^"\\\n]|\\.)*"|@"(?:[^"]|"")*"/g;
    let depth = 0;
    const scope: { ns?: string; type?: SourceController; at: number }[] = [];
    const prefix: { name: string; at: number }[] = [];
    let fileNs = "";
    let pending: SourceRoute[] = [];
    for (let m = re.exec(src); m; m = re.exec(src)) {
        const tok = m[0];
        if (tok === "{") { depth++; continue; }
        if (tok === "}") {
            depth--;
            while (scope.length && scope[scope.length - 1]!.at > depth) scope.pop();
            while (prefix.length && prefix[prefix.length - 1]!.at > depth) prefix.pop();
            continue;
        }
        if (tok.startsWith('"') || tok.startsWith('@"')) continue;
        if (m[1]) {
            if (m[2] === ";") fileNs = m[1];
            else { depth++; prefix.push({ name: m[1], at: depth }); }
            continue;
        }
        if (m[3]) {
            depth++;
            const inType = [...scope].reverse().find((s) => s.type)?.type;
            const ns = [fileNs, ...prefix.map((p) => p.name)].filter(Boolean).join(".");
            const type: SourceController = {
                type: inType ? `${inType.type}/${m[3]}` : ns ? `${ns}.${m[3]}` : m[3],
                controller: /(^|[\s,.:])(\w*Controller\w*|ApiController)(<|\s|,|$)/.test(m[4] ?? "") || /Controller\d*$/.test(m[3]),
                on_type: pending, on_methods: [],
            };
            pending = [];
            out.push(type);
            scope.push({ type, at: depth });
            continue;
        }
        if (m[5]) {
            const line = lineAt(m.index);
            for (const a of m[5].matchAll(/([\w.]+)\s*(?:\(((?:[^()"]|"(?:[^"\\\n]|\\.)*"|@"(?:[^"]|"")*")*)\))?/g)) {
                const hit = SOURCE_ATTR.exec(a[1]!);
                if (!hit) continue;
                const { template, named } = parseArgs(a[2] ?? "");
                pending.push({ attribute: hit[1]!, template, ...(named ? { named } : {}), file, line });
            }
            continue;
        }
        if (m[6]) {
            const owner = [...scope].reverse().find((s) => s.type)?.type;
            if (owner && pending.length) owner.on_methods.push({ method: m[6], routes: pending });
            pending = [];
        }
    }
    return out;
}

const SKIP_DIRS = new Set(["bin", "obj", "node_modules", ".git", ".vs", "packages"]);

/** Every controller in a C# file, or in the .cs files under a folder. */
export function readRouteSources(where: string, label: (f: string) => string): SourceController[] {
    const out: SourceController[] = [];
    const visit = (p: string) => {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
            for (const e of fs.readdirSync(p).sort()) if (!SKIP_DIRS.has(e)) visit(path.join(p, e));
        } else if (/\.cs$/i.test(p)) out.push(...readRoutesFromSource(fs.readFileSync(p, "utf8"), label(p)));
    };
    visit(where);
    return out;
}

// ---------------------------------------------------------------- joining

/** A route as it is served: the type's template, then the method's, unless the method's is absolute. */
export function joinRoutes(onType: (string | null)[], onMethods: (string | null)[]): string[] {
    const clean = (s: string) => `/${s.replace(/^\/+|\/+$/g, "")}`;
    const heads = onType.filter((t): t is string => t !== null);
    const out = new Set<string>();
    for (const r of onMethods) {
        if (r === null) continue;
        if (r.startsWith("~/")) out.add(clean(r.slice(2)));
        else if (r.startsWith("/")) out.add(clean(r));
        else if (heads.length) for (const h of heads) out.add(`${clean(h)}${r ? clean(r) : ""}`);
        else out.add(clean(r));
    }
    // A method with an attribute but no template ([HttpGet]) is served at the type's route; and so is a type with no method routes.
    if (heads.length && (!out.size || onMethods.some((r) => r === null))) for (const h of heads) out.add(clean(h));
    return [...out].sort();
}

/** What's missing from REA, in one sentence, for reports and docs. */
export const REA_ROUTE_GAP = "REA gives a route attribute's length and sha256 but not its value: `value_hex` or `decoded_fixed_string` on each attribute in `rea inspect-managed-artifact` would be enough";
