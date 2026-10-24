// Cases that post forms: body_form from a row file, a page read first for its anti-forgery token
// and cookies, text parts beside uploaded files, and `cmtk data cases --encoding form`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { cookiesOf, loadCases, loadManifest, makeData, planRecipe, run, compare, takeFromPage, writeCases } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-form-"));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof text === "string" ? text : JSON.stringify(text, null, 2));
};

/**
 * A form the way ASP.NET MVC serves one: GET /Catalog/Create sets a cookie and renders a hidden token;
 * POST /Catalog/Create is accepted only when the cookie and the field match, then validates Name and Price.
 * It records every request it saw.
 */
function mvc() {
    const seen = [];
    let n = 0;
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            const chunks = [];
            req.on("data", (d) => chunks.push(d));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                seen.push({ method: req.method, url: req.url, type: req.headers["content-type"] ?? "", cookie: req.headers.cookie ?? "", body });
                if (req.method === "GET" && req.url === "/Catalog/Create") {
                    const token = `tok-${++n}`;
                    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": [`__RequestVerificationToken=cookie-${n}; path=/; HttpOnly`, "ASP.NET_SessionId=sess; path=/"] });
                    res.end(`<html><body><form action="/Catalog/Create" method="post"><input name="__RequestVerificationToken" type="hidden" value="${token}&amp;x" /><input name="Name" /></form></body></html>`);
                    return;
                }
                if (req.method === "POST" && req.url === "/Catalog/Create") {
                    const form = new URLSearchParams(body);
                    const cookie = /__RequestVerificationToken=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
                    const field = form.get("__RequestVerificationToken");
                    if (!cookie || !field || cookie.slice(7) !== field.slice(4, -2)) { res.writeHead(500, { "content-type": "text/html" }); res.end("<h1>The required anti-forgery form field is not present.</h1>"); return; }
                    const errors = [];
                    if (!form.get("Name")) errors.push("The Name field is required.");
                    if (!/^\d+(\.\d{1,2})?$/.test(form.get("Price") ?? "")) errors.push("The field Price must be between 0 and 1000000.");
                    if (errors.length) { res.writeHead(200, { "content-type": "text/html" }); res.end(`<form><span class="field-validation-error">${errors.join(" ")}</span></form>`); return; }
                    res.writeHead(302, { location: "/Catalog" });
                    res.end();
                    return;
                }
                res.writeHead(404);
                res.end("not found");
            });
        });
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

