// Checks for `cmtk run`: does one system's answer meet what the requirement expects?
// Every check is code. Nothing here asks a model.
import { parsePath, render, select } from "./jsonpath.js";
import { ConfigError, short } from "./diff.js";
import { jsonEqual } from "./json.js";
import type { Expectation, Failure, JsonCheck, Observation } from "./types.js";

function regex(pattern: string, where: string): RegExp {
    try {
        return new RegExp(pattern);
    } catch (err) {
        throw new ConfigError(`expect ${where}: ${JSON.stringify(pattern)} is not a valid regular expression (${(err as Error).message}).`);
    }
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function checkJson(path: string, check: JsonCheck, doc: unknown): Failure[] {
    const found = select(doc, parsePath(path));
    if ("exists" in check) {
        return (found.length > 0) === check.exists ? [] : [{ check: path, expected: check.exists ? "present" : "absent", actual: found.length ? short(found[0]!.value) : "(missing)" }];
    }
    if (found.length === 0) return [{ check: path, expected: describe(check), actual: "(missing)" }];
    const out: Failure[] = [];
    for (const { at, value } of found) {
        let ok = true;
        if ("equals" in check) ok = jsonEqual(value, check.equals);
        else if ("matches" in check) ok = typeof value === "string" && regex(check.matches, path).test(value);
        else if ("type" in check) ok = typeOf(value) === check.type;
        if (!ok) out.push({ check: found.length > 1 ? render(at) : path, expected: describe(check), actual: short(value) });
    }
    return out;
}

function describe(check: JsonCheck): string {
    if ("equals" in check) return short(check.equals);
    if ("matches" in check) return `matches /${check.matches}/`;
    if ("type" in check) return `a ${check.type}`;
    return check.exists ? "present" : "absent";
}

export function checkExpectation(exp: Expectation, obs: Observation): Failure[] {
    const out: Failure[] = [];
    if (exp.status !== undefined) {
        const allowed = Array.isArray(exp.status) ? exp.status : [exp.status];
        if (!allowed.includes(obs.status ?? -1)) out.push({ check: "status", expected: allowed.join(" or "), actual: String(obs.status ?? "(none)") });
    }
    for (const [name, want] of Object.entries(exp.headers ?? {})) {
        const got = obs.headers?.[name.toLowerCase()];
        const ok = typeof want === "string" ? got === want : got !== undefined && regex(want.matches, `header ${name}`).test(got);
        if (!ok) out.push({ check: `header:${name.toLowerCase()}`, expected: typeof want === "string" ? want : `matches /${want.matches}/`, actual: got ?? "(missing)" });
    }
    if (exp.json) {
        let doc: unknown;
        try {
            doc = JSON.parse(obs.body ?? "");
        } catch {
            return [...out, { check: "body", expected: "JSON", actual: short(obs.body ?? "", 60) }];
        }
        for (const [path, check] of Object.entries(exp.json)) out.push(...checkJson(path, check, doc));
    }
    for (const text of exp.body_contains ?? []) {
        if (!(obs.body ?? "").includes(text)) out.push({ check: "body", expected: `contains ${short(text, 60)}`, actual: "not found" });
    }
    return out;
}
