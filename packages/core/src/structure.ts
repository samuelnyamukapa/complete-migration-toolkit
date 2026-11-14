// The `structure` and `visual` match levels. A reskin changes the look, but the elements must stay: the same
// roles, labels and order, from the accessibility tree. `visual` also compares screenshots, for an upgrade where
// the look must stay too. Every difference has a `where` a person can approve: the page, plus the role and name.
import zlib from "node:zlib";

import { clip, scrubText, type Scrubber } from "./diff.js";
import type { Difference, Observation, PageElement, PageStructure, Screenshot } from "./types.js";

const line = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();

const label = (e: PageElement) => `${line(e.role)}${e.name ? ` ${JSON.stringify(clip(line(e.name)))}` : ""}`;

/** The elements of a page with scrubs applied, each with a key: its role and name, numbered when one repeats. */
function keyed(elements: PageElement[], sc: Scrubber) {
    const seen = new Map<string, number>();
    return elements.map((raw) => {
        const e: PageElement = { ...raw, name: scrubText(line(raw.name), sc), ...(raw.value !== undefined ? { value: scrubText(line(raw.value), sc) } : {}) };
        const base = label(e);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        return { key: n === 1 ? base : `${base} [${n}]`, e };
    });
}

/** The longest list of keys both orders share; whatever is left out of it has moved. Gives up on a page too big to compare this way. */
function inOrder(a: string[], b: string[]): Set<string> | undefined {
    if (a.length * b.length > 25_000_000) return undefined;
    const t = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
        }
    }
    const kept = new Set<string>();
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { kept.add(a[i]!); i++; j++; }
        else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++;
        else j++;
    }
    return kept;
}

const FACTS = ["level", "value", "required", "disabled", "checked", "readonly"] as const;

function diffPage(page: string, a: PageElement[], b: PageElement[], sc: Scrubber, out: Difference[]) {
    const where = (what: string) => `structure:${page} ${what}`;
    const x = keyed(a, sc), y = keyed(b, sc);
    const mx = new Map(x.map((v) => [v.key, v.e])), my = new Map(y.map((v) => [v.key, v.e]));
    for (const { key } of x) if (!my.has(key)) out.push({ where: where(key), reference: "(element)", candidate: "(missing)" });
    for (const { key } of y) if (!mx.has(key)) out.push({ where: where(key), reference: "(missing)", candidate: "(element)" });
    for (const { key, e } of x) {
        const other = my.get(key);
        if (!other) continue;
        for (const f of FACTS) {
            if (String(e[f] ?? "") !== String(other[f] ?? "")) out.push({ where: where(`${key} ${f}`), reference: String(e[f] ?? "(none)"), candidate: String(other[f] ?? "(none)") });
        }
    }
    const cx = x.map((v) => v.key).filter((k) => my.has(k)), cy = y.map((v) => v.key).filter((k) => mx.has(k));
    if (cx.join("\n") === cy.join("\n")) return;
    const kept = inOrder(cx, cy);
    if (!kept) { out.push({ where: where("order"), reference: `${cx.length} elements`, candidate: "in another order" }); return; }
    const before = (list: string[], key: string) => { const i = list.indexOf(key); return i > 0 ? `after ${list[i - 1]}` : "first"; };
    for (const key of cx) if (!kept.has(key)) out.push({ where: where(`${key} (moved)`), reference: before(cx, key), candidate: before(cy, key) });
}

export function diffStructure(a: Observation["structure"], b: Observation["structure"], sc: Scrubber): Difference[] {
    // A level that found nothing to compare must never read as a match.
    const empty = (s: Observation["structure"]) => !s?.pages?.length || s.pages.every((p) => !p.elements?.length);
    if (empty(a) || empty(b)) return [{ where: "structure", reference: empty(a) ? "(no structure reported)" : "(reported)", candidate: empty(b) ? "(no structure reported)" : "(reported)" }];
    const out: Difference[] = [];
    const byPage = (s: PageStructure[]) => new Map(s.map((p) => [line(p.page), p.elements ?? []]));
    const pa = byPage(a!.pages), pb = byPage(b!.pages);
    for (const page of new Set([...pa.keys(), ...pb.keys()])) {
        const ea = pa.get(page), eb = pb.get(page);
        if (!ea || !eb) { out.push({ where: `structure:${page}`, reference: ea ? "(page)" : "(missing)", candidate: eb ? "(page)" : "(missing)" }); continue; }
        diffPage(page, ea, eb, sc, out);
    }
    return out;
}

// ---------------------------------------------------------------- screenshots

export interface Pixels { width: number; height: number; rgba: Uint8Array }

