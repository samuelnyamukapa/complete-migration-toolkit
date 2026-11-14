// Reading fixed-width records from bytes: the layout file, EBCDIC, and mainframe numbers.
import fs from "node:fs";

/** IBM code page 037, byte to character, as Python's cp037 codec defines it. */
export const CP037 = (
    "\u0000\u0001\u0002\u0003\u009c\u0009\u0086\u007f\u0097\u008d\u008e\u000b\u000c\u000d\u000e\u000f" +
    "\u0010\u0011\u0012\u0013\u009d\u0085\u0008\u0087\u0018\u0019\u0092\u008f\u001c\u001d\u001e\u001f" +
    "\u0080\u0081\u0082\u0083\u0084\u000a\u0017\u001b\u0088\u0089\u008a\u008b\u008c\u0005\u0006\u0007" +
    "\u0090\u0091\u0016\u0093\u0094\u0095\u0096\u0004\u0098\u0099\u009a\u009b\u0014\u0015\u009e\u001a" +
    "\u0020\u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00a2\u002e\u003c\u0028\u002b\u007c" +
    "\u0026\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df\u0021\u0024\u002a\u0029\u003b\u00ac" +
    "\u002d\u002f\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6\u002c\u0025\u005f\u003e\u003f" +
    "\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u0060\u003a\u0023\u0040\u0027\u003d\u0022" +
    "\u00d8\u0061\u0062\u0063\u0064\u0065\u0066\u0067\u0068\u0069\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1" +
    "\u00b0\u006a\u006b\u006c\u006d\u006e\u006f\u0070\u0071\u0072\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4" +
    "\u00b5\u007e\u0073\u0074\u0075\u0076\u0077\u0078\u0079\u007a\u00a1\u00bf\u00d0\u00dd\u00de\u00ae" +
    "\u005e\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be\u005b\u005d\u00af\u00a8\u00b4\u00d7" +
    "\u007b\u0041\u0042\u0043\u0044\u0045\u0046\u0047\u0048\u0049\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5" +
    "\u007d\u004a\u004b\u004c\u004d\u004e\u004f\u0050\u0051\u0052\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff" +
    "\u005c\u00f7\u0053\u0054\u0055\u0056\u0057\u0058\u0059\u005a\u00b2\u00d4\u00d6\u00d2\u00d3\u00d5" +
    "\u0030\u0031\u0032\u0033\u0034\u0035\u0036\u0037\u0038\u0039\u00b3\u00db\u00dc\u00d9\u00da\u009f"
);

export const decodeCp037 = (bytes) => { let s = ""; for (const b of bytes) s += CP037[b]; return s; };

const ENCODINGS = new Set(["cp037", "ascii", "latin1", "utf8"]);
const TYPES = new Set(["text", "zoned", "packed"]);
const decode = (bytes, encoding) => (encoding === "cp037" ? decodeCp037(bytes) : Buffer.from(bytes).toString(encoding));

/** A layout file, checked: a mistake here would misread every record, so it stops the case. */
export function readLayout(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err) { throw new Error(`the layout file ${file} could not be read as JSON: ${err.message}`); }
    return checkLayout(raw, file);
}

export function checkLayout(raw, where = "layout") {
    const encoding = raw?.encoding ?? "ascii";
    if (!ENCODINGS.has(encoding)) throw new Error(`${where}: encoding must be one of ${[...ENCODINGS].join(", ")}`);
    if (!Array.isArray(raw?.fields) || !raw.fields.length) throw new Error(`${where}: fields must list at least one { name, start, length }`);
    const fields = raw.fields.map((f) => {
        const type = f.type ?? "text";
        if (typeof f.name !== "string" || !f.name) throw new Error(`${where}: each field needs a name`);
        if (!Number.isInteger(f.start) || f.start < 0 || !Number.isInteger(f.length) || f.length <= 0) throw new Error(`${where}: ${f.name} needs a start from 0 and a length above 0, in bytes`);
        if (!TYPES.has(type)) throw new Error(`${where}: ${f.name}: type must be one of ${[...TYPES].join(", ")}`);
        return { name: f.name, start: f.start, length: f.length, type, scale: f.scale ?? 0 };
    });
    const longest = Math.max(...fields.map((f) => f.start + f.length));
    const lines = raw.line_breaks === true;
    const length = raw.record_length ?? (lines ? undefined : longest);
    if (!lines && (!Number.isInteger(length) || length < longest)) throw new Error(`${where}: record_length must cover every field (${longest} bytes or more)`);
    const ignore = new Set(raw.ignore ?? []);
    const keys = raw.keys ?? [];
    for (const k of keys) {
        if (!fields.some((f) => f.name === k)) throw new Error(`${where}: the key ${k} is not a field`);
        if (ignore.has(k)) throw new Error(`${where}: the key ${k} cannot be ignored`);
    }
    return { encoding, fields, lines, length, ignore, keys };
}

