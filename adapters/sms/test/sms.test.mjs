// The SMS adapter over its real protocol, against the capture that ships with it and a stand-in for Twilio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { startCapture } from "../capture.mjs";
import { adapter, ADAPTER_DIR, cmtk, project, smsSystem, twilio } from "./helpers.mjs";

const ALLOW = "+15005550006, +1 500 555 0007, +15005550009";
const started = async () => {
    const s = await startCapture();
    return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
};
const SEND = { id: "S", request: { method: "POST", path: "/send-code", body: { to: "+15005550006" } } };
const LOOK = { id: "L", request: { method: "GET", path: "/messages" } };

for (const form of [true, false]) {
    test(`capture (${form ? "Twilio's form" : "JSON"}): reports recipient, sender and text with the code masked, and no ids or times`, async () => {
        const cap = await started();
        const sys = await smsSystem(cap.url, { form });
        const a = adapter();
        try {
            const target = { name: "legacy", base_url: sys.url, capture_url: cap.url, allow_numbers: ALLOW, quiet_ms: 50 };
            const { reply, raw } = await a.call({ op: "run", case: SEND, target, headers: {} });
            assert.equal(reply.status, 202);
            assert.deepEqual(reply.effects, { messages: [{ to: "+15005550006", from: "+15005550006", text: "Your code is <code>" }] });
            assert.doesNotMatch(raw, /\b\d{6}\b|"id"|"sid"|date/);
        } finally { await a.close(); await sys.close(); await cap.close(); }
    });
}

const CODES = {
    "Your code is 482913": "Your code is <code>",
    "482913 is your verification code": "<code> is your verification code",
    "OTP: 4829": "OTP: <code>",
    "Code: AB12CD to log in": "Code: <code> to log in",
    "Your code is 482 913.": "Your code is <code>.",
    "G-482913 is your code": "G-<code> is your code",
    "You paid £1000.50 for order 12": "You paid £1000.50 for order 12",
    "Call 0800 123 now": "Call 0800 123 now".replace("0800", "<code>"),
};

