// A recipe says how test data is derived from a target model: the seed, the clock, each field's
// constraints and the rows, each named by the condition it exercises and tagged with the technique
// that chose it. A person reviews the recipe; the rows are regenerated from it on demand.
//
// Techniques, after ISO/IEC/IEEE 29119-4 and the ISTQB syllabus:
//   EP        equivalence partitioning: one valid representative, and each invalid class
//   BVA-3     three-value boundary analysis: the boundary and both neighbours, on every ordered field
//   pairwise  every pair of values of the discrete fields appears together at least once
//   hostile   strings that break parsers and templates (injection, direction overrides, length)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { inside, ManifestError } from "../manifest.js";
import type { Manifest } from "../types.js";
import { patternLimits } from "./regex.js";
import { loadModel, type Field, type TargetModel } from "./schema.js";

export type Technique = "EP" | "BVA-3" | "pairwise" | "hostile";
export type Oracle = "specified" | "derived" | "implicit" | "human";

export interface Row {
    /** The condition it exercises, such as price_maximum_plus_one_3bva. Unique in the recipe. */
    name: string;
    technique: Technique;
    /** The coverage item in words: "$.price above its maximum (1000000)". */
    coverage_item: string;
    /** Whether the schema says the row is valid. The system's answer is a separate question. */
    expect_valid: boolean;
    /** For an invalid row: the field and the keyword it breaks, so the validator can confirm it. */
    invalid_because?: { path: string; keyword: string };
    /** Where the expected answer comes from: the schema (specified), the legacy system (derived), common sense (implicit) or a person (human). */
    oracle: Oracle;
    /** Values set on top of the generated baseline, by JSON path. */
    set?: Record<string, unknown>;
    /** Fields removed from the baseline, by JSON path. */
    unset?: string[];
    /** The whole body replaced, for rows that are not objects at all. */
    replace_body?: unknown;
}

export interface RecipeField {
    path: string;
    type: string;
    required: boolean;
    nullable: boolean;
    constraints: Record<string, unknown>;
    source: string;
    /** How a valid value is made when a row does not set one: examples, pattern, format, faker:<method>, or type. */
    valid_from: string;
    /** For a person: why this field's values are what they are, and any doubt. */
    note?: string;
}

export interface Quotas {
    /** At most this share of rows may be happy paths (valid rows chosen by EP or pairwise): the rest must be boundaries, negatives and hostile values. */
    max_happy_share: number;
    /** Every field with a minimum, maximum, minLength, maxLength, minItems or maxItems gets its boundary rows. */
    boundaries_on_every_ordered_field: boolean;
    /** Every field gets at least one row that breaks it. */
    negative_for_every_field: boolean;
}

export interface Recipe {
    id: string;
    /** Written by an agent and not yet accepted by a person. Cases made from a draft recipe are drafts too. */
    draft?: boolean;
    seed: number;
    /** The fixed date and time every generated date is relative to. */
    clock: string;
    locale: string;
    source: TargetModel["source"];
    /** Which versions made the rows: a different version may make different rows from the same seed. */
    generators: Record<string, string>;
    quotas: Quotas;
    fields: RecipeField[];
    rows: Row[];
    /** From an OpenAPI operation: the documented responses. */
    responses?: Record<string, string>;
    /** Why the recipe is shaped as it is, for the reviewer. */
    notes?: string[];
}

/** A happy path: a valid row that a partition or a pairwise combination chose, as opposed to a boundary or a hostile value. */
export const isHappy = (r: Row) => r.expect_valid && (r.technique === "EP" || r.technique === "pairwise");

export const DEFAULT_QUOTAS: Quotas = { max_happy_share: 0.5, boundaries_on_every_ordered_field: true, negative_for_every_field: true };

const slugOf = (p: string) => p.replace(/^\$\.?/, "").replace(/\[\*\]/g, "_each").replace(/^\?/, "q_").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "body";
const isOrdered = (f: Field) => [f.minimum, f.maximum, f.minLength, f.maxLength, f.minItems, f.maxItems].some((x) => x !== undefined);
const isLeaf = (f: Field) => f.type !== "object" && f.type !== "array";

