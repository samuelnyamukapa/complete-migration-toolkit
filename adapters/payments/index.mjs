#!/usr/bin/env node
// The payments adapter: reports the payments, charges and refunds a case caused in a Stripe
// test-mode account, and how the system handled Stripe's webhooks, duplicates included. Stripe's
// live and test traffic share one address, so the key is what decides: anything but a test-mode key
// is refused before any network call. No part of a key is ever printed.
// Docs: README.md here, and docs/ADAPTERS.md.
import crypto from "node:crypto";

import { address, direct, jsonFrom, millis, Refusal, refuseUnsupported, safeForCredentials, SAFE_METHODS, scrubber, sendToSystem, serve, settle, under } from "./runtime.mjs";

const PAGE = 100;
const MOST_OBJECTS = 10_000;
const LIVE_KEY = /(?:sk|rk)_live_/;
const ANY_KEY = /(?:sk|rk)_(?:live|test)_|whsec_/;

// ---- Keys ----

const keysSeen = new Set();

/** The value of an environment variable a target names. Keys come only from the environment. */
function fromEnvironment(target, setting) {
    const name = target?.[setting];
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Refusal(`target ${target?.name} needs ${setting}: the name of an environment variable. Keys come only from the environment`);
    const value = process.env[name];
    if (!value) throw new Refusal(`the environment variable ${name} is not set`);
    keysSeen.add(value);
    return { name, value };
}

/** Only a well-formed test-mode key passes. The refusal says nothing about what the key holds. */
function testKey(target) {
    const { name, value } = fromEnvironment(target, "key_env");
    if (!/^(?:sk|rk)_test_[A-Za-z0-9_]+$/.test(value)) throw new Refusal(`the key in ${name} is not a Stripe test-mode key, so it is refused before any network call. Sandboxes only: use a secret or restricted test-mode key`);
    return value;
}

/** A live key anywhere in what was asked for stops everything; a key of any kind in a file's settings or a case does too. */
function refuseKeysIn(c, target, headers) {
    if (LIVE_KEY.test(JSON.stringify({ c, target, headers }))) throw new Refusal("a live Stripe key was passed to this adapter, so it is refused before any network call");
    if (ANY_KEY.test(JSON.stringify({ c, target }))) throw new Refusal("a Stripe key is written in a case or in the target's settings. Keys come only from the environment");
}

// ---- Stripe's test cards, by name ----

/** Stripe's published test cards: the PaymentMethod to use from a server, and the number for a form. */
const TEST_CARDS = {
    visa: { pm: "pm_card_visa", number: "4242424242424242" },
    mastercard: { pm: "pm_card_mastercard", number: "5555555555554444" },
    amex: { pm: "pm_card_amex", number: "378282246310005" },
    declined: { pm: "pm_card_visa_chargeDeclined", number: "4000000000000002" },
    insufficient_funds: { pm: "pm_card_visa_chargeDeclinedInsufficientFunds", number: "4000000000009995" },
    // 3-D Secure challenges.
    "3ds_required": { pm: "pm_card_threeDSecure2Required", number: "4000000000003220" },
    "3ds_always": { pm: "pm_card_authenticationRequired", number: "4000002760003184" },
    "3ds_on_setup": { pm: "pm_card_authenticationRequiredOnSetup", number: "4000002500003155" },
};

/** Puts each `test-card:visa` or `test-card-number:visa` in a value into what it names. */
function withCards(value) {
    if (typeof value === "string") {
        const m = /^test-card(-number)?:(.+)$/.exec(value);
        if (!m) return value;
        const card = TEST_CARDS[m[2]];
        if (!card) throw new Refusal(`there is no test card called ${m[2]}. The names are ${Object.keys(TEST_CARDS).join(", ")}`);
        return m[1] ? card.number : card.pm;
    }
    if (Array.isArray(value)) return value.map(withCards);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withCards(v)]));
    return value;
}

function caseWithCards(c) {
    const request = { ...c.request };
    if (typeof request.body === "string") {
        // A mapping in a case file arrives as JSON text.
        let parsed;
        try { parsed = JSON.parse(request.body); } catch { parsed = undefined; }
        if (parsed !== undefined) request.body = JSON.stringify(withCards(parsed));
    } else if (request.body) request.body = withCards(request.body);
    if (request.body_form) request.body_form = withCards(request.body_form);
    return { ...c, request };
}

// ---- Reading the test-mode account ----

function minor(o, fields, what) {
    for (const f of fields) if (o[f] !== undefined && o[f] !== null && !Number.isInteger(o[f])) throw new Refusal(`${what}: ${f} is not a whole number of minor units`);
    return o;
}

