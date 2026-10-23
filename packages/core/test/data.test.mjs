// Test data: a recipe compiled from a schema, rows regenerated from a seed, checked against the schema, written as files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkQuotas, loadManifest, loadRecipe, makeData, makeRows, patternLimits, planRecipe, stringFromPattern, rng, validate, writeCases, loadCases, readXlsx, writeXlsx } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-data-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof text === "string" ? text : JSON.stringify(text, null, 2));
};
const ITEM = {
    type: "object", additionalProperties: false,
    required: ["Name", "Price", "BrandId", "Stock", "Tags"],
    properties: {
        Name: { type: "string", minLength: 1, maxLength: 50, description: "RULE-011" },
        Description: { type: ["string", "null"], maxLength: 200 },
        Price: { type: "number", minimum: 0, maximum: 1000000, multipleOf: 0.01 },
        Picture: { type: "string", pattern: "^[A-Za-z0-9_-]+\\.(png|jpg)$" },
        BrandId: { type: "integer", enum: [1, 2, 3] },
        Kind: { type: "string", enum: ["Mug", "T-Shirt"] },
        Stock: { type: "integer", minimum: 0, exclusiveMaximum: 100 },
        Email: { type: "string", format: "email" },
        OnReorder: { type: "boolean" },
        Tags: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["new", "sale"] } },
    },
};
function project() {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "schemas/item.json", ITEM);
    return { dir, m: () => loadManifest(path.join(dir, "cmtk.yaml")) };
}

