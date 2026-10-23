// A minimal, deterministic .xlsx writer and reader. An .xlsx is a zip of XML parts; writing our own
// means every byte is under the recipe's control (the zip entries' times included), so the same
// recipe gives the same file, and the file never says who made it or when. Strings, numbers,
// booleans and empty cells only: enough for test data. Nothing here evaluates formulas.
import zlib from "node:zlib";

import { parseXml, type XNode } from "../diff.js";

export type Cell = string | number | boolean | null | undefined;

export interface Sheet { name: string; rows: Cell[][] }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// XML 1.0 forbids most control characters; Excel writes them escaped as _xHHHH_.
const xmlSafe = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, "0")}_`);

function column(i: number): string {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}

function sheetXml(sheet: Sheet): string {
    const rows = sheet.rows.map((r, ri) => {
        const cells = r.map((c, ci) => {
            if (c === null || c === undefined) return "";
            const ref = `${column(ci)}${ri + 1}`;
            if (typeof c === "number" && Number.isFinite(c)) return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === "boolean") return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
            const text = typeof c === "string" ? c : String(c);
            const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
            return `<c r="${ref}" t="inlineStr"><is><t${space}>${esc(xmlSafe(text))}</t></is></c>`;
        }).join("");
        return `<row r="${ri + 1}">${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/** The workbook as bytes. `created` is the only date in it, and the zip entries carry it too. */
export function writeXlsx(sheets: Sheet[], o: { creator?: string; created?: string } = {}): Buffer {
    if (!sheets.length) throw new Error("a workbook needs at least one sheet");
    const creator = o.creator ?? "cmtk";
    const created = o.created ?? "2026-01-15T09:30:00Z";
    const names = sheets.map((s, i) => (s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, "_").slice(0, 31));
    const parts: [string, string][] = [
        ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
        ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
        ["docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${esc(creator)}</dc:creator><cp:lastModifiedBy>${esc(creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${esc(created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${esc(created)}</dcterms:modified></cp:coreProperties>`],
        ["docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>cmtk</Application></Properties>`],
        ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
        ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`],
        ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
    ];
    return zip(parts, new Date(created));
}

// ---------------------------------------------------------------- zip, deterministic

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Buffer): number { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function dosTime(d: Date): { time: number; date: number } {
    const y = Math.max(1980, d.getUTCFullYear());
    return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

function zip(parts: [string, string][], when: Date): Buffer {
    const { time, date } = dosTime(when);
    const locals: Buffer[] = [], centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of parts) {
        const raw = Buffer.from(text, "utf8");
        const data = zlib.deflateRawSync(raw, { level: 9 });
        const nameB = Buffer.from(name, "utf8");
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
        local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
        central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameB.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
        locals.push(local, nameB, data);
        centrals.push(central, nameB);
        offset += local.length + nameB.length + data.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------- reading, for comparisons and tests

function unzip(b: Buffer): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    let p = b.length - 22;
    while (p >= 0 && b.readUInt32LE(p) !== 0x06054b50) p--;
    if (p < 0) throw new Error("not a zip file");
    const count = b.readUInt16LE(p + 10);
    let c = b.readUInt32LE(p + 16);
    for (let i = 0; i < count; i++) {
        if (b.readUInt32LE(c) !== 0x02014b50) throw new Error("bad zip central directory");
        const method = b.readUInt16LE(c + 10), size = b.readUInt32LE(c + 20), rawSize = b.readUInt32LE(c + 24), nameLen = b.readUInt16LE(c + 28), extra = b.readUInt16LE(c + 30), comment = b.readUInt16LE(c + 32), local = b.readUInt32LE(c + 42);
        const name = b.subarray(c + 46, c + 46 + nameLen).toString("utf8");
        const dataAt = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
        const data = b.subarray(dataAt, dataAt + size);
        out.set(name, method === 8 ? zlib.inflateRawSync(data) : method === 0 ? Buffer.from(data) : (() => { throw new Error(`zip method ${method} not supported`); })());
        if (method === 0 && data.length !== rawSize) throw new Error("bad zip entry");
        c += 46 + nameLen + extra + comment;
    }
    return out;
}

const unescapeXml = (s: string) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const textOf = (n: XNode): string => unescapeXml(n.texts.map((t, i) => t + (n.children[i] ? textOf(n.children[i]!) : "")).join(""));
const find = (n: XNode, local: string): XNode[] => n.children.flatMap((c) => (c.local === local ? [c] : find(c, local)));

/** Every sheet's cells, as written: strings, numbers and booleans. Shared strings and inline strings are both read. */
export function readXlsx(b: Buffer): { creator?: string; created?: string; sheets: Sheet[] } {
    const files = unzip(b);
    const text = (name: string) => files.get(name)?.toString("utf8");
    const shared: string[] = [];
    const ss = text("xl/sharedStrings.xml");
    if (ss) for (const si of find(parseXml(ss), "si")) shared.push(find(si, "t").map(textOf).join(""));
    const wb = parseXml(text("xl/workbook.xml") ?? "<workbook/>");
    const rels = parseXml(text("xl/_rels/workbook.xml.rels") ?? "<Relationships/>");
    const target = new Map(find(rels, "Relationship").map((r) => [r.attrs.get("Id") ?? "", r.attrs.get("Target") ?? ""]));
    const sheets: Sheet[] = [];
    for (const s of find(wb, "sheet")) {
        const rid = [...s.attrs].find(([k]) => k.endsWith("}id") || k === "id")?.[1] ?? "";
        const file = `xl/${(target.get(rid) ?? "").replace(/^\/?xl\//, "")}`;
        const xml = text(file);
        if (!xml) continue;
        const rows: Cell[][] = [];
        for (const row of find(parseXml(xml), "row")) {
            const cells: Cell[] = [];
            for (const c of find(row, "c")) {
                const ref = c.attrs.get("r") ?? "";
                const col = ref.replace(/\d+$/, "").split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
                const t = c.attrs.get("t");
                const v = find(c, "v")[0];
                let value: Cell;
                if (t === "inlineStr") value = find(c, "t").map(textOf).join("");
                else if (t === "s") value = shared[Number(v ? textOf(v) : -1)];
                else if (t === "b") value = v ? textOf(v) === "1" : undefined;
                else if (t === "str") value = v ? textOf(v) : "";
                else value = v ? Number(textOf(v)) : undefined;
                cells[col] = value;
            }
            rows.push(cells);
        }
        sheets.push({ name: s.attrs.get("name") ?? "", rows });
    }
    const core = text("docProps/core.xml");
    const coreNode = core ? parseXml(core) : undefined;
    return { ...(coreNode ? { creator: find(coreNode, "creator").map(textOf)[0], created: find(coreNode, "created").map(textOf)[0] } : {}), sheets };
}