const LISTS = {
    payment_intents: {
        path: "/v1/payment_intents",
        fact: (o) => minor({ amount: o.amount, amount_received: o.amount_received ?? null, currency: o.currency, status: o.status, capture_method: o.capture_method ?? null, error_code: o.last_payment_error?.code ?? null, metadata: o.metadata ?? {} }, ["amount", "amount_received"], "a payment"),
    },
    charges: {
        path: "/v1/charges",
        fact: (o) => minor({ amount: o.amount, amount_captured: o.amount_captured ?? null, amount_refunded: o.amount_refunded ?? null, currency: o.currency, status: o.status, captured: o.captured ?? null, refunded: o.refunded ?? null, failure_code: o.failure_code ?? null, metadata: o.metadata ?? {} }, ["amount", "amount_captured", "amount_refunded"], "a charge"),
    },
    refunds: {
        path: "/v1/refunds",
        fact: (o) => minor({ amount: o.amount, currency: o.currency, status: o.status, reason: o.reason ?? null, metadata: o.metadata ?? {} }, ["amount"], "a refund"),
    },
};

/** Every object of one kind created in the window, each page of it, or an error: never part of a list. */
async function listAll(api, key, kind, since) {
    const all = [];
    let after;
    for (;;) {
        const q = new URLSearchParams({ limit: String(PAGE), "created[gte]": String(since) });
        if (after) q.set("starting_after", after);
        const res = await direct(under(api, `${LISTS[kind].path}?${q}`), { headers: { authorization: `Bearer ${key}` } }, "Stripe");
        if (!res.ok) {
            // Stripe's error text can quote part of the key, so only its type is kept.
            const type = (await res.json().catch(() => null))?.error?.type;
            throw new Refusal(`Stripe answered ${res.status}${typeof type === "string" && /^[a-z_]+$/.test(type) ? ` (${type})` : ""} when listing ${kind}`);
        }
        const page = await res.json().catch(() => null);
        if (!Array.isArray(page?.data)) throw new Refusal(`Stripe's list of ${kind} has no \`data\``);
        // The last check that this really is a sandbox: anything marked live stops the run.
        if (page.data.some((o) => o.livemode === true)) throw new Refusal(`Stripe marked ${kind} as live, so this adapter stopped. Sandboxes only`);
        all.push(...page.data);
        if (all.length > MOST_OBJECTS) throw new Refusal(`more than ${MOST_OBJECTS} ${kind} in the window; shorten window_s`);
        if (!page.has_more || page.data.length === 0) return all;
        after = page.data[page.data.length - 1].id;
    }
}

const inOrder = (l) => [...l].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function readAccount(api, key, since, before) {
    const out = {};
    for (const kind of Object.keys(LISTS)) {
        const objects = await listAll(api, key, kind, since);
        out[kind] = objects.filter((o) => !before?.has(o.id));
    }
    return out;
}

const factsOf = (found) => Object.fromEntries(Object.keys(LISTS).map((kind) => [kind, inOrder(found[kind].map(LISTS[kind].fact))]));

// ---- Webhooks ----

