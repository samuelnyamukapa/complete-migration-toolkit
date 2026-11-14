// What a value looks like, whatever it is called. Shared by `cmtk shadow`, `cmtk import-har` and exploration.
// Patterns find values of a known shape and fields of a known name. They can't find a name in free text, so a person
// still reads a capture file or an imported case before it is used.
export const REDACTED = "REDACTED";

const luhn = (digits: string) => {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
    }
    return sum % 10 === 0;
};

const TOKENS: [string, RegExp][] = [
    ["token", /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g],
    ["token", /\b(?:sk|pk|rk)_(?:live|test)_\w+/g],
    ["token", /\b[A-Fa-f0-9]{32,}\b/g],
    ["token", /[A-Za-z0-9+_-]{40,}={0,2}/g],
];

const SHAPES: [string, RegExp, ((match: string) => boolean)?][] = [
    ["email", /[^\s@/?&=;,"'<>[\]]+@[^\s@/?&=;,"'<>[\]]+\.[A-Za-z]{2,}/g],
    ...TOKENS,
    ["card number", /\b\d(?:[ -]?\d){12,18}\b/g, (m) => luhn(m.replace(/\D/g, ""))],
    ["national number", /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi],
    ["national number", /\b\d{3}-\d{2}-\d{4}\b/g],
    ["bank account", /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g],
    ["postcode", /\b[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?[ +]?\d[ABD-HJLNP-UW-Z]{2}\b/gi],
    ["phone number", /(?:\+|\b00)\d[\d ()-]{7,16}\d\b/g],
    ["phone number", /\b0\d{9,10}\b/g],
    ["IP address", /\b\d{1,3}(?:\.\d{1,3}){3}\b/g],
];

/** Text with every value shaped like personal data or a credential replaced. Returns the kinds it found. */
export function redactText(text: string, own: RegExp[] = []): { text: string; kinds: string[] } {
    const kinds: string[] = [];
    let out = text;
    for (const rx of own) out = out.replace(rx, () => { kinds.push("your --redact rule"); return REDACTED; });
    for (const [kind, rx, keep] of SHAPES) {
        out = out.replace(rx, (m) => {
            if (keep && !keep(m)) return m;
            kinds.push(kind);
            return REDACTED;
        });
    }
    return { text: out, kinds };
}

/** Does this text hold something shaped like a key or a token? */
export const holdsToken = (text: string) => TOKENS.some(([, rx]) => new RegExp(rx.source).test(text));

/** Text with anything shaped like a key or a token replaced. A recording keeps other test data, which a replay may need. */
export const redactTokens = (text: string) => TOKENS.reduce((t, [, rx]) => t.replace(rx, REDACTED), text);
