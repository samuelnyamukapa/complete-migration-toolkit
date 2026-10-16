// The drift ledger: differences between the reference and the candidate that a named person has
// approved. A difference it covers is reported as expected drift, not as a failure.
import path from "node:path";

import { locationOf, matches, parsePath } from "./jsonpath.js";
import type { Drift } from "./types.js";

export function coveringDrift(ledger: Drift[], caseId: string, where: string): Drift | undefined {
    return ledger.find((d) => (d.case === "*" || d.case === caseId) && covers(d.where, where));
}

function covers(pattern: string, where: string): boolean {
    for (const prefix of ["", "effects:"]) {
        if (pattern.startsWith(prefix + "$") && where.startsWith(prefix + "$")) {
            try {
                return matches(parsePath(pattern.slice(prefix.length)), locationOf(where.slice(prefix.length)));
            } catch {
                return false;
            }
        }
    }
    return path.posix.matchesGlob(where, pattern);
}