function sign(secret, payload, timestamp, wrong) {
    const signature = crypto.createHmac("sha256", wrong ? `${secret}-wrong` : secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
    return `t=${timestamp},v1=${signature}`;
}

/**
 * Sends each event the case names, signed as Stripe signs them, `deliveries` times with the same
 * event id: a second delivery is the duplicate Stripe's documentation says a system must expect.
 * After each one, `observe` is read from the system. Reports what happened, not the ids.
 */
async function deliverWebhooks(c, target, headers) {
    const events = Array.isArray(c.webhook) ? c.webhook : [c.webhook];
    if (c.request.method !== "POST") throw new Refusal("a case with `webhook` must be a POST: delivering one changes the system");
    const { value: secret } = fromEnvironment(target, "webhook_secret_env");
    if (!/^whsec_[A-Za-z0-9_+/=-]+$/.test(secret)) throw new Refusal("the webhook secret in the environment is not in the expected form");
    const base = address(target, "base_url");
    const observed = c.webhook_observe;
    const report = [];
    for (const ev of events) {
        if (typeof ev?.type !== "string") throw new Refusal("each webhook event needs a `type`, such as payment_intent.succeeded");
        const object = { id: `pi_cmtk_${crypto.randomBytes(8).toString("hex")}`, livemode: false, ...(ev.object ?? {}) };
        minor(object, ["amount", "amount_received", "amount_refunded", "amount_captured"], "a webhook event");
        const created = Math.floor(Date.now() / 1000);
        // A fresh id per run, so a system that remembers events isn't fooled by an earlier run; the same id for each delivery.
        const payload = JSON.stringify({ id: `evt_cmtk_${crypto.randomBytes(12).toString("hex")}`, object: "event", api_version: "2024-06-20", created, type: ev.type, livemode: false, pending_webhooks: 1, request: null, data: { object } });
        const deliveries = ev.deliveries ?? 1;
        if (!Number.isInteger(deliveries) || deliveries < 1 || deliveries > 5) throw new Refusal("a webhook event's `deliveries` must be from 1 to 5");
        for (let delivery = 1; delivery <= deliveries; delivery++) {
            const h = { ...(c.request.headers ?? {}), ...headers, "content-type": "application/json", "stripe-signature": sign(secret, payload, Math.floor(Date.now() / 1000), ev.signature === "wrong") };
            const res = await direct(under(base, c.request.path), { method: "POST", headers: h, body: payload }, `target ${target.name}`);
            await res.arrayBuffer().catch(() => undefined);
            const row = { type: ev.type, delivery, status: res.status, ...(ev.signature === "wrong" ? { signature: "wrong" } : {}) };
            if (observed !== undefined) row.observed = await observe(base, observed, target, headers);
            report.push(row);
        }
    }
    return report;
}

/** A read from the system after a delivery, to see what the delivery did. */
async function observe(base, path, target, headers) {
    const res = await direct(under(base, path), { headers }, `target ${target.name}`);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* left as text */ }
    return { status: res.status, body };
}

// ---- The protocol ----

const describe = () => ({
    name: "payments",
    kinds: ["payments"],
    settings: [
        { name: "stripe_api", description: "Stripe's API for this target: https://api.stripe.com", required: true },
        { name: "key_env", description: "The name of the environment variable holding this system's test-mode key", required: true },
        { name: "base_url", description: "The system itself, which POST, PUT, PATCH and DELETE cases and webhooks are sent to" },
        { name: "webhook_secret_env", description: "The name of the environment variable holding the secret the system checks webhooks with" },
        { name: "window_s", description: "How far back the account is read, in seconds. Default 3600" },
        { name: "quiet_ms", description: "The account has settled when nothing changed for this long. Default 1000" },
        { name: "max_wait_ms", description: "Give up, with an error, if the account is still changing after this long. Default 15000" },
    ],
});

function apiOf(target) {
    const api = address(target, "stripe_api");
    if (!safeForCredentials(api)) throw new Refusal("stripe_api must be https, or http on this machine: keys are not sent in the clear");
    return api;
}

async function run(c, target, headers) {
    // Everything that can refuse comes before anything that can reach the network.
    refuseKeysIn(c, target, headers);
    refuseUnsupported(c);
    const key = testKey(target);
    const api = apiOf(target);
    const windowS = target.window_s ?? 3600;
    if (!Number.isInteger(windowS) || windowS <= 0) throw new Refusal(`target ${target.name}: window_s must be a whole number of seconds`);
    const since = Math.floor(Date.now() / 1000) - windowS;

    if (SAFE_METHODS.has(c.request.method)) {
        if (c.webhook !== undefined) throw new Refusal("a case with `webhook` must be a POST: delivering one changes the system");
        // Observing only: the system is not contacted, and nothing is sent to Stripe but reads.
        return { status: 200, headers: {}, effects: factsOf(await readAccount(api, key, since)) };
    }

    // Stripe keeps everything, so only what this case caused counts: what was there before is left out.
    const existing = await readAccount(api, key, since);
    const before = new Set(Object.values(existing).flat().map((o) => o.id));
    let status;
    let webhooks;
    if (c.webhook !== undefined) {
        webhooks = await deliverWebhooks(c, target, headers);
        status = webhooks[0].status;
    } else {
        status = await sendToSystem(caseWithCards(c), target, headers);
    }
    const quiet = millis(target, "quiet_ms", 1000);
    const most = millis(target, "max_wait_ms", 15_000);
    const found = await settle(async () => factsOf(await readAccount(api, key, since, before)), quiet, most, "the account was");
    return { status, headers: {}, effects: { ...found, ...(webhooks ? { webhooks } : {}) } };
}

/** Stripe has no way to empty an account, and doesn't need one: `run` reports only what a case caused. A live key is still refused here. */
async function reset(target) {
    refuseKeysIn({}, target, {});
    testKey(target);
    apiOf(target);
    return { ok: true };
}

await serve({ describe, run, reset }, scrubber(() => [...keysSeen]));
