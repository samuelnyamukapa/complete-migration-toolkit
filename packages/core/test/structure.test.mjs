// The `structure` and `visual` match levels, with no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { compareObservations, covers, decodePng, diffScreens, loadManifest, ManifestError, MATCH_LEVELS } from "../dist/index.js";

const NONE = { scrub: { json_paths: [], xml_ignore: [], regex: [] }, compare_headers: ["content-type"] };
const page = (elements, name = "/shop") => ({ status: 200, structure: { pages: [{ page: name, elements }] } });
const diff = (a, b, m = NONE, level = "structure") => compareObservations(page(a), page(b), m, level);
const BUTTON = { role: "button", name: "Buy" }, HEADING = { role: "heading", name: "Shop", level: 1 }, FIELD = { role: "textbox", name: "Email" };

test("structure and visual are match levels", () => {
    assert.ok(MATCH_LEVELS.includes("structure"));
    assert.ok(MATCH_LEVELS.includes("visual"));
});

test("structure: the same elements in the same order match, whatever the body and headers say", () => {
    const a = { ...page([HEADING, BUTTON]), headers: { "content-type": "a" }, body: "<div class=old>" };
    const b = { ...page([HEADING, BUTTON]), headers: { "content-type": "b" }, body: "<section class=new>" };
    assert.deepEqual(compareObservations(a, b, NONE, "structure"), []);
});

test("structure: a missing button is reported once, with a where a person can approve", () => {
    const d = diff([HEADING, BUTTON, FIELD], [HEADING, FIELD]);
    assert.deepEqual(d, [{ where: 'structure:/shop button "Buy"', reference: "(element)", candidate: "(missing)" }]);
    assert.ok(covers('structure:/shop button "Buy"', d[0].where));
    assert.ok(covers("structure:/shop *", d[0].where));
    assert.ok(!covers('structure:/other button "Buy"', d[0].where));
});

test("structure: an added element, a changed label and a changed status are each reported", () => {
    assert.deepEqual(diff([HEADING], [HEADING, BUTTON]).map((x) => [x.where, x.candidate]), [['structure:/shop button "Buy"', "(element)"]]);
    assert.deepEqual(diff([{ role: "button", name: "Buy" }], [{ role: "button", name: "Purchase" }]).map((x) => x.where).sort(), ['structure:/shop button "Buy"', 'structure:/shop button "Purchase"']);
    const a = page([BUTTON]), b = { ...page([BUTTON]), status: 500 };
    assert.equal(compareObservations(a, b, NONE, "structure")[0].where, "status");
});

test("structure: an element in another order reads as moved, once, not as missing", () => {
    const d = diff([HEADING, BUTTON, FIELD], [HEADING, FIELD, BUTTON]);
    assert.equal(d.length, 1);
    assert.match(d[0].where, /^structure:\/shop (button "Buy"|textbox "Email") \(moved\)$/);
});

test("structure: facts about an element, and a repeated element by number", () => {
    assert.deepEqual(diff([{ ...FIELD, required: true }], [FIELD]), [{ where: 'structure:/shop textbox "Email" required', reference: "true", candidate: "(none)" }]);
    assert.equal(diff([{ ...HEADING, level: 1 }], [{ ...HEADING, level: 2 }])[0].where, 'structure:/shop heading "Shop" level');
    assert.deepEqual(diff([BUTTON, BUTTON], [BUTTON]), [{ where: 'structure:/shop button "Buy" [2]', reference: "(element)", candidate: "(missing)" }]);
});

test("structure: scrubs let dates and prices change, and hide nothing else", () => {
    const m = { ...NONE, scrub: { json_paths: [], xml_ignore: [], regex: [{ pattern: "£[0-9.]+" }, { pattern: "\\d{4}-\\d{2}-\\d{2}" }] } };
    const a = [{ role: "StaticText", name: "Today 2026-11-04" }, { role: "StaticText", name: "£49.00" }, { role: "textbox", name: "Due", value: "2026-01-01" }];
    const b = [{ role: "StaticText", name: "Today 2027-01-01" }, { role: "StaticText", name: "£55.50" }, { role: "textbox", name: "Due", value: "2027-02-02" }];
    assert.deepEqual(diff(a, b, m), []);
    assert.equal(diff(a, b).length, 5, "with no scrub, every one differs");
    assert.equal(diff([...a, BUTTON], b, m).length, 1);
});

test("structure: a page on one system only is named, and nothing to compare never reads as a match", () => {
    const a = { status: 200, structure: { pages: [{ page: "/a", elements: [BUTTON] }, { page: "/b", elements: [BUTTON] }] } };
    const b = { status: 200, structure: { pages: [{ page: "/a", elements: [BUTTON] }] } };
    assert.deepEqual(compareObservations(a, b, NONE, "structure"), [{ where: "structure:/b", reference: "(page)", candidate: "(missing)" }]);
    assert.equal(compareObservations({ status: 200 }, { status: 200 }, NONE, "structure")[0].where, "structure");
    assert.equal(diff([], [])[0].where, "structure", "a page with no elements is not a match");
});

test("structure: page text cannot break a report's where: control characters go, long names are cut", () => {
    const d = diff([{ role: "button", name: `Buy\u0007\nnow ${"x".repeat(200)}` }], [{ role: "link", name: "y" }]);
    assert.ok(!/[\u0000-\u001f]/.test(d[0].where));
    assert.ok(d[0].where.length < 120);
});

