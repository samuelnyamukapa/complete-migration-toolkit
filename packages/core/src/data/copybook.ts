// COBOL copybooks: the layout of a fixed-width record, read into a target model like any other schema, and
// records encoded and decoded from it, in ASCII or EBCDIC (code page 037). Written here rather than taken from a
// package so the toolkit stays free of a pre-1.0 dependency, and so REDEFINES can be noted instead of refused.
//
// Money stays text when it has more digits than a JavaScript number holds: PIC S9(16)V99 is not safe as a number.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ManifestError } from "../manifest.js";
import type { Field, TargetModel } from "./schema.js";

export type RecordEncoding = "cp037" | "ascii";

type Usage = "display" | "comp3" | "binary";

export interface CopyItem {
    level: number;
    name: string;
    /** Absent on a group. */
    pic?: { kind: "alnum" | "numeric"; length: number; digits: number; scale: number; signed: boolean };
    usage: Usage;
    sign?: "leading" | "trailing";
    occurs?: { min: number; max: number; depending?: string };
    children: CopyItem[];
    /** Bytes one occurrence takes. */
    size: number;
}

export interface Layout {
    name: string;
    items: CopyItem[];
    /** The size of a record: every OCCURS at its largest. */
    record_size: number;
    /** Counter fields of OCCURS DEPENDING ON, set from the array's length rather than generated. */
    counters: string[];
    notes: string[];
}

// ---------------------------------------------------------------- reading a copybook

function statements(text: string): string[] {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => {
        // Fixed format: columns 1 to 6 are a sequence number, 7 marks a comment, and 73 onward is ignored.
        const fixed = /^[ \d]{6}[ *\/-]/.test(l) || /^.{6}[*\/]/.test(l);
        if (fixed) return l[6] === "*" || l[6] === "/" ? "" : l.slice(7, 72);
        return l.trimStart().startsWith("*") ? "" : l;
    });
    return lines.join(" ").split(/\.(?=\s|$)/).map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

function parsePic(raw: string, where: string): NonNullable<CopyItem["pic"]> {
    const s = raw.toUpperCase().replace(/([9XAVSP])\((\d+)\)/g, (_, c: string, n: string) => c.repeat(Number(n)));
    if (/^[XA]+$/.test(s)) return { kind: "alnum", length: s.length, digits: 0, scale: 0, signed: false };
    const m = /^(S?)(9*)(?:V(9*))?$/.exec(s);
    if (!m || (!m[2] && !m[3])) throw new ManifestError(`${where}: PIC ${raw} is not supported. Supported: X, A, 9, S and V, with (n) repeats.`);
    const digits = (m[2]?.length ?? 0) + (m[3]?.length ?? 0);
    return { kind: "numeric", length: digits, digits, scale: m[3]?.length ?? 0, signed: m[1] === "S" };
}

function binarySize(digits: number) { return digits <= 4 ? 2 : digits <= 9 ? 4 : 8; }

function itemSize(i: CopyItem): number {
    if (i.children.length) return i.children.reduce((n, c) => n + c.size * (c.occurs?.max ?? 1), 0);
    const p = i.pic!;
    if (p.kind === "alnum" || i.usage === "display") return p.length + (i.sign ? 1 : 0);
    if (i.usage === "comp3") return Math.floor(p.digits / 2) + 1;
    return binarySize(p.digits);
}

