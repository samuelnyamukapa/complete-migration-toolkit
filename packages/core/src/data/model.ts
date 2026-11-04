// What an agent may add to a recipe, and how the engine decides. The agent proposes what a schema can't say: a business
// invariant, a realistic vocabulary, a notional variable, a state machine, a mutation to try when coverage plateaus.
// Each proposal is tagged with who says so and waits for a person. No proposal holds a row or an expected answer:
// a mutation is an operator on a field, and the engine works out the value and whether the schema calls it valid.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { inside, ManifestError } from "../manifest.js";
import type { Manifest } from "../types.js";
import { makeRows, probeRow } from "./make.js";
import { loadRecipe, recipeFile, renderRecipe, type Recipe, type RecipeField, type Row } from "./recipe.js";
import { validate } from "./schema.js";

export const SAID_BY = ["structure", "spec", "production"] as const;
export type SaidBy = (typeof SAID_BY)[number];

export const INVARIANT_OPS = [">=", ">", "<=", "<", "==", "sum"] as const;
export type InvariantOp = (typeof INVARIANT_OPS)[number];

export const MUTATION_OPERATORS = ["empty_string", "whitespace_only", "trailing_newline", "decomposed_accent", "zero", "negative_one", "very_large", "absent", "same_as_field"] as const;
export type MutationOperator = (typeof MUTATION_OPERATORS)[number];

export interface Invariant { left: string; op: InvariantOp; right: string }

export type DataRule = {
    recipe: string;
    /** Who says so: the structure (a schema, a constraint), the spec (requirements, business rules), or production (traffic, a masked profile). */
    said_by: SaidBy;
    /** Where it was seen: a rule's number and words, a file and line. */
    evidence: string;
} & (
    | { what: "invariant"; invariant: Invariant }
    | { what: "vocabulary"; path: string; values: string[]; prompted_with: { name: string; description?: string; rejection?: string } }
    | { what: "notional"; name: string; description: string; over: string[] }
    | { what: "state_machine"; name: string; states: string[]; transitions: { from: string; to: string; on: string }[] }
    | { what: "mutation"; operator: MutationOperator; path: string; other?: string }
);

/** What a person accepted, kept in the recipe with their name. */
export interface RecipeModel {
    invariants?: (Invariant & { said_by: SaidBy; evidence: string; accepted_by: string; accepted_on: string })[];
    notional?: { name: string; description: string; over: string[]; said_by: SaidBy; evidence: string; accepted_by: string; accepted_on: string }[];
    state_machines?: { name: string; states: string[]; transitions: { from: string; to: string; on: string }[]; said_by: SaidBy; evidence: string; accepted_by: string; accepted_on: string }[];
}

const general = (p: string) => p.replace(/\[\d+\]/g, "[*]");
const slug = (p: string) => p.replace(/^\$\.?/, "").replace(/\[\*\]/g, "_each").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "body";

function fieldAt(r: Recipe, p: unknown, what: string): RecipeField {
    if (typeof p !== "string") throw new ManifestError(`${what} must name a field by its path, such as $.price.`);
    const f = r.fields.find((x) => x.path === general(p));
    if (!f) throw new ManifestError(`${what}: recipe ${r.id} has no field ${p}. It has: ${r.fields.filter((x) => x.path !== "$").map((x) => x.path).slice(0, 30).join(", ")}.`);
    return f;
}

const isOrdered = (f: RecipeField) => f.type === "number" || f.type === "integer" || f.constraints.format === "date" || f.constraints.format === "date-time";
const isNumeric = (f: RecipeField) => f.type === "number" || f.type === "integer";