/** The hostile strings every text field is tried with: each one has broken a real system. */
export const HOSTILE: { name: string; value: string; why: string }[] = [
    { name: "empty", value: "", why: "an empty string where text is expected" },
    { name: "spaces_only", value: "   ", why: "whitespace that trims to nothing" },
    { name: "padded", value: "  padded  ", why: "leading and trailing spaces, which some systems keep and some drop" },
    { name: "sql_quote", value: "O'Brien' OR '1'='1", why: "a quote that breaks string concatenation into SQL" },
    { name: "html", value: "<script>alert(1)</script>", why: "markup that a page may render" },
    { name: "csv_formula", value: "=1+1", why: "a leading = that a spreadsheet runs as a formula (OWASP CSV injection)" },
    { name: "rtl_override", value: "abc‮def", why: "a right-to-left override that hides what the text really says" },
    { name: "accents", value: "Ñandú café", why: "letters outside ASCII" },
    { name: "emoji", value: "😀🚀", why: "characters outside the Basic Multilingual Plane; a length of 2 or 4 depending on the system" },
    { name: "long", value: "x".repeat(4096), why: "4,096 characters: past most column widths" },
];

export function recipeFolder(m: Manifest): string {
    return inside(m, path.join(path.dirname(m.proposals), "data"));
}
export const recipeFile = (m: Manifest, id: string) => path.join(recipeFolder(m), `${id}.yaml`);
export const dataFolder = (m: Manifest, id: string) => path.join(recipeFolder(m), id);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PlanOptions {
    /** A JSON Schema or OpenAPI file inside the project. */
    schema: string;
    /** For OpenAPI: "POST /api/items". */
    operation?: string;
    id?: string;
    seed?: number;
    clock?: string;
    locale?: string;
    quotas?: Partial<Quotas>;
    /** The recipe is an agent's draft. */
    draft?: boolean;
    /** Generator versions to record: cmtk's own, and faker's. */
    generators?: Record<string, string>;
}

