// A credential a page shows must leave nothing behind in the reply: not a long token's first 500 characters, and
// not the token without its scheme. The page text is checked as the adapter returns it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { adapter, browserProblem, serve } from "./helpers.mjs";

const skip = await browserProblem();
const web = { skip, timeout: 120_000 };

const LONG = `Tk${"a1b2c3d4e5".repeat(80)}END`;
const pageWith = (text) => serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>T</title><h1>Your account</h1><p data-testid="x">${text}</p><button>${text}</button>`);
});

/** Every run of 12 or more characters from the token that still appears in the reply. */
const pieces = (reply, token) => {
    const text = JSON.stringify(reply);
    const found = [];
    for (let i = 0; i + 12 <= token.length; i += 6) if (text.includes(token.slice(i, i + 12))) found.push(i);
    return found;
};

async function visit(page, headers, journey) {
    const a = adapter();
    try {
        const c = journey ? { id: "J", request: { method: "POST", path: "/" }, journey } : { id: "P", request: { method: "GET", path: "/" } };
        return await a.run(c, { name: "legacy", base_url: page.url }, headers);
    } finally {
        await a.close();
        await page.close();
    }
}

const READ = { goal: "Read it", steps: [{ goto: "/" }, { read: "v", from: { testid: "x" } }, { check: "shown", value: "v" }] };

test("a long token shown on a page leaves none of itself, though text is cut to 500 characters", web, async () => {
    const o = await visit(await pageWith(`Bearer ${LONG}`), { authorization: `Bearer ${LONG}` });
    assert.deepEqual(pieces(o, LONG), []);
    assert.match(o.body, /<secret authorization>/);
});

test("a long token read by a journey leaves none of itself", web, async () => {
    const o = await visit(await pageWith(`Bearer ${LONG}`), { authorization: `Bearer ${LONG}` }, READ);
    assert.deepEqual(pieces(o, LONG), []);
    assert.match(o.journey.values.v, /<secret authorization>/);
});

test("a token shown without its Bearer prefix is replaced too", web, async () => {
    const o = await visit(await pageWith(`token: bare-token-value-123456`), { authorization: "Bearer bare-token-value-123456" });
    assert.ok(!JSON.stringify(o).includes("bare-token-value-123456"), o.body);
});

test("basic credentials are replaced however a page shows them", web, async () => {
    const encoded = Buffer.from("sam:a-long-password-here").toString("base64");
    const o = await visit(await pageWith(`${encoded} sam:a-long-password-here and a-long-password-here`), { authorization: `Basic ${encoded}` });
    const text = JSON.stringify(o);
    assert.ok(!text.includes(encoded), "the encoded form");
    assert.ok(!text.includes("a-long-password-here"), "the decoded form");
});

test("a value typed from the environment that is longer than the cut leaves none of itself", web, async () => {
    process.env.CMTK_TEST_LONG_VALUE = LONG;
    const page = await serve((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>T</title><label>F <input aria-label="F" oninput="document.getElementById('x').textContent=this.value"></label><p id="x" data-testid="x"></p>`);
    });
    const a = adapter({ CMTK_TEST_LONG_VALUE: LONG });
    try {
        const journey = { goal: "Type it", steps: [{ goto: "/" }, { fill: { label: "F" }, with_env: "CMTK_TEST_LONG_VALUE" }, { read: "v", from: { testid: "x" } }, { check: "shown", value: "v" }] };
        const o = await a.run({ id: "J", request: { method: "POST", path: "/" }, journey }, { name: "legacy", base_url: page.url });
        assert.deepEqual(pieces(o, LONG), []);
    } finally {
        await a.close();
        await page.close();
    }
});

test("ordinary page text longer than the cut is still cut, and text that is not a secret stays", web, async () => {
    const o = await visit(await pageWith(`keep-this ${"x".repeat(900)}`), { authorization: "Bearer another-token-1234567" });
    const el = JSON.parse(o.body).elements.find((e) => e.role === "button");
    assert.match(el.name, /^keep-this x+$/);
    assert.ok(el.name.length <= 500);
});