/** Reads a PNG of 8 bits per channel (grey, RGB or RGBA, with or without alpha, not interlaced), which is what browsers write. */
export function decodePng(png: Buffer): Pixels {
    if (png.length < 33 || png.subarray(1, 4).toString("latin1") !== "PNG") throw new Error("not a PNG");
    let at = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
    const idat: Buffer[] = [];
    while (at + 8 <= png.length) {
        const size = png.readUInt32BE(at);
        const type = png.subarray(at + 4, at + 8).toString("latin1");
        const data = png.subarray(at + 8, at + 8 + size);
        if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; colour = data[9]!; interlace = data[12]!; }
        if (type === "IDAT") idat.push(data);
        if (type === "IEND") break;
        at += size + 12;
    }
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour];
    if (depth !== 8 || !channels || interlace) throw new Error(`a PNG this reader does not handle (depth ${depth}, colour type ${colour}, interlace ${interlace})`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) throw new Error("a PNG with too little data");
    const rgba = new Uint8Array(width * height * 4);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let i = 0; i < stride; i++) {
            const left = i >= channels ? row[i - channels]! : 0, up = prev[i]!, corner = i >= channels ? prev[i - channels]! : 0;
            let add = 0;
            if (filter === 1) add = left;
            else if (filter === 2) add = up;
            else if (filter === 3) add = (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
                add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
            }
            row[i] = (row[i]! + add) & 0xff;
        }
        for (let px = 0; px < width; px++) {
            const o = (y * width + px) * 4, s = px * channels;
            if (channels <= 2) { rgba[o] = rgba[o + 1] = rgba[o + 2] = row[s]!; rgba[o + 3] = channels === 2 ? row[s + 1]! : 255; }
            else { rgba[o] = row[s]!; rgba[o + 1] = row[s + 1]!; rgba[o + 2] = row[s + 2]!; rgba[o + 3] = channels === 4 ? row[s + 3]! : 255; }
        }
        prev = row;
    }
    return { width, height, rgba };
}

/** How far one colour value may move before a pixel counts as changed: it hides only rounding in the browser's drawing. */
const CHANNEL_SLACK = 16;

function diffPicture(a: Pixels, b: Pixels) {
    let changed = 0, left = a.width, top = a.height, right = -1, bottom = -1;
    for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
            const o = (y * a.width + x) * 4;
            let same = true;
            for (let c = 0; c < 4 && same; c++) same = Math.abs(a.rgba[o + c]! - b.rgba[o + c]!) <= CHANNEL_SLACK;
            if (same) continue;
            changed++;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    return { changed, box: `x ${left}, y ${top}, ${right - left + 1} by ${bottom - top + 1}` };
}

/** Page by page, pixel by pixel. `tolerance` is the share of pixels that may change, from 0 to 1. Masks were painted over by the adapter. */
export function diffScreens(a: Screenshot[] | undefined, b: Screenshot[] | undefined, tolerance = 0): Difference[] {
    if (!a?.length || !b?.length) return [{ where: "visual", reference: a?.length ? "(reported)" : "(no screenshot reported)", candidate: b?.length ? "(reported)" : "(no screenshot reported)" }];
    const out: Difference[] = [];
    const pa = new Map(a.map((s) => [line(s.page), s])), pb = new Map(b.map((s) => [line(s.page), s]));
    for (const page of new Set([...pa.keys(), ...pb.keys()])) {
        const sa = pa.get(page), sb = pb.get(page);
        if (!sa || !sb) { out.push({ where: `visual:${page}`, reference: sa ? "(screenshot)" : "(missing)", candidate: sb ? "(screenshot)" : "(missing)" }); continue; }
        if (sa.png_base64 === sb.png_base64) continue;
        let x: Pixels, y: Pixels;
        try {
            x = decodePng(Buffer.from(sa.png_base64, "base64"));
            y = decodePng(Buffer.from(sb.png_base64, "base64"));
        } catch (err) {
            out.push({ where: `visual:${page}`, reference: "the screenshots differ", candidate: `and could not be read to say how: ${(err as Error).message}` });
            continue;
        }
        if (x.width !== y.width || x.height !== y.height) { out.push({ where: `visual:${page} size`, reference: `${x.width} by ${x.height}`, candidate: `${y.width} by ${y.height}` }); continue; }
        const { changed, box } = diffPicture(x, y);
        const share = changed / Math.max(1, x.width * x.height);
        if (changed > 0 && share > tolerance) out.push({ where: `visual:${page}`, reference: `${x.width} by ${x.height}`, candidate: `${(share * 100).toFixed(2)}% of pixels changed, within ${box}` });
    }
    return out;
}
