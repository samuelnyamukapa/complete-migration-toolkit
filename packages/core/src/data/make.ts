// `cmtk data make`: the rows a recipe describes, regenerated from its seed and clock, checked
// against the schema they came from, and written as files with a manifest that says what made them.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createRequire } from "node:module";

import type { Faker } from "@faker-js/faker";
import { faker as fakerEN } from "@faker-js/faker/locale/en";
import { faker as fakerEN_GB } from "@faker-js/faker/locale/en_GB";
import { faker as fakerEN_US } from "@faker-js/faker/locale/en_US";
import { faker as fakerDE } from "@faker-js/faker/locale/de";
import { faker as fakerFR } from "@faker-js/faker/locale/fr";
import { faker as fakerES } from "@faker-js/faker/locale/es";

import { writeXlsx } from "./xlsx.js";
import { decodeFile, EncodeError, encodeRecord, fixedEdges, type Layout } from "./copybook.js";
import { csvBytes, csvEdges, xlsxEdges, type EdgeInfo } from "./files.js";

/** The locales bundled with the plugin. Each is a few hundred kilobytes, so not every one of Faker's seventy is here. */
export const LOCALES: Record<string, Faker> = { en: fakerEN, en_GB: fakerEN_GB, en_US: fakerEN_US, de: fakerDE, fr: fakerFR, es: fakerES };

declare const __CMTK_FAKER_VERSION__: string | undefined;
/** Faker's version: a different one may make different values from the same seed, so the manifest records it. */
export const FAKER_VERSION: string = typeof __CMTK_FAKER_VERSION__ === "string" ? __CMTK_FAKER_VERSION__
    : (() => { try { return (createRequire(import.meta.url)("@faker-js/faker/package.json") as { version: string }).version; } catch { return "unknown"; } })();
import { inside, ManifestError } from "../manifest.js";
import type { Manifest } from "../types.js";
import { dataFolder, loadRecipe, checkQuotas, isHappy, type Recipe, type RecipeField, type Row } from "./recipe.js";
import { stringFromPattern, type Rng } from "./regex.js";
import { soapEnvelope, toXml, validateXml, XML_DECLARATION, type XsdModel } from "./xsd.js";
import { loadModel, validate, type Field } from "./schema.js";

export interface MadeRow {
    name: string;
    technique: string;
    coverage_item: string;
    expect_valid: boolean;
    invalid_because?: { path: string; keyword: string };
    oracle: string;
    /** The request body. */
    value: unknown;
    /** Query and path parameters, for an OpenAPI operation, as the wire carries them. */
    query?: Record<string, string>;
    /** From an XSD or a WSDL: the row as a document, without its declaration. */
    xml?: string;
}

export interface DataManifest {
    recipe: string;
    recipe_sha256: string;
    seed: number;
    clock: string;
    locale: string;
    source: Recipe["source"];
    generators: Record<string, string>;
    made_on: string;
    rows: number;
    valid_rows: number;
    quotas: { max_happy_share: number; happy_share: number; problems: string[] };
    validation: { valid_rows_checked: number; invalid_rows_checked: number };
    files: Record<string, string>;
    /** Edge files: what each exercises, and whether its format should be accepted. */
    edge_files?: EdgeInfo[];
    /** Fixed-width records: the size, the encoding, and the rows a record can't hold. */
    fixed?: { record_size: number; encoding: string; records: number; left_out: { row: string; why: string }[] };
    /** Formats asked for that were not written, and why. */
    not_written?: { format: string; why: string }[];
}

/** A small, fast, seedable random source (mulberry32): the same seed gives the same rows on every platform. */
export function rng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function fakerFor(locale: string, seed: number, clock: string): Faker {
    const f = LOCALES[locale.replace("-", "_")];
    if (!f) throw new ManifestError(`The locale ${JSON.stringify(locale)} is not available. Use one of: ${Object.keys(LOCALES).join(", ")}.`);
    f.seed(seed);
    f.setDefaultRefDate(new Date(clock));
    return f;
}

const round = (n: number, step: number) => { const d = Math.max(0, Math.min(10, Math.ceil(-Math.log10(step)))); return Number(n.toFixed(d)); };

