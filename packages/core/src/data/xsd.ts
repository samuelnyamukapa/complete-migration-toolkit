// XSD and WSDL to the target model, so a SOAP or WCF contract takes the same recipe, boundaries and negatives as JSON,
// with xs:pattern respected. Rows are serialised to XML, with namespaces, and every row is read back and checked by the
// validator here, so nothing rests on how it was written. XML also makes negatives JSON can't: a wrong order in a
// sequence, an extra element, two branches of a choice.
//
// Understood: elements, sequence, choice and all, cardinality, attributes, element refs, named and anonymous types,
// complexContent and simpleContent extension, simple types with length, minLength, maxLength, pattern, enumeration,
// min and max inclusive and exclusive, totalDigits and fractionDigits, xs:include and xs:import of local files.
// Not understood, and said so in the recipe's notes: xs:union, xs:list, xs:group, substitution groups.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseXml, type XNode } from "../diff.js";
import { ManifestError } from "../manifest.js";
import type { FieldType, Violation } from "./schema.js";

export interface SimpleType {
    type: FieldType;
    format?: string;
    enum?: unknown[];
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: boolean;
    exclusiveMaximum?: boolean;
    multipleOf?: number;
    totalDigits?: number;
    fractionDigits?: number;
    /** A value outside what a JavaScript number holds exactly was narrowed to fit. */
    narrowed?: boolean;
}

export interface XAttr { name: string; required: boolean; simple: SimpleType; source: string }

export interface XElement {
    kind: "element";
    name: string;
    /** The namespace it must be in, or "" for none. */
    ns: string;
    min: number;
    max: number;
    nillable: boolean;
    simple?: SimpleType;
    complex?: XComplex;
    source: string;
    /** Set on the elements of a choice: which choice, and which branch. */
    choice?: { group: string; index: number };
}

export interface XChoice { kind: "choice"; group: string; min: number; options: XElement[][] }
export type XParticle = XElement | XChoice;

export interface XComplex {
    order: "sequence" | "all";
    particles: XParticle[];
    attrs: XAttr[];
    /** simpleContent: the element's own text. */
    text?: SimpleType;
    /** xs:any: other elements are allowed. */
    open: boolean;
}

export interface SoapInfo { version: "1.1" | "1.2"; action?: string; operation?: string }

export interface XsdModel { root: XElement; notes: string[]; soap?: SoapInfo }

// ---------------------------------------------------------------- reading a schema

const BUILTIN_PREFIX = /^(xs|xsd|s|xsi|ser)$/i;
const INT_RANGES: Record<string, [number, number]> = {
    int: [-2147483648, 2147483647], short: [-32768, 32767], byte: [-128, 127],
    long: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], integer: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    unsignedint: [0, 4294967295], unsignedshort: [0, 65535], unsignedbyte: [0, 255], unsignedlong: [0, Number.MAX_SAFE_INTEGER],
    nonnegativeinteger: [0, Number.MAX_SAFE_INTEGER], positiveinteger: [1, Number.MAX_SAFE_INTEGER],
    negativeinteger: [Number.MIN_SAFE_INTEGER, -1], nonpositiveinteger: [Number.MIN_SAFE_INTEGER, 0],
};

function builtin(local: string): SimpleType | undefined {
    const k = local.toLowerCase();
    if (INT_RANGES[k]) { const [minimum, maximum] = INT_RANGES[k]!; return { type: "integer", minimum, maximum, ...(k === "long" || k === "integer" || k === "unsignedlong" ? { narrowed: true } : {}) }; }
    switch (k) {
        case "string": case "normalizedstring": case "token": case "name": case "ncname": case "nmtoken": case "language": case "id": case "idref": case "qname": case "base64binary": case "hexbinary": case "duration": case "time": case "anytype": case "anysimpletype": return { type: "string" };
        case "decimal": case "double": case "float": return { type: "number" };
        case "boolean": return { type: "boolean" };
        case "date": return { type: "string", format: "date" };
        case "datetime": return { type: "string", format: "date-time" };
        case "anyuri": return { type: "string", format: "uri" };
        case "guid": return { type: "string", format: "uuid" };
        case "char": return { type: "integer", minimum: 0, maximum: 65535 };
        default: return undefined;
    }
}