test("one-time codes are masked however they are written; prices and short numbers are not", async () => {
    const cap = await started();
    const a = adapter();
    try {
        const target = { name: "x", capture_url: cap.url, allow_numbers: ALLOW };
        for (const text of Object.keys(CODES)) {
            await fetch(`${cap.url}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "+15005550006", from: "A", text }) });
        }
        const { reply } = await a.call({ op: "run", case: LOOK, target, headers: {} });
        assert.deepEqual(reply.effects.messages.map((m) => m.text).sort(), Object.values(CODES).sort());
    } finally { await a.close(); await cap.close(); }
});

test("a case reports only what it caused, the same case twice gives the same answer, and reset clears the capture", async () => {
    const cap = await started();
    const sys = await smsSystem(cap.url);
    const a = adapter();
    try {
        const target = { name: "x", base_url: sys.url, capture_url: cap.url, allow_numbers: ALLOW, quiet_ms: 50 };
        const one = (await a.call({ op: "run", case: SEND, target, headers: {} })).raw;
        const two = (await a.call({ op: "run", case: SEND, target, headers: {} })).raw;
        assert.equal(one, two);
        assert.equal((await a.call({ op: "run", case: LOOK, target, headers: {} })).reply.effects.messages.length, 2, "the capture holds both");
        assert.deepEqual((await a.call({ op: "reset", target })).reply, { ok: true });
        assert.deepEqual((await a.call({ op: "run", case: LOOK, target, headers: {} })).reply.effects.messages, []);
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("GET only observes: the system is not contacted and the capture stays as it was", async () => {
    const cap = await started();
    const sys = await smsSystem(cap.url);
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "run", case: LOOK, target: { name: "x", base_url: sys.url, capture_url: cap.url, allow_numbers: ALLOW }, headers: {} });
        assert.deepEqual(reply.effects.messages, []);
        assert.equal(sys.state.connections, 0);
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("the capture runs as a program, on the port it's given, and says where it is", async () => {
    const p = spawn(process.execPath, [path.join(ADAPTER_DIR, "capture.mjs"), "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
    try {
        const line = (await readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]().next()).value;
        const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line)?.[0];
        assert.ok(url, line);
        assert.deepEqual(await (await fetch(`${url}/__cmtk/info`)).json(), { server: "cmtk-sms-capture", version: 1 });
    } finally { p.kill(); }
});

test("describe names the adapter, its kind and its settings", async () => {
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "describe" });
        assert.equal(reply.name, "sms");
        assert.deepEqual(reply.kinds, ["sms"]);
        assert.ok(reply.settings.some((s) => s.name === "allow_numbers" && s.required));
    } finally { await a.close(); }
});

const SID = `AC${"a".repeat(32)}`, TOKEN = "planted-twilio-token-5678";
const twilioEnv = { TEST_SID: SID, TEST_TOKEN: TOKEN };
const twilioTarget = (url) => ({ name: "t", twilio_api: url, twilio_sid_env: "TEST_SID", twilio_token_env: "TEST_TOKEN", allow_numbers: "+15005550006,+15005550009" });
const TEXT = (to, from) => ({ id: "T", request: { method: "POST", path: "/messages", body: { to, text: "Your code is 482913", ...(from ? { from } : {}) } } });

test("Twilio mode: sends with the test sender and reports recipient, sender, masked text and what Twilio did", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const a = adapter(twilioEnv);
    try {
        const { reply, raw } = await a.call({ op: "run", case: TEXT("+15005550006"), target: twilioTarget(api.url), headers: {} });
        assert.equal(reply.status, 201);
        assert.deepEqual(reply.effects.messages, [{ to: "+15005550006", from: "+15005550006", text: "Your code is <code>", accepted: true, state: "queued" }]);
        assert.doesNotMatch(raw, /SM\d+|aaaaaaaa|planted/);
        const sent = new URLSearchParams(api.state.requests[0].body);
        assert.equal(sent.get("Body"), "Your code is 482913", "the provider gets the real text; only the report is masked");
        assert.equal(sent.get("From"), "+15005550006");
    } finally { await a.close(); await api.close(); }
});

test("Twilio mode: Twilio's refusals are reported by code, without its message or the account", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const a = adapter(twilioEnv);
    try {
        const { reply, raw } = await a.call({ op: "run", case: TEXT("+15005550009"), target: twilioTarget(api.url), headers: {} });
        assert.equal(reply.status, 400);
        assert.equal(reply.effects.messages[0].accepted, false);
        assert.equal(reply.effects.messages[0].error_code, 21614);
        assert.doesNotMatch(raw, /aaaaaaaa|on account/);
    } finally { await a.close(); await api.close(); }
});

test("Twilio mode: wrong credentials are an error that names neither of them", async () => {
    const api = await twilio({ sid: SID, token: "a-different-token" });
    const a = adapter(twilioEnv);
    try {
        const { reply, raw } = await a.call({ op: "run", case: TEXT("+15005550006"), target: twilioTarget(api.url), headers: {} });
        assert.match(reply.error, /answered 401/);
        assert.doesNotMatch(raw, /aaaaaaaa|planted/);
    } finally { await a.close(); await api.close(); }
});

test("Twilio mode: GET is an error, not an empty list that would read as a match, and reset needs no network", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const a = adapter(twilioEnv);
    try {
        assert.match((await a.call({ op: "run", case: LOOK, target: twilioTarget(api.url), headers: {} })).reply.error, /does not read messages back/);
        assert.deepEqual((await a.call({ op: "reset", target: twilioTarget(api.url) })).reply, { ok: true });
        assert.equal(api.state.connections, 0);
    } finally { await a.close(); await api.close(); }
});

const manifest = (a, b) => `system: shop
targets:
  legacy: { base_url: ${a.sys}, capture_url: ${a.cap}, allow_numbers: "+15005550006", quiet_ms: 100 }
  candidate: { base_url: ${b.sys}, capture_url: ${b.cap}, allow_numbers: "+15005550006", quiet_ms: 100 }
reference: legacy
allow_unsafe_methods: true
adapters:
  sms: { command: node, args: [adapters/sms/index.mjs], covers: [sms] }
`;
const CASES = `cases:
  - id: SMS-CODE
    surface: sms
    request:
      method: POST
      path: /send-code
      body: { to: "+15005550006" }
`;

test("the conformance kit passes through the real CLI against the capture", async () => {
    const cap = await started();
    const sys = await smsSystem(cap.url);
    const dir = project(`system: shop\ntargets:\n  legacy: { base_url: ${sys.url}, capture_url: ${cap.url}, allow_numbers: "+15005550006", quiet_ms: 100 }\nadapters:\n  sms: { command: node, args: [adapters/sms/index.mjs] }\n`);
    try {
        const r = await cmtk(dir, {}, "adapter", "check", "sms", "--target", "legacy");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Adapter sms passes the conformance kit/);
        assert.match(r.stdout, /pass {2}SMS-002: the same case twice gives the same observation/);
    } finally { await sys.close(); await cap.close(); }
});

test("cmtk compare: two systems' same messages match despite different codes, and a planted difference is caught", async () => {
    const [capA, capB] = [await started(), await started()];
    let wording = (code) => `Your code is ${code}`;
    const sysA = await smsSystem(capA.url);
    const sysB = await listenWith(capB, () => wording);
    const dir = project(manifest({ sys: sysA.url, cap: capA.url }, { sys: sysB.url, cap: capB.url }), CASES);
    try {
        let r = await cmtk(dir, {}, "compare", "--allow-unsafe");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /PARITY/);
        wording = (code) => `Use ${code} to log in`;
        r = await cmtk(dir, {}, "compare", "--allow-unsafe");
        assert.equal(r.status, 1, r.stdout + r.stderr);
        const report = fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8");
        assert.match(report, /DIFFERENT/);
        assert.match(report, /effects:\$\.messages\[0\]\.text/);
    } finally { await sysA.close(); await sysB.close(); await capA.close(); await capB.close(); }
});

/** A system whose wording the test can change between runs. */
function listenWith(cap, getWording) {
    return smsSystem(cap.url, { text: (code) => getWording()(code) });
}