/** A valid value for one field, from its own constraints, chosen with the recipe's random source. */
function validValue(f: Field, rand: Rng, faker: Faker, clock: string): unknown {
    if (f.const !== undefined) return f.const;
    if (f.enum?.length) return f.enum[Math.floor(rand() * f.enum.length)];
    if (f.vocabulary?.length) return f.vocabulary[Math.floor(rand() * f.vocabulary.length)];
    if (f.examples?.length) return f.examples[0];
    switch (f.type) {
        case "boolean": return rand() < 0.5;
        case "integer": case "number": {
            const step = f.multipleOf ?? (f.type === "integer" ? 1 : 0.01);
            let lo = f.minimum ?? (f.maximum !== undefined ? f.maximum - 1000 : 0);
            let hi = f.maximum ?? lo + 1000;
            if (f.exclusiveMinimum) lo = round(lo + step, step);
            if (f.exclusiveMaximum) hi = round(hi - step, step);
            const steps = Math.max(0, Math.floor((hi - lo) / step));
            return round(lo + Math.floor(rand() * (steps + 1)) * step, step);
        }
        case "string": {
            const fit = (s: string) => {
                let out = s;
                if (f.maxLength !== undefined && [...out].length > f.maxLength) out = [...out].slice(0, f.maxLength).join("");
                if (f.minLength !== undefined && [...out].length < f.minLength) out = out + "x".repeat(f.minLength - [...out].length);
                return out;
            };
            if (f.pattern) return stringFromPattern(f.pattern, rand);
            const name = f.path.split(".").pop()?.toLowerCase() ?? "";
            switch (f.format) {
                case "email": return fit(faker.internet.email().toLowerCase());
                case "uuid": return faker.string.uuid();
                case "date": return faker.date.recent({ days: 365 }).toISOString().slice(0, 10);
                case "date-time": return new Date(new Date(clock).getTime() - Math.floor(rand() * 365 * 86400000)).toISOString();
                case "uri": return fit(faker.internet.url());
                case "ipv4": return faker.internet.ipv4();
            }
            if (/mail/.test(name)) return fit(faker.internet.email().toLowerCase());
            if (/(^|_)(first|given)name/.test(name)) return fit(faker.person.firstName());
            if (/(last|sur|family)name/.test(name)) return fit(faker.person.lastName());
            if (/^(name|fullname|customer|contact)$/.test(name)) return fit(faker.person.fullName());
            if (/phone|mobile|tel/.test(name)) return fit(faker.phone.number({ style: "national" }));
            if (/post(al)?code|zip/.test(name)) return fit(faker.location.zipCode());
            if (/city|town/.test(name)) return fit(faker.location.city());
            if (/country/.test(name)) return fit(faker.location.country());
            if (/address|street/.test(name)) return fit(faker.location.streetAddress());
            if (/company|brand|vendor|supplier/.test(name)) return fit(faker.company.name());
            if (/currency/.test(name)) return fit(faker.finance.currencyCode());
            if (/sku|code|reference|ref$/.test(name)) return fit(faker.string.alphanumeric({ length: 8, casing: "upper" }));
            if (/url|link|uri|picture|image/.test(name)) return fit(faker.internet.url());
            if (/description|notes?|comment|summary|text/.test(name)) return fit(faker.lorem.sentence());
            if (/title|product|item|label/.test(name)) return fit(faker.commerce.productName());
            return fit(faker.lorem.words(2));
        }
        case "null": return null;
        default: return null;
    }
}

/** The baseline: every field at a valid representative value, nested as the schema says. */
function baseline(fields: Field[], at: string, rand: Rng, faker: Faker, clock: string): unknown {
    const self = fields.find((f) => f.path === at);
    if (!self) return undefined;
    if (self.type === "object") {
        const out: Record<string, unknown> = {};
        // A choice takes its first branch; a row may set another.
        for (const f of fields.filter((x) => x.path.startsWith(`${at}.`) && !x.path.slice(at.length + 1).includes(".") && !x.path.slice(at.length + 1).includes("[") && !(x.choice && x.choice.index > 0))) {
            out[f.path.slice(at.length + 1)] = baseline(fields, f.path, rand, faker, clock);
        }
        return out;
    }
    if (self.type === "array") {
        const n = self.minItems !== undefined ? Math.max(self.minItems, 1) : 2;
        const count = Math.min(n, self.maxItems ?? n);
        return Array.from({ length: count }, () => baseline(fields, `${at}[*]`, rand, faker, clock));
    }
    return validValue(self, rand, faker, clock);
}

