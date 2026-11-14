// MFA in a real browser: a local site with a TOTP login, and one with a passkey the site itself verifies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { totpCode } from "../totp.mjs";
import { confirmSafe, loadCases, loadManifest } from "../../../packages/core/dist/index.js";
import { adapter, ADAPTER, browserProblem, cmtk, everyFile, manifest, project, serve } from "./helpers.mjs";

const skip = await browserProblem();
const web = { skip, timeout: 180_000 };

const SEED = "JBSWY3DPEHPK3PXPGEZDGNBVGY3TQOJQ";
const PASSWORD = "test-user-password-for-a-test-tenant";
const ENV = { CMTK_TEST_TOTP_SEED: SEED, CMTK_TEST_PASSWORD: PASSWORD };

function withEnv(values, fn) {
    const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
    Object.assign(process.env, values);
    try {
        return fn();
    } finally {
        for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

test("the helper gives the RFC 6238 codes", () => {
    // RFC 6238 appendix B, SHA-1, the last six digits of its eight.
    withEnv({ CMTK_RFC_SEED: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }, () => {
        for (const [seconds, code] of [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]]) {
            assert.equal(totpCode("CMTK_RFC_SEED", { now: seconds * 1000 }), code);
        }
    });
    withEnv({ CMTK_RFC_SEED: "gezd gnbv gy3t qojq gezd-gnbv gy3t qojq==" }, () => assert.equal(totpCode("CMTK_RFC_SEED", { now: 59000 }), "287082", "as authenticator apps show them"));
});

test("the helper's errors name the variable, never what it holds", () => {
    withEnv({ CMTK_BAD_SEED: "not!base32!secret" }, () => {
        assert.throws(() => totpCode("CMTK_BAD_SEED"), (e) => /CMTK_BAD_SEED is not base32/.test(e.message) && !e.message.includes("secret"));
    });
    assert.throws(() => totpCode("CMTK_NO_SUCH_SEED"), /CMTK_NO_SUCH_SEED is not set/);
});

test("as a command it prints only the code", () => {
    const r = spawnSync(process.execPath, [path.join(ADAPTER, "totp.mjs"), "CMTK_TEST_TOTP_SEED"], { env: { ...process.env, ...ENV }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\d{6}\r?\n$/);
    assert.equal(r.stderr, "");
    const bad = spawnSync(process.execPath, [path.join(ADAPTER, "totp.mjs"), "CMTK_NO_SUCH_SEED"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, "");
});

const form = (req) => new Promise((resolve) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => resolve(new URLSearchParams(b))); });
const send = (res, body, status = 200, more = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...more }); res.end(`<!doctype html><title>Login</title>${body}`); };

/** A site that accepts a password, then a code it works out from its own copy of the seed. `echo` makes it show what it should not. */
function totpSite({ echo = false, attempts = [] } = {}) {
    return serve(async (req, res) => {
        const url = new URL(req.url, "http://x");
        if (url.pathname === "/" ) return send(res, `<h1>Sign in</h1><form method="post" action="/password"><label>Password <input type="password" name="password"></label><button>Next</button></form>`);
        if (url.pathname === "/password") {
            const f = await form(req);
            return f.get("password") === PASSWORD ? send(res, `<h1>Second step</h1><form method="post" action="/code"><label>Code <input name="code"></label><button>Verify</button></form>`) : send(res, "<h1>Wrong password</h1>", 401);
        }
        if (url.pathname === "/code") {
            const f = await form(req);
            attempts.push(f.get("code"));
            const good = withEnv({ SITE_SEED: SEED }, () => [-30000, 0, 30000].map((d) => totpCode("SITE_SEED", { now: Date.now() + d })));
            if (!good.includes(f.get("code"))) return send(res, "<h1>Wrong code</h1>", 401);
            return send(res, `<h1>Your account</h1><p data-testid="who">Test user</p>${echo ? `<p data-testid="leak">seed ${SEED} code ${f.get("code")}</p>` : ""}`);
        }
        res.writeHead(404); res.end();
    });
}

const LOGIN = (code = "with_totp_env: CMTK_TEST_TOTP_SEED") => `    journey:
      goal: Sign in with a password and a code
      step_timeout_ms: 3000
      steps:
        - goto: /
        - fill: { label: Password }
          with_env: CMTK_TEST_PASSWORD
        - click: { role: button, name: Next }
        - reach: second step
          see: { role: heading, name: Second step }
        - fill: { label: Code }
          ${code}
        - click: { role: button, name: Verify }
        - reach: account
          see: { role: heading, name: Your account }
        - read: who
          from: { testid: who }
        - check: signed in as the test user
          value: who
          equals: Test user
`;
/** A person confirms `safe: true` in `cmtk review`. Without that, a case that writes needs both switches. */
const confirmed = (dir) => {
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    for (const c of loadCases(m)) if (c.safe) confirmSafe(m, c.id, "Jo Tester", "2026-11-04", c);
    return dir;
};

