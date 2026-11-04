// docs/TEST-PLAN.md, "Sandboxes only for money and messages": a payment adapter refuses live keys,
// such as sk_live_, before any network call, and no part of a key is ever printed. These must always pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { adapter, ADAPTER_DIR, allText, cmtk, json, listen, project } from "./helpers.mjs";
import { shop, stripe } from "./standins.mjs";

// Every planted key ends in a mark that can be searched for wherever it might have leaked.
const MARK = "PLANTEDKEYTAIL";
const TEST_KEY = `sk_test_${MARK}`;
const REFUSED_KEYS = {
    "a live secret key": `sk_live_${MARK}`,
    "a live restricted key": `rk_live_${MARK}`,
    "a live key with a space in front": ` sk_live_${MARK}`,
    "a live key in capitals": `SK_LIVE_${MARK}`,
    "a live publishable key": `pk_live_${MARK}`,
    "a test publishable key": `pk_test_${MARK}`,
    "something that isn't a key": `hello${MARK}`,
    "a test key with a line break, which fetch would quote in an error": `sk_test_${MARK}\nx`,
};
const POST = { id: "P", request: { method: "POST", path: "/checkout", body: { amount: 100, currency: "gbp", card: "test-card:visa" } } };
const GET = { id: "G", request: { method: "GET", path: "/payments" } };
const HOOK = { id: "W", webhook: { type: "x" }, request: { method: "POST", path: "/stripe/webhook" } };

const noPartOfAKey = (text) => {
    assert.ok(!text.includes(MARK), "the key's tail");
    assert.doesNotMatch(text, /[sr]k_live_|pk_live_/i, "the key's start");
};

for (const [what, key] of Object.entries(REFUSED_KEYS)) {
    test(`safety: ${what} is refused before any network call, for every kind of case and for reset, and no part of it is printed`, async () => {
        const api = await listen((_q, res) => json(res, 200, { data: [] }));
        const sys = await listen((_q, res) => json(res, 200, {}));
        const a = adapter({ STRIPE_KEY: key, WH: "whsec_x" });
        try {
            const target = { name: "x", base_url: sys.url, stripe_api: api.url, key_env: "STRIPE_KEY", webhook_secret_env: "WH" };
            for (const c of [POST, GET, HOOK]) {
                const { reply, raw } = await a.call({ op: "run", case: c, target, headers: {} });
                assert.match(reply.error, /not a Stripe test-mode key/);
                assert.equal(reply.effects, undefined);
                noPartOfAKey(raw);
            }
            const r = await a.call({ op: "reset", target });
            assert.equal(r.reply.ok, false);
            noPartOfAKey(r.raw);
            assert.equal(api.state.connections, 0, "no connection to Stripe's address");
            assert.equal(sys.state.connections, 0, "no connection to the system");
            noPartOfAKey(a.stderr());
        } finally { await a.close(); await api.close(); await sys.close(); }
    });
}

test("safety: a live key anywhere else in the request stops the case too, before any network call", async () => {
    const api = await stripe({ keys: [TEST_KEY] });
    const sys = await listen((_q, res) => json(res, 200, {}));
    const a = adapter({ STRIPE_KEY: TEST_KEY });
    const target = { name: "x", base_url: sys.url, stripe_api: api.url, key_env: "STRIPE_KEY" };
    try {
        const ways = [
            { case: POST, target, headers: { Authorization: `Bearer sk_live_${MARK}` } },
            { case: { ...POST, request: { ...POST.request, body: { key: `rk_live_${MARK}` } } }, target, headers: {} },
            { case: POST, target: { ...target, note: `sk_live_${MARK}` }, headers: {} },
        ];
        for (const w of ways) {
            const { reply, raw } = await a.call({ op: "run", ...w });
            assert.match(reply.error, /live Stripe key/);
            noPartOfAKey(raw);
        }
        assert.equal(api.state.connections, 0);
        assert.equal(sys.state.connections, 0);
    } finally { await a.close(); await api.close(); await sys.close(); }
});