const parsePath = (p: string): (string | number)[] => {
    const parts: (string | number)[] = [];
    for (const m of p.replace(/^\$/, "").matchAll(/\.([^.[]+)|\[(\d+)\]/g)) parts.push(m[1] !== undefined ? m[1] : Number(m[2]));
    return parts;
};

function setAt(root: unknown, p: string, value: unknown): unknown {
    const parts = parsePath(p);
    if (!parts.length) return value;
    let cur: any = root;
    for (const [i, part] of parts.entries()) {
        if (i === parts.length - 1) { cur[part] = value; return root; }
        if (cur[part] === undefined || cur[part] === null) cur[part] = typeof parts[i + 1] === "number" ? [] : {};
        cur = cur[part];
    }
    return root;
}

function unsetAt(root: unknown, p: string) {
    const parts = parsePath(p);
    let cur: any = root;
    for (const part of parts.slice(0, -1)) { cur = cur?.[part]; if (cur === undefined) return; }
    if (cur && typeof cur === "object") Array.isArray(cur) ? cur.splice(parts[parts.length - 1] as number, 1) : delete cur[parts[parts.length - 1] as string];
}

function fieldsOf(m: Manifest, r: Recipe): { fields: Field[]; schema: Record<string, unknown>; parameters: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[]; hasBody: boolean; layout?: Layout; xsd?: XsdModel } {
    const file = inside(m, r.source.file);
    if (!fs.existsSync(file)) throw new ManifestError(`The recipe's schema ${r.source.file} no longer exists.`);
    const model = loadModel(file, r.source.operation);
    if (r.source.sha256 && model.source.sha256 !== r.source.sha256) throw new ManifestError(`${r.source.file} has changed since the recipe was planned (sha256 ${model.source.sha256.slice(0, 12)}… now, ${r.source.sha256.slice(0, 12)}… then). Plan it again, or restore the file.`);
    return { fields: model.fields, schema: model.schema, parameters: model.parameters ?? [], hasBody: model.fields.some((f) => f.path === "$"), ...((model as { layout?: Layout }).layout ? { layout: (model as { layout?: Layout }).layout } : {}), ...(model.xsd ? { xsd: model.xsd } : {}) };
}

const onWire = (v: unknown) => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

interface RowContext { fields: Field[]; schema: Record<string, unknown>; parameters: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[]; hasBody: boolean; xsd?: XsdModel; bodyFields: Field[]; rand: Rng; faker: Faker }

function rowContext(m: Manifest, r: Recipe): RowContext {
    const { fields, schema, parameters, hasBody, xsd } = fieldsOf(m, r);
    // What a person accepted for a field the schema is silent on.
    for (const f of fields) { const v = r.fields.find((x) => x.path === f.path)?.vocabulary; if (v?.length) f.vocabulary = v; }
    return { fields, schema, parameters, hasBody, ...(xsd ? { xsd } : {}), bodyFields: fields.filter((f) => !f.path.startsWith("?")), rand: rng(r.seed), faker: fakerFor(r.locale, r.seed, r.clock) };
}

function buildRow(c: RowContext, r: Recipe, row: Row): { value: unknown; query: Record<string, unknown>; violations: { path: string; keyword: string; message: string }[]; xml?: string } {
    const { fields, schema, parameters, hasBody, xsd, bodyFields, rand, faker } = c;
    const rowRand = rng(hash(r.seed, row.name));
    const rowFaker = fakerFor(r.locale, hash(r.seed, row.name), r.clock);
    let value: unknown = row.replace_body !== undefined ? structuredClone(row.replace_body) : baseline(bodyFields, "$", rowRand, rowFaker, r.clock);
    // Parameters: the required ones get a valid value; a row may set or remove any of them.
    const query: Record<string, unknown> = {};
    for (const q of parameters) if (q.required) query[q.name] = validValue(fields.find((f) => f.path === `?${q.name}`)!, rowRand, rowFaker, r.clock);
    const violations: { path: string; keyword: string; message: string }[] = [];
    for (const [p, v] of Object.entries(row.set ?? {})) if (p.startsWith("?")) query[p.slice(1)] = structuredClone(v);
    for (const p of row.unset ?? []) if (p.startsWith("?")) delete query[p.slice(1)];
    for (const q of parameters) {
        if (!(q.name in query)) { if (q.required) violations.push({ path: `?${q.name}`, keyword: "required", message: "missing" }); continue; }
        violations.push(...validate(q.schema, query[q.name], `?${q.name}`));
    }
    if (row.replace_body === undefined) {
        for (const [p, v] of Object.entries(row.set ?? {})) {
            if (p.startsWith("?")) continue;
            const f = fields.find((x) => x.path === p.replace(/\[\d+\]/g, "[*]"));
            if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$items" in (v as object) && f?.type === "array") {
                value = setAt(value, p, Array.from({ length: Number((v as any).$items) }, () => baseline(fields, `${f.path}[*]`, rand, faker, r.clock)));
            } else if (v && typeof v === "object" && !Array.isArray(v) && (v as { $valid?: unknown }).$valid === true && f) {
                value = setAt(value, p, baseline(fields, f.path, rowRand, rowFaker, r.clock)); // any valid value: the row is about being here at all
            } else if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $copy?: unknown }).$copy === "string") {
                value = setAt(value, p, structuredClone(getAt(value, (v as { $copy: string }).$copy))); // the same value as another field in this row
            } else value = setAt(value, p, structuredClone(v));
        }
        for (const p of row.unset ?? []) if (!p.startsWith("?")) unsetAt(value, p);
        violations.push(...applyInvariants(r, row, value, fields));
    }
    let xml: string | undefined;
    if (xsd) {
        if (!row.keep_choices) leaveOneBranch(fields, value, Object.keys(row.set ?? {}));
        xml = toXml(xsd, value, row.xml_op);
        violations.push(...validateXml(xsd, xml)); // read back from the text: nothing rests on how it was written
    } else if (hasBody) violations.push(...validate(schema, value));
    return { value, query, violations, ...(xml !== undefined ? { xml } : {}) };
}

