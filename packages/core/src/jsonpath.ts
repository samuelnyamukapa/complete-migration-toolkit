// A small JSON path subset, enough to name a value in a report and to match it in a rule:
//   $.a.b    $..id    $.items[*].price    $.items[0]    $['odd key']    $.*
export type Token =
    | { kind: "key"; name: string } // name "*" matches any key
    | { kind: "idx"; index: number | "*" }
    | { kind: "desc"; name: string }; // recursive descent to a key ("*" for any)

export class PathError extends Error {}

const TOKEN = /\.\.(?<desc>[^.[\]]+)|\.(?<key>[^.[\]]+)|\[(?<idx>\*|\d+)\]|\['(?<qkey>[^']*)'\]/y;

export function parsePath(expr: string): Token[] {
    if (typeof expr !== "string" || !expr.startsWith("$")) throw new PathError(`JSON path ${JSON.stringify(expr)} must start with '$'.`);
    const out: Token[] = [];
    let pos = 1;
    while (pos < expr.length) {
        TOKEN.lastIndex = pos;
        const m = TOKEN.exec(expr);
        if (!m || !m.groups) throw new PathError(`Cannot read JSON path ${JSON.stringify(expr)} at ${JSON.stringify(expr.slice(pos))}.`);
        const g = m.groups;
        if (g.desc !== undefined) out.push({ kind: "desc", name: g.desc });
        else if (g.key !== undefined) out.push({ kind: "key", name: g.key });
        else if (g.qkey !== undefined) out.push({ kind: "key", name: g.qkey });
        else out.push({ kind: "idx", index: g.idx === "*" ? "*" : Number(g.idx) });
        pos = TOKEN.lastIndex;
    }
    return out;
}

/** A concrete location: keys and array indexes. */
export type Location = (string | number)[];

export function matches(pattern: Token[], at: Location): boolean {
    if (pattern.length === 0) return at.length === 0;
    const [head, ...rest] = pattern;
    if (!head) return at.length === 0;
    if (head.kind === "desc") {
        for (let i = 0; i < at.length; i++) {
            const step = at[i];
            if (typeof step === "string" && (head.name === "*" || step === head.name) && matches(rest, at.slice(i + 1))) return true;
        }
        return false;
    }
    if (at.length === 0) return false;
    const step = at[0];
    if (head.kind === "key" && typeof step === "string" && (head.name === "*" || head.name === step)) return matches(rest, at.slice(1));
    if (head.kind === "idx" && typeof step === "number" && (head.index === "*" || head.index === step)) return matches(rest, at.slice(1));
    return false;
}

export function render(at: Location): string {
    let out = "$";
    for (const step of at) {
        if (typeof step === "number") out += `[${step}]`;
        else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(step)) out += `.${step}`;
        else out += `['${step}']`;
    }
    return out;
}

/** A rendered location back to steps (only what `render` writes). */
export function locationOf(where: string): Location {
    return parsePath(where).map((t) => (t.kind === "idx" ? (t.index === "*" ? "*" : t.index) : t.name)) as Location;
}

/** Every value a pattern selects in a document, with its location. */
export function select(doc: unknown, pattern: Token[]): { at: Location; value: unknown }[] {
    const out: { at: Location; value: unknown }[] = [];
    const walk = (value: unknown, at: Location) => {
        if (matches(pattern, at)) out.push({ at, value });
        if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...at, i]));
        else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, [...at, k]);
    };
    walk(doc, []);
    return out;
}