test("safety: a key of any kind written in a case or the settings is refused: keys come only from the environment", async () => {
    const api = await stripe({ keys: [TEST_KEY] });
    const a = adapter({ STRIPE_KEY: TEST_KEY });
    const target = { name: "x", stripe_api: api.url, key_env: "STRIPE_KEY" };
    try {
        for (const w of [{ case: GET, target: { ...target, key: TEST_KEY } }, { case: { ...GET, note: "whsec_abc123" }, target }]) {
            const { reply, raw } = await a.call({ op: "run", ...w, headers: {} });
            assert.match(reply.error, /only from the environment/);
            assert.ok(!raw.includes(MARK));
        }
        assert.match((await a.call({ op: "run", case: GET, target: { ...target, key_env: undefined }, headers: {} })).reply.error, /key_env/);
        assert.match((await a.call({ op: "run", case: GET, target: { ...target, key_env: "NOT_SET_ANYWHERE" }, headers: {} })).reply.error, /NOT_SET_ANYWHERE is not set/);
        assert.equal(api.state.connections, 0);
    } finally { await a.close(); await api.close(); }
});

test("safety: a rejected test key isn't printed, though Stripe's own error quotes part of it", async () => {
    const api = await stripe({ keys: ["sk_test_some_other_account"] });
    const a = adapter({ STRIPE_KEY: TEST_KEY });
    try {
        const { reply, raw } = await a.call({ op: "run", case: GET, target: { name: "x", stripe_api: api.url, key_env: "STRIPE_KEY" }, headers: {} });
        assert.match(reply.error, /Stripe answered 401/);
        assert.ok(!raw.includes(MARK.slice(-4)), "not even the last four characters");
        assert.doesNotMatch(raw, /sk_test|Invalid API Key/);
    } finally { await a.close(); await api.close(); }
});

test("safety: an object Stripe marks as live stops the run", async () => {
    const api = await stripe({ keys: [TEST_KEY], liveObjects: true });
    api.fill(TEST_KEY, "charges", [{ id: "ch_1", amount: 1, currency: "gbp", status: "succeeded", created: Math.floor(Date.now() / 1000), metadata: {} }]);
    const a = adapter({ STRIPE_KEY: TEST_KEY });
    try {
        const { reply } = await a.call({ op: "run", case: GET, target: { name: "x", stripe_api: api.url, key_env: "STRIPE_KEY" }, headers: {} });
        assert.match(reply.error, /marked charges as live/);
    } finally { await a.close(); await api.close(); }
});

test("safety: a key goes only over https or to this machine, and never follows a redirect", async () => {
    const elsewhere = await listen((_q, res) => json(res, 200, { data: [] }));
    const redirecting = await listen((_q, res) => { res.writeHead(307, { location: `${elsewhere.url}/v1/charges` }); res.end(); });
    const a = adapter({ STRIPE_KEY: TEST_KEY });
    try {
        const plain = await a.call({ op: "run", case: GET, target: { name: "x", stripe_api: "http://stripe.example.test", key_env: "STRIPE_KEY" }, headers: {} });
        assert.match(plain.reply.error, /must be https/);
        const moved = await a.call({ op: "run", case: GET, target: { name: "x", stripe_api: redirecting.url, key_env: "STRIPE_KEY" }, headers: {} });
        assert.match(moved.reply.error, /Stripe answered 307/);
        assert.equal(elsewhere.state.connections, 0, "the key did not go to the other address");
    } finally { await a.close(); await elsewhere.close(); await redirecting.close(); }
});

test("safety: through the real CLI a live key gives no evidence, reaches nothing, and is on no disk or output", async () => {
    const api = await listen((_q, res) => json(res, 200, { data: [] }));
    const sys = await listen((_q, res) => json(res, 200, {}));
    const dir = project(`system: shop
targets:
  legacy: { base_url: ${sys.url}, stripe_api: ${api.url}, key_env: LEGACY_KEY }
  candidate: { base_url: ${sys.url}, stripe_api: ${api.url}, key_env: CANDIDATE_KEY }
reference: legacy
allow_unsafe_methods: true
adapters:
  payments: { command: node, args: [adapters/payments/index.mjs] }
`, `cases:
  - id: PAY
    surface: payments
    request: { method: POST, path: /checkout, body: { amount: 100, currency: gbp, card: "test-card:visa" } }
`);
    try {
        const r = await cmtk(dir, { LEGACY_KEY: `sk_live_${MARK}`, CANDIDATE_KEY: `rk_live_${MARK}` }, "compare", "--allow-unsafe");
        assert.notEqual(r.status, 0);
        assert.doesNotMatch(r.stdout, /verdict for shop: PARITY/);
        assert.match(r.stdout, /NO EVIDENCE/);
        assert.equal(api.state.connections, 0);
        assert.equal(sys.state.connections, 0);
        noPartOfAKey(r.stdout + r.stderr + allText(dir));
    } finally { await api.close(); await sys.close(); }
});