/** One row, built without being judged: for the gate that decides whether a proposed row adds anything. */
export function probeRow(m: Manifest, r: Recipe, row: Row): { value: unknown; violations: { path: string; keyword: string; message: string }[]; schema: Record<string, unknown> } {
    const c = rowContext(m, r);
    const b = buildRow(c, r, row);
    return { value: b.value, violations: b.violations, schema: c.schema };
}

/** The rows a recipe makes, each checked against the schema: valid rows validate, invalid rows fail for the reason they claim. */
export function makeRows(m: Manifest, r: Recipe): MadeRow[] {
    const c = rowContext(m, r);
    const out: MadeRow[] = [];
    for (const row of r.rows) {
        const { value, query, violations, xml } = buildRow(c, r, row);
        if (row.expect_valid && violations.length) throw new ManifestError(`Row ${row.name} should be valid but is not: ${violations.map((v) => `${v.path} ${v.message}`).join("; ")}. The schema may use a keyword the planner does not understand, or the row was edited.`);
        if (!row.expect_valid) {
            const why = row.invalid_because!;
            const hit = violations.find((v) => v.path === why.path && v.keyword === why.keyword) ?? violations.find((v) => v.path === why.path);
            if (!hit) throw new ManifestError(`Row ${row.name} should break ${why.path} (${why.keyword}) but the schema accepts it${violations.length ? ` (it breaks ${violations.map((v) => `${v.path} ${v.keyword}`).join(", ")} instead)` : ""}. Correct the row or its reason.`);
        }
        const wire: Record<string, string> = {};
        for (const [k, v] of Object.entries(query)) wire[k] = onWire(v);
        out.push({ name: row.name, technique: row.technique, coverage_item: row.coverage_item, expect_valid: row.expect_valid, ...(row.invalid_because ? { invalid_because: row.invalid_because } : {}), oracle: row.oracle, value, ...(c.parameters.length ? { query: wire } : {}), ...(xml !== undefined ? { xml } : {}) });
    }
    return out;
}

function getAt(root: unknown, p: string): unknown {
    let cur: any = root;
    for (const part of parsePath(p)) cur = cur?.[part];
    return cur;
}

/** Numbers and dates, compared and stepped alike. */
const asOrdinal = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);

function fromOrdinal(n: number, like: unknown): unknown {
    if (typeof like === "number") return n;
    const iso = new Date(n).toISOString();
    return String(like).length === 10 ? iso.slice(0, 10) : iso;
}