/** Refuse a rule that holds anything other than a rule, or that the engine can't honour. */
export function checkDataRule(m: Manifest, rule: DataRule): void {
    const raw = rule as unknown as Record<string, unknown>;
    if (!raw || typeof raw !== "object") throw new ManifestError("A data rule is needed.");
    const { recipe } = loadRecipe(m, String(raw.recipe ?? ""));
    if (!(SAID_BY as readonly string[]).includes(String(raw.said_by))) throw new ManifestError(`said_by must be ${SAID_BY.join(", ")}: who says so, and the three are never mixed.`);
    if (typeof raw.evidence !== "string" || !raw.evidence.trim()) throw new ManifestError("evidence is required: the rule's words, or the file and line.");
    // A rule never carries rows or answers, whatever is passed.
    for (const k of ["rows", "row", "set", "unset", "value", "expect", "expect_valid", "expected", "invalid_because", "status"]) {
        if (k in raw) throw new ManifestError(`A data rule can't hold ${k}: the engine makes rows, and what the system should answer comes from a requirement, a person or the legacy system.`);
    }
    switch (rule.what) {
        case "invariant": {
            const i = rule.invariant;
            if (!i || !(INVARIANT_OPS as readonly string[]).includes(i.op)) throw new ManifestError(`An invariant needs left, right and an op: ${INVARIANT_OPS.join(", ")}.`);
            const l = fieldAt(recipe, i.left, "invariant.left");
            const r = fieldAt(recipe, i.right, "invariant.right");
            if (i.op === "sum" ? !(isNumeric(l) && isNumeric(r) && i.right.includes("[*]")) : !(isOrdered(l) && isOrdered(r))) throw new ManifestError(i.op === "sum" ? "A sum needs a number on the left, and a number inside a list on the right, such as $.lines[*].amount." : "Both sides of an invariant must be numbers or dates.");
            if (i.left === i.right) throw new ManifestError("An invariant compares two different fields.");
            return;
        }
        case "vocabulary": {
            const f = fieldAt(recipe, rule.path, "vocabulary.path");
            const c = f.constraints;
            if (c.enum !== undefined || c.const !== undefined || c.pattern !== undefined || c.format !== undefined) throw new ManifestError(`The schema already says what ${f.path} may hold, so it needs no vocabulary. Values come from the schema where it speaks.`);
            if (f.type !== "string") throw new ManifestError(`${f.path} is not text: the engine makes its values.`);
            if (!rule.prompted_with?.name) throw new ManifestError("prompted_with needs the field's name, and its description and the server's rejection message if there are any: that is what the values were proposed from.");
            if (!Array.isArray(rule.values) || !rule.values.length || rule.values.length > 50 || !rule.values.every((v) => typeof v === "string")) throw new ManifestError("A vocabulary is one to fifty text values.");
            const schema = { type: "string", ...c };
            for (const v of rule.values) {
                const broken = validate(schema, v);
                if (broken.length) throw new ManifestError(`The gate refuses ${JSON.stringify(v)} for ${f.path}: ${broken[0]!.message}. A vocabulary only holds values the schema accepts; boundaries and negatives come from the engine.`);
            }
            return;
        }
        case "notional":
            if (!rule.name || !rule.description) throw new ManifestError("A notional variable needs a name and a description.");
            if (!Array.isArray(rule.over) || !rule.over.length) throw new ManifestError("A notional variable says which fields it is over.");
            for (const p of rule.over) fieldAt(recipe, p, "notional.over");
            return;
        case "state_machine":
            if (!rule.name || !Array.isArray(rule.states) || rule.states.length < 2 || !Array.isArray(rule.transitions) || !rule.transitions.length) throw new ManifestError("A state machine needs a name, at least two states, and its transitions.");
            for (const t of rule.transitions) if (!rule.states.includes(t.from) || !rule.states.includes(t.to) || !t.on) throw new ManifestError(`The transition ${JSON.stringify(t)} needs states from the list and an event in \`on\`.`);
            return;
        case "mutation": {
            mutationRow(m, recipe, rule);
            return;
        }
        default:
            throw new ManifestError("what must be invariant, vocabulary, notional, state_machine or mutation.");
    }
}

const OPERATOR_VALUES: Record<Exclude<MutationOperator, "absent" | "same_as_field">, { value: unknown; words: string }> = {
    empty_string: { value: "", words: "an empty string" },
    whitespace_only: { value: "\t ", words: "a tab and a space" },
    trailing_newline: { value: "value\n", words: "text ending in a line break" },
    decomposed_accent: { value: "café", words: "an accent as two code points, which looks the same as one" },
    zero: { value: 0, words: "zero" },
    negative_one: { value: -1, words: "minus one" },
    very_large: { value: Number.MAX_SAFE_INTEGER, words: "the largest whole number a double holds exactly" },
};

/**
 * The gate for a mutation: the engine builds the row, and the validator says whether it is valid. It is kept only if it
 * adds something: a row that repeats an existing one is refused. It is always oracle `human`, so a person says what
 * should happen, and it is never asserted automatically.
 */