test("safety: a test key and a webhook secret reach no output or file on a run that works", async () => {
    const SECRET = `whsec_${MARK}`;
    const api = await stripe({ keys: [TEST_KEY] });
    const sys = await shop({ stripeUrl: api.url, key: TEST_KEY, secret: SECRET });
    const settings = `{ base_url: ${sys.url}, stripe_api: ${api.url}, key_env: A_KEY, webhook_secret_env: A_SECRET, quiet_ms: 20 }`;
    const dir = project(`system: shop\ntargets:\n  legacy: ${settings}\n  candidate: ${settings}\nreference: legacy\nallow_unsafe_methods: true\nadapters:\n  payments: { command: node, args: [adapters/payments/index.mjs] }\n`, `cases:
  - id: PAY
    surface: payments
    request: { method: POST, path: /checkout, body: { amount: 100, currency: gbp, card: "test-card:visa" } }
  - id: HOOK
    surface: payments
    webhook: { type: payment_intent.succeeded, deliveries: 2 }
    request: { method: POST, path: /stripe/webhook }
`);
    try {
        const r = await cmtk(dir, { A_KEY: TEST_KEY, A_SECRET: SECRET }, "compare", "--allow-unsafe");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.ok(!(r.stdout + r.stderr + allText(dir)).includes(MARK));
    } finally { await sys.close(); await api.close(); }
});

test("safety: POST needs both switches, so without them Stripe and the system are not touched", async () => {
    const api = await stripe({ keys: [TEST_KEY] });
    const sys = await shop({ stripeUrl: api.url, key: TEST_KEY, secret: "whsec_x" });
    const settings = `{ base_url: ${sys.url}, stripe_api: ${api.url}, key_env: A_KEY }`;
    const cases = `cases:\n  - id: PAY\n    surface: payments\n    request: { method: POST, path: /checkout, body: { amount: 100, currency: gbp, card: "test-card:visa" } }\n`;
    const adapters = `adapters:\n  payments: { command: node, args: [adapters/payments/index.mjs] }\n`;
    try {
        for (const [yaml, flags] of [["allow_unsafe_methods: true\n", []], ["", ["--allow-unsafe"]]]) {
            const dir = project(`system: shop\ntargets:\n  legacy: ${settings}\n  candidate: ${settings}\nreference: legacy\n${yaml}${adapters}`, cases);
            const r = await cmtk(dir, { A_KEY: TEST_KEY }, "compare", ...flags);
            assert.match(r.stdout, /skipped/i, r.stdout + r.stderr);
        }
        assert.equal(api.state.connections, 0);
        assert.equal(sys.state.connections, 0);
    } finally { await sys.close(); await api.close(); }
});

test("safety: no proxy, even with proxy environment variables and Node's proxy switch on", async () => {
    const proxy = await listen((_q, res) => json(res, 200, { data: [] }));
    const api = await stripe({ keys: [TEST_KEY] });
    const a = adapter({ STRIPE_KEY: TEST_KEY, HTTP_PROXY: proxy.url, http_proxy: proxy.url, HTTPS_PROXY: proxy.url, https_proxy: proxy.url, NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" });
    try {
        const { reply } = await a.call({ op: "run", case: GET, target: { name: "x", stripe_api: api.url, key_env: "STRIPE_KEY" }, headers: {} });
        assert.equal(proxy.state.connections, 0, "the key did not go through the proxy");
        assert.deepEqual(reply.effects?.charges, [], JSON.stringify(reply));
    } finally { await a.close(); await proxy.close(); await api.close(); }
});

test("safety: the adapter imports only Node's own modules and its own runtime, and each adapter has the same runtime", () => {
    for (const f of ["index.mjs", "runtime.mjs"]) {
        for (const m of fs.readFileSync(path.join(ADAPTER_DIR, f), "utf8").matchAll(/from "([^"]+)"/g)) assert.ok(m[1].startsWith("node:") || m[1] === "./runtime.mjs", `${f} imports ${m[1]}`);
    }
    const own = fs.readFileSync(path.join(ADAPTER_DIR, "runtime.mjs"), "utf8");
    for (const other of ["mailbox", "sms"]) assert.equal(fs.readFileSync(path.join(ADAPTER_DIR, "..", other, "runtime.mjs"), "utf8"), own, `adapters/${other}/runtime.mjs has drifted`);
});