export function parseCopybook(text: string, file = "copybook"): Layout {
    const notes: string[] = [];
    const roots: CopyItem[] = [];
    const stack: CopyItem[] = [];
    const counters: string[] = [];
    let filler = 0;
    let skipping: number | undefined;
    for (const st of statements(text)) {
        const m = /^(\d{1,2})\s+([A-Za-z0-9-]+)\b\s*(.*)$/.exec(st);
        if (!m) { if (/^(\d{1,2})$/.test(st)) continue; throw new ManifestError(`${file}: this line is not a data description: ${st.slice(0, 80)}`); }
        const level = Number(m[1]);
        const name = m[2]!.toUpperCase();
        const rest = m[3]!.toUpperCase();
        if (level === 88 || level === 66) continue; // condition names and RENAMES hold no bytes of their own
        if (skipping !== undefined) { if (level > skipping) continue; skipping = undefined; }
        const redefines = /\bREDEFINES\s+([A-Z0-9-]+)/.exec(rest);
        if (redefines) {
            notes.push(`${name} REDEFINES ${redefines[1]}: a second view of the same bytes. Rows follow ${redefines[1]}; a person decides if ${name} needs its own recipe.`);
            skipping = level;
            continue;
        }
        const pic = /\bPIC(?:TURE)?\s+(?:IS\s+)?([^\s]+)/.exec(rest);
        const usageWord = /\b(COMP-3|COMPUTATIONAL-3|PACKED-DECIMAL|COMP-5|COMP-4|COMPUTATIONAL-[45]|COMPUTATIONAL|COMP-[12]|COMP|BINARY)\b/.exec(rest)?.[1];
        if (usageWord && /-[12]$/.test(usageWord)) throw new ManifestError(`${file}: ${name} is ${usageWord}, a floating-point number, which is not supported.`);
        const usage: Usage = !usageWord ? "display" : /3|PACKED/.test(usageWord) ? "comp3" : "binary";
        const occurs = /\bOCCURS\s+(?:(\d+)\s+TO\s+)?(\d+)(?:\s+TIMES)?(?:\s+DEPENDING\s+(?:ON\s+)?([A-Z0-9-]+))?/.exec(rest);
        const signClause = /\bSIGN\s+(?:IS\s+)?(LEADING|TRAILING)\s+SEPARATE/.exec(rest) ?? /\b(LEADING|TRAILING)\s+SEPARATE/.exec(rest);
        const item: CopyItem = {
            level, name: name === "FILLER" ? `FILLER-${++filler}` : name, usage, children: [], size: 0,
            ...(pic ? { pic: parsePic(pic[1]!, `${file}: ${name}`) } : {}),
            ...(signClause ? { sign: signClause[1]!.toLowerCase() as "leading" | "trailing" } : {}),
            ...(occurs ? { occurs: { min: occurs[1] ? Number(occurs[1]) : Number(occurs[2]), max: Number(occurs[2]), ...(occurs[3] ? { depending: occurs[3] } : {}) } } : {}),
        };
        if (occurs?.[3]) counters.push(occurs[3]);
        while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
        (stack.length ? stack[stack.length - 1]!.children : roots).push(item);
        stack.push(item);
    }
    if (!roots.length) throw new ManifestError(`${file}: no data descriptions found.`);
    const size = (i: CopyItem) => { i.children.forEach(size); i.size = itemSize(i); };
    roots.forEach(size);
    // A single 01 is the record; its name is not part of the data.
    const single = roots.length === 1 && roots[0]!.children.length > 0;
    const items = single ? roots[0]!.children : roots;
    return { name: single ? roots[0]!.name : path.basename(file), items, record_size: items.reduce((n, c) => n + c.size * (c.occurs?.max ?? 1), 0), counters, notes };
}

// ---------------------------------------------------------------- to the target model

const isFiller = (i: CopyItem) => /^FILLER-\d+$/.test(i.name);
const money = (digits: number) => digits > 15;