/**
 * Keep every row on the right side of each invariant a person accepted, so a cross-field break appears only as a
 * labelled negative. A row on an invariant's edge or past it is placed exactly by the engine.
 */
function applyInvariants(r: Recipe, row: Row, value: unknown, fields: Field[]): { path: string; keyword: string; message: string }[] {
    const out: { path: string; keyword: string; message: string }[] = [];
    const list = r.model?.invariants ?? [];
    list.forEach((inv, index) => {
        const leftPath = inv.left.replace(/\[\*\]/g, "[0]");
        const isDate = typeof getAt(value, leftPath) === "string";
        const leftField = fields.find((f) => f.path === inv.left);
        const step = isDate ? 86400000 : (leftField?.multipleOf ?? (leftField?.type === "integer" ? 1 : 0.01));
        const round2 = (n: number) => (isDate ? n : round(n, step));
        const rightNow = (): number | undefined => {
            if (inv.op !== "sum") return asOrdinal(getAt(value, inv.right.replace(/\[\*\]/g, "[0]")));
            const [head, tail] = inv.right.split("[*]");
            const list2 = getAt(value, head!);
            if (!Array.isArray(list2)) return undefined;
            const each = list2.map((x) => asOrdinal(tail ? getAt(x, `$${tail}`) : x));
            return each.every((x) => x !== undefined) ? round2((each as number[]).reduce((a, b) => a + b, 0)) : undefined;
        };
        const right = rightNow();
        const left = asOrdinal(getAt(value, leftPath));
        if (right === undefined || left === undefined) return; // one side is missing or not comparable: this row is about that
        const holds = (l: number) => { switch (inv.op) { case ">=": return l >= right; case ">": return l > right; case "<=": return l <= right; case "<": return l < right; default: return Math.abs(l - right) < 1e-9; } };
        const like = getAt(value, leftPath);
        const place = (n: number) => { setAt(value, leftPath, fromOrdinal(round2(n), like)); };
        if (row.invariant?.index === index) {
            if (row.invariant.kind === "edge") place(inv.op === ">" ? right + step : inv.op === "<" ? right - step : right);
            else place(inv.op === ">=" || inv.op === ">" ? (inv.op === ">" ? right : right - step) : inv.op === "<=" || inv.op === "<" ? (inv.op === "<" ? right : right + step) : right + step);
        } else if (!holds(left)) {
            // The row didn't choose this: move whichever side it left alone.
            const setByRow = (p: string) => Object.keys(row.set ?? {}).some((k) => k === p);
            if (!setByRow(leftPath)) place(inv.op === ">" ? right + step : inv.op === "<" ? right - step : right);
            else if (inv.op !== "sum" && !setByRow(inv.right.replace(/\[\*\]/g, "[0]"))) setAt(value, inv.right.replace(/\[\*\]/g, "[0]"), fromOrdinal(round2(inv.op === ">" ? left - step : inv.op === "<" ? left + step : left), getAt(value, inv.right.replace(/\[\*\]/g, "[0]"))));
        }
        const finalLeft = asOrdinal(getAt(value, leftPath)), finalRight = rightNow();
        if (finalLeft !== undefined && finalRight !== undefined) {
            const ok = inv.op === ">=" ? finalLeft >= finalRight : inv.op === ">" ? finalLeft > finalRight : inv.op === "<=" ? finalLeft <= finalRight : inv.op === "<" ? finalLeft < finalRight : Math.abs(finalLeft - finalRight) < 1e-9;
            if (!ok) out.push({ path: leftPath, keyword: "invariant", message: `breaks ${inv.left} ${inv.op} ${inv.right}` });
        }
    });
    return out;
}

/** A row that sets a branch of a choice takes that branch only. */
function leaveOneBranch(fields: Field[], value: unknown, setPaths: string[]) {
    for (const p of setPaths) {
        const general = p.replace(/\[\d+\]/g, "[*]");
        const f = fields.find((x) => x.choice && (x.path === general || general.startsWith(`${x.path}.`) || general.startsWith(`${x.path}[`)));
        if (!f) continue;
        for (const other of fields.filter((x) => x.choice?.group === f.choice!.group && x.choice.index !== f.choice!.index)) unsetAt(value, other.path.replace(/\[\*\]/g, "[0]"));
    }
}

