// The mailbox adapter over its real protocol, against local stand-ins for Mailpit and MailHog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { adapter, cmtk, mailhog, mailpit, project, receipt, system } from "./standins.mjs";

const GET = { id: "G", request: { method: "GET", path: "/mailbox" } };
const POST = { id: "P", request: { method: "POST", path: "/send", body: { template: "receipt" } } };

const EXPECTED_EMAIL = {
    from: "Shop <shop@example.test>",
    to: ["ann@example.test", "zed@example.test"],
    cc: ["copy@example.test"],
    bcc: ["hidden@example.test"],
    subject: "Your order: café",
    text: "Thanks.\nTrack it: https://shop.example.test/track/<masked>?lang=en&token=<masked>.",
    links: ["https://shop.example.test/track/<masked>?lang=en&token=<masked>"],
    attachments: [{ name: "receipt.pdf", type: "application/pdf", sha256: "(checked below)" }],
};
const withRealHash = (actual) => ({ ...EXPECTED_EMAIL, attachments: [{ ...EXPECTED_EMAIL.attachments[0], sha256: actual.attachments[0].sha256 }] });

for (const [label, make] of [["Mailpit", () => mailpit()], ["Mailpit without checksums", () => mailpit({ checksums: false })], ["MailHog", () => mailhog()]]) {
    test(`${label}: reports sender, sorted recipients, subject, text, masked links and hashed attachments, with no ids or dates`, async () => {
        const cap = await make();
        const sys = await system(cap, () => [receipt()]);
        const a = adapter();
        try {
            const target = { name: "legacy", base_url: sys.url, capture_url: cap.url, quiet_ms: 50 };
            const { reply, raw } = await a.call({ op: "run", case: POST, target, headers: {} });
            assert.equal(reply.error, undefined);
            assert.equal(reply.status, 202);
            assert.equal(reply.effects.emails.length, 1);
            const got = reply.effects.emails[0];
            assert.deepEqual(got, withRealHash(got));
            assert.match(got.attachments[0].sha256, /^[0-9a-f]{64}$/);
            assert.doesNotMatch(raw, /a1b2c3d4e5f6/, "the token is masked everywhere");
            assert.doesNotMatch(raw, /id-\d+|mailhog\.example|"Created"|"Date"|"ID"|"MessageID"/);
        } finally { await a.close(); await sys.close(); await cap.close(); }
    });
}

test("Mailpit and MailHog report the same email the same way", async () => {
    const [pit, hog] = [await mailpit(), await mailhog()];
    pit.deliver(receipt());
    hog.deliver(receipt());
    const a = adapter();
    try {
        const one = (await a.call({ op: "run", case: GET, target: { name: "a", capture_url: pit.url }, headers: {} })).reply;
        const two = (await a.call({ op: "run", case: GET, target: { name: "b", capture_url: hog.url }, headers: {} })).reply;
        assert.deepEqual(one.effects, two.effects);
        assert.equal(one.effects.emails.length, 1);
    } finally { await a.close(); await pit.close(); await hog.close(); }
});

test("a single-part MailHog message is read", async () => {
    const hog = await mailhog();
    hog.deliver({ from: { address: "a@x.test" }, to: [{ address: "b@x.test" }], subject: "plain", text: "café\n" });
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "run", case: GET, target: { name: "a", capture_url: hog.url }, headers: {} });
        assert.deepEqual(reply.effects.emails[0], { from: "a@x.test", to: ["b@x.test"], cc: [], bcc: [], subject: "plain", text: "café", links: [], attachments: [] });
    } finally { await a.close(); await hog.close(); }
});

test("waits until mail stops arriving, and reports only what this case caused", async () => {
    for (const make of [mailpit, mailhog]) {
        const cap = await make();
        cap.deliver({ ...receipt(), subject: "from an earlier case" });
        const sys = await system(cap, () => [{ ...receipt(), subject: "first" }, { ...receipt(), subject: "late" }], [0, 250]);
        const a = adapter();
        try {
            const target = { name: "legacy", base_url: sys.url, capture_url: cap.url, quiet_ms: 600 };
            const { reply } = await a.call({ op: "run", case: POST, target, headers: {} });
            assert.deepEqual(reply.effects.emails.map((e) => e.subject).sort(), ["first", "late"]);
        } finally { await a.close(); await sys.close(); await cap.close(); }
    }
});

test("mail still arriving after max_wait_ms is an error, not part of an answer", async () => {
    const cap = await mailpit();
    const sys = await system(cap, () => [0, 1, 2, 3, 4, 5, 6, 7].map(() => receipt()), [0, 60, 120, 180, 240, 300, 360, 420]);
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "run", case: POST, target: { name: "legacy", base_url: sys.url, capture_url: cap.url, quiet_ms: 150, max_wait_ms: 200 }, headers: {} });
        assert.match(reply.error, /still changing after 200 ms/);
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("more messages than one page are all read", async () => {
    for (const make of [mailpit, mailhog]) {
        const cap = await make();
        for (let i = 0; i < 205; i++) cap.deliver({ from: { address: "a@x.test" }, to: [{ address: "b@x.test" }], subject: `n${i}`, text: "t" });
        const a = adapter();
        try {
            const { reply } = await a.call({ op: "run", case: GET, target: { name: "a", capture_url: cap.url }, headers: {} });
            assert.equal(reply.effects.emails.length, 205);
        } finally { await a.close(); await cap.close(); }
    }
});