test("values are taken from a page: inputs, meta tags, any attribute, a regex, and entities are unescaped", () => {
    const html = `<html><head><meta name="csrf-token" content="m&amp;1"><meta name='other' content='x'></head>
<body><input type="hidden" name="__RequestVerificationToken" value="abc&#43;def==" /><INPUT NAME="Name" VALUE="n" data-id='7'><input name="flag" disabled></body></html>`;
    assert.equal(takeFromPage(html, "input[name=__RequestVerificationToken]"), "abc+def==");
    assert.equal(takeFromPage(html, 'input[name="Name"]'), "n", "attribute names and tags match in any case; the value as written");
    assert.equal(takeFromPage(html, "input[name=Name]@data-id"), "7");
    assert.equal(takeFromPage(html, "meta[name=csrf-token]"), "m&1", "a meta tag gives its content");
    assert.equal(takeFromPage(html, "input[name=flag]"), undefined, "an input without the attribute is not a match");
    assert.equal(takeFromPage(html, "input[name=missing]"), undefined);
    assert.equal(takeFromPage(html, 'regex:NAME="Name" VALUE="([^"]+)"'), "n", "a regex is applied to the page as written");
    assert.equal(takeFromPage(html, 'regex:name="Name" value="([^"]+)"'), undefined, "and is case-sensitive");
    assert.throws(() => takeFromPage(html, "div > input"), /not tag\[attr=value\]/);
    assert.deepEqual(cookiesOf(["a=1; Path=/; HttpOnly", "b=x=y; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "bad"]), { a: "1", b: "x=y" });
});

test("a form case reads the page first, posts the row as a browser would with the cookies and the token, and the evidence names what it took but never the value", async () => {
    const s = await mvc();
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  candidate: ${s.url}\nallow_unsafe_methods: true\n`);
    write(dir, "cmtk/data/item/rows/baseline_valid.json", { Name: "Mug & Co", Price: 12.5, OnReorder: false, Description: null, Tags: ["a", "b"] });
    write(dir, "cmtk/data/item/rows/Name_missing.json", { Price: 12.5 });
    write(dir, "cmtk/cases/a.yaml", `cases:
  - id: OK
    request:
      method: POST
      path: /Catalog/Create
      body_form: cmtk/data/item/rows/baseline_valid.json
      before:
        get: /Catalog/Create
        take: { __RequestVerificationToken: "input[name=__RequestVerificationToken]" }
    expect: { status: 302 }
  - id: BAD
    request:
      method: POST
      path: /Catalog/Create
      body_form: cmtk/data/item/rows/Name_missing.json
      before:
        get: /Catalog/Create
        take: { __RequestVerificationToken: "input[name=__RequestVerificationToken]" }
    expect: { status: 200, body_contains: ["The Name field is required."] }
  - id: NOTOKEN
    request: { method: POST, path: /Catalog/Create, body_form: { Name: Mug, Price: 1 } }
    expect: { status: 500 }
  - id: INLINE
    request:
      method: POST
      path: /Catalog/Create
      headers: { Cookie: theirs=1 }
      body_form: { Name: Mug, Price: 1 }
      before: { get: /Catalog/Create, take: { __RequestVerificationToken: "input[name=__RequestVerificationToken]" } }
    expect: { status: 302 }
  - id: NOPAGE
    request:
      method: POST
      path: /Catalog/Create
      body_form: { Name: Mug }
      before: { get: /Catalog/Missing, take: { __RequestVerificationToken: "input[name=__RequestVerificationToken]" } }
    expect: { status: 302 }
  - id: NOMATCH
    request:
      method: POST
      path: /Catalog/Create
      body_form: { Name: Mug }
      before: { get: /Catalog/Create, take: { token: "input[name=nothing]" } }
    expect: { status: 302 }
`);
    try {
        const r = await run(loadManifest(path.join(dir, "cmtk.yaml")), { allowUnsafe: true });
        const by = Object.fromEntries(r.cases.map((c) => [c.id, c]));
        assert.equal(by.OK.result, "PASS", JSON.stringify(by.OK));
        assert.equal(by.BAD.result, "PASS", JSON.stringify(by.BAD));
        assert.equal(by.NOTOKEN.result, "PASS", "without the page, the server refuses the post, as it should");
        assert.equal(by.INLINE.result, "PASS", JSON.stringify(by.INLINE));
        assert.equal(by.NOPAGE.result, "ERROR");
        assert.match(by.NOPAGE.why, /before: GET \/Catalog\/Missing answered 404/);
        assert.equal(by.NOMATCH.result, "ERROR");
        assert.match(by.NOMATCH.why, /nothing on the page matches input\[name=nothing\] for token/);
        // What the server saw for OK: the page first, then the post with the cookies and the token.
        const [page, post] = s.seen.filter((x) => x.url === "/Catalog/Create").slice(0, 2);
        assert.equal(page.method, "GET");
        assert.equal(post.method, "POST");
        assert.equal(post.type, "application/x-www-form-urlencoded");
        assert.match(post.cookie, /__RequestVerificationToken=cookie-1/);
        assert.match(post.cookie, /ASP\.NET_SessionId=sess/);
        const form = new URLSearchParams(post.body);
        assert.equal(form.get("Name"), "Mug & Co");
        assert.equal(form.get("Price"), "12.5");
        assert.equal(form.get("OnReorder"), "false", "booleans as a browser sends a checkbox value");
        assert.equal(form.get("Description"), "", "null is an empty value, as an empty input would be");
        assert.deepEqual(form.getAll("Tags"), ["a", "b"], "a list is repeated fields");
        assert.equal(form.get("__RequestVerificationToken"), "tok-1&x", "the token as the page carried it, entities unescaped");
        const inline = s.seen.find((x) => x.method === "POST" && x.cookie.includes("theirs=1"));
        assert.ok(inline, "the case's own Cookie header is kept");
        assert.match(inline.cookie, /theirs=1; .*__RequestVerificationToken=cookie-/);
        // The evidence: the file fingerprinted as a form, the page named, and no token value anywhere.
        assert.equal(by.OK.inputs[0].as, "form");
        assert.equal(by.OK.inputs[0].path, "cmtk/data/item/rows/baseline_valid.json");
        assert.deepEqual(by.OK.before, { request: "GET /Catalog/Create", status: 200, took: ["__RequestVerificationToken"], cookies: ["__RequestVerificationToken", "ASP.NET_SessionId"] });
        const evidence = fs.readdirSync(path.join(dir, "cmtk/evidence/run/answers")).map((f) => fs.readFileSync(path.join(dir, "cmtk/evidence/run/answers", f), "utf8")).join("\n")
            + fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.json"), "utf8") + fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8");
        assert.doesNotMatch(evidence, /tok-\d/, "the token taken from the page is never written");
        assert.doesNotMatch(evidence, /cookie-\d/, "nor the cookie");
        const md = fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8");
        assert.match(md, /## Pages read first/);
        assert.match(md, /\| OK \| GET \/Catalog\/Create \| 200 \| __RequestVerificationToken \| __RequestVerificationToken, ASP\.NET_SessionId \|/);
        assert.match(md, /the form fields/);
    } finally {
        await s.close();
    }
});

test("a compare reads the page on each system separately", async () => {
    const a = await mvc();
    const b = await mvc();
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: ${a.url}\n  candidate: ${b.url}\nallow_unsafe_methods: true\n`);
    write(dir, "cmtk/cases/a.yaml", `cases:
  - id: F
    request:
      method: POST
      path: /Catalog/Create
      body_form: { Name: "", Price: 1 }
      before: { get: /Catalog/Create, take: { __RequestVerificationToken: "input[name=__RequestVerificationToken]" } }
`);
    try {
        const r = await compare(loadManifest(path.join(dir, "cmtk.yaml")), { allowUnsafe: true });
        assert.equal(r.cases[0].result, "MATCH", JSON.stringify(r.cases[0]));
        assert.equal(a.seen.filter((x) => x.method === "POST").length, 1);
        assert.equal(b.seen.filter((x) => x.method === "POST").length, 1);
        assert.match(b.seen.find((x) => x.method === "POST").cookie, /cookie-1/, "each system's own cookie, not the other's");
    } finally {
        await a.close();
        await b.close();
    }
});

test("form fields go as text parts beside uploaded files, and the loader refuses what a form cannot hold", async () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "f.csv", "a,b\r\n");
    write(dir, "cmtk/cases/a.yaml", `cases:
  - id: M
    request:
      method: POST
      path: /import
      body_form: { title: "Q3 & Q4", replace: true }
      files: [{ field: file, path: f.csv }]
`);
    const { requestBody } = await import("../dist/index.js");
    const [c] = loadCases(loadManifest(path.join(dir, "cmtk.yaml")));
    const headers = {};
    const made = requestBody(c, dir, headers);
    const text = made.body.toString("utf8");
    assert.match(headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(text, /Content-Disposition: form-data; name="title"\r\n\r\nQ3 & Q4\r\n/);
    assert.match(text, /name="replace"\r\n\r\ntrue\r\n/);
    assert.match(text, /name="file"; filename="f.csv"\r\nContent-Type: text\/csv/);
    assert.ok(text.indexOf('name="title"') < text.indexOf('name="file"'), "fields first, then files, as a browser sends them");

    const bad = (yaml, re) => {
        const d = tmp();
        write(d, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
        write(d, "cmtk/cases/a.yaml", yaml);
        assert.throws(() => loadCases(loadManifest(path.join(d, "cmtk.yaml"))), re);
    };
    bad("cases:\n  - id: A\n    request: { method: POST, path: /x, body: '{}', body_form: { a: 1 } }\n", /give no `body` or `body_file`/);
    bad("cases:\n  - id: A\n    request: { method: POST, path: /x, body_form: { a: { nested: 1 } } }\n", /body_form.a is an object/);
    bad("cases:\n  - id: A\n    request: { method: POST, path: /x, body_form: ../outside.json }\n", /inside the project|outside/);
    bad("cases:\n  - id: A\n    request: { method: POST, path: /x, body_form: { a: 1 }, before: { get: 'http://evil/' } }\n", /a path on the same target, never a host/);
    bad("cases:\n  - id: A\n    request: { method: POST, path: /x, body: '{}', before: { get: /p, take: { t: 'input[name=t]' } } }\n", /needs `body_form` or `files`/);
    bad("cases:\n  - id: A\n    request: { method: POST, path: /x, body_form: { a: 1 }, before: { get: /p, take: { t: 5 } } }\n", /must be a selector/);
});

test("cmtk data cases --encoding form writes form posts with the page to read first, leaves out rows that are not an object, and marks statuses a person gave", async () => {
    const dir = tmp();
    write(dir, "cmtk.yaml", "system: s\ntargets:\n  candidate: http://127.0.0.1:9\n");
    write(dir, "schemas/item.json", { type: "object", required: ["Name"], properties: { Name: { type: "string", minLength: 1, maxLength: 5 }, Note: { type: "string" }, Price: { type: "number", minimum: 0, maximum: 10 } } });
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    planRecipe(m(), { schema: "schemas/item.json", seed: 3 });
    await makeData(m(), "item", { formats: ["json"], now: "2026-10-25T00:00:00Z" });
    const before = { get: "/Catalog/Create", take: { __RequestVerificationToken: "input[name=__RequestVerificationToken]" } };
    const out = writeCases(m(), "item", { path: "/Catalog/Create", requirement: "RULE-013", encoding: "form", before, expectValid: 302, expectInvalid: 200 });
    assert.deepEqual(out.leftOut.map((x) => x.name).sort(), ["Name_wrong_type", "Note_null", "Note_wrong_type", "body_not_an_object"], "rows that mean nothing as a form, where every value is text");
    assert.match(out.leftOut.find((x) => x.name === "Note_null").why, /empty value/);
    assert.ok(!out.leftOut.some((x) => x.name === "Name_null"), "null posts as empty, which a required field refuses, so that row keeps its meaning");
    assert.ok(!out.leftOut.some((x) => x.name === "Price_wrong_type"), "text where a number is expected is still the wrong type");
    assert.equal(out.withoutExpect, 0);
    const cases = loadCases(m()).filter((c) => c.file.split(path.sep).join("/") === out.file);
    assert.equal(cases.length, out.cases.length);
    const base = cases.find((c) => c.request.body_form === "cmtk/data/item/rows/baseline_valid.json");
    assert.ok(base, "the row goes as a form");
    assert.equal(base.request.body_file, undefined);
    assert.deepEqual(base.request.before, before);
    assert.deepEqual(base.expect, { status: 302 });
    assert.match(base.draft_note, /given on the command line, not read from a document/);
    assert.match(base.draft_note, /changes data: it runs only with allow_unsafe_methods/);
    assert.match(base.draft_note, /never written to evidence/);
    const missing = cases.find((c) => c.name === "$.Name missing though required");
    assert.deepEqual(missing.expect, { status: 200 });
    assert.ok(cases.every((c) => c.draft === true));
    assert.throws(() => writeCases(m(), "item", { path: "/x", before, out: "cmtk/cases/other.yaml" }), /needs --encoding form/);
    const invalid = writeCases(m(), "item", { path: "/Catalog/Create", requirement: "RULE-009, RULE-013", encoding: "form", rows: "invalid", out: "cmtk/cases/invalid.yaml" });
    assert.ok(invalid.cases.length > 0 && invalid.cases.length < out.cases.length);
    assert.ok(invalid.cases.every((c) => !c.name.includes("valid representative")));
    assert.deepEqual(invalid.cases[0].requirement, ["RULE-009", "RULE-013"], "several requirements, as a list");
    assert.match(fs.readFileSync(path.join(dir, "cmtk/cases/invalid.yaml"), "utf8"), /one per invalid row/);
});
