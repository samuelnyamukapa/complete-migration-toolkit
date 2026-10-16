// A strict JSON reader that keeps what JSON.parse throws away and an exact comparison needs:
//   - the source text of every number, so `10` and `10.0` differ and 64-bit ids keep every digit;
//   - the order of keys as sent, including integer-like keys, which plain objects reorder.
// Anything JSON.parse rejects is rejected here too (and so are leading zeros, which it also rejects).

/** A number as it was written. */
export class JsonNumber {
    constructor(readonly source: string) {}
    get value() {
        return Number(this.source);
    }
    /** The same value for any way of writing it: `10`, `10.0` and `1e1` all give `1e1`. Exact for any size. */
    get canonical(): string {
        const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(this.source);
        if (!m) return this.source;
        const frac = m[3] ?? "";
        let digits = (m[2]! + frac).replace(/^0+/, "");
        let exp = Number(m[4] ?? 0) - frac.length;
        if (!digits) return "0";
        while (digits.endsWith("0")) { digits = digits.slice(0, -1); exp++; }
        return `${m[1]}${digits}e${exp}`;
    }
    toJSON() {
        return this.value;
    }
}

/** An object with its keys in the order they were sent. */
export class JsonObject extends Map<string, unknown> {
    toJSON() {
        return Object.fromEntries(this);
    }
}

const MAX_DEPTH = 1000;

export function parseJsonExact(text: string): unknown {
    let i = 0;
    const fail = (what: string): never => { throw new SyntaxError(`${what} at position ${i}`); };
    const ws = () => {
        for (;;) {
            const c = text.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13) i++;
            else return;
        }
    };
    const str = (): string => {
        const start = i++;
        let escaped = false;
        for (;;) {
            if (i >= text.length) fail("unterminated string");
            const c = text.charCodeAt(i);
            if (c === 92) { escaped = true; i += 2; continue; }
            if (c === 34) break;
            if (c < 32) fail("control character in a string");
            i++;
        }
        i++;
        const raw = text.slice(start, i);
        return escaped ? (JSON.parse(raw) as string) : raw.slice(1, -1);
    };
    const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    const value = (depth: number): unknown => {
        if (depth > MAX_DEPTH) fail("nested too deeply");
        ws();
        const c = text[i];
        if (c === "{") {
            i++;
            const o = new JsonObject();
            ws();
            if (text[i] === "}") { i++; return o; }
            for (;;) {
                ws();
                if (text[i] !== '"') fail("expected a key");
                const k = str();
                ws();
                if (text[i] !== ":") fail("expected ':'");
                i++;
                o.set(k, value(depth + 1));
                ws();
                if (text[i] === ",") { i++; continue; }
                if (text[i] === "}") { i++; return o; }
                fail("expected ',' or '}'");
            }
        }
        if (c === "[") {
            i++;
            const a: unknown[] = [];
            ws();
            if (text[i] === "]") { i++; return a; }
            for (;;) {
                a.push(value(depth + 1));
                ws();
                if (text[i] === ",") { i++; continue; }
                if (text[i] === "]") { i++; return a; }
                fail("expected ',' or ']'");
            }
        }
        if (c === '"') return str();
        if (text.startsWith("true", i)) { i += 4; return true; }
        if (text.startsWith("false", i)) { i += 5; return false; }
        if (text.startsWith("null", i)) { i += 4; return null; }
        NUM.lastIndex = i;
        const m = NUM.exec(text);
        if (!m) fail("unexpected character");
        i = NUM.lastIndex;
        if (/[0-9.eE+-]/.test(text[i] ?? "")) fail("malformed number");
        return new JsonNumber(m![0]);
    };
    const v = value(0);
    ws();
    if (i < text.length) fail("unexpected text after the value");
    return v;
}

/** Keys and values of an object, in the order they were sent when that is known. */
export function entriesOf(v: unknown): [string, unknown][] {
    if (v instanceof JsonObject) return [...v.entries()];
    return Object.entries(v as Record<string, unknown>);
}

export const isJsonObject = (v: unknown): boolean =>
    v instanceof JsonObject || (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof JsonNumber) && !(v instanceof Map));

/** Equality that ignores key order, with numbers compared by value. */
export function jsonEqual(a: unknown, b: unknown): boolean {
    if (a instanceof JsonNumber) a = a.value;
    if (b instanceof JsonNumber) b = b.value;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
    }
    if (isJsonObject(a) || isJsonObject(b)) {
        if (!isJsonObject(a) || !isJsonObject(b)) return false;
        const ea = new Map(entriesOf(a)), eb = new Map(entriesOf(b));
        return ea.size === eb.size && [...ea].every(([k, v]) => eb.has(k) && jsonEqual(v, eb.get(k)));
    }
    return a === b;
}
