// Strings that match a schema's `pattern`, generated rather than guessed: the common constructs
// (literals, classes, escapes, groups, alternation, quantifiers, anchors) are read into a small
// tree and walked with the recipe's random source. A construct we don't read (lookaround,
// backreferences, Unicode properties) is reported, never silently ignored.
import { ManifestError } from "../manifest.js";

export type Rng = () => number; // [0, 1)

type Node =
    | { kind: "seq"; items: Node[] }
    | { kind: "alt"; options: Node[] }
    | { kind: "lit"; char: string }
    | { kind: "class"; chars: string[]; negate: boolean }
    | { kind: "any" }
    | { kind: "repeat"; node: Node; min: number; max: number }
    | { kind: "group"; node: Node };

const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
const DIGITS = "0123456789".split("");
const WORD = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"];
const SPACE = [" ", "\t"];
const UNBOUNDED = 8; // "+" and "*" generate at most this many, so a row stays readable

class Parser {
    private i = 0;
    constructor(private readonly src: string) {}
    parse(): Node {
        const n = this.alt();
        if (this.i < this.src.length) throw new ManifestError(`pattern ${this.src}: unexpected "${this.src[this.i]}" at ${this.i}.`);
        return n;
    }
    private peek() { return this.src[this.i]; }
    private take() { return this.src[this.i++]!; }
    private alt(): Node {
        const options = [this.seq()];
        while (this.peek() === "|") { this.take(); options.push(this.seq()); }
        return options.length === 1 ? options[0]! : { kind: "alt", options };
    }
    private seq(): Node {
        const items: Node[] = [];
        while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
            const atom = this.atom();
            if (atom) items.push(this.quant(atom));
        }
        return { kind: "seq", items };
    }
    private atom(): Node | undefined {
        const c = this.take();
        if (c === "^" || c === "$") return undefined; // anchors: the whole string is generated anyway
        if (c === ".") return { kind: "any" };
        if (c === "(") {
            if (this.src.startsWith("?:", this.i)) this.i += 2;
            else if (this.peek() === "?") throw new ManifestError(`pattern ${this.src}: lookaround and named groups are not supported.`);
            const node = this.alt();
            if (this.take() !== ")") throw new ManifestError(`pattern ${this.src}: missing ")".`);
            return { kind: "group", node };
        }
        if (c === "[") return this.cls();
        if (c === "\\") return this.escape(this.take());
        return { kind: "lit", char: c };
    }
    private escape(c: string): Node {
        switch (c) {
            case "d": return { kind: "class", chars: DIGITS, negate: false };
            case "D": return { kind: "class", chars: DIGITS, negate: true };
            case "w": return { kind: "class", chars: WORD, negate: false };
            case "W": return { kind: "class", chars: WORD, negate: true };
            case "s": return { kind: "class", chars: SPACE, negate: false };
            case "S": return { kind: "class", chars: SPACE, negate: true };
            case "n": return { kind: "lit", char: "\n" };
            case "t": return { kind: "lit", char: "\t" };
            case "b": case "B": throw new ManifestError(`pattern ${this.src}: word boundaries are not supported.`);
            case "p": case "P": throw new ManifestError(`pattern ${this.src}: Unicode property classes are not supported.`);
            default:
                if (/\d/.test(c)) throw new ManifestError(`pattern ${this.src}: backreferences are not supported.`);
                return { kind: "lit", char: c };
        }
    }
    private cls(): Node {
        let negate = false;
        if (this.peek() === "^") { this.take(); negate = true; }
        const chars: string[] = [];
        let first = true;
        while (this.peek() !== "]" || first) {
            if (this.i >= this.src.length) throw new ManifestError(`pattern ${this.src}: missing "]".`);
            first = false;
            let c = this.take();
            let lo: string;
            if (c === "\\") {
                const e = this.escape(this.take());
                if (e.kind === "class") { chars.push(...(e.negate ? PRINTABLE.filter((x) => !e.chars.includes(x)) : e.chars)); continue; }
                lo = (e as { char: string }).char;
            } else lo = c;
            if (this.peek() === "-" && this.src[this.i + 1] !== "]" && this.i + 1 < this.src.length) {
                this.take();
                let hi = this.take();
                if (hi === "\\") hi = (this.escape(this.take()) as { char: string }).char;
                for (let x = lo.charCodeAt(0); x <= hi.charCodeAt(0); x++) chars.push(String.fromCharCode(x));
            } else chars.push(lo);
        }
        this.take();
        return { kind: "class", chars, negate };
    }
    private quant(node: Node): Node {
        const c = this.peek();
        let min: number, max: number;
        if (c === "*") { this.take(); min = 0; max = UNBOUNDED; }
        else if (c === "+") { this.take(); min = 1; max = UNBOUNDED; }
        else if (c === "?") { this.take(); min = 0; max = 1; }
        else if (c === "{") {
            const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
            if (!m) return node;
            this.i += m[0].length;
            min = Number(m[1]);
            max = m[2] === undefined ? min : m[3] === "" ? Math.max(min, UNBOUNDED) : Number(m[3]);
        } else return node;
        if (this.peek() === "?" || this.peek() === "+") this.take(); // lazy and possessive: same strings
        return { kind: "repeat", node, min, max };
    }
}

/** Which constructs a pattern uses that we can't generate: empty when every one is supported. */
export function patternLimits(pattern: string): string | undefined {
    try { new Parser(pattern).parse(); return undefined; } catch (err) { return (err as Error).message; }
}

/** A string matching the pattern, chosen with `rng`. Ranges pick the shortest form when `shortest` is set. */
export function stringFromPattern(pattern: string, rng: Rng, shortest = false): string {
    const walk = (n: Node): string => {
        switch (n.kind) {
            case "seq": return n.items.map(walk).join("");
            case "alt": return walk(n.options[shortest ? 0 : Math.floor(rng() * n.options.length)]!);
            case "group": return walk(n.node);
            case "lit": return n.char;
            case "any": return PRINTABLE[Math.floor(rng() * PRINTABLE.length)]!;
            case "class": {
                const pool = n.negate ? PRINTABLE.filter((c) => !n.chars.includes(c)) : n.chars;
                if (!pool.length) throw new ManifestError(`pattern ${pattern}: a character class matches nothing.`);
                return pool[Math.floor(rng() * pool.length)]!;
            }
            case "repeat": {
                const count = shortest ? n.min : n.min + Math.floor(rng() * (n.max - n.min + 1));
                return Array.from({ length: count }, () => walk(n.node)).join("");
            }
        }
    };
    const out = walk(new Parser(pattern).parse());
    if (!new RegExp(pattern, "u").test(out)) throw new ManifestError(`pattern ${pattern}: the generated string ${JSON.stringify(out)} does not match it; write the valid value by hand in the recipe.`);
    return out;
}