/** The JSON Schema one item means, with the source that justifies it. */
function schemaOf(i: CopyItem): Record<string, unknown> {
    if (i.children.length) {
        const kept = i.children.filter((c) => !isFiller(c));
        return { type: "object", additionalProperties: false, required: kept.map((c) => c.name).filter((n) => !countersIn(i).has(n)), properties: Object.fromEntries(kept.filter((c) => !countersIn(i).has(c.name)).map((c) => [c.name, wrap(c)])) };
    }
    const p = i.pic!;
    if (p.kind === "alnum") return { type: "string", maxLength: p.length };
    const int = "9".repeat(p.digits - p.scale) || "0";
    const whole = Number(`${int}${p.scale ? `.${"9".repeat(p.scale)}` : ""}`);
    if (money(p.digits)) return { type: "string", pattern: `^${p.signed ? "-?" : ""}\\d{1,${p.digits - p.scale}}${p.scale ? `\\.\\d{${p.scale}}` : ""}$`, description: `PIC ${p.signed ? "S" : ""}9(${p.digits - p.scale})${p.scale ? `V9(${p.scale})` : ""}: kept as text, because a number can't hold it exactly` };
    return { type: p.scale ? "number" : "integer", minimum: p.signed ? -whole : 0, maximum: whole, ...(p.scale ? { multipleOf: Number((10 ** -p.scale).toFixed(p.scale)) } : {}) };
}
const countersIn = (i: CopyItem) => new Set(i.children.flatMap((c) => (c.occurs?.depending ? [c.occurs.depending] : [])));

function wrap(i: CopyItem): Record<string, unknown> {
    const s = schemaOf(i);
    if (!i.occurs) return s;
    return { type: "array", minItems: i.occurs.min, maxItems: i.occurs.max, items: s };
}

export function schemaOfLayout(l: Layout): Record<string, unknown> {
    const top = new Set(l.counters);
    const kept = l.items.filter((c) => !isFiller(c) && !top.has(c.name));
    return { type: "object", additionalProperties: false, required: kept.map((c) => c.name), properties: Object.fromEntries(kept.map((c) => [c.name, wrap(c)])) };
}

export const isCopybook = (file: string) => /\.(cpy|cbl|cob|copy)$/i.test(file);

/** A copybook as a target model, so it takes the same recipe, boundaries and negatives as JSON. */
export function modelFromCopybook(file: string, collect: (schema: Record<string, unknown>, source: string) => Field[]): TargetModel & { layout: Layout } {
    const bytes = fs.readFileSync(file);
    const layout = parseCopybook(bytes.toString("utf8"), path.basename(file));
    const schema = schemaOfLayout(layout);
    return { source: { file, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }, schema, fields: collect(schema, `${path.basename(file)}#`), layout };
}

// ---------------------------------------------------------------- code page 037

// The 256 characters of IBM code page 037, in byte order, as written by Python's codec.
const CP037 = "0000000100020003009c00090086007f0097008d008e000b000c000d000e000f0010001100120013009d008500080087001800190092008f001c001d001e001f00800081008200830084000a0017001b00880089008a008b008c0005000600070090009100160093009400950096000400980099009a009b00140015009e001a002000a000e200e400e000e100e300e500e700f100a2002e003c0028002b007c002600e900ea00eb00e800ed00ee00ef00ec00df00210024002a0029003b00ac002d002f00c200c400c000c100c300c500c700d100a6002c0025005f003e003f00f800c900ca00cb00c800cd00ce00cf00cc0060003a002300400027003d002200d800610062006300640065006600670068006900ab00bb00f000fd00fe00b100b0006a006b006c006d006e006f00700071007200aa00ba00e600b800c600a400b5007e0073007400750076007700780079007a00a100bf00d000dd00de00ae005e00a300a500b700a900a700b600bc00bd00be005b005d00af00a800b400d7007b00410042004300440045004600470048004900ad00f400f600f200f300f5007d004a004b004c004d004e004f00500051005200b900fb00fc00f900fa00ff005c00f70053005400550056005700580059005a00b200d400d600d200d300d5003000310032003300340035003600370038003900b300db00dc00d900da009f";
const TO_UNI: string[] = Array.from({ length: 256 }, (_, i) => String.fromCharCode(parseInt(CP037.slice(i * 4, i * 4 + 4), 16)));
const TO_EBC = new Map(TO_UNI.map((c, i) => [c, i]));

