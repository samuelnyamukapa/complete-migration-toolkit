// A local stand-in for Stripe's API in test mode, and a small system that uses it. Stripe's API
// takes form-encoded bodies and a Bearer key, lists as { object: "list", url, has_more, data } newest
// first, and answers a bad key with a message quoting part of it. A live key must never arrive here.
import crypto from "node:crypto";

import { json, listen } from "./helpers.mjs";

const OUTCOME = {
    pm_card_visa: "ok", pm_card_mastercard: "ok", pm_card_amex: "ok",
    pm_card_visa_chargeDeclined: "declined", pm_card_visa_chargeDeclinedInsufficientFunds: "insufficient_funds",
    pm_card_threeDSecure2Required: "3ds", pm_card_authenticationRequired: "3ds", pm_card_authenticationRequiredOnSetup: "3ds",
};

const rid = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

function metadataOf(form) {
    const metadata = {};
    for (const [k, v] of form) {
        const m = /^metadata\[(.+)\]$/.exec(k);
        if (m) metadata[m[1]] = v;
    }
    return metadata;
}

/** `keys` lists the test-mode keys of the accounts it knows. Each key has its own account. */
export async function stripe({ keys, liveObjects = false }) {
    const accounts = new Map(keys.map((k) => [k, { payment_intents: [], charges: [], refunds: [] }]));
    const seenKeys = new Set();
    const server = await listen((req, res, body) => {
        const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        seenKeys.add(key);
        const account = accounts.get(key);
        if (!account) {
            return json(res, 401, { error: { type: "invalid_request_error", code: "api_key_invalid", message: `Invalid API Key provided: ${key.slice(0, 8)}****${key.slice(-4)}`, doc_url: "https://docs.stripe.com/keys" } });
        }
        const u = new URL(req.url, "http://x");
        const list = /^\/v1\/(payment_intents|charges|refunds)$/.exec(u.pathname);
        if (req.method === "GET" && list) {
            const kind = list[1];
            const since = Number(u.searchParams.get("created[gte]") ?? 0);
            const limit = Number(u.searchParams.get("limit") ?? 10);
            let rows = [...account[kind]].reverse().filter((o) => o.created >= since);
            const after = u.searchParams.get("starting_after");
            if (after) rows = rows.slice(rows.findIndex((o) => o.id === after) + 1);
            return json(res, 200, { object: "list", url: u.pathname, has_more: rows.length > limit, data: rows.slice(0, limit).map((o) => (liveObjects ? { ...o, livemode: true } : o)) });
        }
        if (req.method === "POST" && u.pathname === "/v1/payment_intents") {
            const form = new URLSearchParams(body);
            const amount = form.get("amount");
            if (!/^\d+$/.test(amount ?? "")) return json(res, 400, { error: { type: "invalid_request_error", code: "parameter_invalid_integer", param: "amount", message: "Invalid integer" } });
            const currency = form.get("currency");
            const method = form.get("capture_method") ?? "automatic";
            const pmName = form.get("payment_method");
            const outcome = OUTCOME[pmName];
            if (!outcome) return json(res, 400, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such PaymentMethod" } });
            const metadata = metadataOf(form);
            const pi = { id: rid("pi"), object: "payment_intent", amount: Number(amount), amount_received: 0, amount_capturable: 0, capture_method: method, client_secret: rid("secret"), created: now(), currency, livemode: false, metadata, payment_method: pmName, status: "requires_payment_method", last_payment_error: null, latest_charge: null };
            const addCharge = (fields) => {
                const charge = { id: rid("ch"), object: "charge", amount: pi.amount, amount_captured: 0, amount_refunded: 0, captured: false, created: now(), currency, livemode: false, metadata, payment_intent: pi.id, refunded: false, failure_code: null, status: "pending", ...fields };
                account.charges.push(charge);
                pi.latest_charge = charge.id;
                return charge;
            };
            account.payment_intents.push(pi);
            if (outcome === "ok") {
                if (method === "manual") { pi.status = "requires_capture"; pi.amount_capturable = pi.amount; addCharge({ status: "succeeded" }); }
                else { pi.status = "succeeded"; pi.amount_received = pi.amount; addCharge({ status: "succeeded", captured: true, amount_captured: pi.amount }); }
            } else if (outcome === "3ds") {
                pi.status = "requires_action";
            } else {
                const code = outcome === "declined" ? "card_declined" : "insufficient_funds";
                pi.last_payment_error = { code, type: "card_error" };
                addCharge({ status: "failed", failure_code: code });
                return json(res, 402, { error: { type: "card_error", code, message: "Your card was declined.", payment_intent: pi } });
            }
            return json(res, 200, pi);
        }
        if (req.method === "POST" && u.pathname === "/v1/refunds") {
            const form = new URLSearchParams(body);
            const pi = account.payment_intents.find((p) => p.id === form.get("payment_intent"));
            if (!pi) return json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such payment_intent" } });
            const amount = Number(form.get("amount") ?? pi.amount);
            // A refund, as in Stripe's API, carries no livemode.
            const refund = { id: rid("re"), object: "refund", amount, charge: pi.latest_charge, created: now(), currency: pi.currency, metadata: {}, payment_intent: pi.id, reason: form.get("reason"), status: "succeeded" };
            account.refunds.push(refund);
            const charge = account.charges.find((c) => c.id === pi.latest_charge);
            charge.amount_refunded += amount;
            charge.refunded = charge.amount_refunded === charge.amount;
            return json(res, 200, refund);
        }
        return json(res, 404, { error: { type: "invalid_request_error", message: "Unrecognized request URL" } });
    });
    return { ...server, seenKeys, accounts, fill: (key, kind, rows) => accounts.get(key)[kind].push(...rows) };
}

/**
 * A system with its own Stripe key: POST /checkout { amount, currency, card, capture, metadata } takes a
 * payment, POST /refund-last refunds it, POST /stripe/webhook checks the signature and fulfils the order
 * once per event when `idempotent`, or once per delivery when not. GET /orders says how many were fulfilled.
 */
export function shop({ stripeUrl, key, secret, idempotent = true, amountChange = 0, currency, refundShort = 0 }) {
    let last, fulfilled = 0;
    const seen = new Set();
    const call = async (path, fields) => {
        const r = await fetch(`${stripeUrl}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
        return { status: r.status, body: await r.json() };
    };
    return listen(async (req, res, body) => {
        if (req.method === "GET" && req.url === "/orders") return json(res, 200, { fulfilled });
        if (req.method === "POST" && req.url === "/checkout") {
            const b = JSON.parse(body);
            const fields = { amount: String(b.amount + amountChange), currency: currency ?? b.currency, payment_method: b.card, confirm: "true", ...(b.capture ? { capture_method: b.capture } : {}) };
            for (const [k, v] of Object.entries(b.metadata ?? {})) fields[`metadata[${k}]`] = v;
            const r = await call("/v1/payment_intents", fields);
            if (r.status === 200) last = r.body.id;
            return json(res, r.status === 200 ? 200 : 402, { ok: r.status === 200 });
        }
        if (req.method === "POST" && req.url === "/refund-last") {
            const r = await call("/v1/refunds", { payment_intent: last, ...(refundShort ? { amount: String(refundShort) } : {}), reason: "requested_by_customer" });
            return json(res, r.status, {});
        }
        if (req.method === "POST" && req.url === "/stripe/webhook") {
            const sig = Object.fromEntries(String(req.headers["stripe-signature"] ?? "").split(",").map((p) => p.split("=")));
            const expected = crypto.createHmac("sha256", secret).update(`${sig.t}.${body}`, "utf8").digest("hex");
            if (sig.v1 !== expected || Math.abs(now() - Number(sig.t)) > 300) return json(res, 400, { error: "bad signature" });
            const event = JSON.parse(body);
            if (event.type === "payment_intent.succeeded" && !(idempotent && seen.has(event.id))) fulfilled++;
            seen.add(event.id);
            return json(res, 200, { received: true });
        }
        return json(res, 404, {});
    });
}
