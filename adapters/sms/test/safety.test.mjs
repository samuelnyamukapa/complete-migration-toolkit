// docs/TEST-PLAN.md, "Sandboxes only for money and messages": an SMS adapter refuses anything that
// isn't a capture server or a test number, before any network call. These must always pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { startCapture } from "../capture.mjs";
import { adapter, ADAPTER_DIR, allText, cmtk, json, listen, project, smsSystem, twilio } from "./helpers.mjs";

const REAL_LOOKING = "+447911123456";
const SID = `AC${"a".repeat(32)}`, TOKEN = "planted-twilio-token-5678";
const twilioEnv = { TEST_SID: SID, TEST_TOKEN: TOKEN };
const started = async () => {
    const s = await startCapture();
    return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
};

const RECIPIENT_PLACES = {
    "a JSON body": { body: { to: REAL_LOOKING } },
    "a nested field with another name": { body: { customer: { contact: { mobile: REAL_LOOKING } } } },
    "any value written as an international number": { body: { note: REAL_LOOKING } },
    "a body in text": { body: `To=${encodeURIComponent(REAL_LOOKING)}&Body=hi` },
    "a form": { body_form: { To: REAL_LOOKING, Body: "hi" } },
    "a query string": { path: `/send-code?to=${encodeURIComponent(REAL_LOOKING)}` },
    "a list of recipients": { body: { recipients: ["+15005550006", REAL_LOOKING] } },
    "a number written with spaces": { body: { phone: "+44 7911 123456" } },
    "a channel prefix": { body: { to: `whatsapp:${REAL_LOOKING}` } },
    "a tel: address": { body: { to: `tel:${REAL_LOOKING}` } },
    "an sms: address outside a recipient field": { body: { note: `sms:${REAL_LOOKING}` } },
    "numbers joined by a comma": { body: { to: `+15005550006,${REAL_LOOKING}` } },
    "numbers joined by a semicolon": { body: { recipients: `+15005550006; ${REAL_LOOKING}` } },
    "joined numbers outside a recipient field": { body: { note: `+15005550006,${REAL_LOOKING}` } },
    "numbers joined by a word": { body: { to: `+15005550006 or ${REAL_LOOKING}` } },
    "numbers with no separator but the plus": { body: { to: `+15005550006${REAL_LOOKING}` } },
    "full-width digits": { body: { to: "＋４４７９１１１２３４５６" } },
    "a zero-width space inside": { body: { to: "+15005550006\u200b,\u200b+447911123456" } },
    "the international prefix 00": { body: { to: "00447911123456" } },
    "no plus at all": { body: { to: "447911123456" } },
    "a whole number as JSON": { body: { to: 447911123456 } },
    "a form with the field twice": { body: `To=${encodeURIComponent(REAL_LOOKING)}&To=%2B15005550006&Body=hi` },
    "a query string with the field twice": { path: `/send-code?to=${encodeURIComponent(REAL_LOOKING)}&to=%2B15005550006` },
    "the path": { path: `/send/${encodeURIComponent(REAL_LOOKING)}/now` },
    "a header": { headers: { "x-recipient": REAL_LOOKING } },
    "a key": { body: { messages: { [REAL_LOOKING]: "hi" } } },
    "a field named to_number": { body: { to_number: "447911123456" } },
    "a field named toNumbers": { body: { toNumbers: ["447911123456"] } },
    "a field named bcc": { body: { bcc: "447911123456" } },
    "JSON inside a string": { body: { payload: JSON.stringify({ to: REAL_LOOKING }) } },
    "XML": { body: `<message><to>${REAL_LOOKING}</to></message>` },
};