const CASES = `cases:\n  - id: MFA\n    surface: web\n    match: journey\n    safe: true\n    request: POST /password\n    expect: { status: 200 }\n${LOGIN()}`;

test("a journey through a TOTP login runs on both systems, and the seed is in no evidence file or log", web, async () => {
    const attempts = [];
    const [a, b] = [await totpSite({ attempts }), await totpSite({ attempts })];
    const dir = confirmed(project({ "cmtk.yaml": manifest(a.url, b.url), "cmtk/cases/mfa.yaml": CASES }));
    try {
        const r = await cmtk(dir, ["compare"], ENV);
        const rep = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.json"), "utf8"));
        assert.equal(rep.verdict, "PARITY", r.stdout + r.stderr + JSON.stringify(rep.cases));
        assert.equal(attempts.length, 2);
        assert.match(attempts[0], /^\d{6}$/, "the site got a code");
        const run = await cmtk(dir, ["run", "--target", "legacy"], ENV);
        assert.equal(run.status, 0, run.stdout + run.stderr);
        const secrets = [SEED, SEED.toLowerCase(), PASSWORD, ...attempts];
        const files = everyFile(dir);
        assert.ok(files.some((f) => f.endsWith(".png")), "screenshots were kept");
        for (const f of files) {
            const text = fs.readFileSync(f);
            for (const s of secrets) assert.ok(!text.includes(s), `${path.relative(dir, f)} holds a secret`);
        }
        for (const s of secrets) assert.ok(!(r.stdout + r.stderr + run.stdout + run.stderr).includes(s), "a log holds a secret");
    } finally {
        await a.close(); await b.close();
    }
});

