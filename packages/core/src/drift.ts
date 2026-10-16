// The drift ledger: differences between the reference and the candidate that a named person has
// approved. A difference it covers is reported as expected drift, not as a failure.
import { locationOf, matches, parsePath } from "./jsonpath.js";
import type { Drift } from "./types.js";

export function coveringDrift(ledger: Drift[], caseId: string, where: string): Drift | undefined {
    return ledger.find((d) => (d.case === "*" || d.case === caseId) && covers(d.where, where));
}

/**
 * JSON paths (`$…` and `effects:$…`) match by path, so `[*]` and `..` work. Every other `where`
 * (status, headers, XML positions, contract findings) is literal text in which only `*` is a
 * wildcard, so the `[2]` in an XML position means the second element, not a character class.
 */
export function covers(pattern: string, where: string): boolean {
    for (const prefix of ["", "effects:"]) {
        if (pattern.startsWith(prefix + "$") && where.startsWith(prefix + "$")) {
            try {
                return matches(parsePath(pattern.slice(prefix.length)), locationOf(where.slice(prefix.length)));
            } catch {
                return false;
            }
        }
    }
    return starGlob(pattern).test(where);
}

/** Literal text where `*` matches any run of characters. */
export const starGlob = (pattern: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
