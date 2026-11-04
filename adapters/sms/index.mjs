#!/usr/bin/env node
// The SMS adapter: reports the text messages a system would have sent, from a local capture, or
// sends one through Twilio's test credentials. It never reaches a real phone: every recipient must
// be on the target's allow-list, and that is checked before any network call.
// Docs: README.md here, and docs/ADAPTERS.md.
import { address, direct, jsonFrom, millis, Refusal, refuseUnsupported, safeForCredentials, SAFE_METHODS, scrubber, sendToSystem, serve, settle, under } from "./runtime.mjs";

// ---- Masking one-time codes ----

const CODE = "<code>";
/** A word such as "code" or "OTP", then a code of letters and digits, or digits with a space or dash in the middle. */
const AFTER_WORD = /\b((?:code|otp|pin|passcode|password|token)\b(?:\s+is)?\s*[:=-]?\s*)([A-Za-z0-9]*\d[A-Za-z0-9]*(?:[ -]\d+)*)/gi;
/** Four to eight digits standing alone. A price or a longer number is left as it is. */
const ALONE = /(?<![\d£$€.,/:-])\b\d{4,8}\b(?![\d.,/:]\d)/g;

/** A short prefix and a dash, as in G-482913. */
const PREFIXED = /\b([A-Z]{1,3}-)\d{4,8}\b/g;

const maskCodes = (text) => String(text ?? "").replace(AFTER_WORD, (_m, word) => word + CODE).replace(PREFIXED, `$1${CODE}`).replace(ALONE, CODE);

// ---- The allow-list ----

const normal = (n) => String(n ?? "").replace(/[\s().-]/g, "");

/** The target's test numbers. With none, nothing is allowed. */
function allowList(target) {
    const raw = target?.allow_numbers;
    if (typeof raw !== "string" || raw.trim() === "") throw new Refusal(`target ${target?.name} has no allow_numbers in its settings, so every recipient is refused. List the test numbers, separated by commas`);
    return new Set(raw.split(",").map(normal).filter(Boolean));
}

const PHONE = /^\+?\d[\d\s().-]{5,}\d$/;
const PHONE_FIELD = /^(to|recipients?|destination|phone|phone_?number|mobile|msisdn|tel)$/i;
const E164 = /^\+\d{7,15}$/;
const SENDER_FIELD = /^(from|sender|originator)$/i;

/** Every recipient a case names: a field with a recipient's name, or anything written as +447700900123. */
function recipientsIn(value, key, out) {
    if (Array.isArray(value)) { for (const v of value) recipientsIn(v, key, out); return out; }
    if (value && typeof value === "object") { for (const [k, v] of Object.entries(value)) recipientsIn(v, k, out); return out; }
    if (key && SENDER_FIELD.test(key)) return out;
    if (typeof value === "number" && key && PHONE_FIELD.test(key)) out.push(String(value));
    if (typeof value === "string" && (E164.test(normal(value)) || (key && PHONE_FIELD.test(key) && PHONE.test(value)))) out.push(value);
    return out;
}

function caseRecipients(c) {
    const found = [];
    let body = c.request.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(body)); }
    }
    recipientsIn(body, undefined, found);
    recipientsIn(c.request.body_form, undefined, found);
    const query = String(c.request.path ?? "").split("?")[1];
    if (query) for (const [k, v] of new URLSearchParams(query)) recipientsIn(v, k, found);
    return found;
}

/** The number itself isn't printed: phone numbers don't belong in logs and reports. */
function refuseOutsideList(numbers, allowed) {
    for (const n of numbers) if (!allowed.has(normal(n))) throw new Refusal("a recipient is outside the target's allow_numbers, so this case is refused before any network call");
}

// ---- A local capture ----

const known = new Set();

async function captureAddress(target) {
    const base = address(target, "capture_url");
    if (!known.has(base)) {
        const res = await direct(under(base, "/__cmtk/info"), {}, `SMS capture ${base}`);
        const info = res.ok ? await res.json().catch(() => null) : null;
        if (info?.server !== "cmtk-sms-capture") throw new Refusal(`${base} does not answer as the SMS capture, so this adapter refuses to use it. Start it with: node adapters/sms/capture.mjs`);
        known.add(base);
    }
    return base;
}

async function recorded(base) {
    const list = await jsonFrom(await direct(under(base, "/__cmtk/messages"), {}, "the SMS capture"), "the SMS capture");
    if (!Array.isArray(list?.messages)) throw new Refusal("the SMS capture's answer has no `messages`");
    return list.messages;
}

const facts = (m) => ({ to: m.to, from: m.from, text: maskCodes(m.text) });
const inOrder = (l) => [...l].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function runCapture(c, target, headers, allowed) {
    const base = await captureAddress(target);
    let status = 200, messages;
    if (SAFE_METHODS.has(c.request.method)) messages = await recorded(base);
    else {
        // Only what this case caused counts, even when the capture was not empty.
        const before = new Set((await recorded(base)).map((m) => m.id));
        status = await sendToSystem(c, target, headers);
        const quiet = millis(target, "quiet_ms", 1000);
        const most = millis(target, "max_wait_ms", 15_000);
        const ids = await settle(async () => (await recorded(base)).filter((m) => !before.has(m.id)).map((m) => m.id), quiet, most, "messages were");
        messages = (await recorded(base)).filter((m) => ids.includes(m.id));
    }
    for (const m of messages) if (m.to === null) throw new Refusal("the capture holds a request with no recipient it could read");
    // The capture kept it from a phone, but a system texting someone off the list is not a pass.
    for (const m of messages) if (!allowed.has(normal(m.to))) throw new Refusal("the system sent to a recipient outside the target's allow_numbers. The capture kept it from any phone");
    return { status, headers: {}, effects: { messages: inOrder(messages.map(facts)) } };
}

