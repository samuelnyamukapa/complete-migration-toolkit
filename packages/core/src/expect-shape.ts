// Is an `expect:` block one the checks can read? A misspelt key is not a weak check: it is no check at all, and the
// case passes whatever comes back. So this runs when a case is loaded, and `cmtk check` reports it before anything is sent.
import { parsePath } from "./jsonpath.js";

const KEYS = new Set(["status", "headers", "json", "body_contains", "body_excludes"]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function jsonCheckProblem(check: unknown): string | undefined {
    if (!isObject(check)) return "must be one of { equals }, { matches }, { type } or { exists }";
    const given = Object.keys(check);
    if (given.length !== 1 || !["equals", "matches", "type", "exists"].includes(given[0]!)) return `must hold exactly one of equals, matches, type or exists, and holds ${given.length ? given.join(", ") : "nothing"}`;
    // A pattern that can't compile is left to the run: that one case errors, and the others still run.
    if ("matches" in check && typeof check.matches !== "string") return "matches must be a regular expression, as text";
    if ("type" in check && !JSON_TYPES.has(String(check.type))) return `type must be one of ${[...JSON_TYPES].join(", ")}`;
    if ("exists" in check && typeof check.exists !== "boolean") return "exists must be true or false";
    return undefined;
}

/** What is wrong with an `expect:` block, in words, or undefined when it is sound and checks at least one thing. */
export function expectProblem(exp: unknown): string | undefined {
    if (!isObject(exp)) return "must be a mapping of checks";
    const unknown = Object.keys(exp).filter((k) => !KEYS.has(k));
    if (unknown.length) return `${unknown.join(", ")} ${unknown.length === 1 ? "is not a check" : "are not checks"}: use ${[...KEYS].join(", ")}`;
    let checks = 0;
    if (exp.status !== undefined) {
        const list = Array.isArray(exp.status) ? exp.status : [exp.status];
        if (!list.length || !list.every((s) => Number.isInteger(s))) return "status must be a number or a list of numbers, such as 200 or [200, 204]";
        checks++;
    }
    if (exp.headers !== undefined) {
        if (!isObject(exp.headers)) return "headers must map a header name to its value or { matches }";
        for (const [name, want] of Object.entries(exp.headers)) {
            if (typeof want === "string") { checks++; continue; }
            if (!isObject(want) || Object.keys(want).join() !== "matches" || typeof want.matches !== "string") return `headers.${name} must be text or { matches: <regular expression> }`;
            checks++;
        }
    }
    if (exp.json !== undefined) {
        if (!isObject(exp.json)) return "json must map a JSON path to a check";
        for (const [where, check] of Object.entries(exp.json)) {
            try { parsePath(where); } catch (err) { return `json: ${where}: ${(err as Error).message}`; }
            const bad = jsonCheckProblem(check);
            if (bad) return `json: ${where} ${bad}`;
            checks++;
        }
    }
    for (const k of ["body_contains", "body_excludes"] as const) {
        const v = exp[k];
        if (v === undefined) continue;
        if (!Array.isArray(v) || !v.every((t) => typeof t === "string")) return `${k} must be a list of text`;
        checks += v.length;
    }
    return checks ? undefined : "holds no check, so it would pass whatever came back. Add one, or remove `expect:`";
}