export function mutationRow(m: Manifest, recipe: Recipe, rule: Extract<DataRule, { what: "mutation" }>): Row {
    if (!(MUTATION_OPERATORS as readonly string[]).includes(rule.operator)) throw new ManifestError(`A mutation is one of the engine's operators: ${MUTATION_OPERATORS.join(", ")}. It can't hold a value of your own.`);
    const f = fieldAt(recipe, rule.path, "mutation.path");
    const at = f.path.replace(/\[\*\]/g, "[0]");
    const name = `mutation_${rule.operator}_${slug(f.path)}`;
    if (recipe.rows.some((r) => r.name === name)) throw new ManifestError(`The gate refuses it: the recipe already has ${name}.`);
    let row: Row = { name, technique: "hostile", coverage_item: "", expect_valid: true, oracle: "human" };
    if (rule.operator === "absent") {
        if (f.required) throw new ManifestError(`The gate refuses it: ${f.path} is required, so the recipe already has a row without it.`);
        row = { ...row, coverage_item: `${f.path} left out, by mutation`, unset: [at] };
    } else if (rule.operator === "same_as_field") {
        const other = fieldAt(recipe, rule.other, "mutation.other");
        row = { ...row, coverage_item: `${f.path} the same as ${other.path}, by mutation`, set: { [at]: { $copy: other.path.replace(/\[\*\]/g, "[0]") } } };
    } else {
        const o = OPERATOR_VALUES[rule.operator];
        row = { ...row, coverage_item: `${f.path} as ${o.words}, by mutation`, set: { [at]: o.value } };
    }
    const probe = probeRow(m, recipe, row);
    const hit = probe.violations[0];
    if (hit) row = { ...row, expect_valid: false, invalid_because: { path: hit.path, keyword: hit.keyword } };
    // Each row's other fields come from its own seed, so the same condition is what must not repeat.
    const delta = (x: Row) => JSON.stringify([x.set ?? {}, x.unset ?? []]);
    const same = recipe.rows.find((r) => delta(r) === delta(row));
    if (same) throw new ManifestError(`The gate refuses it: it makes the same data as ${same.name}, so it adds no coverage.`);
    // The same field and the same reason as an existing row adds nothing either, whatever the value.
    if (hit) {
        const again = recipe.rows.find((r) => !r.expect_valid && r.invalid_because?.path === hit.path && r.invalid_because.keyword === hit.keyword);
        if (again) throw new ManifestError(`The gate refuses it: ${again.name} already breaks ${hit.path} by ${hit.keyword}, so it adds no coverage.`);
    }
    return row;
}