/** Compile a recipe from a schema: the fields, and the rows every technique calls for. */
export function planRecipe(m: Manifest, o: PlanOptions): { file: string; recipe: Recipe } {
    const schemaFile = inside(m, o.schema);
    if (!fs.existsSync(schemaFile)) throw new ManifestError(`${o.schema} does not exist.`);
    const model = loadModel(schemaFile, o.operation);
    const id = o.id ?? (model.source.operation ? model.source.operation.replace(/^[A-Z]+\s+\/?/, "").replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-|-$/g, "") : path.basename(o.schema).replace(/\.[^.]+$/, "")).slice(0, 64);
    if (!ID.test(id)) throw new ManifestError(`The recipe id ${JSON.stringify(id)} must be letters, digits, '.', '-' and '_'.`);
    const clock = o.clock ?? "2026-01-15T09:30:00Z";
    if (Number.isNaN(Date.parse(clock))) throw new ManifestError(`The clock ${JSON.stringify(clock)} is not a date and time.`);
    const seed = o.seed ?? 20260115;
    if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31) throw new ManifestError("The seed must be a whole number from 0 to 2147483648.");
    const quotas = { ...DEFAULT_QUOTAS, ...(o.quotas ?? {}) };
    const notes: string[] = [];
    const fields: RecipeField[] = model.fields.map((f) => {
        const constraints: Record<string, unknown> = {};
        for (const k of ["enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "uniqueItems"] as const) if (f[k] !== undefined) constraints[k] = f[k];
        let valid_from = f.const !== undefined ? "const" : f.enum ? "enum" : f.examples?.length ? "examples" : f.pattern ? "pattern" : f.format ? `format:${f.format}` : f.type;
        let note: string | undefined;
        if (f.pattern) {
            const limit = patternLimits(f.pattern);
            if (limit) { valid_from = f.examples?.length ? "examples" : "type"; note = `The pattern can't be generated (${limit}); set a valid value in a row by hand.`; }
        }
        if (f.unsupported?.length) note = `${note ? `${note} ` : ""}Keywords not understood and not honoured: ${f.unsupported.join(", ")}.`;
        if (f.description) note = `${f.description}${note ? ` ${note}` : ""}`;
        return { path: f.path, type: f.type, required: f.required, nullable: f.nullable, constraints, source: f.source, valid_from, ...(note ? { note } : {}) };
    });
    const rows = planRows(model.fields, notes);
    const recipe: Recipe = {
        id, ...(o.draft ? { draft: true } : {}), seed, clock, locale: o.locale ?? "en_GB", source: { ...model.source, file: path.relative(m.root, schemaFile).split(path.sep).join("/") },
        generators: { ...(o.generators ?? {}) }, quotas, fields, rows, ...(model.responses ? { responses: model.responses } : {}), ...(notes.length ? { notes } : {}),
    };
    const problems = checkQuotas(recipe);
    if (problems.length) throw new ManifestError(`The plan breaks its own quotas: ${problems.join("; ")}`);
    const file = recipeFile(m, id);
    if (fs.existsSync(file)) throw new ManifestError(`${path.relative(m.root, file)} already exists. Choose another --id, or delete it.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderRecipe(recipe), "utf8");
    return { file: path.relative(m.root, file).split(path.sep).join("/"), recipe };
}

const HEADER = `# A test-data recipe, written by \`cmtk data plan\`. Review this file, not the rows: \`cmtk data make\`
# regenerates the rows from it, the same ones every time, from the seed and the clock below.
# Each row is named by the condition it exercises and says which technique chose it.
`;

export function renderRecipe(r: Recipe): string {
    return HEADER + YAML.stringify({ recipe: r }, { lineWidth: 0 });
}

export function loadRecipe(m: Manifest, id: string): { file: string; recipe: Recipe; sha256: string } {
    if (!ID.test(id)) throw new ManifestError(`The recipe id ${JSON.stringify(id)} must be letters, digits, '.', '-' and '_'.`);
    const file = recipeFile(m, id);
    if (!fs.existsSync(file)) throw new ManifestError(`There is no recipe ${id}: ${path.relative(m.root, file)} does not exist. Make one with \`cmtk data plan\`.`);
    const text = fs.readFileSync(file, "utf8");
    const doc = YAML.parse(text) as { recipe?: Recipe };
    const r = doc?.recipe;
    if (!r || r.id !== id || !Array.isArray(r.rows) || !Array.isArray(r.fields)) throw new ManifestError(`${path.relative(m.root, file)} is not a recipe for ${id}.`);
    const names = new Set<string>();
    for (const row of r.rows) {
        if (typeof row.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(row.name)) throw new ManifestError(`${id}: a row name must be letters, digits, '.', '-' and '_': ${JSON.stringify(row.name)}.`);
        if (names.has(row.name)) throw new ManifestError(`${id}: the row name ${row.name} is used twice.`);
        names.add(row.name);
        if (typeof row.expect_valid !== "boolean") throw new ManifestError(`${id}: row ${row.name} needs expect_valid: true or false.`);
        if (!row.expect_valid && !row.invalid_because?.path) throw new ManifestError(`${id}: row ${row.name} is invalid but does not say why (invalid_because: { path, keyword }).`);
    }
    return { file: path.relative(m.root, file).split(path.sep).join("/"), recipe: r, sha256: crypto.createHash("sha256").update(text).digest("hex") };
}

/** The quotas, checked against a recipe as it is now: a person may have edited it. */
export function checkQuotas(r: Recipe): string[] {
    const out: string[] = [];
    const q = r.quotas ?? DEFAULT_QUOTAS;
    const happy = r.rows.filter(isHappy).length;
    if (r.rows.length && happy / r.rows.length > q.max_happy_share) out.push(`${happy} of ${r.rows.length} rows are happy paths, above the quota of ${Math.round(q.max_happy_share * 100)}%: add boundaries and negatives, not more happy paths`);
    const leaves = r.fields.filter((f) => f.type !== "object" && f.path !== "$");
    if (q.boundaries_on_every_ordered_field) {
        for (const f of r.fields) {
            const c = f.constraints;
            if (![c.minimum, c.maximum, c.minLength, c.maxLength, c.minItems, c.maxItems].some((x) => x !== undefined)) continue;
            if (!r.rows.some((x) => x.technique === "BVA-3" && x.coverage_item.startsWith(`${f.path} `))) out.push(`${f.path} has a boundary but no BVA-3 rows`);
        }
    }
    if (q.negative_for_every_field) {
        const general = (p: string) => p.replace(/\[\d+\]/g, "[*]");
        for (const f of leaves) if (!r.rows.some((x) => !x.expect_valid && x.invalid_because && general(x.invalid_because.path) === f.path)) out.push(`${f.path} has no row that breaks it`);
    }
    return out;
}

// ---------------------------------------------------------------- planning the rows

function planRows(fields: Field[], notes: string[]): Row[] {
    const rows: Row[] = [];
    const add = (row: Row) => { if (!rows.some((x) => x.name === row.name)) rows.push(row); };
    const leaves = fields.filter((f) => f.path !== "$" && f.type !== "object");
    add({ name: "baseline_valid", technique: "EP", coverage_item: "every field: a valid representative", expect_valid: true, oracle: "specified" });
    if (fields[0]?.type === "object") add({ name: "body_not_an_object", technique: "EP", coverage_item: "$ is a list, not an object", expect_valid: false, invalid_because: { path: "$", keyword: "type" }, oracle: "specified", replace_body: [] });

    for (const f of leaves) {
        const slug = slugOf(f.path);
        const p = f.path;
        if (f.path.includes("[*]")) continue; // elements are varied through their array; a row names one element below
        // Boundaries, three values each: below, at, above (ISTQB's 3-value BVA).
        const num = f.type === "integer" || f.type === "number";
        const step = f.multipleOf ?? (f.type === "integer" ? 1 : 0.01);
        if (num && f.minimum !== undefined) {
            const at = f.exclusiveMinimum ? round(f.minimum + step, step) : f.minimum;
            add(bva(slug, "minimum", "below", p, f.exclusiveMinimum ? f.minimum : round(f.minimum - step, step), false, f.exclusiveMinimum ? "exclusiveMinimum" : "minimum", `${p} ${f.exclusiveMinimum ? "at" : "below"} its minimum (${f.minimum})`));
            add(bva(slug, "minimum", "at", p, at, true, undefined, `${p} at its lowest valid value (${at})`));
            add(bva(slug, "minimum", "above", p, round(at + step, step), true, undefined, `${p} one step above its lowest valid value`));
        }
        if (num && f.maximum !== undefined) {
            const at = f.exclusiveMaximum ? round(f.maximum - step, step) : f.maximum;
            add(bva(slug, "maximum", "below", p, round(at - step, step), true, undefined, `${p} one step below its highest valid value`));
            add(bva(slug, "maximum", "at", p, at, true, undefined, `${p} at its highest valid value (${at})`));
            add(bva(slug, "maximum", "above", p, f.exclusiveMaximum ? f.maximum : round(f.maximum + step, step), false, f.exclusiveMaximum ? "exclusiveMaximum" : "maximum", `${p} ${f.exclusiveMaximum ? "at" : "above"} its maximum (${f.maximum})`));
        }
        if (f.type === "string" && f.minLength !== undefined && f.minLength > 0 && !f.pattern && !f.enum) {
            add(bva(slug, "minLength", "below", p, "a".repeat(f.minLength - 1), false, "minLength", `${p} one character shorter than ${f.minLength}`));
            add(bva(slug, "minLength", "at", p, "a".repeat(f.minLength), true, undefined, `${p} exactly ${f.minLength} characters`));
            add(bva(slug, "minLength", "above", p, "a".repeat(f.minLength + 1), true, undefined, `${p} ${f.minLength + 1} characters`));
        }
        if (f.type === "string" && f.maxLength !== undefined && !f.pattern && !f.enum) {
            add(bva(slug, "maxLength", "below", p, "b".repeat(Math.max(f.maxLength - 1, f.minLength ?? 0)), true, undefined, `${p} one character shorter than ${f.maxLength}`));
            add(bva(slug, "maxLength", "at", p, "b".repeat(f.maxLength), true, undefined, `${p} exactly ${f.maxLength} characters`));
            add(bva(slug, "maxLength", "above", p, "b".repeat(f.maxLength + 1), false, "maxLength", `${p} one character longer than ${f.maxLength}`));
        }
        // Negatives: one per way the field can be wrong.
        if (f.required) add({ name: `${slug}_missing`, technique: "EP", coverage_item: `${p} missing though required`, expect_valid: false, invalid_because: { path: p, keyword: "required" }, oracle: "specified", unset: [p] });
        if (!f.nullable) add({ name: `${slug}_null`, technique: "EP", coverage_item: `${p} null though not nullable`, expect_valid: false, invalid_because: { path: p, keyword: "type" }, oracle: "specified", set: { [p]: null } });
        add({ name: `${slug}_wrong_type`, technique: "EP", coverage_item: `${p} of the wrong type`, expect_valid: false, invalid_because: { path: p, keyword: f.const !== undefined ? "const" : f.enum ? "enum" : "type" }, oracle: "specified", set: { [p]: wrongType(f) } });
        if (f.enum) add({ name: `${slug}_not_in_enum`, technique: "EP", coverage_item: `${p} outside ${JSON.stringify(f.enum)}`, expect_valid: false, invalid_because: { path: p, keyword: "enum" }, oracle: "specified", set: { [p]: typeof f.enum[0] === "number" ? 999999 : "not-a-valid-choice" } });
        if (f.type === "string" && f.format && ["email", "uuid", "date", "date-time", "uri", "ipv4"].includes(f.format)) add({ name: `${slug}_bad_${f.format.replace("-", "_")}`, technique: "EP", coverage_item: `${p} is not a ${f.format}`, expect_valid: false, invalid_because: { path: p, keyword: "format" }, oracle: "specified", set: { [p]: "not-a-" + f.format } });
        if (f.type === "string" && f.pattern) {
            // A printable string the pattern refuses, if there is one: readable in a CSV or a report.
            const breaker = ["!!! not a match", "no", "\n", "", "\u0000"].find((s) => { try { return !new RegExp(f.pattern!, "u").test(s); } catch { return false; } });
            if (breaker !== undefined) add({ name: `${slug}_breaks_pattern`, technique: "EP", coverage_item: `${p} does not match ${f.pattern}`, expect_valid: false, invalid_because: { path: p, keyword: "pattern" }, oracle: "specified", set: { [p]: breaker } });
        }
        // Enums of strings are usually matched exactly: the same word in another case is a negative worth its own row.
        if (f.enum && typeof f.enum[0] === "string") {
            const v = f.enum[0] as string;
            const other = v === v.toLowerCase() ? v.toUpperCase() : v.toLowerCase();
            if (other !== v && !f.enum.includes(other)) add({ name: `${slug}_enum_other_case`, technique: "EP", coverage_item: `${p} as ${JSON.stringify(other)}: a listed value in another case`, expect_valid: false, invalid_because: { path: p, keyword: "enum" }, oracle: "specified", set: { [p]: other } });
        }
        if (num && f.multipleOf !== undefined) add({ name: `${slug}_not_a_multiple`, technique: "EP", coverage_item: `${p} not a multiple of ${f.multipleOf}`, expect_valid: false, invalid_because: { path: p, keyword: "multipleOf" }, oracle: "specified", set: { [p]: round((f.minimum ?? 0) + f.multipleOf / 3, f.multipleOf / 1000) } });
        if (f.type === "integer") add({ name: `${slug}_fraction`, technique: "EP", coverage_item: `${p} with a fraction though an integer`, expect_valid: false, invalid_because: { path: p, keyword: "type" }, oracle: "specified", set: { [p]: (f.minimum ?? 0) + 0.5 } });
        if (f.type === "array") {
            if (f.minItems !== undefined && f.minItems > 0) {
                add(bva(slug, "minItems", "below", p, { $items: f.minItems - 1 }, false, "minItems", `${p} with ${f.minItems - 1} items, one fewer than allowed`));
                add(bva(slug, "minItems", "at", p, { $items: f.minItems }, true, undefined, `${p} with exactly ${f.minItems} items`));
            } else add({ name: `${slug}_empty`, technique: "EP", coverage_item: `${p} empty`, expect_valid: true, oracle: "specified", set: { [p]: { $items: 0 } } });
            if (f.maxItems !== undefined) {
                add(bva(slug, "maxItems", "at", p, { $items: f.maxItems }, true, undefined, `${p} with exactly ${f.maxItems} items`));
                add(bva(slug, "maxItems", "above", p, { $items: f.maxItems + 1 }, false, "maxItems", `${p} with ${f.maxItems + 1} items, one more than allowed`));
            }
        }
        // Hostile strings on free text (not on enums, patterns, formats or constants, which have their own negatives).
        if (f.type === "string" && !f.enum && !f.pattern && !f.format && f.const === undefined) {
            for (const h of HOSTILE) {
                const tooLong = f.maxLength !== undefined && [...h.value].length > f.maxLength;
                const tooShort = f.minLength !== undefined && [...h.value].length < f.minLength;
                const valid = !tooLong && !tooShort;
                add({ name: `${slug}_hostile_${h.name}`, technique: "hostile", coverage_item: `${p}: ${h.why}`, expect_valid: valid, ...(valid ? {} : { invalid_because: { path: p, keyword: tooLong ? "maxLength" : "minLength" } }), oracle: valid ? "implicit" : "specified", set: { [p]: h.value } });
            }
        }
    }
    // One row varies the first element of each array, so element constraints are exercised at least once.
    for (const f of leaves.filter((x) => x.path.includes("[*]") && x.type !== "array")) {
        const p = f.path.replace("[*]", "[0]");
        add({ name: `${slugOf(f.path)}_element_wrong_type`, technique: "EP", coverage_item: `${f.path}: the first element of the wrong type`, expect_valid: false, invalid_because: { path: p, keyword: f.enum ? "enum" : "type" }, oracle: "specified", set: { [p]: wrongType(f) } });
    }
    // Pairwise over the discrete fields: enums, booleans, nullable and optional fields.
    const discrete = leaves.filter((f) => !f.path.includes("[*]")).map((f) => {
        const values: { label: string; apply: (row: Row) => void }[] = [];
        if (f.enum) for (const v of f.enum) values.push({ label: `${f.path}=${JSON.stringify(v)}`, apply: (r) => { (r.set ??= {})[f.path] = v; } });
        else if (f.type === "boolean") for (const v of [true, false]) values.push({ label: `${f.path}=${v}`, apply: (r) => { (r.set ??= {})[f.path] = v; } });
        if (f.nullable) values.push({ label: `${f.path}=null`, apply: (r) => { (r.set ??= {})[f.path] = null; } });
        if (!f.required) values.push({ label: `${f.path} absent`, apply: (r) => { (r.unset ??= []).push(f.path); } });
        if (values.length && !f.enum && f.type !== "boolean") values.unshift({ label: `${f.path} present`, apply: () => {} });
        return { field: f, values };
    }).filter((d) => d.values.length >= 2);
    if (discrete.length >= 2) {
        const pairs = new Set<string>();
        for (let i = 0; i < discrete.length; i++) for (let j = i + 1; j < discrete.length; j++) for (const a of discrete[i]!.values) for (const b of discrete[j]!.values) pairs.add(`${a.label} & ${b.label}`);
        let n = 0;
        while (pairs.size && n < 60) {
            // Greedy: the combination that covers the most pairs still uncovered.
            const choice = discrete.map(() => 0);
            for (let i = 0; i < discrete.length; i++) {
                let best = 0, bestScore = -1;
                for (let k = 0; k < discrete[i]!.values.length; k++) {
                    let score = 0;
                    for (let j = 0; j < i; j++) if (pairs.has(`${discrete[j]!.values[choice[j]!]!.label} & ${discrete[i]!.values[k]!.label}`)) score++;
                    if (score > bestScore) { bestScore = score; best = k; }
                }
                choice[i] = best;
            }
            const covered: string[] = [];
            for (let i = 0; i < discrete.length; i++) for (let j = i + 1; j < discrete.length; j++) {
                const key = `${discrete[i]!.values[choice[i]!]!.label} & ${discrete[j]!.values[choice[j]!]!.label}`;
                if (pairs.delete(key)) covered.push(key);
            }
            if (!covered.length) break;
            const row: Row = { name: `pairwise_${String(++n).padStart(2, "0")}`, technique: "pairwise", coverage_item: covered.slice(0, 3).join("; ") + (covered.length > 3 ? `; and ${covered.length - 3} more pairs` : ""), expect_valid: true, oracle: "specified" };
            discrete.forEach((d, i) => d.values[choice[i]!]!.apply(row));
            add(row);
        }
        notes.push(`Pairwise rows cover every pair of values of ${discrete.map((d) => d.field.path).join(", ")} (${n} rows).`);
    }
    return rows;
}

const round = (n: number, step: number) => { const d = Math.max(0, Math.min(10, Math.ceil(-Math.log10(step)))); return Number(n.toFixed(d)); };

function bva(slug: string, edge: string, side: "below" | "at" | "above", path: string, value: unknown, valid: boolean, keyword: string | undefined, item: string): Row {
    return { name: `${slug}_${edge}_${side}_3bva`, technique: "BVA-3", coverage_item: item, expect_valid: valid, ...(valid ? {} : { invalid_because: { path, keyword: keyword! } }), oracle: "specified", set: { [path]: value } };
}

function wrongType(f: Field): unknown {
    switch (f.type) {
        case "string": return 12345;
        case "integer": case "number": return "twelve";
        case "boolean": return "yes";
        case "array": return "not-a-list";
        default: return "wrong";
    }
}
