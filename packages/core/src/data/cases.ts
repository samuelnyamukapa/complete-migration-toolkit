// `cmtk data cases`: one draft case per row of a recipe, each sending its row as the request body
// from a file the evidence can fingerprint. Drafts wait for `cmtk review`, like every case an
// agent writes, and an expectation is written only where the schema or the OpenAPI document
// says what the answer should be.
import fs from "node:fs";
import path from "node:path";

import { casesToYaml } from "../har.js";
import { inside, ManifestError } from "../manifest.js";
import type { Case, Manifest } from "../types.js";
import { dataFolder, loadRecipe } from "./recipe.js";

export interface CasesOptions {
    /** The request path, such as /api/items. Default: the operation's path for an OpenAPI recipe. */
    path?: string;
    /** Default: the operation's method, or POST. */
    method?: string;
    /** The requirement every case names, such as RULE-013. */
    requirement?: string;
    /** The case file, relative to the project. Default: cmtk/cases/data-<id>.yaml. */
    out?: string;
    headers?: Record<string, string>;
}

/** The lowest documented 2xx, and the documented 400 or 422, from an OpenAPI operation's responses. */
function statuses(responses: Record<string, string> | undefined): { ok?: number; bad?: number } {
    const codes = Object.keys(responses ?? {}).map(Number).filter((c) => !Number.isNaN(c)).sort((a, b) => a - b);
    return { ok: codes.find((c) => c >= 200 && c < 300), bad: codes.find((c) => c === 400 || c === 422) };
}

export function writeCases(m: Manifest, id: string, o: CasesOptions = {}): { file: string; cases: Case[]; withoutExpect: number } {
    const { recipe } = loadRecipe(m, id);
    const rowsDir = path.join(dataFolder(m, id), "rows");
    const rowsFile = path.join(dataFolder(m, id), "rows.json");
    if (!fs.existsSync(rowsDir) || !fs.existsSync(rowsFile)) throw new ManifestError(`There are no rows for ${id} yet: run \`cmtk data make ${id}\` first.`);
    const made = new Map<string, { query?: Record<string, string>; value?: unknown }>((JSON.parse(fs.readFileSync(rowsFile, "utf8")) as { name: string; query?: Record<string, string>; value?: unknown }[]).map((r) => [r.name, r]));
    const op = /^([A-Z]+)\s+(\S+)$/.exec(recipe.source.operation ?? "");
    const reqPath = o.path ?? op?.[2];
    if (!reqPath || !reqPath.startsWith("/") || reqPath.startsWith("//")) throw new ManifestError("Give the request path with --path /api/..., a path and never a host.");
    const method = (o.method ?? op?.[1] ?? "POST").toUpperCase();
    const { ok, bad } = statuses(recipe.responses);
    const prefix = id.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
    const cases: Case[] = [];
    let withoutExpect = 0;
    for (const [i, row] of recipe.rows.entries()) {
        const rowFile = path.join(rowsDir, `${row.name}.json`);
        const hasBody = made.get(row.name)?.value !== undefined;
        if (hasBody && !fs.existsSync(rowFile)) throw new ManifestError(`Row ${row.name} has no file: run \`cmtk data make ${id}\` again.`);
        const query = made.get(row.name)?.query;
        const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
        const status = row.expect_valid ? ok : bad;
        if (status === undefined) withoutExpect++;
        cases.push({
            id: `${prefix}-${String(i + 1).padStart(3, "0")}`,
            name: `${row.coverage_item}`,
            ...(o.requirement ? { requirement: o.requirement } : {}),
            request: { method, path: reqPath + qs, ...(o.headers ? { headers: o.headers } : {}), ...(hasBody ? { body_file: path.relative(m.root, rowFile).split(path.sep).join("/") } : {}) } as Case["request"],
            ...(status !== undefined ? { expect: { status } } : {}),
            draft: true,
            draft_note: `From recipe ${id}, row ${row.name} (${row.technique}): ${row.coverage_item}. The schema says the body is ${row.expect_valid ? "valid" : `invalid (${row.invalid_because?.path} ${row.invalid_because?.keyword})`}; the oracle is ${row.oracle}.${status === undefined ? " No documented status for this answer, so no expect: a person adds one." : ""}`,
        });
    }
    const out = inside(m, o.out ?? path.join("cmtk", "cases", `data-${id}.yaml`));
    if (fs.existsSync(out)) throw new ManifestError(`${path.relative(m.root, out)} already exists; choose another --out, or delete it.`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, casesToYaml(cases, `Draft cases from the test-data recipe ${id}: one per row, each sending its row from cmtk/data/${id}/rows/. A person accepts them with \`cmtk review\`.`), "utf8");
    return { file: path.relative(m.root, out).split(path.sep).join("/"), cases, withoutExpect };
}