export function encodeText(s: string, enc: RecordEncoding): Buffer {
    const out: number[] = [];
    for (const c of s) {
        if (enc === "ascii") {
            const code = c.codePointAt(0)!;
            if (code > 0x7e || (code < 0x20 && code !== 9)) throw new EncodeError(`the character ${JSON.stringify(c)} is not in ASCII`);
            out.push(code);
        } else {
            const b = TO_EBC.get(c);
            if (b === undefined) throw new EncodeError(`the character ${JSON.stringify(c)} is not in code page 037`);
            out.push(b);
        }
    }
    return Buffer.from(out);
}
export const decodeText = (b: Buffer, enc: RecordEncoding) => (enc === "ascii" ? b.toString("latin1") : [...b].map((x) => TO_UNI[x]!).join(""));

export class EncodeError extends Error {}

// ---------------------------------------------------------------- numbers

/** A number as whole units of its scale, exactly: "12.34" at scale 2 is 1234n. */
function scaled(v: unknown, p: NonNullable<CopyItem["pic"]>, name: string): bigint {
    // Never rounded: a value with too many places is refused below.
    const text = typeof v === "number" && String(v).includes("e") ? v.toFixed(p.scale) : String(v ?? "0");
    const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (!m || (!m[2] && !m[3])) throw new EncodeError(`${name}: ${JSON.stringify(v)} is not a number`);
    const frac = m[3] ?? "";
    if (frac.replace(/0+$/, "").length > p.scale) throw new EncodeError(`${name}: ${text} has more than ${p.scale} decimal places`);
    const n = BigInt(`${m[2] || "0"}${frac.padEnd(p.scale, "0").slice(0, p.scale)}`);
    if (m[1] && !p.signed && n !== 0n) throw new EncodeError(`${name}: ${text} is negative but the field has no sign`);
    if (n.toString().length > p.digits) throw new EncodeError(`${name}: ${text} does not fit in ${p.digits} digits`);
    return m[1] ? -n : n;
}

function unscaled(n: bigint, p: NonNullable<CopyItem["pic"]>): string {
    const neg = n < 0n;
    const d = (neg ? -n : n).toString().padStart(p.scale + 1, "0");
    return `${neg ? "-" : ""}${p.scale ? `${d.slice(0, -p.scale)}.${d.slice(-p.scale)}` : d}`;
}

// Zoned decimal: the sign is in the last digit. ASCII uses the overpunch letters; EBCDIC, the zone nibble.
const OVER_POS = "{ABCDEFGHI", OVER_NEG = "}JKLMNOPQR";

function encodeDisplay(n: bigint, i: CopyItem, enc: RecordEncoding): Buffer {
    const p = i.pic!;
    const digits = (n < 0n ? -n : n).toString().padStart(p.digits, "0");
    if (i.sign) {
        const body = encodeText(digits, enc), mark = encodeText(n < 0n ? "-" : "+", enc);
        return i.sign === "leading" ? Buffer.concat([mark, body]) : Buffer.concat([body, mark]);
    }
    const out = encodeText(digits, enc);
    if (p.signed) {
        const last = Number(digits[digits.length - 1]);
        if (enc === "ascii") out[out.length - 1] = (n < 0n ? OVER_NEG : OVER_POS).charCodeAt(last);
        else out[out.length - 1] = ((n < 0n ? 0xd : 0xc) << 4) | last;
    }
    return out;
}

function decodeDisplay(b: Buffer, i: CopyItem, enc: RecordEncoding): { value?: bigint; problem?: string } {
    const p = i.pic!;
    let body = b;
    let neg = false;
    if (i.sign) {
        const mark = decodeText(i.sign === "leading" ? b.subarray(0, 1) : b.subarray(b.length - 1), enc);
        if (mark !== "+" && mark !== "-") return { problem: `sign byte ${JSON.stringify(mark)}` };
        neg = mark === "-";
        body = i.sign === "leading" ? b.subarray(1) : b.subarray(0, b.length - 1);
    }
    let text = decodeText(body, enc);
    if (p.signed && !i.sign) {
        const raw = body[body.length - 1]!;
        let d: number;
        if (enc === "ascii") {
            const c = String.fromCharCode(raw);
            const a = OVER_POS.indexOf(c), o = OVER_NEG.indexOf(c);
            if (a >= 0) d = a;
            else if (o >= 0) { d = o; neg = true; } else if (/\d/.test(c)) d = Number(c);
            else return { problem: `sign byte ${JSON.stringify(c)}` };
        } else {
            const zone = raw >> 4;
            d = raw & 0xf;
            if (d > 9 || ![0xc, 0xd, 0xf].includes(zone)) return { problem: `sign byte 0x${raw.toString(16)}` };
            neg = zone === 0xd;
        }
        text = text.slice(0, -1) + d;
    }
    if (!/^\d+$/.test(text)) return { problem: `not digits: ${JSON.stringify(text)}` };
    return { value: neg ? -BigInt(text) : BigInt(text) };
}