// ---------------------------------------------------------------- screenshots

function crc(buf) {
    let c, r = 0xffffffff;
    for (const b of buf) { c = (r ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; }
    return (r ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const t = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
}
/** A PNG of 10 by 10 from a colour function, using one filter on every row. */
function png(colour, { filter = 0, channels = 4 } = {}) {
    const w = 10, h = 10;
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
    const rows = [];
    let prev = Buffer.alloc(w * channels);
    for (let y = 0; y < h; y++) {
        const row = Buffer.alloc(w * channels);
        for (let x = 0; x < w; x++) { const [r, g, b] = colour(x, y); row.set(channels === 4 ? [r, g, b, 255] : [r, g, b], x * channels); }
        const line = Buffer.alloc(w * channels);
        for (let i = 0; i < line.length; i++) {
            const left = i >= channels ? row[i - channels] : 0, up = prev[i], corner = i >= channels ? prev[i - channels] : 0;
            let p = 0;
            if (filter === 1) p = left;
            if (filter === 2) p = up;
            if (filter === 3) p = (left + up) >> 1;
            if (filter === 4) { const q = left + up - corner, a = Math.abs(q - left), b = Math.abs(q - up), c = Math.abs(q - corner); p = a <= b && a <= c ? left : b <= c ? up : corner; }
            line[i] = (row[i] - p) & 0xff;
        }
        rows.push(Buffer.from([filter]), line);
        prev = row;
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const shot = (buf, name = "/shop") => [{ page: name, png_base64: buf.toString("base64") }];
const white = () => [255, 255, 255];
const dot = (x, y) => (x === 3 && y === 4 ? [0, 0, 0] : [255, 255, 255]);

test("the PNG reader reads every filter, with and without alpha", () => {
    const pattern = (x, y) => [x * 20, y * 20, (x + y) * 5];
    const want = decodePng(png(pattern)).rgba;
    for (const filter of [0, 1, 2, 3, 4]) {
        for (const channels of [3, 4]) {
            const got = decodePng(png(pattern, { filter, channels }));
            assert.deepEqual([got.width, got.height], [10, 10]);
            assert.deepEqual(got.rgba, want, `filter ${filter}, ${channels} channels`);
        }
    }
    assert.throws(() => decodePng(Buffer.from("not a png, and long enough to be read as one")), /not a PNG/);
});

test("visual: pixels that differ are reported with how much and where; the same picture in other bytes matches", () => {
    assert.deepEqual(diffScreens(shot(png(white)), shot(png(white, { filter: 1 }))), [], "other bytes, the same pixels");
    assert.deepEqual(diffScreens(shot(png(white)), shot(png(dot))), [{ where: "visual:/shop", reference: "10 by 10", candidate: "1.00% of pixels changed, within x 3, y 4, 1 by 1" }]);
});

test("visual: visual_tolerance lets a share of pixels change, and no more", () => {
    assert.deepEqual(diffScreens(shot(png(white)), shot(png(dot)), 0.01), []);
    assert.equal(diffScreens(shot(png(white)), shot(png(dot)), 0.005).length, 1);
});

test("visual: rounding in the drawing is not a change, a real colour change is", () => {
    assert.deepEqual(diffScreens(shot(png(white)), shot(png(() => [250, 250, 250]))), []);
    assert.equal(diffScreens(shot(png(white)), shot(png(() => [200, 200, 200]))).length, 1);
});

test("visual: a missing screenshot, a missing page and a bad file are each a difference, never a match", () => {
    assert.equal(diffScreens(undefined, undefined)[0].where, "visual");
    assert.deepEqual(diffScreens(shot(png(white)), [...shot(png(white)), ...shot(png(white), "/other")]), [{ where: "visual:/other", reference: "(missing)", candidate: "(screenshot)" }]);
    assert.match(diffScreens(shot(Buffer.from("x".repeat(40))), shot(png(white)))[0].candidate, /could not be read/);
});

test("visual: the level also compares structure, and structure never looks at a screenshot", () => {
    const a = { status: 200, ...page([BUTTON]), screenshots: shot(png(white)) };
    const b = { status: 200, ...page([BUTTON]), screenshots: shot(png(dot)) };
    assert.deepEqual(compareObservations(a, b, NONE, "structure"), []);
    assert.deepEqual(compareObservations(a, b, NONE, "visual").map((d) => d.where), ["visual:/shop"]);
    assert.deepEqual(compareObservations(a, { ...b, structure: { pages: [{ page: "/shop", elements: [HEADING] }] } }, { ...NONE, visual_tolerance: 1 }, "visual").map((d) => d.where).sort(), ['structure:/shop button "Buy"', 'structure:/shop heading "Shop"']);
});

test("visual_tolerance must be a share", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-structure-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets: { a: http://x }\nvisual_tolerance: 5\n");
    assert.throws(() => loadManifest(path.join(dir, "cmtk.yaml")), (e) => e instanceof ManifestError && /from 0 to 1/.test(e.message));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets: { a: http://x }\nmatch: structure\nvisual_tolerance: 0.01\n");
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    assert.equal(m.match, "structure");
    assert.equal(m.visual_tolerance, 0.01);
});
