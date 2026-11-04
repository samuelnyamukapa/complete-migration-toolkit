// A reskin in a real browser: the look changes and the elements stay. Only a missing button may be reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { adapter, browserProblem, cmtk, manifest, project, serve } from "./helpers.mjs";

const skip = await browserProblem();
const web = { skip, timeout: 180_000 };

const send = (res, html) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); };

/** One page in plain markup, with a date and a price that change. */
const plain = (date, price, { button = true } = {}) => `<!doctype html><html lang="en"><head><title>Shop</title><style>body{font-family:serif}</style></head><body>
<nav aria-label="Main"><a href="/">Home</a> <a href="/basket">Basket</a></nav>
<main><h1>Red jacket</h1><p>Updated ${date}</p><p>Price ${price}</p>
<form><label for="qty">Quantity</label><input id="qty" required value="1">
${button ? "<button type=\"button\">Add to basket</button>" : ""}
<button type="button">Save for later</button></form></main></body></html>`;

/** The same page reskinned: other markup, other wrappers, other colours and layout. The same elements, labels and order. */
const reskin = (date, price) => `<!doctype html><html lang="en"><head><title>Shop</title><style>
body{background:#102030;color:#fff;font:16px sans-serif;display:grid;gap:3em}.c{padding:3em;border:2px solid gold}button{background:gold;border-radius:9px}a{color:gold}</style></head><body>
<div class="c"><nav aria-label="Main"><div><a href="/">Home</a></div><div><a href="/basket">Basket</a></div></nav></div>
<div class="c"><main><div><div><h1 style="font-size:50px">Red jacket</h1></div></div><div>Updated ${date}</div><section><div>Price ${price}</div></section>
<form class="c"><div><label for="qty">Quantity</label></div><div><input id="qty" required value="1"></div>
<div><div><button type="button">Add to basket</button></div></div>
<div><button type="button">Save for later</button></div></form></main></div></body></html>`;

const CASES = `cases:
  - { id: PAGE, surface: web, match: structure, request: GET / }
`;
const SCRUB = `scrub:
  regex:
    - { pattern: "\\\\d{4}-\\\\d{2}-\\\\d{2}" }
    - { pattern: "£[0-9.]+" }
`;
const report = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.json"), "utf8"));

async function compareSites(first, second, more = SCRUB, cases = CASES, files = {}) {
    const [a, b] = [await serve((q, s) => send(s, first)), await serve((q, s) => send(s, second))];
    const dir = project({ "cmtk.yaml": manifest(a.url, b.url, more), "cmtk/cases/page.yaml": cases, ...files });
    try {
        const r = await cmtk(dir, ["compare"]);
        return { ...r, dir, rep: report(dir) };
    } finally {
        await a.close(); await b.close();
    }
}

test("a reskin with the same structure passes at `structure`, though it looks nothing alike", web, async () => {
    const r = await compareSites(plain("2026-11-04", "£49.00"), reskin("2027-01-02", "£55.00"));
    assert.equal(r.rep.verdict, "PARITY", r.stdout + JSON.stringify(r.rep.cases));
    assert.equal(r.status, 0);
    const shots = ["PAGE.reference.json", "PAGE.candidate.json"].map((f) => JSON.parse(fs.readFileSync(path.join(r.dir, "cmtk/evidence/compare/answers", f), "utf8")));
    assert.notEqual(shots[0].screenshots[0].sha256, shots[1].screenshots[0].sha256);
    assert.deepEqual(shots[0].structure.pages[0].elements.filter((e) => e.role === "button").map((e) => e.name), ["Add to basket", "Save for later"]);
    const qty = shots[0].structure.pages[0].elements.find((e) => e.role === "textbox");
    assert.deepEqual(qty, { role: "textbox", name: "Quantity", value: "1", required: true });
});

test("a page with a button missing: only the missing button is reported", web, async () => {
    const r = await compareSites(plain("2026-11-04", "£49.00"), plain("2027-01-02", "£55.00", { button: false }));
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.rep.verdict, "NO PARITY");
    assert.deepEqual(r.rep.cases[0].differences, [{ where: 'structure:/ button "Add to basket"', reference: "(element)", candidate: "(missing)" }]);
});

test("a person can approve that difference as drift, by its where", web, async () => {
    const drift = `drift:\n  - { id: DRIFT-1, case: PAGE, where: 'structure:/ button "Add to basket"', reason: "moved to the next page", approved_by: Jane Smith }\n`;
    const r = await compareSites(plain("2026-11-04", "£49.00"), plain("2026-11-04", "£49.00", { button: false }), SCRUB, CASES, { "cmtk/drift.yaml": drift });
    assert.equal(r.rep.verdict, "DRIFT ONLY", r.stdout);
    assert.equal(r.rep.cases[0].differences[0].drift, "DRIFT-1");
});