/** An XSD pattern as a JavaScript one: anchored, as XSD's always are, with XSD's name escapes spelled out. */
export function xsdPattern(p: string): string {
    const js = p.replace(/\\i/g, "[A-Za-z_:]").replace(/\\I/g, "[^A-Za-z_:]").replace(/\\c/g, "[-A-Za-z0-9._:]").replace(/\\C/g, "[^-A-Za-z0-9._:]").replace(/\\-/g, "\\x2d");
    return `^(?:${js})$`;
}

const CHILD = (n: XNode, local: string) => n.children.filter((c) => c.local === local);
const FIRST = (n: XNode, local: string) => n.children.find((c) => c.local === local);
const localOf = (qname: string) => qname.split(":").pop()!;
const prefixOf = (qname: string) => (qname.includes(":") ? qname.split(":")[0]! : "");

interface Schema { node: XNode; tns: string; qualified: boolean; attrQualified: boolean; file: string }

class Reader {
    readonly notes: string[] = [];
    readonly schemas: Schema[] = [];
    private groups = 0;
    private readonly noted = new Set<string>();

    add(node: XNode, file: string, seen = new Set<string>()) {
        this.schemas.push({ node, tns: node.attrs.get("targetNamespace") ?? "", qualified: node.attrs.get("elementFormDefault") === "qualified", attrQualified: node.attrs.get("attributeFormDefault") === "qualified", file });
        for (const inc of [...CHILD(node, "include"), ...CHILD(node, "import")]) {
            const loc = inc.attrs.get("schemaLocation");
            if (!loc) continue;
            const full = path.resolve(path.dirname(file), loc);
            if (/^[a-z]+:\/\//i.test(loc) || !fs.existsSync(full)) { this.note(`${path.basename(file)} refers to ${loc}, which was not read: only local files are followed, and nothing is fetched.`); continue; }
            if (seen.has(full)) continue;
            seen.add(full);
            this.add(parseXml(fs.readFileSync(full, "utf8").replace(/^﻿/, "")), full, seen);
        }
    }
    private note(s: string) { if (!this.noted.has(s)) { this.noted.add(s); this.notes.push(s); } }
    private global(kind: string, local: string): { node: XNode; schema: Schema } | undefined {
        for (const schema of this.schemas) {
            const node = schema.node.children.find((c) => c.local === kind && c.attrs.get("name") === local);
            if (node) return { node, schema };
        }
        return undefined;
    }
    topElements(): string[] { return this.schemas.flatMap((s) => CHILD(s.node, "element").map((e) => e.attrs.get("name") ?? "").filter(Boolean)); }

    simpleOf(qname: string, where: string): SimpleType {
        const local = localOf(qname);
        const user = BUILTIN_PREFIX.test(prefixOf(qname)) && builtin(local) ? undefined : this.global("simpleType", local);
        if (user) return this.readSimple(user.node, where);
        const b = builtin(local);
        if (b) return b;
        throw new ManifestError(`${where}: the type ${qname} was not found. Is it in a schema that is not local?`);
    }
    readSimple(n: XNode, where: string): SimpleType {
        const r = FIRST(n, "restriction");
        if (!r) {
            this.note(`${where}: xs:union and xs:list are not understood, so it is treated as plain text, and its limits aren't honoured.`);
            return { type: "string" };
        }
        const base = r.attrs.get("base");
        const nested = FIRST(r, "simpleType");
        const s: SimpleType = { ...(base ? this.simpleOf(base, where) : nested ? this.readSimple(nested, where) : { type: "string" as FieldType }) };
        const num = s.type === "integer" || s.type === "number";
        const typed = (v: string) => (num ? Number(v) : s.type === "boolean" ? v === "true" || v === "1" : v);
        const values = CHILD(r, "enumeration").map((e) => typed(e.attrs.get("value") ?? ""));
        if (values.length) s.enum = values;
        const patterns = CHILD(r, "pattern").map((e) => e.attrs.get("value") ?? "");
        if (patterns.length) {
            if (s.pattern) this.note(`${where}: a pattern on a type that already has one: only the narrower one is checked.`);
            s.pattern = xsdPattern(patterns.join("|"));
        }
        const facet = (k: string) => { const v = FIRST(r, k)?.attrs.get("value"); return v === undefined ? undefined : Number(v); };
        const len = facet("length");
        if (len !== undefined) { s.minLength = len; s.maxLength = len; }
        if (facet("minLength") !== undefined) s.minLength = facet("minLength")!;
        if (facet("maxLength") !== undefined) s.maxLength = facet("maxLength")!;
        if (facet("minInclusive") !== undefined) { s.minimum = facet("minInclusive")!; s.exclusiveMinimum = false; }
        if (facet("minExclusive") !== undefined) { s.minimum = facet("minExclusive")!; s.exclusiveMinimum = true; }
        if (facet("maxInclusive") !== undefined) { s.maximum = facet("maxInclusive")!; s.exclusiveMaximum = false; }
        if (facet("maxExclusive") !== undefined) { s.maximum = facet("maxExclusive")!; s.exclusiveMaximum = true; }
        const td = facet("totalDigits"), fd = facet("fractionDigits");
        if (fd !== undefined) { s.fractionDigits = fd; if (s.type === "number") s.multipleOf = Number((10 ** -fd).toFixed(fd)); }
        if (td !== undefined) {
            s.totalDigits = td;
            const scale = fd ?? 0;
            const top = Number(`${"9".repeat(Math.max(td - scale, 0)) || "0"}${scale ? `.${"9".repeat(scale)}` : ""}`);
            if (Number.isFinite(top) && Math.abs(top) <= Number.MAX_SAFE_INTEGER) {
                if (s.maximum === undefined || s.maximum > top) { s.maximum = top; s.exclusiveMaximum = false; }
                if (s.minimum === undefined || s.minimum < -top) { s.minimum = -top; s.exclusiveMinimum = false; }
            }
        }
        return s;
    }
    private complexOf(n: XNode, schema: Schema, where: string, stack: string[]): XComplex {
        const out: XComplex = { order: "sequence", particles: [], attrs: [], open: false };
        const simple = FIRST(n, "simpleContent");
        if (simple) {
            const ext = FIRST(simple, "extension") ?? FIRST(simple, "restriction");
            if (ext?.attrs.get("base")) out.text = this.simpleOf(ext.attrs.get("base")!, where);
            if (ext) this.attrs(ext, schema, where, out);
            return out;
        }
        const cc = FIRST(n, "complexContent");
        const ext = cc ? FIRST(cc, "extension") ?? FIRST(cc, "restriction") : undefined;
        if (ext?.attrs.get("base")) {
            const base = this.global("complexType", localOf(ext.attrs.get("base")!));
            if (!base) throw new ManifestError(`${where}: the base type ${ext.attrs.get("base")} was not found.`);
            const b = this.complexOf(base.node, base.schema, where, stack);
            out.particles.push(...b.particles);
            out.attrs.push(...b.attrs);
            out.open = b.open;
            out.order = b.order;
        }
        const body = ext ?? n;
        this.particles(body, schema, where, stack, out);
        this.attrs(body, schema, where, out);
        return out;
    }
    private attrs(n: XNode, _schema: Schema, where: string, out: XComplex) {
        for (const a of CHILD(n, "attribute")) {
            const name = a.attrs.get("name") ?? (a.attrs.get("ref") ? localOf(a.attrs.get("ref")!) : "");
            if (!name || a.attrs.get("use") === "prohibited") continue;
            const inline = FIRST(a, "simpleType");
            const source = `${where}/@${name}`;
            const simple = inline ? this.readSimple(inline, source) : a.attrs.get("type") ? this.simpleOf(a.attrs.get("type")!, source) : { type: "string" as FieldType };
            out.attrs.push({ name, required: a.attrs.get("use") === "required", simple, source });
        }
    }
    private particles(n: XNode, schema: Schema, where: string, stack: string[], out: XComplex) {
        for (const c of n.children) {
            if (c.local === "sequence") this.particles(c, schema, where, stack, out);
            else if (c.local === "all") { out.order = "all"; this.particles(c, schema, where, stack, out); }
            else if (c.local === "element") { const e = this.element(c, schema, where, stack); if (e) out.particles.push(e); }
            else if (c.local === "choice") {
                const group = `choice${++this.groups}`;
                const options: XElement[][] = [];
                for (const o of c.children) {
                    if (o.local === "element") { const e = this.element(o, schema, where, stack); if (e) options.push([e]); }
                    else if (o.local === "sequence") options.push(o.children.filter((x) => x.local === "element").map((x) => this.element(x, schema, where, stack)).filter((x): x is XElement => !!x));
                }
                options.forEach((list, index) => list.forEach((e) => { e.choice = { group, index }; }));
                out.particles.push({ kind: "choice", group, min: Number(c.attrs.get("minOccurs") ?? 1), options });
            } else if (c.local === "any") out.open = true;
            else if (c.local === "group") throw new ManifestError(`${where}: xs:group is not supported. Write the elements out in the schema, or use a JSON Schema for this one.`);
        }
    }
    element(n: XNode, schema: Schema, parent: string, stack: string[]): XElement | undefined {
        let node = n;
        let home = schema;
        const min = Number(n.attrs.get("minOccurs") ?? 1);
        const maxRaw = n.attrs.get("maxOccurs") ?? "1";
        const max = maxRaw === "unbounded" ? Infinity : Number(maxRaw);
        const ref = n.attrs.get("ref");
        let top = schema.node.children.includes(n);
        if (ref) {
            const g = this.global("element", localOf(ref));
            if (!g) throw new ManifestError(`${parent}: the element ${ref} was not found.`);
            node = g.node;
            home = g.schema;
            top = true;
        }
        const name = node.attrs.get("name");
        if (!name) throw new ManifestError(`${parent}: an element has no name.`);
        if (name.includes(".")) throw new ManifestError(`${parent}: the element name ${name} holds a dot, which the recipe's paths can't carry.`);
        const where = `${parent}/${name}`;
        const typeName = node.attrs.get("type");
        const inlineSimple = FIRST(node, "simpleType");
        const inlineComplex = FIRST(node, "complexType");
        const base: Omit<XElement, "simple" | "complex"> = { kind: "element", name, ns: top || home.qualified ? home.tns : "", min, max, nillable: node.attrs.get("nillable") === "true", source: where };
        if (inlineSimple) return { ...base, simple: this.readSimple(inlineSimple, where) };
        if (inlineComplex) return { ...base, complex: this.complexOf(inlineComplex, home, where, stack) };
        if (!typeName) return { ...base, simple: { type: "string" } };
        const local = localOf(typeName);
        const userComplex = BUILTIN_PREFIX.test(prefixOf(typeName)) && builtin(local) ? undefined : this.global("complexType", local);
        if (userComplex) {
            if (stack.includes(local)) {
                if (min === 0) { this.note(`${where}: the type ${local} contains itself. The optional inner one is left out, so recursion is not exercised.`); return undefined; }
                throw new ManifestError(`${where}: the type ${local} requires itself, so no finite document exists.`);
            }
            return { ...base, complex: this.complexOf(userComplex.node, userComplex.schema, where, [...stack, local]) };
        }
        return { ...base, simple: this.simpleOf(typeName, where) };
    }
    root(name: string, file: string): XElement {
        const g = this.global("element", name);
        if (!g) throw new ManifestError(`${path.basename(file)} has no top-level element ${name}. It has: ${this.topElements().join(", ") || "none"}.`);
        const e = this.element(g.node, g.schema, path.basename(file) + "#", [])!;
        return { ...e, min: 1, max: 1 };
    }
}

export const isXsd = (file: string) => /\.(xsd|wsdl)$/i.test(file);

/** A schema, or a WSDL's, as the model of one element. For a WSDL, `name` is an operation; for an XSD, an element. */
export function readXsd(file: string, name?: string): XsdModel {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    let doc: XNode;
    try { doc = parseXml(text); } catch (err) { throw new ManifestError(`${path.basename(file)} is not XML: ${(err as Error).message}`); }
    const r = new Reader();
    let rootName = name;
    let soap: SoapInfo | undefined;
    if (doc.local === "definitions" || doc.local === "description") {
        for (const types of CHILD(doc, "types")) for (const s of CHILD(types, "schema")) r.add(s, file);
        if (!r.schemas.length) throw new ManifestError(`${path.basename(file)} holds no schema in its types. Give the XSD, or a single-file WSDL (?singleWsdl).`);
        const portOps = CHILD(doc, "portType").flatMap((p) => CHILD(p, "operation"));
        const opNames = portOps.map((o) => o.attrs.get("name") ?? "");
        if (!name) throw new ManifestError(`${path.basename(file)} is a WSDL: name the operation with --operation. Operations: ${opNames.join(", ") || "none"}.`);
        const op = portOps.find((o) => o.attrs.get("name") === name);
        if (!op) throw new ManifestError(`${path.basename(file)} has no operation ${name}. Operations: ${opNames.join(", ") || "none"}.`);
        const msgName = localOf(FIRST(op, "input")?.attrs.get("message") ?? "");
        const msg = CHILD(doc, "message").find((m) => m.attrs.get("name") === msgName);
        const part = msg ? FIRST(msg, "part") : undefined;
        const element = part?.attrs.get("element");
        if (!element) throw new ManifestError(`${name}: the input message ${msgName} names no element. Only document-style operations are supported.`);
        rootName = localOf(element);
        const bindOp = CHILD(doc, "binding").flatMap((b) => CHILD(b, "operation")).find((o) => o.attrs.get("name") === name);
        const soapOp = bindOp ? FIRST(bindOp, "operation") : undefined;
        const isV12 = soapOp?.ns === "http://schemas.xmlsoap.org/wsdl/soap12/";
        soap = { version: isV12 ? "1.2" : "1.1", operation: name, ...(soapOp?.attrs.get("soapAction") ? { action: soapOp.attrs.get("soapAction")! } : {}) };
    } else {
        if (doc.local !== "schema") throw new ManifestError(`${path.basename(file)} is neither an XSD nor a WSDL: its root is ${doc.local}.`);
        r.add(doc, file);
        if (!rootName) {
            const tops = r.topElements();
            if (tops.length !== 1) throw new ManifestError(`${path.basename(file)} has ${tops.length} top-level elements: name one with --operation. They are: ${tops.join(", ") || "none"}.`);
            rootName = tops[0]!;
        }
    }
    return { root: r.root(rootName!, file), notes: r.notes, ...(soap ? { soap } : {}) };
}

export const xsdSha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// ---------------------------------------------------------------- generating and writing

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
// XML 1.0 has no way to write most control characters at all.
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

/** An edit that only XML can express, applied after the row is built. */
export type XmlOp =
    | { kind: "swap"; path: string; a: string; b: string }
    | { kind: "extra"; path: string; name: string }
    | { kind: "duplicate"; path: string }
    | { kind: "wrong_namespace" };

interface Tree { name: string; ns: string; attrs: [string, string][]; nil?: boolean; text?: string; children: Tree[] }

const wire = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function allElements(c: XComplex): XElement[] {
    return c.particles.flatMap((p) => (p.kind === "element" ? [p] : p.options.flat()));
}

function toTree(e: XElement, value: unknown): Tree {
    const t: Tree = { name: e.name, ns: e.ns, attrs: [], children: [] };
    if (value === null && e.nillable) { t.nil = true; return t; }
    if (e.simple) { t.text = wire(value); return t; }
    const c = e.complex!;
    const o = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    if (value !== null && typeof value !== "object" && value !== undefined) { t.text = wire(value); return t; }
    for (const a of c.attrs) if (`@${a.name}` in o) t.attrs.push([a.name, wire(o[`@${a.name}`])]);
    if (c.text) t.text = wire(o["#text"]);
    for (const child of allElements(c)) {
        if (!(child.name in o)) continue;
        const v = o[child.name];
        if (Array.isArray(v) && child.max !== 1) for (const x of v) t.children.push(toTree(child, x));
        else t.children.push(toTree(child, v));
    }
    return t;
}

function findTree(root: Tree, p: string): Tree | undefined {
    const parts = p.replace(/^\$\.?/, "").split(".").filter(Boolean);
    let cur: Tree | undefined = undefined;
    for (const [i, part] of parts.entries()) {
        const name = part.replace(/\[\d+\]$/, "");
        const idx = Number(/\[(\d+)\]$/.exec(part)?.[1] ?? 0);
        if (i === 0) { cur = root.name === name ? root : undefined; continue; }
        cur = cur?.children.filter((c) => c.name === name)[idx];
    }
    return cur;
}

function applyOp(root: Tree, op: XmlOp) {
    if (op.kind === "wrong_namespace") { root.ns = "urn:cmtk:not-this-namespace"; return; }
    const t = findTree(root, op.path);
    if (!t) throw new ManifestError(`The row's XML edit names ${op.path}, which the row does not have.`);
    if (op.kind === "swap") {
        const i = t.children.findIndex((c) => c.name === op.a), j = t.children.findIndex((c) => c.name === op.b);
        if (i < 0 || j < 0) throw new ManifestError(`The row's XML edit swaps ${op.a} and ${op.b} in ${op.path}, which does not have both.`);
        [t.children[i], t.children[j]] = [t.children[j]!, t.children[i]!];
    } else if (op.kind === "extra") {
        t.children.push({ name: op.name, ns: t.ns, attrs: [], children: [], text: "not in the schema" });
    } else if (op.kind === "duplicate") {
        const parent = findTree(root, op.path.replace(/\.[^.]+$/, ""));
        if (!parent) throw new ManifestError(`The row's XML edit names ${op.path}, whose parent the row does not have.`);
        parent.children.splice(parent.children.indexOf(t) + 1, 0, structuredClone(t));
    }
}

function render(t: Tree, inScope: string): string {
    // A namespace is declared where it starts, as the default one; an element in no namespace undoes it.
    const decl = t.ns !== inScope ? ` xmlns="${escAttr(t.ns)}"` : "";
    const nil = t.nil ? ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"' : "";
    const attrs = t.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
    if (t.nil) return `<${t.name}${decl}${nil}${attrs}/>`;
    const inner = (t.text !== undefined ? esc(t.text) : "") + t.children.map((c) => render(c, t.ns)).join("");
    return inner === "" ? `<${t.name}${decl}${attrs}/>` : `<${t.name}${decl}${attrs}>${inner}</${t.name}>`;
}

/** A row's value as an XML document, without the declaration. Throws if it holds what XML can't carry. */
export function toXml(model: XsdModel, value: unknown, op?: XmlOp): string {
    const root = model.root.name;
    const v = (value && typeof value === "object" ? value as Record<string, unknown> : {})[root];
    const tree = toTree(model.root, v);
    if (op) applyOp(tree, op);
    const out = render(tree, "");
    if (NOT_XML.test(out)) throw new ManifestError("The row holds a control character, which XML 1.0 can't carry.");
    return out;
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>\n';

/** The SOAP envelope for a request. SOAP 1.1 and 1.2 differ in the namespace, and in how the action travels. */
export function soapEnvelope(body: string, version: "1.1" | "1.2" = "1.1"): string {
    const ns = version === "1.2" ? "http://www.w3.org/2003/05/soap-envelope" : "http://schemas.xmlsoap.org/soap/envelope/";
    return `${XML_DECLARATION}<soap:Envelope xmlns:soap="${ns}"><soap:Body>${body}</soap:Body></soap:Envelope>\n`;
}

export function soapHeaders(s: SoapInfo): Record<string, string> {
    if (s.version === "1.2") return { "Content-Type": `application/soap+xml; charset=utf-8${s.action ? `; action="${s.action}"` : ""}` };
    return { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${s.action ?? ""}"` };
}

// ---------------------------------------------------------------- validating

const FORMATS: Record<string, RegExp> = {
    date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|[+-]\d{2}:\d{2})?$/,
    "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    uri: /^\S+$/,
};

/** Every way a piece of text breaks its simple type. XML values are all text, so a type here means a lexical form. */
export function checkSimple(s: SimpleType, text: string, at: string): Violation[] {
    const out: Violation[] = [];
    const bad = (keyword: string, message: string) => out.push({ path: at, keyword, message });
    if (s.type === "integer" && !/^[+-]?\d+$/.test(text.trim())) { bad("type", `"${text.slice(0, 40)}" is not a whole number`); return out; }
    if (s.type === "number" && !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())) { bad("type", `"${text.slice(0, 40)}" is not a number`); return out; }
    if (s.type === "boolean" && !/^(true|false|1|0)$/.test(text.trim())) { bad("type", `"${text.slice(0, 40)}" is not a boolean`); return out; }
    const num = s.type === "integer" || s.type === "number";
    const value: unknown = num ? Number(text) : s.type === "boolean" ? text.trim() === "true" || text.trim() === "1" : text;
    if (s.enum && !s.enum.some((e) => e === value)) bad("enum", `must be one of ${JSON.stringify(s.enum)}`);
    if (s.type === "string") {
        const len = [...text].length;
        if (s.minLength !== undefined && len < s.minLength) bad("minLength", `shorter than ${s.minLength}`);
        if (s.maxLength !== undefined && len > s.maxLength) bad("maxLength", `longer than ${s.maxLength}`);
        if (s.pattern && !new RegExp(s.pattern, "u").test(text)) bad("pattern", `does not match ${s.pattern}`);
        if (s.format && FORMATS[s.format] && !FORMATS[s.format]!.test(text)) bad("format", `not a ${s.format}`);
    }
    if (num) {
        const n = value as number;
        if (s.minimum !== undefined && (s.exclusiveMinimum ? n <= s.minimum : n < s.minimum)) bad(s.exclusiveMinimum ? "exclusiveMinimum" : "minimum", `below ${s.minimum}`);
        if (s.maximum !== undefined && (s.exclusiveMaximum ? n >= s.maximum : n > s.maximum)) bad(s.exclusiveMaximum ? "exclusiveMaximum" : "maximum", `above ${s.maximum}`);
        const digits = text.trim().replace(/^[+-]/, "").replace(/[eE].*$/, "");
        const [whole = "", frac = ""] = digits.split(".");
        if (s.fractionDigits !== undefined && frac.replace(/0+$/, "").length > s.fractionDigits) bad("fractionDigits", `more than ${s.fractionDigits} decimal places`);
        if (s.totalDigits !== undefined && (whole.replace(/^0+/, "") + frac.replace(/0+$/, "")).length > s.totalDigits) bad("totalDigits", `more than ${s.totalDigits} digits`);
        if (s.multipleOf !== undefined && s.fractionDigits === undefined && Math.abs(Math.round(n / s.multipleOf) * s.multipleOf - n) > Math.max(1e-9, Math.abs(n) * Number.EPSILON * 4)) bad("multipleOf", `not a multiple of ${s.multipleOf}`);
    }
    return out;
}

const textOf = (n: XNode) => n.texts.join("");
const XSI = "http://www.w3.org/2001/XMLSchema-instance";

function checkElement(e: XElement, n: XNode, at: string, out: Violation[]) {
    if ((n.ns ?? "") !== e.ns) out.push({ path: at, keyword: "namespace", message: `in namespace "${n.ns ?? ""}", not "${e.ns}"` });
    if (n.attrs.get(`{${XSI}}nil`) === "true") {
        if (!e.nillable) out.push({ path: at, keyword: "type", message: "nil where the schema does not allow it" });
        return;
    }
    if (e.simple) {
        if (n.children.length) out.push({ path: at, keyword: "type", message: "holds elements where the schema says text" });
        else out.push(...checkSimple(e.simple, textOf(n), at));
        return;
    }
    const c = e.complex!;
    for (const a of c.attrs) {
        const v = n.attrs.get(a.name);
        if (v === undefined) { if (a.required) out.push({ path: `${at}.@${a.name}`, keyword: "required", message: "missing" }); continue; }
        out.push(...checkSimple(a.simple, v, `${at}.@${a.name}`));
    }
    for (const k of n.attrs.keys()) if (!k.startsWith("{") && !c.attrs.some((a) => a.name === k)) out.push({ path: `${at}.@${k}`, keyword: "additional", message: "not allowed" });
    if (c.text) { out.push(...checkSimple(c.text, textOf(n), `${at}.#text`)); return; }
    if (textOf(n).trim() && !c.open) out.push({ path: at, keyword: "type", message: "holds text where the schema says elements" });
    const kids = n.children;
    let i = 0;
    const consume = (el: XElement, multi: boolean): number => {
        let count = 0;
        while (i < kids.length && kids[i]!.local === el.name) {
            const here = `${at}.${el.name}`;
            checkElement(el, kids[i]!, el.max !== 1 ? `${here}[${count}]` : count === 0 ? here : `${here}[${count}]`, out);
            i++; count++;
        }
        void multi;
        return count;
    };
    const counts = (el: XElement, n2: number) => {
        const here = `${at}.${el.name}`;
        if (el.max === 1 && el.min === 1 && n2 === 0) out.push({ path: here, keyword: "required", message: "missing" });
        else if (el.max === 1 && el.min === 0 && n2 > 1) out.push({ path: here, keyword: "maxOccurs", message: `${n2} of them; at most 1` });
        else if (el.max === 1 && n2 > 1) out.push({ path: here, keyword: "maxOccurs", message: `${n2} of them; at most 1` });
        else if (el.max !== 1 && n2 < el.min) out.push({ path: here, keyword: n2 === 0 && el.min === 1 ? "required" : "minItems", message: `${n2} of them; at least ${el.min}` });
        else if (el.max !== 1 && n2 > el.max) out.push({ path: here, keyword: "maxItems", message: `${n2} of them; at most ${el.max}` });
    };
    if (c.order === "all") {
        for (const p of c.particles) {
            if (p.kind !== "element") continue;
            const mine = kids.filter((k) => k.local === p.name);
            mine.forEach((k, idx) => checkElement(p, k, p.max !== 1 ? `${at}.${p.name}[${idx}]` : `${at}.${p.name}`, out));
            counts(p, mine.length);
        }
        for (const k of kids) if (!c.particles.some((p) => p.kind === "element" && p.name === k.local) && !c.open) out.push({ path: `${at}.${k.local}`, keyword: "additional", message: "not in the schema" });
        return;
    }
    for (const p of c.particles) {
        if (p.kind === "element") { counts(p, consume(p, p.max !== 1)); continue; }
        // A choice: exactly one branch. Finding a second branch straight after the first breaks it.
        const startsBranch = (idx: number) => p.options.findIndex((o) => o[0]?.name === kids[idx]?.local);
        const branch = i < kids.length ? startsBranch(i) : -1;
        if (branch < 0) { if (p.min > 0) out.push({ path: at, keyword: "choice", message: `none of the branches: ${p.options.map((o) => o[0]?.name).join(", ")}` }); continue; }
        for (const el of p.options[branch]!) counts(el, consume(el, el.max !== 1));
        if (i < kids.length && startsBranch(i) >= 0) {
            out.push({ path: at, keyword: "choice", message: `more than one branch: ${p.options[branch]![0]?.name} and ${kids[i]!.local}` });
            while (i < kids.length && startsBranch(i) >= 0) i++;
        }
    }
    if (i < kids.length && !c.open) {
        const known = new Set(allElements(c).map((x) => x.name));
        const k = kids[i]!;
        if (known.has(k.local)) out.push({ path: at, keyword: "order", message: `${k.local} is out of order` });
        else out.push({ path: `${at}.${k.local}`, keyword: "additional", message: "not in the schema" });
    }
}

/** Every way a document breaks the schema. An empty list means valid. The text is parsed: nothing rests on how it was written. */
export function validateXml(model: XsdModel, xml: string): Violation[] {
    let doc: XNode;
    try { doc = parseXml(xml); } catch (err) { return [{ path: "$", keyword: "well-formed", message: (err as Error).message }]; }
    const out: Violation[] = [];
    if (doc.local !== model.root.name) { out.push({ path: "$", keyword: "root", message: `the root is ${doc.local}, not ${model.root.name}` }); return out; }
    checkElement(model.root, doc, `$.${model.root.name}`, out);
    return out;
}

// ---------------------------------------------------------------- to fields

export interface XField {
    path: string; type: FieldType; nullable: boolean; required: boolean; source: string;
    simple?: SimpleType; minItems?: number; maxItems?: number;
    choice?: { group: string; index: number; parent: string };
}

/** The elements as fields at JSON paths, which the planner and the baseline read like any others. */
export function xsdFields(model: XsdModel): XField[] {
    const out: XField[] = [{ path: "$", type: "object", nullable: false, required: true, source: `${model.root.source}` }];
    const walk = (e: XElement, parent: string, required: boolean, choice?: { group: string; index: number }) => {
        const at = `${parent}.${e.name}`;
        let inner = at;
        const ch = choice ? { ...choice, parent } : undefined;
        if (e.max !== 1) {
            out.push({ path: at, type: "array", nullable: false, required: required && e.min > 0, source: e.source, minItems: e.min, ...(Number.isFinite(e.max) ? { maxItems: e.max } : {}), ...(ch ? { choice: ch } : {}) });
            inner = `${at}[*]`;
        }
        const isRequired = e.max !== 1 ? true : required && e.min > 0;
        if (e.simple) {
            out.push({ path: inner, type: e.simple.type, nullable: e.nillable, required: isRequired, source: e.source, simple: e.simple, ...(e.max === 1 && ch ? { choice: ch } : {}) });
            return;
        }
        const c = e.complex!;
        out.push({ path: inner, type: "object", nullable: e.nillable, required: isRequired, source: e.source, ...(e.max === 1 && ch ? { choice: ch } : {}) });
        for (const a of c.attrs) out.push({ path: `${inner}.@${a.name}`, type: a.simple.type, nullable: false, required: a.required, source: a.source, simple: a.simple });
        if (c.text) out.push({ path: `${inner}.#text`, type: c.text.type, nullable: false, required: true, source: `${e.source}/text()`, simple: c.text });
        for (const p of c.particles) {
            if (p.kind === "element") walk(p, inner, p.min > 0 && !p.choice, p.choice);
            else for (const o of p.options) for (const el of o) walk(el, inner, false, el.choice);
        }
    };
    walk(model.root, "$", true);
    return out;
}