/** Packed decimal: two digits a byte, and the last nibble is the sign (C plus, D minus, F unsigned). */
export function encodePacked(n: bigint, digits: number, signed: boolean, signNibble?: number): Buffer {
    const size = Math.floor(digits / 2) + 1;
    const text = (n < 0n ? -n : n).toString().padStart(size * 2 - 1, "0");
    const nibbles = [...text].map(Number);
    nibbles.push(signNibble ?? (signed ? (n < 0n ? 0xd : 0xc) : 0xf));
    return Buffer.from(Array.from({ length: size }, (_, i) => (nibbles[i * 2]! << 4) | nibbles[i * 2 + 1]!));
}

function decodePacked(b: Buffer): { value?: bigint; problem?: string } {
    let digits = "";
    for (const x of b) digits += (x >> 4).toString(16) + (x & 0xf).toString(16);
    const sign = parseInt(digits[digits.length - 1]!, 16);
    const body = digits.slice(0, -1);
    if (!/^\d+$/.test(body)) return { problem: `packed digits ${digits}` };
    if (![0xc, 0xd, 0xf, 0xa, 0xe, 0xb].includes(sign)) return { problem: `sign nibble 0x${sign.toString(16)}` };
    return { value: sign === 0xd || sign === 0xb ? -BigInt(body) : BigInt(body) };
}

