// `cmtk data cases`: one draft case per row of a recipe, each sending its row as the request body
// from a file the evidence can fingerprint. Drafts wait for `cmtk review`, like every case an
// agent writes, and an expectation is written only where the schema or the OpenAPI document
// says what the answer should be, or where a person gave the status on the command line.
import fs from "node:fs";
import path from "node:path";

import { casesToYaml } from "../har.js";
import { inside, ManifestError } from "../manifest.js";
import type { Before, Case, Manifest } from "../types.js";
import { dataFolder, loadRecipe, type Recipe, type RecipeField } from "./recipe.js";

export interface CasesOptions {
    /** The request path, such as /api/items. Default: the operation's path for an OpenAPI recipe. */
    path?: string;
    /** Default: the operation's method, or POST. */
    method?: string;
    /** The requirement every case names, such as RULE-013, or several separated by commas. */
    requirement?: string;
    /** Which rows: all (the default), only the ones the schema calls valid, or only the invalid ones, which a form answers without writing (RULE-009-style). */
    rows?: "all" | "valid" | "invalid";
    /** The case file, relative to the project. Default: cmtk/cases/data-<id>.yaml. */
    out?: string;
    headers?: Record<string, string>;
    /**
     * How a row is sent. `json` (the default): the row file as the body. `form`: the row's fields as
     * application/x-www-form-urlencoded, the way a browser posts a form; rows that are not an object are left out.
     */
    encoding?: "json" | "form";
    /** A page read before each request, for an anti-forgery token and the cookies it sets. Needs `form`. */
    before?: Before;
    /** The status a person says a valid row must get, and an invalid one, when no document gives it. */
    expectValid?: number;
    expectInvalid?: number;
}

/** The lowest documented 2xx, and the documented 400 or 422, from an OpenAPI operation's responses. */
function statuses(responses: Record<string, string> | undefined): { ok?: number; bad?: number } {
    const codes = Object.keys(responses ?? {}).map(Number).filter((c) => !Number.isNaN(c)).sort((a, b) => a - b);
    return { ok: codes.find((c) => c >= 200 && c < 300), bad: codes.find((c) => c === 400 || c === 422) };
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** A row that means nothing as a form, and why: every form value is text, so a text field cannot have the wrong type, and null is an empty value. */
function notAForm(row: Recipe["rows"][number], fields: RecipeField[], value: unknown): string | undefined {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) return "a form is named fields and this row is not an object";
    const why = row.invalid_because;
    if (!why || why.keyword !== "type") return undefined;
    const f = fields.find((x) => x.path === why.path);
    if (!f || f.type !== "string") return undefined;
    const set = row.set?.[why.path];
    if (set === null) {
        // null posts as an empty value; the row keeps its meaning only if something would refuse "".
        const c = f.constraints;
        const refusesEmpty = f.required || (typeof c.minLength === "number" && c.minLength >= 1) || c.pattern !== undefined || c.enum !== undefined || c.const !== undefined || c.format !== undefined;
        return refusesEmpty ? undefined : "null posts as an empty value, which nothing in the schema refuses for this text field";
    }
    return "every form value is text, so a text field cannot have the wrong type";
}

/** The left-out rows as one line per reason: "because <why>: a, b". */
export function describeLeftOut(leftOut: { name: string; why: string }[]): string[] {
    const by = new Map<string, string[]>();
    for (const x of leftOut) by.set(x.why, [...(by.get(x.why) ?? []), x.name]);
    return [...by].map(([why, names]) => `because ${why}: ${names.join(", ")}`);
}