test("with no scrub, a date and a price are differences: the scrub is what lets them change", web, async () => {
    const r = await compareSites(plain("2026-11-04", "£49.00"), plain("2027-01-02", "£55.00"), "");
    assert.deepEqual(r.rep.cases[0].differences.map((d) => d.where).sort(), [
        'structure:/ StaticText "Price £49.00"', 'structure:/ StaticText "Price £55.00"', 'structure:/ StaticText "Updated 2026-11-04"', 'structure:/ StaticText "Updated 2027-01-02"',
    ]);
});

test("a screenshot comparison: masks cover what changes, and the look is compared", web, async () => {
    const page = (time, colour = "#fff") => `<!doctype html><html lang="en"><head><title>T</title><style>body{background:${colour}}</style></head><body><h1>Same</h1><p data-testid="clock">${time}</p></body></html>`;
    const cases = (mask) => `cases:\n  - id: LOOK\n    surface: web\n    match: visual\n    request: GET /\n${mask ? "    mask:\n      - { testid: clock }\n" : ""}`;
    const scrub = `scrub:\n  regex:\n    - { pattern: "\\\\d\\\\d:\\\\d\\\\d" }\n`;

    const unmasked = await compareSites(page("10:15"), page("23:48"), scrub, cases(false));
    assert.deepEqual(unmasked.rep.cases[0].differences.map((d) => d.where), ["visual:/"], unmasked.stdout);
    assert.match(unmasked.rep.cases[0].differences[0].candidate, /% of pixels changed, within x \d+, y \d+/);

    const masked = await compareSites(page("10:15"), page("23:48"), scrub, cases(true));
    assert.equal(masked.rep.verdict, "PARITY", JSON.stringify(masked.rep.cases));

    const reskinned = await compareSites(page("10:15"), page("23:48", "#fdd"), scrub, cases(true));
    assert.deepEqual(reskinned.rep.cases[0].differences.map((d) => d.where), ["visual:/"], "a look that changed is still found outside the mask");

    const moved = await compareSites(page("10:15"), reskin("10:15", "x"), scrub, cases(true));
    assert.equal(moved.rep.verdict, "NO PARITY");
    assert.ok(moved.rep.cases[0].differences.some((d) => d.where.startsWith("structure:/")), "visual also compares structure");
});

test("what it can't see, as the README says: text a stylesheet changes reads as a difference, and a frame's content is not read", web, async () => {
    const upper = await compareSites(plain("d", "p"), plain("d", "p").replace("body{font-family:serif}", "button{text-transform:uppercase}"), "");
    assert.ok(upper.rep.cases[0].differences.some((d) => d.where === 'structure:/ button "ADD TO BASKET"'), JSON.stringify(upper.rep.cases[0].differences));
    const site = await serve((req, res) => send(res, req.url === "/inner" ? "<!doctype html><title>i</title><button>Inside</button>" : '<!doctype html><title>t</title><h1>Outer</h1><iframe src="/inner" title="Frame"></iframe>'));
    const a = adapter();
    try {
        const o = await a.run({ id: "p", request: { method: "GET", path: "/" } }, { name: "t", base_url: site.url });
        const names = o.structure.pages[0].elements.map((e) => e.name);
        assert.ok(names.includes("Outer"));
        assert.ok(!names.includes("Inside"), names.join());
    } finally {
        await a.close(); await site.close();
    }
});

test("a page visit is read-only: it sends nothing but reads, whatever the page's own script tries", web, async () => {
    const seen = [];
    const site = await serve((req, res) => {
        seen.push(req.method);
        send(res, `<!doctype html><title>t</title><h1>T</h1><script>fetch("/x",{method:"POST"}).catch(()=>{})</script>`);
    });
    const a = adapter();
    try {
        const o = await a.run({ id: "p", request: { method: "GET", path: "/" } }, { name: "t", base_url: site.url });
        assert.ok(!seen.includes("POST"));
        assert.equal(JSON.parse(o.body).blocked[0].request, "POST /x");
    } finally {
        await a.close(); await site.close();
    }
});

test("a journey's milestones have their structure compared too", web, async () => {
    const site = (button) => serve((req, res) => send(res, `<!doctype html><title>t</title><main><h1>Stop</h1>${button ? "<button>Go</button>" : ""}</main>`));
    const [a, b] = [await site(true), await site(false)];
    const dir = project({
        "cmtk.yaml": manifest(a.url, b.url),
        "cmtk/cases/j.yaml": `cases:
  - id: J
    surface: web
    match: structure
    request: GET /
    journey:
      goal: Reach the stop
      steps:
        - goto: /
        - reach: stop
          see: { role: heading, name: Stop }
        - check: on the stop
          see: { role: heading, name: Stop }
`,
    });
    try {
        await cmtk(dir, ["compare"]);
        const wheres = report(dir).cases[0].differences.map((d) => d.where).sort();
        assert.deepEqual(wheres, ['structure:end button "Go"', 'structure:stop button "Go"']);
    } finally {
        await a.close(); await b.close();
    }
});