const withScale = (digits, scale, negative) => {
    let d = digits.replace(/^0+(?=\d)/, "");
    if (scale > 0) {
        d = d.padStart(scale + 1, "0");
        d = `${d.slice(0, -scale)}.${d.slice(-scale)}`;
    }
    return negative && /[1-9]/.test(d) ? `-${d}` : d;
};
const invalid = (bytes) => `invalid:${Buffer.from(bytes).toString("hex")}`;

/** COBOL DISPLAY numbers: digits with the sign in the last byte's zone, or (in ASCII) as a separate sign or an overpunched letter. */
function zoned(bytes, scale, encoding) {
    if (encoding === "cp037") {
        let digits = "";
        for (let i = 0; i < bytes.length; i++) {
            const low = bytes[i] & 0x0f, zone = bytes[i] & 0xf0;
            if (low > 9 || (i < bytes.length - 1 ? zone !== 0xf0 : ![0xf0, 0xc0, 0xd0].includes(zone))) return invalid(bytes);
            digits += low;
        }
        return withScale(digits, scale, (bytes[bytes.length - 1] & 0xf0) === 0xd0);
    }
    const text = Buffer.from(bytes).toString("latin1").trim();
    const plain = /^([+-]?)(\d+)$/.exec(text);
    if (plain) return withScale(plain[2], scale, plain[1] === "-");
    const over = /^(\d*)([{A-IJ-R}])$/.exec(text);
    if (!over) return invalid(bytes);
    const c = over[2];
    const [digit, negative] = c === "{" ? [0, false] : c === "}" ? [0, true] : c <= "I" ? [c.charCodeAt(0) - 64, false] : [c.charCodeAt(0) - 73, true];
    return withScale(over[1] + digit, scale, negative);
}

/** COBOL COMP-3: two digits a byte, the last nibble the sign. */
function packed(bytes, scale) {
    let digits = "";
    for (let i = 0; i < bytes.length; i++) {
        const hi = bytes[i] >> 4, lo = bytes[i] & 0x0f;
        if (hi > 9) return invalid(bytes);
        digits += hi;
        if (i < bytes.length - 1) {
            if (lo > 9) return invalid(bytes);
            digits += lo;
        } else if (lo < 0x0a) return invalid(bytes);
    }
    return withScale(digits, scale, [0x0b, 0x0d].includes(bytes[bytes.length - 1] & 0x0f));
}

function field(bytes, f, encoding) {
    if (f.type === "packed") return packed(bytes, f.scale);
    if (f.type === "zoned") return zoned(bytes, f.scale, encoding);
    return decode(bytes, encoding).replace(/[ \u0000]+$/, "");
}

/** The file's bytes as records: { records: [ {field: value} ], total } with `problem` when the bytes do not fit the layout. */
export function parseRecords(buf, layout, maxRecords = Infinity) {
    const chunks = [];
    if (layout.lines) {
        let start = 0;
        for (let i = 0; i <= buf.length; i++) {
            if (i === buf.length || buf[i] === 0x0a) {
                let end = i;
                if (end > start && buf[end - 1] === 0x0d) end--;
                if (i < buf.length || end > start) chunks.push(buf.subarray(start, end));
                start = i + 1;
            }
        }
    } else {
        if (buf.length % layout.length) return { records: [], total: 0, problem: `the file holds ${buf.length} bytes, which is not a whole number of ${layout.length}-byte records` };
        for (let i = 0; i < buf.length; i += layout.length) chunks.push(buf.subarray(i, i + layout.length));
    }
    const records = [];
    for (const [n, chunk] of chunks.entries()) {
        if (n >= maxRecords) break;
        const rec = {};
        for (const f of layout.fields) {
            if (f.start + f.length > chunk.length) return { records: [], total: chunks.length, problem: `record ${n + 1} is ${chunk.length} bytes, too short for ${f.name}` };
            if (!layout.ignore.has(f.name)) rec[f.name] = field(chunk.subarray(f.start, f.start + f.length), f, layout.encoding);
        }
        records.push(rec);
    }
    return { records, total: chunks.length };
}

export function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
    return JSON.stringify(v) ?? "null";
}

/** Records by key, so a different order is not a difference. A key held twice keeps both, sorted. */
export function byKey(records, keys) {
    const groups = new Map();
    for (const r of records) {
        const k = keys.map((x) => String(r[x])).join("|");
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    const out = {};
    const duplicates = [];
    for (const k of [...groups.keys()].sort()) {
        const g = groups.get(k).sort((a, b) => { const [x, y] = [canonical(a), canonical(b)]; return x < y ? -1 : x > y ? 1 : 0; });
        if (g.length > 1) duplicates.push(k);
        out[k] = g.length > 1 ? g : g[0];
    }
    return { records: out, duplicates };
}
