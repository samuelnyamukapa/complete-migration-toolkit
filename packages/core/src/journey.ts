// The `journey` match level: the same goals reached with the same outcomes, whatever the screens look like.
// Compared: the goal, each check's result, the key values and the named pages. Not compared: paths, styling,
// screenshots, and API calls unless the journey asked for them. Nothing here asks a model.
import { scrubJson, type Scrubber } from "./diff.js";
import type { Difference, JourneyOutcome } from "./types.js";

const words = (c: JourneyOutcome["checks"][number] | undefined) => (!c ? "(missing)" : c.passed ? "passed" : `failed${c.expected !== undefined || c.actual !== undefined ? `: expected ${c.expected ?? "(not given)"}, got ${c.actual ?? "(not given)"}` : ""}`);

const count = (list: string[]) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
};

export function diffJourney(a: JourneyOutcome | undefined, b: JourneyOutcome | undefined, sc: Scrubber): Difference[] {
    // A level that found nothing to compare must never read as a match.
    if (!a || !b) return [{ where: "journey", reference: a ? "(reported)" : "(no journey reported)", candidate: b ? "(reported)" : "(no journey reported)" }];
    const x = scrubJson(a, sc) as JourneyOutcome, y = scrubJson(b, sc) as JourneyOutcome;
    const empty = (j: JourneyOutcome) => !j.checks?.length && !Object.keys(j.values ?? {}).length && !(j.pages ?? []).some((p) => p.name);
    if (empty(x) || empty(y)) return [{ where: "journey", reference: empty(x) ? "(no checks, values or named pages)" : "(reported)", candidate: empty(y) ? "(no checks, values or named pages)" : "(reported)" }];

    const out: Difference[] = [];
    if (x.goal !== y.goal) out.push({ where: "journey:goal", reference: x.goal, candidate: y.goal });

    const cx = new Map((x.checks ?? []).map((c) => [c.name, c])), cy = new Map((y.checks ?? []).map((c) => [c.name, c]));
    for (const name of new Set([...cx.keys(), ...cy.keys()])) {
        const p = cx.get(name), q = cy.get(name);
        if (p?.passed !== q?.passed) out.push({ where: `journey:check:${name}`, reference: words(p), candidate: words(q) });
    }

    const vx = x.values ?? {}, vy = y.values ?? {};
    for (const name of new Set([...Object.keys(vx), ...Object.keys(vy)])) {
        const p = vx[name], q = vy[name];
        if ((p ?? null) !== (q ?? null) || (name in vx) !== (name in vy)) out.push({ where: `journey:value:${name}`, reference: name in vx ? String(p ?? "(not shown)") : "(missing)", candidate: name in vy ? String(q ?? "(not shown)") : "(missing)" });
    }

    const px = (x.pages ?? []).flatMap((p) => (p.name ? [p.name] : [])), py = (y.pages ?? []).flatMap((p) => (p.name ? [p.name] : []));
    for (const name of new Set([...px, ...py])) {
        if (px.includes(name) !== py.includes(name)) out.push({ where: `journey:page:${name}`, reference: px.includes(name) ? "reached" : "(not reached)", candidate: py.includes(name) ? "reached" : "(not reached)" });
    }
    const common = (l: string[], other: string[]) => l.filter((n) => other.includes(n));
    if (common(px, py).join("\n") !== common(py, px).join("\n")) out.push({ where: "journey:pages", reference: common(px, py).join(" > "), candidate: common(py, px).join(" > ") });

    if (x.api_compared || y.api_compared) {
        const ax = count(x.api_compared ?? []), ay = count(y.api_compared ?? []);
        for (const call of new Set([...ax.keys(), ...ay.keys()])) {
            if ((ax.get(call) ?? 0) !== (ay.get(call) ?? 0)) out.push({ where: `journey:api:${call}`, reference: `${ax.get(call) ?? 0} time(s)`, candidate: `${ay.get(call) ?? 0} time(s)` });
        }
    }
    return out;
}