/** A seed for one row, from the recipe's seed and the row's name: adding a row never changes the others. */
function hash(seed: number, name: string): number {
    return crypto.createHash("sha256").update(`${seed}:${name}`).digest().readUInt32BE(0) >>> 1;
}

export const DATA_FORMATS = ["json", "csv", "xlsx", "xml", "fixed", "edge-csv", "edge-xlsx", "edge-fixed"] as const;
export type DataFormat = (typeof DATA_FORMATS)[number];

export interface MakeOptions {
    formats?: DataFormat[];
    /** Recorded in the manifest. */
    generators?: Record<string, string>;
    /** For tests: a fixed "made on" time. */
    now?: string;
}

/** Make the rows and write them, with the manifest, into cmtk/data/<id>/. */
export async function makeData(m: Manifest, id: string, o: MakeOptions = {}): Promise<{ folder: string; manifest: DataManifest; rows: MadeRow[] }> {
    const { file, recipe, sha256 } = loadRecipe(m, id);
    const rows = makeRows(m, recipe);
    const problems = checkQuotas(recipe);
    const asked = o.formats ?? ["json", "csv"];
    // An XML recipe always writes its documents, and rows.json, which `cmtk data cases` reads.
    const formats: DataFormat[] = recipe.source.format === "xsd" ? [...new Set<DataFormat>(["json", "xml", ...asked])] : asked;
    const dir = dataFolder(m, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "rows"), { recursive: true });
    const files: Record<string, string> = {};
    const put = (name: string, bytes: Buffer | string) => {
        const b = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
        fs.writeFileSync(path.join(dir, name), b);
        files[name.split(path.sep).join("/")] = crypto.createHash("sha256").update(b).digest("hex");
    };
    if (formats.includes("json")) {
        put("rows.json", JSON.stringify(rows, null, 2) + "\n");
        for (const r of rows) if (r.value !== undefined) put(path.join("rows", `${r.name}.json`), JSON.stringify(r.value, null, 2) + "\n");
    }
    const table = tabulate(rows);
    const csv = recipe.csv ?? {};
    if (formats.includes("csv")) {
        put("rows.csv", csvBytes(table.columns, table.records, csv));
        // One CSV per row, data columns only: the file an import would take, for that one condition.
        for (const r of rows) {
            if (!r.value || typeof r.value !== "object" || Array.isArray(r.value)) continue;
            const one = tabulate([r]);
            const cols = one.columns.filter((c) => c !== "row" && c !== "expect_valid" && !c.startsWith("?"));
            put(path.join("rows", `${r.name}.csv`), csvBytes(cols, one.records, csv));
        }
    }
    if (formats.includes("xlsx")) put("rows.xlsx", workbook(table, recipe));
    if (formats.includes("xml")) {
        if (recipe.source.format !== "xsd") throw new ManifestError(`Recipe ${id} did not come from an XSD or a WSDL, so it has no XML documents.`);
        for (const r of rows) {
            if (r.xml === undefined) continue;
            put(path.join("rows", `${r.name}.xml`), XML_DECLARATION + r.xml + "\n");
            if (recipe.soap) put(path.join("rows", `${r.name}.soap.xml`), soapEnvelope(r.xml, recipe.soap.version));
        }
    }
    // The valid rows, data columns only: the files an import would take.
    const validRows = rows.filter((r) => r.expect_valid && r.value && typeof r.value === "object" && !Array.isArray(r.value));
    const data = (() => {
        const t = tabulate(validRows);
        return { columns: t.columns.filter((c) => c !== "row" && c !== "expect_valid" && !c.startsWith("?")), records: t.records };
    })();
    const edgeInfo: EdgeInfo[] = [];
    const notWritten: { format: string; why: string }[] = [];
    const putEdges = (folder: string, edges: (EdgeInfo & { bytes: Buffer })[]) => {
        fs.mkdirSync(path.join(dir, "edge", folder), { recursive: true });
        for (const e of edges) {
            const rel = path.join("edge", folder, e.file);
            put(rel, e.bytes);
            edgeInfo.push({ file: rel.split(path.sep).join("/"), kind: e.kind, expect_valid: e.expect_valid, why: e.why });
        }
    };
    const dataCheck = () => (data.columns.length && data.records.length ? undefined : "the recipe has no valid rows that are objects");
    if (formats.includes("edge-csv")) { const why = dataCheck(); if (why) notWritten.push({ format: "edge-csv", why }); else putEdges("csv", csvEdges(data.columns, data.records, csv)); }
    if (formats.includes("edge-xlsx")) { const why = dataCheck(); if (why) notWritten.push({ format: "edge-xlsx", why }); else putEdges("xlsx", xlsxEdges(data.columns, data.records, { creator: "cmtk", created: recipe.clock, ...(recipe.xlsx?.formulas ? { formulas: recipe.xlsx.formulas } : {}) })); }
    let fixed: DataManifest["fixed"];
    if (formats.includes("fixed") || formats.includes("edge-fixed")) {
        const layout = fieldsOf(m, recipe).layout;
        if (!layout) throw new ManifestError(`Recipe ${id} did not come from a copybook, so it has no fixed-width records. Plan it from a .cpy file.`);
        const enc = recipe.fixed?.encoding ?? "cp037";
        const records: Buffer[] = [];
        const left_out: { row: string; why: string }[] = [];
        let baseRecord: Record<string, unknown> | undefined;
        for (const r of rows) {
            if (!r.expect_valid) { left_out.push({ row: r.name, why: `an invalid row (${r.invalid_because?.path} ${r.invalid_because?.keyword}): the edge files hold what a record can hold of this kind` }); continue; }
            try {
                records.push(encodeRecord(layout, r.value as Record<string, unknown>, enc));
                baseRecord ??= r.value as Record<string, unknown>;
            } catch (err) {
                if (!(err instanceof EncodeError)) throw err;
                left_out.push({ row: r.name, why: err.message });
            }
        }
        if (!baseRecord) throw new ManifestError(`No valid row of recipe ${id} fits a record.`);
        const bytes = Buffer.concat(records);
        // The self-check: a file of fixed-length records has a length that is a multiple of the record's, and every record reads back.
        const back = decodeFile(layout, bytes, enc);
        if (back.problems.length || back.records.length !== records.length) throw new ManifestError(`The fixed-width file failed its own check: ${back.problems[0] ?? `${back.records.length} records read back, not ${records.length}`}.`);
        if (formats.includes("fixed")) {
            put("records.dat", bytes);
            put("layout.json", JSON.stringify({ name: layout.name, record_size: layout.record_size, encoding: enc, items: layout.items }, null, 2) + "\n");
            fixed = { record_size: layout.record_size, encoding: enc, records: records.length, left_out };
        }
        if (formats.includes("edge-fixed")) putEdges("fixed", fixedEdges(layout, baseRecord, enc));
    }
    const valid = rows.filter((r) => r.expect_valid).length;
    const manifest: DataManifest = {
        recipe: file, recipe_sha256: sha256, seed: recipe.seed, clock: recipe.clock, locale: recipe.locale, source: recipe.source,
        generators: { ...recipe.generators, ...(o.generators ?? {}), "@faker-js/faker": FAKER_VERSION, node: process.version },
        made_on: o.now ?? new Date().toISOString(), rows: rows.length, valid_rows: valid,
        quotas: { max_happy_share: recipe.quotas.max_happy_share, happy_share: rows.length ? Number((recipe.rows.filter(isHappy).length / rows.length).toFixed(3)) : 0, problems },
        validation: { valid_rows_checked: valid, invalid_rows_checked: rows.length - valid }, files,
        ...(edgeInfo.length ? { edge_files: edgeInfo } : {}), ...(fixed ? { fixed } : {}), ...(notWritten.length ? { not_written: notWritten } : {}),
    };
    fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(dir, "DATA.md"), renderData(recipe, rows, manifest), "utf8");
    return { folder: path.relative(m.root, dir).split(path.sep).join("/"), manifest, rows };
}

