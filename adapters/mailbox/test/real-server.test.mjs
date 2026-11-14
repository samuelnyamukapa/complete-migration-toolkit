// Against a real capture server, for a CI job that starts one. Skipped without these variables:
//   CMTK_TEST_CAPTURE_URL   the API, such as http://127.0.0.1:8025
//   CMTK_TEST_CAPTURE_SMTP  its SMTP port on the same host, such as 1025
// The address must be a disposable capture server: this test empties it.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";

import { adapter } from "./standins.mjs";

const URL_ = process.env.CMTK_TEST_CAPTURE_URL, SMTP = Number(process.env.CMTK_TEST_CAPTURE_SMTP);

/** A small SMTP client: enough to hand one message to a capture server. */
function smtpSend(host, port, from, recipients, data) {
    return new Promise((resolve, reject) => {
        const steps = [`EHLO test`, `MAIL FROM:<${from}>`, ...recipients.map((r) => `RCPT TO:<${r}>`), "DATA", `${data}\r\n.`, "QUIT"];
        const s = net.connect(port, host);
        s.setEncoding("utf8");
        let buffer = "";
        s.on("data", (d) => {
            buffer += d;
            const lines = buffer.split("\r\n");
            buffer = lines.pop();
            for (const line of lines) {
                if (line[3] === "-") continue;
                if (Number(line.slice(0, 3)) >= 400) return reject(new Error(`SMTP: ${line}`));
                const next = steps.shift();
                if (next) s.write(`${next}\r\n`);
            }
        });
        s.on("close", resolve);
        s.on("error", reject);
    });
}

test("a real capture server: identified, read and emptied", { skip: URL_ && SMTP ? false : "set CMTK_TEST_CAPTURE_URL and CMTK_TEST_CAPTURE_SMTP" }, async () => {
    const a = adapter();
    const target = { name: "real", capture_url: URL_ };
    try {
        assert.deepEqual((await a.call({ op: "reset", target })).reply, { ok: true });
        const data = [
            "From: Shop <shop@example.test>", "To: Zed <zed@example.test>, ann@example.test", "Subject: =?UTF-8?B?Y2Fmw6k=?=", "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
            "Track: https://shop.example.test/t/a1b2c3d4e5f60718293a4b5c6d7e8f90", "--b1",
            'Content-Type: application/pdf; name="r.pdf"', 'Content-Disposition: attachment; filename="r.pdf"', "Content-Transfer-Encoding: base64", "",
            Buffer.from("%PDF-1.4").toString("base64"), "--b1--",
        ].join("\r\n");
        await smtpSend(new URL(URL_).hostname, SMTP, "shop@example.test", ["zed@example.test", "ann@example.test", "hidden@example.test"], data);
        await new Promise((r) => setTimeout(r, 500));
        const { reply } = await a.call({ op: "run", case: { id: "G", request: { method: "GET", path: "/" } }, target, headers: {} });
        assert.equal(reply.error, undefined);
        const sha256 = crypto.createHash("sha256").update("%PDF-1.4").digest("hex");
        assert.deepEqual(reply.effects.emails, [{
            from: "Shop <shop@example.test>", to: ["ann@example.test", "zed@example.test"], cc: [], bcc: ["hidden@example.test"], subject: "café",
            text: "Track: https://shop.example.test/t/<masked>", links: ["https://shop.example.test/t/<masked>"],
            attachments: [{ name: "r.pdf", type: "application/pdf", sha256 }],
        }]);
        assert.deepEqual((await a.call({ op: "reset", target })).reply, { ok: true });
        assert.deepEqual((await a.call({ op: "run", case: { id: "G", request: { method: "GET", path: "/" } }, target, headers: {} })).reply.effects.emails, []);
    } finally { await a.close(); }
});