test("a recipe names every row by the condition it exercises, with its technique, and meets the quotas", () => {
    const p = project();
    const { file, recipe } = planRecipe(p.m(), { schema: "schemas/item.json", seed: 7, clock: "2026-02-01T00:00:00Z", generators: { cmtk: "test" } });
    assert.equal(file, "cmtk/data/item.yaml");
    assert.equal(recipe.id, "item");
    const names = recipe.rows.map((r) => r.name);
    for (const n of ["baseline_valid", "body_not_an_object", "Name_minLength_below_3bva", "Name_minLength_at_3bva", "Name_maxLength_above_3bva", "Price_minimum_below_3bva", "Price_maximum_at_3bva", "Price_not_a_multiple",
        "Stock_maximum_above_3bva", "Name_missing", "Name_null", "Price_wrong_type", "BrandId_not_in_enum", "Kind_not_in_enum", "Kind_enum_other_case", "Email_bad_email", "Picture_breaks_pattern", "Stock_fraction", "Tags_minItems_below_3bva", "Tags_maxItems_above_3bva",
        "Tags_each_element_wrong_type", "Name_hostile_csv_formula", "Name_hostile_long", "pairwise_01"]) assert.ok(names.includes(n), n);
    const stockAbove = recipe.rows.find((r) => r.name === "Stock_maximum_above_3bva");
    assert.deepEqual(stockAbove.set, { "$.Stock": 100 }, "exclusiveMaximum 100: 100 itself is the value above");
    assert.deepEqual(stockAbove.invalid_because, { path: "$.Stock", keyword: "exclusiveMaximum" });
    assert.equal(recipe.rows.find((r) => r.name === "Price_maximum_above_3bva").set["$.Price"], 1000000.01);
    assert.deepEqual(recipe.rows.find((r) => r.name === "Kind_enum_other_case").set, { "$.Kind": "mug" }, "a listed value in another case, for case-sensitive lookups");
    assert.equal(recipe.rows.find((r) => r.name === "Name_hostile_long").expect_valid, false, "4,096 characters break maxLength 50");
    assert.equal(recipe.rows.find((r) => r.name === "Name_hostile_csv_formula").expect_valid, true);
    assert.equal(recipe.rows.find((r) => r.name === "Name_hostile_csv_formula").oracle, "implicit");
    assert.deepEqual(checkQuotas(recipe), []);
    const happy = recipe.rows.filter((r) => r.expect_valid && (r.technique === "EP" || r.technique === "pairwise")).length;
    assert.ok(happy / recipe.rows.length <= 0.5);
    assert.ok(recipe.notes.some((n) => /Pairwise rows cover every pair/.test(n)));
    const text = fs.readFileSync(path.join(p.dir, file), "utf8");
    assert.match(text, /^# A test-data recipe/);
    assert.match(text, /source: item\.json#\/properties\/Price/);
});

test("rows are regenerated from the seed, identical every time, and each one is checked against the schema", async () => {
    const p = project();
    planRecipe(p.m(), { schema: "schemas/item.json", seed: 42 });
    const a = await makeData(p.m(), "item", { formats: ["json", "csv", "xlsx"], now: "2026-10-23T00:00:00Z" });
    const first = fs.readFileSync(path.join(p.dir, "cmtk/data/item/rows.json"), "utf8");
    const csv1 = fs.readFileSync(path.join(p.dir, "cmtk/data/item/rows.csv"));
    const b = await makeData(p.m(), "item", { formats: ["json", "csv", "xlsx"], now: "2026-10-23T00:00:00Z" });
    assert.equal(fs.readFileSync(path.join(p.dir, "cmtk/data/item/rows.json"), "utf8"), first, "same seed, same rows");
    assert.equal(a.manifest.files["rows.csv"], b.manifest.files["rows.csv"]);
    assert.equal(a.manifest.files["rows.json"], b.manifest.files["rows.json"]);
    assert.deepEqual(csv1.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), "the CSV starts with a BOM, so Excel reads it as UTF-8");
    assert.match(csv1.toString("utf8"), /\r\n/);
    assert.equal(a.manifest.quotas.problems.length, 0);
    assert.equal(a.rows.length, a.manifest.rows);
    for (const r of a.rows) {
        const v = validate(ITEM, r.value);
        if (r.expect_valid) assert.deepEqual(v, [], `${r.name}: ${JSON.stringify(v)}`);
        else assert.ok(v.some((x) => x.path === r.invalid_because.path), `${r.name} breaks ${r.invalid_because.path}`);
    }
    const base = a.rows.find((r) => r.name === "baseline_valid").value;
    assert.match(base.Picture, /^[A-Za-z0-9_-]+\.(png|jpg)$/, "the pattern is generated, not guessed");
    assert.match(base.Email, /@/);
    assert.ok(base.Tags.length >= 1 && base.Tags.length <= 3);
    assert.equal(fs.existsSync(path.join(p.dir, "cmtk/data/item/rows/Price_maximum_at_3bva.json")), true);
    // One CSV per row too, data columns only: what an import takes for that one condition.
    const oneCsv = fs.readFileSync(path.join(p.dir, "cmtk/data/item/rows/Price_maximum_at_3bva.csv"), "utf8");
    assert.match(oneCsv.split("\r\n")[0], /^\uFEFFName,/);
    assert.doesNotMatch(oneCsv, /expect_valid|^row,/m);
    assert.equal(oneCsv.trim().split("\r\n").length, 2, "a header and one row");
    assert.equal(fs.existsSync(path.join(p.dir, "cmtk/data/item/rows/body_not_an_object.csv")), false, "a body that is not an object has no CSV");
    const breaker = a.rows.find((r) => r.name === "Picture_breaks_pattern").value.Picture;
    assert.match(breaker, /^[ -~]+$/, "the pattern breaker is printable, so it reads in a CSV or a report");
    // The workbook: pinned metadata, the same bytes on a second make, and the cells as written.
    const x1 = fs.readFileSync(path.join(p.dir, "cmtk/data/item/rows.xlsx"));
    const wb = readXlsx(x1);
    assert.equal(wb.creator, "cmtk");
    assert.equal(wb.created, "2026-01-15T09:30:00Z");
    assert.deepEqual(wb.sheets.map((s) => s.name), ["rows", "recipe"]);
    assert.deepEqual(wb.sheets[0].rows[0].slice(0, 3), ["row", "expect_valid", "Name"]);
    assert.equal(wb.sheets[0].rows[1][0], "baseline_valid");
    assert.equal(wb.sheets[0].rows[1][1], true);
    assert.equal(typeof wb.sheets[0].rows[1][wb.sheets[0].rows[0].indexOf("Price")], "number");
    assert.equal(a.manifest.files["rows.xlsx"], b.manifest.files["rows.xlsx"], "the workbook's bytes are the same on every make");
    assert.match(fs.readFileSync(path.join(p.dir, "cmtk/data/item/DATA.md"), "utf8"), /Quotas met/);
});

test("a recipe a person edited is checked: missing boundaries, too many happy paths, and a row that lies about itself", async () => {
    const p = project();
    const { file, recipe } = planRecipe(p.m(), { schema: "schemas/item.json" });
    // Drop every boundary and negative row: the quotas say so.
    const happy = { ...recipe, rows: recipe.rows.filter((r) => r.expect_valid && (r.technique === "EP" || r.technique === "pairwise")) };
    assert.ok(checkQuotas(happy).some((x) => /happy paths, above the quota/.test(x)));
    assert.ok(checkQuotas(happy).some((x) => /\$\.Price has a boundary but no BVA-3 rows/.test(x)));
    assert.ok(checkQuotas(happy).some((x) => /\$\.Name has no row that breaks it/.test(x)));
    // A row edited to claim an invalid value that the schema accepts.
    const YAML = (await import("yaml")).default;
    const doc = YAML.parse(fs.readFileSync(path.join(p.dir, file), "utf8"));
    const row = doc.recipe.rows.find((r) => r.name === "Price_maximum_above_3bva");
    row.set["$.Price"] = 5;
    fs.writeFileSync(path.join(p.dir, file), YAML.stringify(doc));
    assert.throws(() => makeRows(p.m(), loadRecipe(p.m(), "item").recipe), /Price_maximum_above_3bva should break \$\.Price \(maximum\) but the schema accepts it/);
    // The schema changed since the plan.
    write(p.dir, "schemas/item.json", { ...ITEM, properties: { ...ITEM.properties, Price: { type: "number", minimum: 1 } } });
    await assert.rejects(() => makeData(p.m(), "item"), /has changed since the recipe was planned/);
});

test("from an OpenAPI operation: the body, the query parameters, and cases that expect the documented statuses", async () => {
    const p = project();
    write(p.dir, "api.json", {
        openapi: "3.0.3", info: { title: "shop", version: "1" },
        components: { schemas: { Item: ITEM } },
        paths: { "/api/items": { post: {
            parameters: [{ name: "dryRun", in: "query", required: false, schema: { type: "boolean" } }],
            requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } } },
            responses: { 201: { description: "created" }, 400: { description: "invalid" }, 500: { description: "boom" } },
        } } },
    });
    assert.throws(() => planRecipe(p.m(), { schema: "api.json" }), /name the operation.*POST \/api\/items/);
    const { recipe } = planRecipe(p.m(), { schema: "api.json", operation: "POST /api/items" });
    assert.equal(recipe.id, "api-items");
    assert.ok(recipe.fields.some((f) => f.path === "?dryRun"));
    assert.deepEqual(recipe.responses, { 201: "created", 400: "invalid", 500: "boom" });
    await makeData(p.m(), "api-items");
    const { file, cases, withoutExpect } = writeCases(p.m(), "api-items", { requirement: "STORY-1/AC-2" });
    assert.equal(withoutExpect, 0);
    const loaded = loadCases(p.m());
    assert.equal(loaded.length, cases.length);
    const base = loaded.find((c) => c.name === "every field: a valid representative");
    assert.deepEqual(base.expect, { status: 201 });
    assert.equal(base.request.body_file, "cmtk/data/api-items/rows/baseline_valid.json");
    assert.equal(base.request.path, "/api/items");
    assert.equal(base.draft, true);
    assert.deepEqual(loaded.find((c) => c.name === "$.Price above its maximum (1000000)").expect, { status: 400 });
    assert.match(fs.readFileSync(path.join(p.dir, file), "utf8"), /A person accepts them with `cmtk review`/);
});