/** Apply an accepted rule to the recipe. Only `cmtk review` reaches this, with a person's name. The gate runs again first. */
export function applyDataRule(m: Manifest, rule: DataRule, who: string, date: string): string {
    checkDataRule(m, rule);
    const { recipe } = loadRecipe(m, rule.recipe);
    const by = { said_by: rule.said_by, evidence: rule.evidence, accepted_by: who, accepted_on: date };
    const model: RecipeModel = recipe.model ?? {};
    let done = "";
    switch (rule.what) {
        case "invariant": {
            const i = rule.invariant;
            const index = (model.invariants ?? []).length;
            (model.invariants ??= []).push({ left: i.left, op: i.op, right: i.right, ...by });
            const name = `${slug(i.left)}_${i.op === "sum" ? "sum" : { ">=": "ge", ">": "gt", "<=": "le", "<": "lt", "==": "eq" }[i.op]}_${slug(i.right)}`;
            const says = `${i.left} ${i.op === "sum" ? "= the sum of" : i.op} ${i.right}`;
            const left = i.left.replace(/\[\*\]/g, "[0]");
            recipe.rows.push(
                { name: `${name}_at_edge_invariant`, technique: "BVA-3", coverage_item: `${says}: exactly at the edge`, expect_valid: true, oracle: "specified", invariant: { index, kind: "edge" } },
                { name: `${name}_broken_invariant`, technique: "BVA-3", coverage_item: `${says}: broken, by one step`, expect_valid: false, invalid_because: { path: left, keyword: "invariant" }, oracle: "specified", invariant: { index, kind: "broken" } },
            );
            // A row the invariant can't let stand (a boundary on a total, against its lines) is a labelled negative, never a valid row that isn't.
            recipe.model = model;
            let relabelled = 0;
            for (const r of recipe.rows) {
                if (!r.expect_valid || r.invariant) continue;
                const hit = probeRow(m, recipe, r).violations.find((v) => v.keyword === "invariant");
                if (!hit) continue;
                r.expect_valid = false;
                r.invalid_because = { path: hit.path, keyword: "invariant" };
                r.coverage_item = `${r.coverage_item}, which breaks ${says}`;
                relabelled++;
            }
            done = `invariant added to recipe ${rule.recipe}, with an edge row and a broken row${relabelled ? `; ${relabelled} rows that break it are now labelled negatives` : ""}`;
            break;
        }
        case "vocabulary": {
            const f = fieldAt(recipe, rule.path, "vocabulary.path");
            f.vocabulary = [...rule.values];
            f.valid_from = "vocabulary";
            f.low_confidence = `Values proposed by an agent from ${JSON.stringify(rule.prompted_with)}, accepted by ${who}. Realistic, not proved.`;
            done = `vocabulary for ${f.path} in recipe ${rule.recipe}`;
            break;
        }
        case "notional":
            (model.notional ??= []).push({ name: rule.name, description: rule.description, over: rule.over, ...by });
            done = `notional variable ${rule.name} recorded in recipe ${rule.recipe}: no row is made from it yet`;
            break;
        case "state_machine":
            (model.state_machines ??= []).push({ name: rule.name, states: rule.states, transitions: rule.transitions, ...by });
            done = `state machine ${rule.name} recorded in recipe ${rule.recipe}: no sequence is made from it yet`;
            break;
        case "mutation":
            recipe.rows.push(mutationRow(m, recipe, rule));
            done = `row ${recipe.rows[recipe.rows.length - 1]!.name} added to recipe ${rule.recipe}, for a person to say what should happen`;
            break;
    }
    if (Object.keys(model).length) recipe.model = model;
    makeRows(m, recipe); // a recipe that no longer regenerates is not written
    fs.writeFileSync(recipeFile(m, rule.recipe), renderRecipe(recipe), "utf8");
    return done;
}

export function describeDataRule(r: DataRule): string[] {
    const q = (v: unknown) => JSON.stringify(v ?? null);
    const head = `  recipe ${q(r.recipe)}, ${r.what}, ${r.said_by} says so. Evidence: ${q(r.evidence)}`;
    switch (r.what) {
        case "invariant": return [head, `  rule: ${q(r.invariant)}. Accepting it adds an edge row and a broken row, made by the engine.`];
        case "vocabulary": return [head, `  values for ${q(r.path)}: ${q(r.values)}, proposed from ${q(r.prompted_with)}`];
        case "notional": return [head, `  ${q(r.name)}: ${q(r.description)}, over ${q(r.over)}. It is recorded; no row is made from it yet.`];
        case "state_machine": return [head, `  ${q(r.name)}: states ${q(r.states)}, transitions ${q(r.transitions)}. It is recorded; no sequence is made from it yet.`];
        case "mutation": return [head, `  try ${q(r.operator)} on ${q(r.path)}${r.other ? ` from ${q(r.other)}` : ""}. The engine makes the row, and you say what should happen.`];
    }
}

// ---------------------------------------------------------------- disagreements are findings

export interface DataFinding {
    id: string;
    recipe: string;
    field: string;
    structure_says?: string;
    spec_says?: string;
    production_says?: string;
    /** The question for a person. A finding is reported, never settled here. */
    question: string;
    found_by: string;
    found_on: string;
    status: "open";
}

export const findingsFile = (m: Manifest, id: string) => path.join(path.dirname(recipeFile(m, id)), `${id}.findings.yaml`);

export function loadDataFindings(m: Manifest, id: string): DataFinding[] {
    const f = findingsFile(m, id);
    if (!fs.existsSync(f)) return [];
    return ((YAML.parse(fs.readFileSync(f, "utf8")) as { findings?: DataFinding[] } | null)?.findings ?? []);
}

