// The target model: what a JSON Schema or an OpenAPI operation says each field may hold, with the
// source that justifies each constraint, and a validator for exactly the subset the planner uses,
// so that every generated row can be checked against the schema it came from.
//
// The subset: type (and [type, "null"]), properties, required, additionalProperties: false, enum,
// const, minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, minLength, maxLength,
// pattern, format, items, minItems, maxItems, uniqueItems, nullable (OpenAPI 3.0), examples,
// default, description, and local $ref. Anything else is recorded as a limitation, never ignored
// silently.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readStructured, ManifestError } from "../manifest.js";

export type FieldType = "string" | "integer" | "number" | "boolean" | "object" | "array" | "null";

/** One field of the target model, at a JSON path such as "$.price" or "$.lines[*].qty". */
export interface Field {
    path: string;
    type: FieldType;
    nullable: boolean;
    required: boolean;
    description?: string;
    enum?: unknown[];
    const?: unknown;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: boolean;
    exclusiveMaximum?: boolean;
    multipleOf?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    examples?: unknown[];
    default?: unknown;
    /** Which part of which source justified this field: "schema.json#/properties/price". */
    source: string;
    /** Keywords the planner does not understand, kept so nobody believes they were honoured. */
    unsupported?: string[];
}

export interface TargetModel {
    /** Where the schema came from, and its fingerprint. */
    source: { file: string; sha256: string; operation?: string };
    /** The root schema, with every local $ref resolved. */
    schema: Record<string, unknown>;
    fields: Field[];
    /** From an OpenAPI operation: the documented responses, so cases can expect them. */
    responses?: Record<string, string>;
    /** Parameters of an OpenAPI operation (query and path), each with its own schema. */
    parameters?: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[];
}

const SUPPORTED = new Set(["type", "properties", "required", "additionalProperties", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "format", "items", "minItems", "maxItems", "uniqueItems", "nullable", "examples", "example", "default", "description", "title", "$ref", "$schema", "$id", "$comment", "readOnly", "writeOnly", "deprecated", "xml"]);

type S = Record<string, any>;

/** Resolve local "#/…" references against the document, refusing cycles and remote references. */
function resolve(node: unknown, doc: S, seen: string[] = []): unknown {
    if (Array.isArray(node)) return node.map((n) => resolve(n, doc, seen));
    if (!node || typeof node !== "object") return node;
    const s = node as S;
    if (typeof s.$ref === "string") {
        if (!s.$ref.startsWith("#/")) throw new ManifestError(`$ref ${s.$ref}: only references inside the same file ("#/…") are supported.`);
        if (seen.includes(s.$ref)) throw new ManifestError(`$ref ${s.$ref} refers to itself: recursive schemas are not supported.`);
        let target: any = doc;
        for (const part of s.$ref.slice(2).split("/")) target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
        if (target === undefined) throw new ManifestError(`$ref ${s.$ref} points at nothing.`);
        const { $ref: _r, ...rest } = s;
        return { ...(resolve(target, doc, [...seen, s.$ref]) as S), ...resolve(rest, doc, seen) as S };
    }
    const out: S = {};
    for (const [k, v] of Object.entries(s)) out[k] = k === "enum" || k === "examples" || k === "const" || k === "default" || k === "example" ? v : resolve(v, doc, seen);
    return out;
}

function typeOf(s: S, where: string): { type: FieldType; nullable: boolean } {
    let t = s.type;
    let nullable = s.nullable === true;
    if (Array.isArray(t)) {
        const rest = t.filter((x) => x !== "null");
        nullable = nullable || rest.length < t.length;
        if (rest.length !== 1) throw new ManifestError(`${where}: a type list may hold one type plus "null", not ${JSON.stringify(t)}.`);
        t = rest[0];
    }
    if (t === undefined) {
        if (s.properties) t = "object";
        else if (s.items) t = "array";
        else if (Array.isArray(s.enum) && s.enum.length) t = typeof s.enum[0] === "number" ? "number" : typeof s.enum[0] === "boolean" ? "boolean" : "string";
        else if (s.const !== undefined) t = typeof s.const === "number" ? "number" : typeof s.const === "boolean" ? "boolean" : "string";
        else throw new ManifestError(`${where}: no type. Give the field a type.`);
    }
    if (!["string", "integer", "number", "boolean", "object", "array", "null"].includes(t)) throw new ManifestError(`${where}: unknown type ${JSON.stringify(t)}.`);
    return { type: t, nullable };
}