export function writeCases(m: Manifest, id: string, o: CasesOptions = {}): { file: string; cases: Case[]; withoutExpect: number; leftOut: { name: string; why: string }[] } {
    const { recipe } = loadRecipe(m, id);
    const rowsDir = path.join(dataFolder(m, id), "rows");
    const rowsFile = path.join(dataFolder(m, id), "rows.json");
    if (!fs.existsSync(rowsDir) || !fs.existsSync(rowsFile)) throw new ManifestError(`There are no rows for ${id} yet: run \`cmtk data make ${id}\` first.`);
    const made = new Map<string, { query?: Record<string, string>; value?: unknown }>((JSON.parse(fs.readFileSync(rowsFile, "utf8")) as { name: string; query?: Record<string, string>; value?: unknown }[]).map((r) => [r.name, r]));
    const op = /^([A-Z]+)\s+(\S+)$/.exec(recipe.source.operation ?? "");
    const reqPath = o.path ?? op?.[2];
    if (!reqPath || !reqPath.startsWith("/") || reqPath.startsWith("//")) throw new ManifestError("Give the request path with --path /api/..., a path and never a host.");
    const method = (o.method ?? op?.[1] ?? "POST").toUpperCase();
    const encoding = o.encoding ?? "json";
    const which = o.rows ?? "all";
    const requirement = o.requirement?.split(",").map((s) => s.trim()).filter(Boolean);
    if (o.before && encoding !== "form") throw new ManifestError("`before` reads a page for a form, so it needs --encoding form.");
    if (o.before && (!o.before.get.startsWith("/") || o.before.get.startsWith("//"))) throw new ManifestError("`before.get` must be a path on the same target, such as /Catalog/Create.");
    for (const [field, selector] of Object.entries(o.before?.take ?? {})) if (!selector.trim()) throw new ManifestError(`before.take.${field} needs a selector, such as input[name=${field}].`);
    const documented = statuses(recipe.responses);
    const ok = documented.ok ?? o.expectValid;
    const bad = documented.bad ?? o.expectInvalid;
    const given = (s: number | undefined, from: number | undefined) => s !== undefined && from === undefined;
    const prefix = id.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
    const cases: Case[] = [];
    const leftOut: { name: string; why: string }[] = [];
    let withoutExpect = 0;
    // Ids follow the row's place in the recipe, so a row keeps its id whichever subset is written.
    for (const [i, row] of recipe.rows.entries()) {
        if (which !== "all" && row.expect_valid !== (which === "valid")) continue;
        const rowFile = path.join(rowsDir, `${row.name}.json`);
        const value = made.get(row.name)?.value;
        const hasBody = value !== undefined;
        if (hasBody && !fs.existsSync(rowFile)) throw new ManifestError(`Row ${row.name} has no file: run \`cmtk data make ${id}\` again.`);
        if (encoding === "form") {
            const why = notAForm(row, recipe.fields, value);
            if (why) { leftOut.push({ name: row.name, why }); continue; }
        }
        const query = made.get(row.name)?.query;
        const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
        const status = row.expect_valid ? ok : bad;
        if (status === undefined) withoutExpect++;
        const rel = path.relative(m.root, rowFile).split(path.sep).join("/");
        const notes = [
            `From recipe ${id}, row ${row.name} (${row.technique}): ${row.coverage_item}. The schema says the body is ${row.expect_valid ? "valid" : `invalid (${row.invalid_because?.path} ${row.invalid_because?.keyword})`}; the oracle is ${row.oracle}.`,
            encoding === "form" ? "Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields." : "",
            o.before ? `Before it, ${o.before.get} is read for ${Object.keys(o.before.take ?? {}).join(", ") || "its cookies"}; the values taken are never written to evidence.` : "",
            status === undefined ? "No documented status for this answer, so no expect: a person adds one."
                : given(status, row.expect_valid ? documented.ok : documented.bad) ? `The expected status ${status} was given on the command line, not read from a document: the reviewer confirms it against the requirement.` : "",
            !SAFE.has(method) ? "This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data." : "",
        ].filter(Boolean);
        cases.push({
            id: `${prefix}-${String(i + 1).padStart(3, "0")}`,
            name: `${row.coverage_item}`,
            ...(requirement?.length ? { requirement: requirement.length === 1 ? requirement[0] : [...requirement] } : {}),
            request: {
                method, path: reqPath + qs,
                ...(o.headers ? { headers: o.headers } : {}),
                ...(hasBody ? (encoding === "form" ? { body_form: rel } : { body_file: rel }) : {}),
                ...(o.before ? { before: structuredClone(o.before) } : {}),
            } as Case["request"],
            ...(status !== undefined ? { expect: { status } } : {}),
            draft: true,
            draft_note: notes.join(" "),
        });
    }
    const out = inside(m, o.out ?? path.join("cmtk", "cases", `data-${id}.yaml`));
    if (fs.existsSync(out)) throw new ManifestError(`${path.relative(m.root, out)} already exists; choose another --out, or delete it.`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const how = encoding === "form" ? "as a form" : "as the body";
    const subset = which === "all" ? "one per row" : `one per ${which} row (the rows the schema calls ${which})`;
    fs.writeFileSync(out, casesToYaml(cases, `Draft cases from the test-data recipe ${id}: ${subset}, each sending its row from cmtk/data/${id}/rows/ ${how}. A person accepts them with \`cmtk review\`.`), "utf8");
    return { file: path.relative(m.root, out).split(path.sep).join("/"), cases, withoutExpect, leftOut };
}