/** Rows as a table: one column per leaf path, plus the row's name and whether it is valid. */
export function tabulate(rows: MadeRow[]): { columns: string[]; records: Record<string, unknown>[] } {
    const columns = new Set<string>(["row", "expect_valid"]);
    const flat = (v: unknown, at: string, into: Record<string, unknown>) => {
        if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${at}[${i}]`, into));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) flat(x, at ? `${at}.${k}` : k, into);
        else into[at || "body"] = v;
    };
    const records = rows.map((r) => {
        const rec: Record<string, unknown> = { row: r.name, expect_valid: r.expect_valid };
        for (const [k, v] of Object.entries(r.query ?? {})) rec[`?${k}`] = v;
        if (r.value && typeof r.value === "object" && !Array.isArray(r.value)) flat(r.value, "", rec);
        else rec.body = JSON.stringify(r.value); // a row whose body is not an object has one cell, the body itself
        for (const k of Object.keys(rec)) columns.add(k);
        return rec;
    });
    return { columns: [...columns], records };
}

function workbook(table: { columns: string[]; records: Record<string, unknown>[] }, recipe: Recipe): Buffer {
    const cell = (v: unknown) => (v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean));
    return writeXlsx([
        { name: "rows", rows: [table.columns, ...table.records.map((r) => table.columns.map((c) => cell(r[c])))] },
        { name: "recipe", rows: [["recipe", recipe.id], ["seed", recipe.seed], ["clock", recipe.clock], ["locale", recipe.locale], ["source", recipe.source.file]] },
    ], { creator: "cmtk", created: recipe.clock, ...(recipe.xlsx?.formulas ? { formulas: recipe.xlsx.formulas } : {}) }); // pinned, so the file never says who made it or when, and the same recipe gives the same bytes
}

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 120);

function renderData(r: Recipe, rows: MadeRow[], man: DataManifest): string {
    const L = [`# Test data: ${r.id}`, "",
        `Made by \`cmtk data make\` from \`${man.recipe}\` (seed ${r.seed}, clock ${r.clock}, locale ${r.locale}) on ${man.made_on}. ${rows.length} rows, ${man.valid_rows} valid, ${Math.round(man.quotas.happy_share * 100)}% happy paths.`, "",
        man.quotas.problems.length ? `**Quotas not met:** ${man.quotas.problems.join("; ")}.` : "Quotas met: happy paths are within the limit, every ordered field has its boundaries, and every field has a row that breaks it.", "",
        `Source: \`${r.source.file}\`${r.source.operation ? ` (${r.source.operation})` : ""}, sha256 ${r.source.sha256.slice(0, 16)}…`, "",
        "| Row | Technique | Exercises | Valid | Oracle | Sets |", "|---|---|---|---|---|---|"];
    for (const row of rows) {
        const sets = r.rows.find((x) => x.name === row.name);
        const what = sets?.replace_body !== undefined ? `body = ${cell(JSON.stringify(sets.replace_body))}` : [...Object.entries(sets?.set ?? {}).map(([k, v]) => `${k} = ${cell(JSON.stringify(v))}`), ...(sets?.unset ?? []).map((k) => `${k} removed`)].join("; ");
        L.push(`| ${row.name} | ${row.technique} | ${cell(row.coverage_item)} | ${row.expect_valid ? "yes" : `no: ${row.invalid_because?.path} ${row.invalid_because?.keyword}`} | ${row.oracle} | ${cell(what)} |`);
    }
    L.push("", "## Fields", "", "| Field | Type | Required | Constraints | Valid values from | Source |", "|---|---|---|---|---|---|");
    for (const f of r.fields) L.push(`| ${f.path} | ${f.type}${f.nullable ? " or null" : ""} | ${f.required ? "yes" : "no"} | ${cell(JSON.stringify(f.constraints))} | ${f.valid_from} | ${cell(f.source)} |`);
    if (r.notes?.length) L.push("", "## Notes", "", ...r.notes.map((n) => `- ${n}`));
    if (man.edge_files?.length) L.push("", "## Edge files", "", "What each exercises, and whether the format allows it. What the system should answer comes from the requirement or the legacy system.", "", "| File | Kind | Format allows it | Why |", "|---|---|---|---|", ...man.edge_files.map((e) => `| ${e.file} | ${e.kind} | ${e.expect_valid ? "yes" : "no"} | ${cell(e.why)} |`));
    if (man.fixed) L.push("", "## Fixed-width records", "", `${man.fixed.records} records of ${man.fixed.record_size} bytes, in ${man.fixed.encoding}. Left out: ${man.fixed.left_out.length}.`, "", ...man.fixed.left_out.map((x) => `- ${x.row}: ${cell(x.why)}`));
    L.push("", "## Files", "", ...Object.entries(man.files).map(([f, h]) => `- \`${f}\`: sha256 ${h.slice(0, 16)}…`), "");
    return L.join("\n");
}

export { type RecipeField, type Row };