function encodeBinary(n: bigint, size: number): Buffer {
    const out = Buffer.alloc(size);
    let v = BigInt.asUintN(size * 8, n);
    for (let i = size - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
}
function decodeBinary(b: Buffer, signed: boolean): bigint {
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    return signed ? BigInt.asIntN(b.length * 8, v) : v;
}

// ---------------------------------------------------------------- records

function encodeLeaf(i: CopyItem, v: unknown, enc: RecordEncoding): Buffer {
    const p = i.pic!;
    if (p.kind === "alnum") {
        const s = v === undefined || v === null ? "" : String(v);
        if ([...s].length > p.length) throw new EncodeError(`${i.name}: ${[...s].length} characters do not fit in ${p.length}`);
        return encodeText(s.padEnd(p.length, " "), enc);
    }
    const n = scaled(v ?? 0, p, i.name);
    if (i.usage === "comp3") return encodePacked(n, p.digits, p.signed);
    if (i.usage === "binary") return encodeBinary(n, binarySize(p.digits));
    return encodeDisplay(n, i, enc);
}

const pad = (size: number, enc: RecordEncoding) => Buffer.alloc(size, enc === "ascii" ? 0x20 : 0x40);

function encodeItems(items: CopyItem[], value: Record<string, unknown>, enc: RecordEncoding, parts: Buffer[]) {
    // A counter is set from its array's length, whatever is in the row.
    const counted = new Map(items.filter((c) => c.occurs?.depending).map((c) => [c.occurs!.depending!, Array.isArray(value[c.name]) ? (value[c.name] as unknown[]).length : c.occurs!.min]));
    for (const i of items) {
        if (isFiller(i)) { parts.push(pad(i.size * (i.occurs?.max ?? 1), enc)); continue; }
        const one = (v: unknown) => {
            if (i.children.length) encodeItems(i.children, (v ?? {}) as Record<string, unknown>, enc, parts);
            else parts.push(encodeLeaf(i, counted.has(i.name) ? counted.get(i.name) : v, enc));
        };
        if (!i.occurs) { one(value[i.name]); continue; }
        const list = Array.isArray(value[i.name]) ? (value[i.name] as unknown[]) : [];
        if (list.length > i.occurs.max) throw new EncodeError(`${i.name}: ${list.length} items do not fit in OCCURS ${i.occurs.max}`);
        if (list.length < i.occurs.min) throw new EncodeError(`${i.name}: ${list.length} items is fewer than OCCURS ${i.occurs.min}`);
        list.forEach(one);
        // A fixed-length record keeps room for every occurrence: unused ones are spaces.
        if (list.length < i.occurs.max) parts.push(pad(i.size * (i.occurs.max - list.length), enc));
    }
}

/** One record as bytes, exactly `record_size` long. Throws EncodeError when a value can't be held. */
export function encodeRecord(l: Layout, value: Record<string, unknown>, enc: RecordEncoding): Buffer {
    const parts: Buffer[] = [];
    encodeItems(l.items, value, enc, parts);
    const out = Buffer.concat(parts);
    if (out.length !== l.record_size) throw new EncodeError(`the record came out ${out.length} bytes, not ${l.record_size}`);
    return out;
}

/** One record decoded. Numbers come back as text, exact. Anything the layout doesn't allow is a problem, not a guess. */
export function decodeRecord(l: Layout, b: Buffer, enc: RecordEncoding): { value: Record<string, unknown>; problems: string[] } {
    const problems: string[] = [];
    let at = 0;
    const leaf = (i: CopyItem, where: string): unknown => {
        const p = i.pic!;
        const bytes = b.subarray(at, at + i.size);
        at += i.size;
        if (p.kind === "alnum") return decodeText(bytes, enc).replace(/ +$/, "");
        if (i.usage === "binary") return unscaled(decodeBinary(bytes, p.signed), p);
        const r = i.usage === "comp3" ? decodePacked(bytes) : decodeDisplay(bytes, i, enc);
        if (r.problem) { problems.push(`${where}: ${r.problem}`); return null; }
        return unscaled(r.value!, p);
    };
    const walk = (items: CopyItem[], prefix: string): Record<string, unknown> => {
        const o: Record<string, unknown> = {};
        for (const i of items) {
            const where = prefix ? `${prefix}.${i.name}` : i.name;
            const one = (w: string) => (i.children.length ? walk(i.children, w) : leaf(i, w));
            if (isFiller(i)) { at += i.size * (i.occurs?.max ?? 1); continue; }
            if (!i.occurs) { o[i.name] = one(where); continue; }
            let count = i.occurs.max;
            if (i.occurs.depending) {
                const n = Number(o[i.occurs.depending]);
                if (!Number.isInteger(n) || n < i.occurs.min || n > i.occurs.max) {
                    problems.push(`${where}: OCCURS DEPENDING ON ${i.occurs.depending} is ${o[i.occurs.depending]}, outside ${i.occurs.min} to ${i.occurs.max}`);
                    count = Number.isInteger(n) ? Math.max(0, Math.min(n, i.occurs.max)) : 0;
                } else count = n;
            }
            o[i.name] = Array.from({ length: count }, (_, k) => one(`${where}[${k}]`));
            at += i.size * (i.occurs.max - count);
        }
        return o;
    };
    return { value: walk(l.items, ""), problems };
}

/** A whole file of records. The file length must be a multiple of the record size. */
export function decodeFile(l: Layout, b: Buffer, enc: RecordEncoding): { records: Record<string, unknown>[]; problems: string[] } {
    if (b.length % l.record_size !== 0) return { records: [], problems: [`the file is ${b.length} bytes, not a multiple of the record size ${l.record_size}`] };
    const records: Record<string, unknown>[] = [];
    const problems: string[] = [];
    for (let i = 0; i < b.length; i += l.record_size) {
        const r = decodeRecord(l, b.subarray(i, i + l.record_size), enc);
        records.push(r.value);
        problems.push(...r.problems.map((p) => `record ${i / l.record_size + 1}: ${p}`));
    }
    return { records, problems };
}

const walkLeaves = (items: CopyItem[], at = 0, out: { item: CopyItem; offset: number }[] = []) => {
    for (const i of items) {
        if (i.children.length) walkLeaves(i.children, at, out);
        else out.push({ item: i, offset: at });
        at += i.size * (i.occurs?.max ?? 1);
    }
    return out;
};

export interface EdgeFile { file: string; expect_valid: boolean; kind: string; why: string; bytes: Buffer }

/** Edge records a mainframe file can hold and a generator rarely writes, each labelled with what it should do. */
export function fixedEdges(l: Layout, value: Record<string, unknown>, enc: RecordEncoding): EdgeFile[] {
    const base = encodeRecord(l, value, enc);
    const out: EdgeFile[] = [
        { file: "empty.dat", kind: "file", expect_valid: true, why: "no records at all: the length is a multiple of the record size", bytes: Buffer.alloc(0) },
        { file: "one_record.dat", kind: "file", expect_valid: true, why: "one record", bytes: base },
        { file: "truncated.dat", kind: "file", expect_valid: false, why: "the file length is not a multiple of the record size", bytes: base.subarray(0, Math.max(1, base.length - 1)) },
    ];
    const leaves = walkLeaves(l.items);
    const packed = leaves.find((x) => x.item.usage === "comp3" && x.item.pic?.kind === "numeric");
    if (packed) {
        const end = packed.offset + packed.item.size - 1;
        const nibble = (n: number, valid: boolean, name: string, why: string) => {
            const b = Buffer.from(base);
            b[end] = (b[end]! & 0xf0) | n;
            out.push({ file: `${packed.item.name}_sign_${name}.dat`, kind: "sign-nibble", expect_valid: valid, why: `${packed.item.name}: sign nibble 0x${n.toString(16)}, ${why}`, bytes: b });
        };
        nibble(0xc, true, "c", "positive");
        nibble(0xd, true, "d", "negative");
        nibble(0xf, true, "f", "unsigned");
        nibble(0xa, true, "a", "an alternate plus: legal, and often mishandled");
        const bad = Buffer.from(base);
        bad[end] = (bad[end]! & 0xf0) | 0x5;
        out.push({ file: `${packed.item.name}_sign_invalid.dat`, kind: "sign-nibble", expect_valid: false, why: `${packed.item.name}: 0x5 is a digit, not a sign`, bytes: bad });
    }
    const zoned = leaves.find((x) => x.item.usage === "display" && x.item.pic?.kind === "numeric" && x.item.pic.signed && !x.item.sign);
    if (zoned) {
        const b = Buffer.from(base);
        b[zoned.offset + zoned.item.size - 1] = enc === "ascii" ? 0x21 : 0x5a;
        out.push({ file: `${zoned.item.name}_sign_invalid.dat`, kind: "sign-nibble", expect_valid: false, why: `${zoned.item.name}: the last byte holds no sign and no digit`, bytes: b });
    }
    const odo = l.items.find((i) => i.occurs?.depending);
    if (odo) {
        const counter = leaves.find((x) => x.item.name === odo.occurs!.depending);
        if (counter) {
            const setTo = (n: number) => {
                const b = Buffer.from(base);
                encodeLeaf(counter.item, n, enc).copy(b, counter.offset);
                return b;
            };
            out.push({ file: `${odo.name}_depending_above_max.dat`, kind: "occurs-depending-on", expect_valid: false, why: `${counter.item.name} says ${odo.occurs!.max + 1}, above OCCURS ${odo.occurs!.max}`, bytes: setTo(odo.occurs!.max + 1) });
            if (odo.occurs!.min > 0) out.push({ file: `${odo.name}_depending_below_min.dat`, kind: "occurs-depending-on", expect_valid: false, why: `${counter.item.name} says ${odo.occurs!.min - 1}, below OCCURS ${odo.occurs!.min}`, bytes: setTo(odo.occurs!.min - 1) });
        }
    }
    return out;
}