test("a wrong seed fails the journey, so the code is what got it through", web, async () => {
    const [a, b] = [await totpSite(), await totpSite()];
    const dir = confirmed(project({ "cmtk.yaml": manifest(a.url, b.url), "cmtk/cases/mfa.yaml": CASES }));
    try {
        const r = await cmtk(dir, ["run", "--target", "legacy"], { ...ENV, CMTK_TEST_TOTP_SEED: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
        assert.equal(r.status, 1, r.stdout + r.stderr);
    } finally {
        await a.close(); await b.close();
    }
});

test("a page that shows the seed or the code has them replaced in the answer", web, async () => {
    const site = await totpSite({ echo: true });
    const ad = adapter(ENV);
    const journey = { goal: "g", steps: [
        { goto: "/" }, { fill: { label: "Password" }, with_env: "CMTK_TEST_PASSWORD" }, { click: { role: "button", name: "Next" } },
        { fill: { label: "Code" }, with_totp_env: "CMTK_TEST_TOTP_SEED" }, { click: { role: "button", name: "Verify" } },
        { read: "leak", from: { testid: "leak" } }, { check: "c", value: "leak" },
    ] };
    try {
        const o = await ad.run({ id: "p", safe: true, request: { method: "POST", path: "/" }, journey }, { name: "t", base_url: site.url });
        assert.match(o.journey.values.leak, /^seed <secret CMTK_TEST_TOTP_SEED> code <secret CMTK_TEST_TOTP_SEED code>$/);
        assert.ok(!JSON.stringify({ ...o, screenshots: [] }).includes(SEED));
        assert.ok(!ad.stderr().includes(SEED));
    } finally {
        await ad.close(); await site.close();
    }
});

test("a seed that is missing or a code from a capture adapter is an error that says why", web, async () => {
    const site = await totpSite();
    const ad = adapter({ CMTK_TEST_PASSWORD: PASSWORD, CMTK_TEST_TOTP_SEED: "" });
    const c = (fill) => ({ id: "p", safe: true, request: { method: "POST", path: "/" }, journey: { goal: "g", steps: [
        { goto: "/" }, { fill: { label: "Password" }, with_env: "CMTK_TEST_PASSWORD" }, { click: { role: "button", name: "Next" } },
        { fill: { label: "Code" }, ...fill }, { check: "c", see: { role: "heading" } },
    ] } });
    try {
        assert.match((await ad.run(c({ with_totp_env: "CMTK_TEST_TOTP_SEED" }), { name: "t", base_url: site.url })).error, /step 4: the environment variable CMTK_TEST_TOTP_SEED is not set/);
        assert.match((await ad.run(c({ with_code_from: "mailbox" }), { name: "t", base_url: site.url })).error, /step 4: reading a code from mailbox is not wired/);
    } finally {
        await ad.close(); await site.close();
    }
});

/** A site that registers a passkey and signs in with it, and checks the signature itself. */
function passkeySite() {
    let key, credentialId, challenge;
    const page = `<!doctype html><title>Passkey</title><h1>Passkeys</h1><button id="r">Register</button><button id="s">Sign in</button><p data-testid="state">none</p>
<script>
const b = (x) => btoa(String.fromCharCode(...new Uint8Array(x)));
const u = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const state = document.querySelector("[data-testid=state]");
const post = (p, d) => fetch(p, { method: "POST", body: JSON.stringify(d) }).then((r) => r.json());
r.onclick = async () => {
  const { challenge } = await fetch("/challenge").then((x) => x.json());
  const c = await navigator.credentials.create({ publicKey: { challenge: u(challenge), rp: { name: "Test", id: "localhost" }, user: { id: u("AAAA"), name: "test", displayName: "Test" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required", userVerification: "required" } } });
  state.textContent = (await post("/register", { id: b(c.rawId), key: b(c.response.getPublicKey()), client: b(c.response.clientDataJSON) })).state;
};
s.onclick = async () => {
  const { challenge, id } = await fetch("/challenge").then((x) => x.json());
  const a = await navigator.credentials.get({ publicKey: { challenge: u(challenge), rpId: "localhost", allowCredentials: [{ type: "public-key", id: u(id) }], userVerification: "required" } });
  state.textContent = (await post("/signin", { auth: b(a.response.authenticatorData), client: b(a.response.clientDataJSON), sig: b(a.response.signature) })).state;
};
</script>`;
    return serve(async (req, res) => {
        const url = new URL(req.url, "http://x");
        const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
        if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
        if (url.pathname === "/challenge") { challenge = crypto.randomBytes(32).toString("base64"); return json({ challenge, id: credentialId }); }
        let raw = ""; for await (const d of req) raw += d;
        const body = JSON.parse(raw);
        const client = JSON.parse(Buffer.from(body.client, "base64").toString("utf8"));
        const sent = Buffer.from(client.challenge, "base64url").toString("base64");
        if (url.pathname === "/register") {
            key = crypto.createPublicKey({ key: Buffer.from(body.key, "base64"), format: "der", type: "spki" });
            credentialId = body.id;
            return json({ state: sent === challenge && client.type === "webauthn.create" ? "registered" : "bad challenge" });
        }
        if (url.pathname === "/signin") {
            const signed = Buffer.concat([Buffer.from(body.auth, "base64"), crypto.createHash("sha256").update(Buffer.from(body.client, "base64")).digest()]);
            const ok = sent === challenge && crypto.verify("sha256", signed, key, Buffer.from(body.sig, "base64"));
            return json({ state: ok ? "signed in" : "bad signature" });
        }
        res.writeHead(404); res.end();
    });
}

for (const authenticator of ["passkey", "security-key"]) {
    test(`a ${authenticator} through a virtual authenticator: no hardware, and the site verifies a real signature`, web, async () => {
        const site = await passkeySite();
        const ad = adapter();
        const steps = [
            { goto: "/" }, { click: { role: "button", name: "Register" } },
            { reach: "registered", see: { text: "registered" } }, { click: { role: "button", name: "Sign in" } }, { reach: "signed in", see: { text: "signed in" } },
            { read: "state", from: { testid: "state" } }, { check: "the site accepted the signature", value: "state", equals: "signed in" },
        ];
        try {
            const url = site.url.replace("127.0.0.1", "localhost");
            const o = await ad.run({ id: "p", safe: true, request: { method: "POST", path: "/" }, journey: { goal: "Sign in with a passkey", authenticator, step_timeout_ms: 5000, steps } }, { name: "t", base_url: url });
            assert.equal(o.error, undefined);
            assert.equal(o.journey.passed, true, JSON.stringify(o.journey));
            assert.ok(!JSON.stringify({ ...o, screenshots: [] }).toLowerCase().includes("privatekey"));
        } finally {
            await ad.close(); await site.close();
        }
    });
}

test("an authenticator of another kind is refused", web, async () => {
    const ad = adapter();
    const site = await passkeySite();
    try {
        const o = await ad.run({ id: "p", request: { method: "GET", path: "/" }, journey: { goal: "g", authenticator: "phone", steps: [{ goto: "/" }, { check: "c", see: { role: "heading" } }] } }, { name: "t", base_url: site.url });
        assert.match(o.error, /authenticator must be passkey or security-key/);
    } finally {
        await ad.close(); await site.close();
    }
});
