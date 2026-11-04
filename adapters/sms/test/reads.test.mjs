// Finding 3 of the review of 0.6, on the real adapter and capture: a GET compares what each capture holds. It used to
// reset both first, so two different captures read as PARITY, with both emptied.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { startCapture } from "../capture.mjs";
import { cmtk, project } from "./helpers.mjs";

const started = async () => {
    const s = await startCapture();
    return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
};
const text = (url, body) => fetch(`${url}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "+15005550006", from: "A", text: body }) });
const held = async (url) => (await (await fetch(`${url}/__cmtk/messages`)).json());

test("GET /messages on two captures that differ is NO PARITY, and both keep their messages", async () => {
    const [a, b] = [await started(), await started()];
    await text(a.url, "Your parcel has shipped");
    await text(b.url, "Your order was cancelled");
    const dir = project(`system: shop
targets:
  legacy: { capture_url: ${a.url}, allow_numbers: "+15005550006" }
  candidate: { capture_url: ${b.url}, allow_numbers: "+15005550006" }
reference: legacy
adapters:
  sms: { command: node, args: [adapters/sms/index.mjs], covers: [sms] }
`, "cases:\n  - { id: LOOK, surface: sms, request: { method: GET, path: /messages } }\n");
    try {
        const r = await cmtk(dir, {}, "compare");
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /NO PARITY/);
        for (const url of [a.url, b.url]) {
            const left = await held(url);
            assert.equal((Array.isArray(left) ? left : left.messages).length, 1, "the capture must not be emptied by a read");
        }
    } finally {
        await a.close(); await b.close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});