for (const [where, request] of Object.entries(RECIPIENT_PLACES)) {
    test(`safety: a recipient outside the allow-list, in ${where}, is refused before any network call`, async () => {
        const provider = await listen((_q, res) => json(res, 201, {}));
        const sys = await listen((_q, res) => json(res, 200, {}));
        const a = adapter(twilioEnv);
        try {
            const c = { id: "X", request: { method: "POST", path: "/send-code", ...request } };
            for (const settings of [{ capture_url: provider.url }, { twilio_api: provider.url, twilio_sid_env: "TEST_SID", twilio_token_env: "TEST_TOKEN" }]) {
                const { reply, raw } = await a.call({ op: "run", case: c, target: { name: "x", base_url: sys.url, allow_numbers: "+15005550006", ...settings }, headers: {} });
                assert.match(reply.error, /outside the target's allow_numbers/);
                assert.doesNotMatch(raw, /7911/, "the number itself is not printed");
            }
            assert.equal(provider.state.connections, 0, "no connection to the provider or capture");
            assert.equal(sys.state.connections, 0, "no connection to the system");
        } finally { await a.close(); await provider.close(); await sys.close(); }
    });
}

test("safety: a number on the list is still the number on the list, written any way", async () => {
    const cap = await started();
    const sys = await listen((_q, res) => json(res, 202, {}));
    const a = adapter();
    try {
        for (const to of ["+15005550006", "+1 500 555 0006", "+1 (500) 555-0006", "tel:+15005550006", "whatsapp:+15005550006", "+15005550006,+1 500 555 0006", "００１５００５５５０００６"]) {
            const { reply } = await a.call({ op: "run", case: { id: "X", request: { method: "POST", path: "/send", body: { to } } }, target: { name: "x", base_url: sys.url, capture_url: cap.url, allow_numbers: "+15005550006", quiet_ms: 20 }, headers: {} });
            assert.equal(reply.error, undefined, `${to}: ${reply.error}`);
        }
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("safety: the message's text and the sender are not recipients, and neither is a short id", async () => {
    const cap = await started();
    const sys = await listen((_q, res) => json(res, 202, {}));
    const a = adapter();
    try {
        const bodies = [{ to: "+15005550006", from: "+447911123456" }, { to: "+15005550006", text: "Call +447911123456 about order 12" }, { customer: "c-42", to: "customer-42" }, { order_number: "12345678" }];
        for (const body of bodies) {
            const { reply } = await a.call({ op: "run", case: { id: "X", request: { method: "POST", path: "/send", body } }, target: { name: "x", base_url: sys.url, capture_url: cap.url, allow_numbers: "+15005550006", quiet_ms: 20 }, headers: {} });
            assert.equal(reply.error, undefined, `${JSON.stringify(body)}: ${reply.error}`);
        }
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("safety: in Twilio mode only a plain number on the list goes to Twilio, whatever else it could be read as", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const a = adapter(twilioEnv);
    const target = { name: "t", allow_numbers: "+15005550006", twilio_api: api.url, twilio_sid_env: "TEST_SID", twilio_token_env: "TEST_TOKEN" };
    const send = (to) => ({ id: "T", request: { method: "POST", path: "/m", body: { to, text: "hi" } } });
    try {
        for (const to of ["whatsapp:+15005550006", "sms:+15005550006", "+15005550006,+15005550006", "+15005550006;", `whatsapp:${REAL_LOOKING}`, `+15005550006,${REAL_LOOKING}`, "customer-42", "+15005550006 x"]) {
            const { reply, raw } = await a.call({ op: "run", case: send(to), target, headers: {} });
            assert.match(reply.error ?? "", /allow_numbers/, to);
            assert.doesNotMatch(raw, /7911/);
        }
        assert.equal(api.state.connections, 0, "nothing was sent to Twilio");
        const ok = await a.call({ op: "run", case: send("+1 500 555 0006"), target, headers: {} });
        assert.equal(ok.reply.error, undefined);
        assert.equal(new URLSearchParams(api.state.requests[0].body).get("To"), "+15005550006");
    } finally { await a.close(); await api.close(); }
});

test("safety: with no allow-list, every recipient is refused before any network call", async () => {
    const provider = await listen((_q, res) => json(res, 201, {}));
    const a = adapter();
    try {
        for (const allow_numbers of [undefined, "", "   "]) {
            const { reply } = await a.call({ op: "run", case: { id: "X", request: { method: "POST", path: "/s", body: { to: "+15005550006" } } }, target: { name: "x", capture_url: provider.url, allow_numbers }, headers: {} });
            assert.match(reply.error, /no allow_numbers/);
        }
        assert.equal(provider.state.connections, 0);
    } finally { await a.close(); await provider.close(); }
});

test("safety: a system that texts someone off the list is an error, though the capture kept it from any phone", async () => {
    const cap = await started();
    const sys = await smsSystem(cap.url, { to: REAL_LOOKING });
    const a = adapter();
    try {
        // The case names no recipient, so only the capture can show it.
        const c = { id: "X", request: { method: "POST", path: "/send-code" } };
        const { reply, raw } = await a.call({ op: "run", case: c, target: { name: "x", base_url: sys.url, capture_url: cap.url, allow_numbers: "+15005550006", quiet_ms: 50 }, headers: {} });
        assert.match(reply.error, /outside the target's allow_numbers/);
        assert.doesNotMatch(raw, /7911/);
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("safety: an address that doesn't answer as the capture is refused, and the system isn't asked to send", async () => {
    const fake = await listen((_q, res) => json(res, 200, {}));
    const sys = await listen((_q, res) => json(res, 200, {}));
    const a = adapter();
    try {
        const target = { name: "x", base_url: sys.url, capture_url: fake.url, allow_numbers: "+15005550006" };
        assert.match((await a.call({ op: "run", case: { id: "X", request: { method: "POST", path: "/s", body: { to: "+15005550006" } } }, target, headers: {} })).reply.error, /does not answer as the SMS capture/);
        const reset = (await a.call({ op: "reset", target })).reply;
        assert.equal(reset.ok, false);
        assert.equal(sys.state.connections, 0);
        assert.ok(fake.state.requests.every((r) => r.method === "GET"));
    } finally { await a.close(); await sys.close(); await fake.close(); }
});

test("safety: Twilio mode takes only Twilio's own test numbers, whatever the credentials are, before any network call", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const a = adapter(twilioEnv);
    try {
        const base = { name: "t", twilio_api: api.url, twilio_sid_env: "TEST_SID", twilio_token_env: "TEST_TOKEN" };
        const send = (body) => ({ id: "T", request: { method: "POST", path: "/m", body: { text: "hi", ...body } } });
        // A real number on the allow-list is still refused, since test and live credentials look the same.
        let r = await a.call({ op: "run", case: send({ to: REAL_LOOKING }), target: { ...base, allow_numbers: REAL_LOOKING }, headers: {} });
        assert.match(r.reply.error, /only Twilio's test numbers/);
        // A real sender is refused, which a live account could own.
        r = await a.call({ op: "run", case: send({ to: "+15005550006", from: "+447700900123" }), target: { ...base, allow_numbers: "+15005550006,+447700900123" }, headers: {} });
        assert.match(r.reply.error, /only Twilio's test numbers/);
        r = await a.call({ op: "run", case: send({ to: "+15005550006", from: "+12025550100" }), target: { ...base, allow_numbers: "+15005550006" }, headers: {} });
        assert.match(r.reply.error, /sender must be one of Twilio's test numbers/);
        assert.equal(api.state.connections, 0);
    } finally { await a.close(); await api.close(); }
});

test("safety: Twilio credentials come only from named environment variables, and go only over https or to this machine", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const a = adapter(twilioEnv);
    const send = { id: "T", request: { method: "POST", path: "/m", body: { to: "+15005550006", text: "hi" } } };
    const base = { name: "t", allow_numbers: "+15005550006", twilio_api: api.url, twilio_sid_env: "TEST_SID", twilio_token_env: "TEST_TOKEN" };
    try {
        assert.match((await a.call({ op: "run", case: send, target: { ...base, twilio_token_env: undefined }, headers: {} })).reply.error, /environment variable/);
        assert.match((await a.call({ op: "run", case: send, target: { ...base, twilio_token_env: "NOT_SET_ANYWHERE" }, headers: {} })).reply.error, /NOT_SET_ANYWHERE is not set/);
        const plain = await a.call({ op: "run", case: send, target: { ...base, twilio_api: "http://twilio.example.test" }, headers: {} });
        assert.match(plain.reply.error, /must be https/);
        assert.equal(api.state.connections, 0);
    } finally { await a.close(); await api.close(); }
});

test("safety: no Twilio secret reaches stdout, stderr, or any file a run writes", async () => {
    const api = await twilio({ sid: SID, token: TOKEN });
    const dir = project(`system: shop
targets:
  legacy: { twilio_api: ${api.url}, twilio_sid_env: TEST_SID, twilio_token_env: TEST_TOKEN, allow_numbers: "+15005550006" }
  candidate: { twilio_api: ${api.url}, twilio_sid_env: TEST_SID, twilio_token_env: TEST_TOKEN, allow_numbers: "+15005550006" }
reference: legacy
allow_unsafe_methods: true
adapters:
  sms: { command: node, args: [adapters/sms/index.mjs] }
`, `cases:
  - id: T1
    surface: sms
    request: { method: POST, path: /messages, body: { to: "+15005550006", text: "Your code is 482913" } }
`);
    try {
        const r = await cmtk(dir, twilioEnv, "compare", "--allow-unsafe");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /PARITY/);
        const everything = r.stdout + r.stderr + allText(dir);
        assert.ok(!everything.includes(TOKEN), "the token");
        assert.ok(!everything.includes(SID), "the account");
        // The case file holds the text it asked for; what the run reported must not.
        assert.ok(!(r.stdout + allText(path.join(dir, "cmtk", "evidence"))).includes("482913"), "the code");
    } finally { await api.close(); }
});

test("safety: the capture keeps no credentials and listens only on this machine", async () => {
    const s = await startCapture();
    const url = `http://127.0.0.1:${s.address().port}`;
    try {
        assert.equal(s.address().address, "127.0.0.1");
        await fetch(`${url}/x`, { method: "POST", headers: { authorization: "Basic cGxhbnRlZC1jYXB0dXJl", "content-type": "application/x-www-form-urlencoded" }, body: "To=%2B15005550006&Body=hi" });
        const held = await (await fetch(`${url}/__cmtk/messages`)).text();
        assert.match(held, /15005550006/);
        assert.doesNotMatch(held, /cGxhbnRlZC1jYXB0dXJl/);
    } finally { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
});

test("safety: no proxy, even with proxy environment variables and Node's proxy switch on", async () => {
    const proxy = await listen((_q, res) => json(res, 200, {}));
    const cap = await started();
    const proxied = { HTTP_PROXY: proxy.url, http_proxy: proxy.url, HTTPS_PROXY: proxy.url, https_proxy: proxy.url, NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "1" };
    const a = adapter(proxied);
    try {
        const { reply } = await a.call({ op: "run", case: { id: "G", request: { method: "GET", path: "/" } }, target: { name: "x", capture_url: cap.url, allow_numbers: "+15005550006" }, headers: {} });
        assert.equal(proxy.state.connections, 0);
        assert.deepEqual(reply.effects?.messages, [], JSON.stringify(reply));
    } finally { await a.close(); await proxy.close(); await cap.close(); }
});

test("safety: the adapter imports only Node's own modules and its own runtime", () => {
    for (const f of ["index.mjs", "runtime.mjs", "capture.mjs"]) {
        for (const m of fs.readFileSync(path.join(ADAPTER_DIR, f), "utf8").matchAll(/from "([^"]+)"/g)) assert.ok(m[1].startsWith("node:") || m[1] === "./runtime.mjs", `${f} imports ${m[1]}`);
    }
});