test("strings are generated from patterns, and patterns we can't generate are reported", () => {
    const r = rng(1);
    for (const pat of ["^[A-Z]{3}-\\d{4}$", "^(png|jpg|gif)$", "^[a-z]+@[a-z]+\\.(com|org)$", "^\\+44 ?\\d{10}$", "^[^0-9]{2,5}$", "^GB\\d{2}[A-Z]{4}\\d{14}$"]) {
        for (let i = 0; i < 20; i++) assert.match(stringFromPattern(pat, r), new RegExp(pat, "u"), pat);
    }
    assert.equal(patternLimits("^[A-Z]{3}$"), undefined);
    assert.match(patternLimits("^(?=.*\\d).+$"), /lookaround/);
    assert.match(patternLimits("^(a)\\1$"), /backreferences/);
    assert.equal(stringFromPattern("^[A-Z]{3}-\\d{4}$", rng(5)), stringFromPattern("^[A-Z]{3}-\\d{4}$", rng(5)), "the same seed gives the same string");
});

test("a query parameter's rows reach the request path, never the body", async () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "api.json", { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: { "/search": { get: {
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 20 } }, { name: "page", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } }],
        responses: { 200: { description: "ok" }, 400: { description: "bad" } } } } } });
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    const { recipe } = planRecipe(m(), { schema: "api.json", operation: "GET /search" });
    const { rows } = await makeData(m(), "search");
    const base = rows.find((r) => r.name === "baseline_valid");
    assert.ok(base.query.q.length >= 1 && base.query.q.length <= 20);
    assert.equal(base.query.page, undefined, "an optional parameter is absent unless a row sets it");
    assert.equal(rows.find((r) => r.name === "q_page_maximum_above_3bva").query.page, "51");
    assert.equal(rows.find((r) => r.name === "q_q_missing").query.q, undefined);
    writeCases(m(), "search");
    const cases = loadCases(m());
    assert.match(cases.find((c) => c.name === "?page above its maximum (50)").request.path, /^\/search\?q=.+&page=51$/);
    assert.equal(cases.find((c) => c.name === "?page above its maximum (50)").request.method, "GET");
    assert.ok(recipe.rows.every((r) => !r.replace_body || r.name === "body_not_an_object") && !recipe.rows.some((r) => r.name === "body_not_an_object"), "no body rows for an operation without a body");
});

test("the workbook writer: round trip, control characters escaped, and bytes that never change", () => {
    const sheets = [{ name: "s", rows: [["a", "b", "c"], [1, true, "x\u0000y"], [null, " padded ", "=1+1"], [2.5, false, "Ñandú 😀"]] }];
    const one = writeXlsx(sheets, { created: "2026-02-02T00:00:00Z" });
    const two = writeXlsx(sheets, { created: "2026-02-02T00:00:00Z" });
    assert.ok(one.equals(two));
    assert.equal(one.subarray(0, 4).toString("hex"), "504b0304", "a zip");
    const back = readXlsx(one);
    assert.deepEqual(back.sheets[0].rows[1], [1, true, "x\u0000y"]);
    assert.deepEqual(back.sheets[0].rows[2].slice(1), [" padded ", "=1+1"]);
    assert.deepEqual(back.sheets[0].rows[3], [2.5, false, "Ñandú 😀"]);
    assert.equal(back.created, "2026-02-02T00:00:00Z");
    assert.ok(!one.toString("latin1").includes("samuel"), "no person named");
});
