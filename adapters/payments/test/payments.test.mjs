// The payments adapter over its real protocol, against a local stand-in for Stripe's API.
// No Stripe account is used here. The manual run against a real test-mode account is in the README.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { adapter, cmtk, project } from "./helpers.mjs";
import { shop, stripe } from "./standins.mjs";

const KEY_A = "sk_test_planted_account_a_12345", KEY_B = "rk_test_planted_account_b_67890";
const SECRET_A = "whsec_planted_secret_a", SECRET_B = "whsec_planted_secret_b";
const ENV = { KEY_A, KEY_B, SECRET_A, SECRET_B };
const LOOK = { id: "L", request: { method: "GET", path: "/payments" } };
const checkout = (card, extra = {}) => ({ id: "C", request: { method: "POST", path: "/checkout", body: JSON.stringify({ amount: 1999, currency: "gbp", card: `test-card:${card}`, ...extra }) } });

async function world(shopOptions = {}) {
    const api = await stripe({ keys: [KEY_A] });
    const sys = await shop({ stripeUrl: api.url, key: KEY_A, secret: SECRET_A, ...shopOptions });
    const target = { name: "legacy", base_url: sys.url, stripe_api: api.url, key_env: "KEY_A", webhook_secret_env: "SECRET_A", quiet_ms: 30 };
    const a = adapter(ENV);
    return { api, sys, target, a, close: async () => { await a.close(); await sys.close(); await api.close(); } };
}

test("reports a payment and its charge in minor units, with capture mode and metadata, and no ids or times", async () => {
    const w = await world();
    try {
        const { reply, raw } = await w.a.call({ op: "run", case: checkout("visa", { metadata: { order: "A1" } }), target: w.target, headers: {} });
        assert.equal(reply.error, undefined);
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.effects, {
            payment_intents: [{ amount: 1999, amount_received: 1999, currency: "gbp", status: "succeeded", capture_method: "automatic", error_code: null, metadata: { order: "A1" } }],
            charges: [{ amount: 1999, amount_captured: 1999, amount_refunded: 0, currency: "gbp", status: "succeeded", captured: true, refunded: false, failure_code: null, metadata: { order: "A1" } }],
            refunds: [],
        });
        assert.doesNotMatch(raw, /pi_|ch_|secret_|created|client_secret|"id"/);
    } finally { await w.close(); }
});

test("a refund is reported, and only what this case caused counts", async () => {
    const w = await world();
    try {
        await w.a.call({ op: "run", case: checkout("visa"), target: w.target, headers: {} });
        const { reply } = await w.a.call({ op: "run", case: { id: "R", request: { method: "POST", path: "/refund-last", body: null } }, target: w.target, headers: {} });
        assert.deepEqual(reply.effects.payment_intents, [], "the payment came from the case before");
        assert.deepEqual(reply.effects.refunds, [{ amount: 1999, currency: "gbp", status: "succeeded", reason: "requested_by_customer", metadata: {} }]);
    } finally { await w.close(); }
});

test("test cards by name: a declined card, and a 3-D Secure challenge that waits for the customer", async () => {
    const w = await world();
    try {
        let { reply } = await w.a.call({ op: "run", case: checkout("declined"), target: w.target, headers: {} });
        assert.equal(reply.status, 402);
        assert.equal(reply.effects.payment_intents[0].error_code, "card_declined");
        assert.equal(reply.effects.charges[0].failure_code, "card_declined");
        for (const card of ["3ds_required", "3ds_always", "3ds_on_setup"]) {
            ({ reply } = await w.a.call({ op: "run", case: checkout(card), target: w.target, headers: {} }));
            assert.equal(reply.effects.payment_intents[0].status, "requires_action", card);
            assert.deepEqual(reply.effects.charges, []);
        }
        ({ reply } = await w.a.call({ op: "run", case: checkout("no_such_card"), target: w.target, headers: {} }));
        assert.match(reply.error, /no test card called no_such_card/);
    } finally { await w.close(); }
});

test("a card can go in as a number too, for a system with a card form", async () => {
    const seen = [];
    const { listen, json } = await import("./helpers.mjs");
    const api = await stripe({ keys: [KEY_A] });
    const sys = await listen((_q, res, body) => { seen.push(body); json(res, 200, {}); });
    const a = adapter(ENV);
    try {
        await a.call({ op: "run", case: { id: "F", request: { method: "POST", path: "/pay", body_form: { number: "test-card-number:visa", name: "A" } } }, target: { name: "x", base_url: sys.url, stripe_api: api.url, key_env: "KEY_A", quiet_ms: 10 }, headers: {} });
        assert.equal(seen[0], "number=4242424242424242&name=A");
    } finally { await a.close(); await sys.close(); await api.close(); }
});