test("GET only observes: the system is not contacted and nothing is deleted", async () => {
    const cap = await mailpit();
    cap.deliver(receipt());
    const sys = await system(cap, () => [receipt()]);
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "run", case: GET, target: { name: "legacy", base_url: sys.url, capture_url: cap.url }, headers: {} });
        assert.equal(reply.effects.emails.length, 1);
        assert.equal(sys.state.connections, 0);
        assert.equal(cap.count(), 1);
        assert.ok(cap.state.requests.every((r) => r.method === "GET"));
    } finally { await a.close(); await sys.close(); await cap.close(); }
});

test("reset empties the mailbox on either server", async () => {
    for (const make of [mailpit, mailhog]) {
        const cap = await make();
        cap.deliver(receipt());
        const a = adapter();
        try {
            assert.deepEqual((await a.call({ op: "reset", target: { name: "x", capture_url: cap.url } })).reply, { ok: true });
            assert.equal(cap.count(), 0);
        } finally { await a.close(); await cap.close(); }
    }
});

test("describe names the adapter, its kind and its settings; unsupported request features are an error", async () => {
    const cap = await mailpit();
    const a = adapter();
    try {
        const { reply } = await a.call({ op: "describe" });
        assert.equal(reply.name, "mailbox");
        assert.deepEqual(reply.kinds, ["email"]);
        assert.ok(reply.settings.some((s) => s.name === "capture_url"));
        const bad = await a.call({ op: "run", case: { id: "x", request: { method: "POST", path: "/x", body_file: "a.json" } }, target: { name: "x", capture_url: cap.url, base_url: cap.url }, headers: {} });
        assert.match(bad.reply.error, /body_file/);
    } finally { await a.close(); await cap.close(); }
});

const manifest = (a, b) => `system: shop
targets:
  legacy: { base_url: ${a.sys}, capture_url: ${a.cap}, quiet_ms: 100 }
  candidate: { base_url: ${b.sys}, capture_url: ${b.cap}, quiet_ms: 100 }
reference: legacy
allow_unsafe_methods: true
adapters:
  mailbox: { command: node, args: [adapters/mailbox/index.mjs], covers: [email] }
`;

const CASES = `cases:
  - id: MAIL-RECEIPT
    surface: mailbox
    expect: { status: 202 }
    request:
      method: POST
      path: /send
      body: { template: receipt }
`;

test("the conformance kit passes through the real CLI, against Mailpit and against MailHog", async () => {
    for (const make of [mailpit, mailhog]) {
        const cap = await make();
        const sys = await system(cap, () => [receipt(`${Math.random().toString(16).slice(2)}aaaaaaaaaaaaaaaaaaaaaa`)]);
        const dir = project("mailbox", `system: shop\ntargets:\n  legacy: { base_url: ${sys.url}, capture_url: ${cap.url}, quiet_ms: 100 }\nadapters:\n  mailbox: { command: node, args: [adapters/mailbox/index.mjs] }\n`);
        try {
            const r = await cmtk(dir, {}, "adapter", "check", "mailbox", "--target", "legacy");
            assert.equal(r.status, 0, r.stdout + r.stderr);
            assert.match(r.stdout, /Adapter mailbox passes the conformance kit/);
            assert.match(r.stdout, /pass {2}MAIL-002: the same case twice gives the same observation/);
        } finally { await sys.close(); await cap.close(); }
    }
});

test("cmtk compare: two systems' same emails match, and a planted difference is caught", async () => {
    const [capA, capB] = [await mailpit(), await mailhog()];
    let subject = "Your order: café";
    const sysA = await system(capA, () => [receipt("aaaa1111bbbb2222cccc3333dddd4444")]);
    const sysB = await system(capB, () => [{ ...receipt("ffff9999eeee8888dddd7777cccc6666"), subject }]);
    const dir = project("mailbox", manifest({ sys: sysA.url, cap: capA.url }, { sys: sysB.url, cap: capB.url }), CASES);
    try {
        let r = await cmtk(dir, {}, "compare", "--allow-unsafe", "--json");
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8"), /MATCH|PARITY/);

        subject = "Your order";
        r = await cmtk(dir, {}, "compare", "--allow-unsafe", "--json");
        assert.equal(r.status, 1, r.stdout + r.stderr);
        const report = fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8");
        assert.match(report, /DIFFERENT/);
        assert.match(report, /effects:\$\.emails\[0\]\.subject/);
    } finally { await sysA.close(); await sysB.close(); await capA.close(); await capB.close(); }
});