function collect(s: S, at: string, source: string, required: boolean, fields: Field[]) {
    const { type, nullable } = typeOf(s, source);
    const unsupported = Object.keys(s).filter((k) => !SUPPORTED.has(k));
    const f: Field = { path: at, type, nullable, required, source, ...(unsupported.length ? { unsupported } : {}) };
    for (const k of ["description", "enum", "const", "minimum", "maximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems", "default"] as const) {
        if (s[k] !== undefined) (f as any)[k] = s[k];
    }
    // Draft 4 wrote exclusiveMinimum: true; 2019-09 and later write the number. Keep both shapes.
    if (typeof s.exclusiveMinimum === "number") { f.minimum = s.exclusiveMinimum; f.exclusiveMinimum = true; } else if (s.exclusiveMinimum === true) f.exclusiveMinimum = true;
    if (typeof s.exclusiveMaximum === "number") { f.maximum = s.exclusiveMaximum; f.exclusiveMaximum = true; } else if (s.exclusiveMaximum === true) f.exclusiveMaximum = true;
    if (Array.isArray(s.examples)) f.examples = s.examples; else if (s.example !== undefined) f.examples = [s.example];
    fields.push(f);
    if (type === "object" && s.properties) {
        const req = new Set<string>(Array.isArray(s.required) ? s.required : []);
        for (const [name, child] of Object.entries(s.properties as S)) collect(child as S, `${at}.${name}`, `${source}/properties/${name}`, req.has(name), fields);
    }
    if (type === "array" && s.items && typeof s.items === "object" && !Array.isArray(s.items)) collect(s.items as S, `${at}[*]`, `${source}/items`, true, fields);
}

/** The model of one JSON Schema file. */
export function modelFromSchema(file: string, raw: unknown, doc?: S): TargetModel {
    const schema = resolve(raw, doc ?? (raw as S)) as S;
    const fields: Field[] = [];
    collect(schema, "$", `${path.basename(file)}#`, true, fields);
    return { source: { file, sha256: fileSha(file) }, schema, fields };
}

const fileSha = (file: string) => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "");

/** The model of one OpenAPI 3 operation: its JSON request body and its parameters. */
export function modelFromOpenApi(file: string, raw: unknown, operation: string): TargetModel {
    const doc = raw as S;
    if (!doc?.openapi && !doc?.swagger) throw new ManifestError(`${file} is not an OpenAPI document: it has no "openapi" field.`);
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(operation.trim());
    if (!m) throw new ManifestError(`Name the operation as "POST /path", not ${JSON.stringify(operation)}.`);
    const [, method, p] = m;
    const op = doc.paths?.[p!]?.[method!.toLowerCase()];
    if (!op) throw new ManifestError(`${file} has no operation ${method!.toUpperCase()} ${p}. Paths: ${Object.keys(doc.paths ?? {}).join(", ") || "none"}.`);
    const content = op.requestBody?.content ?? {};
    const json = content["application/json"] ?? content[Object.keys(content).find((k) => /json/i.test(k)) ?? ""];
    const bodySchema = json?.schema ? (resolve(json.schema, doc) as S) : undefined;
    const fields: Field[] = [];
    if (bodySchema) collect(bodySchema, "$", `${path.basename(file)}#${method!.toUpperCase()} ${p}/requestBody`, op.requestBody?.required !== false, fields);
    const parameters = [...(doc.paths?.[p!]?.parameters ?? []), ...(op.parameters ?? [])].map((x: S) => resolve(x, doc) as S).filter((x: S) => x.in === "query" || x.in === "path")
        .map((x: S) => ({ name: String(x.name), in: String(x.in), required: x.required === true || x.in === "path", schema: (x.schema ?? { type: "string" }) as S }));
    for (const q of parameters) collect(q.schema, `?${q.name}`, `${path.basename(file)}#${method!.toUpperCase()} ${p}/parameters/${q.name}`, q.required, fields);
    const responses: Record<string, string> = {};
    for (const [code, r] of Object.entries(op.responses ?? {})) responses[code] = String((r as S)?.description ?? "");
    if (!bodySchema && !parameters.length) throw new ManifestError(`${method!.toUpperCase()} ${p} has no JSON request body and no query or path parameters, so there is nothing to generate.`);
    return { source: { file, sha256: fileSha(file), operation: `${method!.toUpperCase()} ${p}` }, schema: bodySchema ?? { type: "object", properties: {} }, fields, responses, parameters };
}