test("capture mode is reported: a manual capture waits with no money received", async () => {
    const w = await world();
    try {
        const { reply } = await w.a.call({ op: "run", case: checkout("visa", { capture: "manual" }), target: w.target, headers: {} });
        assert.equal(reply.effects.payment_intents[0].capture_method, "manual");
        assert.equal(reply.effects.payment_intents[0].status, "requires_capture");
        assert.equal(reply.effects.payment_intents[0].amount_received, 0);
    } finally { await w.close(); }
});

test("an amount that isn't a whole number of minor units is an error, not a fact", async () => {
    const api = await stripe({ keys: [KEY_A] });
    api.fill(KEY_A, "refunds", [{ id: "re_1", amount: 19.99, currency: "gbp", status: "succeeded", created: Math.floor(Date.now() / 1000), metadata: {} }]);
    const a = adapter(ENV);
    try {
        assert.match((await a.call({ op: "run", case: LOOK, target: { name: "x", stripe_api: api.url, key_env: "KEY_A" }, headers: {} })).reply.error, /not a whole number of minor units/);
        const hook = { id: "W", webhook: { type: "payment_intent.succeeded", object: { amount: 19.99 } }, request: { method: "POST", path: "/h" } };
        assert.match((await a.call({ op: "run", case: hook, target: { name: "x", base_url: api.url, stripe_api: api.url, key_env: "KEY_A", webhook_secret_env: "SECRET_A", window_s: 1 }, headers: {} })).reply.error, /not a whole number/);
    } finally { await a.close(); await api.close(); }
});

test("more objects than one page are all read", async () => {
    const api = await stripe({ keys: [KEY_A] });
    const created = Math.floor(Date.now() / 1000);
    api.fill(KEY_A, "charges", Array.from({ length: 230 }, (_, i) => ({ id: `ch_${i}`, amount: i, currency: "gbp", status: "succeeded", created, metadata: {} })));
    const a = adapter(ENV);
    try {
        const { reply } = await a.call({ op: "run", case: LOOK, target: { name: "x", stripe_api: api.url, key_env: "KEY_A" }, headers: {} });
        assert.equal(reply.effects.charges.length, 230);
    } finally { await a.close(); await api.close(); }
});

test("GET only observes: the system is not contacted, and Stripe gets only reads", async () => {
    const w = await world();
    try {
        const { reply } = await w.a.call({ op: "run", case: LOOK, target: w.target, headers: {} });
        assert.deepEqual(reply.effects, { payment_intents: [], charges: [], refunds: [] });
        assert.equal(w.sys.state.connections, 0);
        assert.ok(w.api.state.requests.every((r) => r.method === "GET"));
        const asGet = await w.a.call({ op: "run", case: { id: "X", webhook: { type: "x" }, request: { method: "GET", path: "/h" } }, target: w.target, headers: {} });
        assert.match(asGet.reply.error, /must be a POST/);
        assert.equal(w.sys.state.connections, 0);
    } finally { await w.close(); }
});

const HOOK = { id: "W", webhook: { type: "payment_intent.succeeded", object: { amount: 1999, currency: "gbp" }, deliveries: 2 }, webhook_observe: "/orders", request: { method: "POST", path: "/stripe/webhook" } };

test("webhooks: signed as Stripe signs them, the duplicate has the same event id, and what each delivery did is reported", async () => {
    const w = await world();
    try {
        const { reply, raw } = await w.a.call({ op: "run", case: HOOK, target: w.target, headers: {} });
        assert.deepEqual(reply.effects.webhooks, [
            { type: "payment_intent.succeeded", delivery: 1, status: 200, observed: { status: 200, body: { fulfilled: 1 } } },
            { type: "payment_intent.succeeded", delivery: 2, status: 200, observed: { status: 200, body: { fulfilled: 1 } } },
        ]);
        assert.doesNotMatch(raw, /evt_|whsec|planted/);
        const posts = w.sys.state.requests.filter((r) => r.method === "POST");
        assert.equal(posts.length, 2);
        assert.equal(JSON.parse(posts[0].body).id, JSON.parse(posts[1].body).id);
        assert.equal(JSON.parse(posts[0].body).livemode, false);
    } finally { await w.close(); }
});

test("webhooks: a wrong signature is delivered too, and refusing it is what's reported", async () => {
    const w = await world();
    try {
        const c = { ...HOOK, webhook: { ...HOOK.webhook, deliveries: 1, signature: "wrong" } };
        const { reply } = await w.a.call({ op: "run", case: c, target: w.target, headers: {} });
        assert.deepEqual(reply.effects.webhooks, [{ type: "payment_intent.succeeded", delivery: 1, status: 400, signature: "wrong", observed: { status: 200, body: { fulfilled: 0 } } }]);
    } finally { await w.close(); }
});