// ---- Twilio test credentials ----

/** Numbers Twilio keeps for testing. Twilio's test credentials accept them as sender, and no real phone has one. */
const TWILIO_MAGIC = /^\+1500555\d{4}$/;
const VALID_SENDER = "+15005550006";
const secretsSeen = new Set();

function twilioCredentials(target) {
    const named = (key) => {
        const name = target[key];
        if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Refusal(`target ${target.name} needs ${key}: the name of an environment variable. Credentials come only from the environment`);
        const value = process.env[name];
        if (!value) throw new Refusal(`the environment variable ${name} is not set`);
        secretsSeen.add(value);
        return value;
    };
    const sid = named("twilio_sid_env"), token = named("twilio_token_env");
    if (!/^AC[0-9a-fA-F]{32}$/.test(sid) || !/^[0-9A-Za-z_-]+$/.test(token)) throw new Refusal("the Twilio credentials in the environment are not in the expected form");
    return { sid, token };
}

async function runTwilio(c, target, allowed) {
    // Twilio's test and live credentials look the same, so the numbers are what keep this safe:
    // every recipient and sender must be one of Twilio's own test numbers, whatever the credentials are.
    for (const n of allowed) if (!TWILIO_MAGIC.test(n)) throw new Refusal("in Twilio mode allow_numbers may hold only Twilio's test numbers, which start +1500555");
    if (SAFE_METHODS.has(c.request.method)) throw new Refusal("in Twilio mode this adapter only sends; it does not read messages back. An empty answer would read as a match, so use a capture to observe a system");
    let body = c.request.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body || typeof body !== "object" || typeof body.to !== "string" || typeof (body.text ?? body.body) !== "string") throw new Refusal("in Twilio mode a case's body needs `to` and `text`");
    const from = body.from ?? VALID_SENDER;
    if (!TWILIO_MAGIC.test(normal(from))) throw new Refusal("in Twilio mode the sender must be one of Twilio's test numbers, which start +1500555");
    const api = address(target, "twilio_api");
    if (!safeForCredentials(api)) throw new Refusal("twilio_api must be https, or http on this machine: credentials are not sent in the clear");
    const { sid, token } = twilioCredentials(target);
    const res = await direct(under(api, `/2010-04-01/Accounts/${sid}/Messages.json`), {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: normal(body.to), From: normal(from), Body: body.text ?? body.body }).toString(),
    }, "Twilio");
    if (res.status === 401 || res.status === 403) throw new Refusal(`Twilio answered ${res.status}: check the credentials`);
    if (res.status >= 300 && res.status < 400) throw new Refusal(`Twilio answered a redirect (${res.status}), which is not followed`);
    const answer = await res.json().catch(() => null);
    if (answer === null) throw new Refusal("Twilio did not answer with JSON");
    // Twilio's own message is left out: only the facts are compared, and it can quote the account.
    const message = { to: normal(body.to), from: normal(from), text: maskCodes(body.text ?? body.body), accepted: res.ok, ...(res.ok ? { state: answer.status ?? null } : { error_code: answer.code ?? null }) };
    return { status: res.status, headers: {}, effects: { messages: [message] } };
}

// ---- The protocol ----

const describe = () => ({
    name: "sms",
    kinds: ["sms"],
    settings: [
        { name: "allow_numbers", description: "The test numbers a message may go to, separated by commas. Anything else is refused", required: true },
        { name: "capture_url", description: "The local capture for this target (node adapters/sms/capture.mjs)" },
        { name: "base_url", description: "The system itself, which POST, PUT, PATCH and DELETE cases are sent to" },
        { name: "twilio_api", description: "Twilio mode, instead of capture_url: https://api.twilio.com" },
        { name: "twilio_sid_env", description: "Twilio mode: the name of the environment variable with the test Account SID" },
        { name: "twilio_token_env", description: "Twilio mode: the name of the environment variable with the test Auth Token" },
        { name: "quiet_ms", description: "Messages have stopped when nothing new came for this long. Default 1000" },
        { name: "max_wait_ms", description: "Give up, with an error, if messages are still arriving after this long. Default 15000" },
    ],
});

async function run(c, target, headers) {
    refuseUnsupported(c);
    const allowed = allowList(target);
    refuseOutsideList(caseRecipients(c), allowed);
    if (target.capture_url !== undefined) return runCapture(c, target, headers, allowed);
    if (target.twilio_api !== undefined) return runTwilio(c, target, allowed);
    throw new Refusal(`target ${target.name} needs capture_url or twilio_api in its settings`);
}

async function reset(target) {
    // Twilio keeps nothing to clear for test credentials.
    if (target?.capture_url === undefined && target?.twilio_api !== undefined) return { ok: true };
    const base = await captureAddress(target);
    const res = await direct(under(base, "/__cmtk/messages"), { method: "DELETE" }, "the SMS capture");
    if (!res.ok) throw new Refusal(`the SMS capture answered ${res.status} when asked to clear`);
    return { ok: true };
}

await serve({ describe, run, reset }, scrubber(() => [...secretsSeen]));