/** Load a JSON Schema or an OpenAPI file into a target model. */
export function loadModel(file: string, operation?: string): TargetModel {
    const raw = readStructured(file) as S;
    if (raw?.openapi || raw?.swagger) {
        if (!operation) throw new ManifestError(`${path.basename(file)} is an OpenAPI document: name the operation, such as --operation "POST /api/items". Operations: ${listOperations(raw).join(", ")}.`);
        return modelFromOpenApi(file, raw, operation);
    }
    if (operation) throw new ManifestError(`${path.basename(file)} is a JSON Schema, not an OpenAPI document, so there is no operation to pick.`);
    return modelFromSchema(file, raw);
}

export function listOperations(doc: S): string[] {
    const out: string[] = [];
    for (const [p, item] of Object.entries(doc.paths ?? {})) for (const m of Object.keys(item as S)) if (/^(get|post|put|patch|delete|head|options)$/i.test(m)) out.push(`${m.toUpperCase()} ${p}`);
    return out;
}

// ---------------------------------------------------------------- validation

export interface Violation { path: string; keyword: string; message: string }

const FORMATS: Record<string, RegExp> = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
    ipv4: /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/,
};

/** Every way a value breaks the schema, for the subset the planner understands. An empty list means valid. */
export function validate(schema: S, value: unknown, at = "$"): Violation[] {
    const out: Violation[] = [];
    const bad = (keyword: string, message: string) => out.push({ path: at, keyword, message });
    const { type, nullable } = typeOf(schema, at);
    if (value === null) {
        if (!nullable && type !== "null") bad("type", "null where a value is required");
        return out;
    }
    if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) bad("const", `must be ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) bad("enum", `must be one of ${JSON.stringify(schema.enum)}`);
    const actual = Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
    const okType = type === "number" ? actual === "number" || actual === "integer" : actual === type;
    if (!okType) { bad("type", `must be ${type}, not ${actual}`); return out; }
    if (type === "string") {
        const s = value as string;
        const len = [...s].length;
        if (schema.minLength !== undefined && len < schema.minLength) bad("minLength", `shorter than ${schema.minLength}`);
        if (schema.maxLength !== undefined && len > schema.maxLength) bad("maxLength", `longer than ${schema.maxLength}`);
        if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(s)) bad("pattern", `does not match ${schema.pattern}`);
        if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format]!.test(s)) bad("format", `not a ${schema.format}`);
    }
    if (type === "number" || type === "integer") {
        const n = value as number;
        const min = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : schema.minimum;
        const max = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : schema.maximum;
        const exMin = schema.exclusiveMinimum === true || typeof schema.exclusiveMinimum === "number";
        const exMax = schema.exclusiveMaximum === true || typeof schema.exclusiveMaximum === "number";
        if (min !== undefined && (exMin ? n <= min : n < min)) bad(exMin ? "exclusiveMinimum" : "minimum", `${exMin ? "not above" : "below"} ${min}`);
        if (max !== undefined && (exMax ? n >= max : n > max)) bad(exMax ? "exclusiveMaximum" : "maximum", `${exMax ? "not below" : "above"} ${max}`);
        if (schema.multipleOf !== undefined && Math.abs(Math.round(n / schema.multipleOf) * schema.multipleOf - n) > 1e-9) bad("multipleOf", `not a multiple of ${schema.multipleOf}`);
    }
    if (type === "array") {
        const a = value as unknown[];
        if (schema.minItems !== undefined && a.length < schema.minItems) bad("minItems", `fewer than ${schema.minItems} items`);
        if (schema.maxItems !== undefined && a.length > schema.maxItems) bad("maxItems", `more than ${schema.maxItems} items`);
        if (schema.uniqueItems && new Set(a.map((x) => JSON.stringify(x))).size !== a.length) bad("uniqueItems", "repeated items");
        if (schema.items && typeof schema.items === "object") a.forEach((x, i) => out.push(...validate(schema.items, x, `${at}[${i}]`)));
    }
    if (type === "object") {
        const o = value as S;
        const props: S = schema.properties ?? {};
        for (const r of schema.required ?? []) if (!(r in o)) out.push({ path: `${at}.${r}`, keyword: "required", message: "missing" });
        for (const [k, v] of Object.entries(o)) {
            if (props[k]) out.push(...validate(props[k], v, `${at}.${k}`));
            else if (schema.additionalProperties === false) out.push({ path: `${at}.${k}`, keyword: "additionalProperties", message: "not allowed" });
        }
    }
    return out;
}