test("describe names the adapter, its kind and its settings; reset says ok with a test key and needs no network", async () => {
    const w = await world();
    try {
        const { reply } = await w.a.call({ op: "describe" });
        assert.equal(reply.name, "payments");
        assert.deepEqual(reply.kinds, ["payments"]);
        assert.ok(reply.settings.some((s) => s.name === "key_env" && s.required));
        assert.deepEqual((await w.a.call({ op: "reset", target: w.target })).reply, { ok: true });
        assert.equal(w.api.state.connections, 0);
    } finally { await w.close(); }
});

const manifest = (a, b) => `system: shop
targets:
  legacy: { base_url: ${a.sys}, stripe_api: ${a.api}, key_env: KEY_A, webhook_secret_env: SECRET_A, quiet_ms: 50 }
  candidate: { base_url: ${b.sys}, stripe_api: ${b.api}, key_env: KEY_B, webhook_secret_env: SECRET_B, quiet_ms: 50 }
reference: legacy
allow_unsafe_methods: true
adapters:
  payments: { command: node, args: [adapters/payments/index.mjs], covers: [payments] }
`;

const CHECKOUT_CASE = `cases:
  - id: PAY-VISA
    surface: payments
    request:
      method: POST
      path: /checkout
      body: { amount: 1999, currency: gbp, card: "test-card:visa", metadata: { order: A1 } }
`;

const WEBHOOK_CASE = `cases:
  - id: PAY-HOOK
    surface: payments
    webhook: { type: payment_intent.succeeded, object: { amount: 1999, currency: gbp }, deliveries: 2 }
    webhook_observe: /orders
    request: { method: POST, path: /stripe/webhook }
`;

async function twoSystems(cases, candidateOptions) {
    const apiA = await stripe({ keys: [KEY_A] }), apiB = await stripe({ keys: [KEY_B] });
    const sysA = await shop({ stripeUrl: apiA.url, key: KEY_A, secret: SECRET_A });
    const sysB = await shop({ stripeUrl: apiB.url, key: KEY_B, secret: SECRET_B, ...candidateOptions });
    const dir = project(manifest({ sys: sysA.url, api: apiA.url }, { sys: sysB.url, api: apiB.url }), cases);
    return { dir, compare: () => cmtk(dir, ENV, "compare", "--allow-unsafe"), report: () => fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8"),
        close: async () => { await sysA.close(); await sysB.close(); await apiA.close(); await apiB.close(); } };
}

test("the conformance kit passes through the real CLI, against the stand-in for Stripe", async () => {
    const api = await stripe({ keys: [KEY_A] });
    const sys = await shop({ stripeUrl: api.url, key: KEY_A, secret: SECRET_A });
    const dir = project(`system: shop\ntargets:\n  legacy: { base_url: ${sys.url}, stripe_api: ${api.url}, key_env: KEY_A, webhook_secret_env: SECRET_A, quiet_ms: 50 }\nadapters:\n  payments: { command: node, args: [adapters/payments/index.mjs] }\n`);
    try {
        const r = await cmtk(dir, ENV, "adapter", "check", "payments", "--target", "legacy");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Adapter payments passes the conformance kit/);
        for (const id of ["PAY-001", "PAY-002", "PAY-003", "PAY-004"]) assert.match(r.stdout, new RegExp(`pass {2}${id}: the same case twice`));
    } finally { await sys.close(); await api.close(); }
});

test("cmtk compare: two systems' same payments match, with each on its own account", async () => {
    const t = await twoSystems(CHECKOUT_CASE);
    try {
        const r = await t.compare();
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /verdict for shop: PARITY/);
    } finally { await t.close(); }
});

test("cmtk compare: a planted one-penny difference in the amount is caught", async () => {
    const t = await twoSystems(CHECKOUT_CASE, { amountChange: 1 });
    try {
        const r = await t.compare();
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /NO PARITY/);
        assert.match(t.report(), /effects:\$\.payment_intents\[0\]\.amount/);
        assert.match(t.report(), /1999/);
        assert.match(t.report(), /2000/);
    } finally { await t.close(); }
});

test("cmtk compare: two systems that both ignore a duplicate webhook match", async () => {
    const t = await twoSystems(WEBHOOK_CASE);
    try {
        const r = await t.compare();
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /verdict for shop: PARITY/);
    } finally { await t.close(); }
});

test("cmtk compare: a system that fulfils an order twice on a duplicate webhook is caught", async () => {
    const t = await twoSystems(WEBHOOK_CASE, { idempotent: false });
    try {
        const r = await t.compare();
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /NO PARITY/);
        // The first delivery is the same on both. The second is where they part.
        assert.match(t.report(), /effects:\$\.webhooks\[1\]\.observed\.body\.fulfilled/);
        assert.doesNotMatch(t.report(), /webhooks\[0\]/);
    } finally { await t.close(); }
});