/** Record where the schema, the spec and production disagree. It needs two sides, and it changes nothing else. */
export function addDataFinding(m: Manifest, input: Omit<DataFinding, "id" | "found_on" | "status">, date = new Date().toISOString().slice(0, 10)): DataFinding {
    loadRecipe(m, input.recipe);
    const sides = [input.structure_says, input.spec_says, input.production_says].filter((s) => typeof s === "string" && s.trim());
    if (sides.length < 2) throw new ManifestError("A finding is a disagreement: say what at least two of structure, spec and production say. If only one speaks, it is not a disagreement.");
    if (!input.question?.trim()) throw new ManifestError("A finding ends in a question for a person.");
    if (!input.field?.trim()) throw new ManifestError("A finding names the field.");
    const all = loadDataFindings(m, input.recipe);
    const f: DataFinding = { id: `F-${String(all.length + 1).padStart(3, "0")}`, recipe: input.recipe, field: input.field, ...(input.structure_says ? { structure_says: input.structure_says } : {}), ...(input.spec_says ? { spec_says: input.spec_says } : {}), ...(input.production_says ? { production_says: input.production_says } : {}), question: input.question, found_by: input.found_by, found_on: date, status: "open" };
    fs.writeFileSync(inside(m, findingsFile(m, input.recipe)), `# Where the schema, the spec and production disagree. Each one is a question for a person, and none is settled here.\n${YAML.stringify({ findings: [...all, f] }, { lineWidth: 0 })}`, "utf8");
    return f;
}

export interface TrafficDisagreement { field: string; keyword: string; requests: number; says: string }

/**
 * What recorded traffic says against the schema: requests the schema would refuse, and fields it does not name.
 * Only paths, counts and reasons come out: a recording can hold real data, so no value is ever copied from it.
 */
export function trafficAgainstSchema(m: Manifest, id: string, harFile: string, o: { path?: string; method?: string } = {}): { requests: number; disagreements: TrafficDisagreement[] } {
    const { recipe } = loadRecipe(m, id);
    const full = inside(m, harFile);
    if (!fs.existsSync(full)) throw new ManifestError(`The recording ${harFile} does not exist.`);
    const entries: any[] = JSON.parse(fs.readFileSync(full, "utf8"))?.log?.entries;
    if (!Array.isArray(entries)) throw new ManifestError(`${harFile} is not a HAR file: it has no log.entries.`);
    const op = /^([A-Z]+)\s+(\S+)$/.exec(recipe.source.operation ?? "");
    const wantPath = o.path ?? op?.[2];
    const wantMethod = (o.method ?? op?.[1] ?? "POST").toUpperCase();
    if (!wantPath) throw new ManifestError("Say which requests to read with a path, such as /api/items.");
    const schema = schemaOf(m, recipe);
    const count = new Map<string, TrafficDisagreement>();
    const add = (field: string, keyword: string, says: string) => {
        const key = `${field}|${keyword}`;
        const d = count.get(key) ?? { field, keyword, requests: 0, says };
        d.requests++;
        count.set(key, d);
    };
    let requests = 0;
    const known = new Set(recipe.fields.map((f) => f.path));
    const walk = (v: unknown, at: string) => {
        if (Array.isArray(v)) { v.forEach((x) => walk(x, `${at}[*]`)); return; }
        if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
            const p = `${at}.${k}`;
            if (!known.has(p)) add(p, "not in the schema", "Traffic sends this field; the schema does not name it.");
            else walk(x, p);
        }
    };
    for (const e of entries) {
        let url: URL;
        try { url = new URL(String(e?.request?.url)); } catch { continue; }
        if (url.pathname !== wantPath || String(e?.request?.method ?? "").toUpperCase() !== wantMethod) continue;
        let body: unknown;
        try { body = JSON.parse(String(e?.request?.postData?.text ?? "")); } catch { continue; }
        requests++;
        walk(body, "$");
        for (const x of validate(schema, body)) if (x.keyword !== "additionalProperties") add(general(x.path), x.keyword, `Traffic sends what the schema refuses (${x.keyword}).`);
    }
    return { requests, disagreements: [...count.values()].sort((a, b) => a.field.localeCompare(b.field)) };
}

function schemaOf(m: Manifest, recipe: Recipe): Record<string, unknown> {
    return (probeRow(m, recipe, { name: "probe", technique: "EP", coverage_item: "", expect_valid: true, oracle: "specified" }).schema);
}
