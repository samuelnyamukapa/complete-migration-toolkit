#!/usr/bin/env node
// Records a verified journey as a script that replays with no model. It runs the journey on each target and
// writes the script only when every check held on every target. Checks and values are copied as written: nothing
// the page showed becomes an expectation. Usage: see README.md.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { insideProject, runCase } from "./journey.mjs";

const require = createRequire(import.meta.url);

const fail = (message) => { process.stderr.write(`record: ${message}\n`); process.exitCode = 1; };

/** The steps of the script: what every target shares, and under `on` what differs. Only an action's locator changes. */
export function mergeSteps(steps, resolvedByTarget) {
    const names = Object.keys(resolvedByTarget);
    return steps.map((step, i) => {
        const n = i + 1;
        const found = names.map((t) => [t, resolvedByTarget[t].get(n)]).filter(([, r]) => r);
        if (!found.length) return step;
        const { action } = found[0][1];
        const out = { ...step };
        const on = JSON.parse(JSON.stringify(step.on ?? {}));
        out[action] = found[0][1].locator;
        for (const [t, r] of found) {
            if (JSON.stringify(r.locator) === JSON.stringify(out[action])) { if (on[t]) delete on[t][action]; }
            else on[t] = { ...(on[t] ?? {}), [action]: r.locator };
        }
        for (const t of Object.keys(on)) if (!Object.keys(on[t]).length) delete on[t];
        if (Object.keys(on).length) out.on = on; else delete out.on;
        return out;
    });
}

async function main() {
    const { values } = parseArgs({ options: { journey: { type: "string" }, out: { type: "string" }, target: { type: "string", multiple: true }, writes: { type: "boolean" }, date: { type: "string" } } });
    if (!values.journey || !values.out || !values.target?.length) return fail("it needs --journey <file>, --out <file> and at least one --target name=url");
    const source = insideProject(values.journey, "--journey");
    const out = insideProject(values.out, "--out");
    if (!fs.existsSync(source)) return fail(`${values.journey} does not exist`);
    const bytes = fs.readFileSync(source);
    let draft;
    try { draft = JSON.parse(bytes.toString("utf8")); } catch { return fail(`${values.journey} is not JSON`); }
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
    const resolved = {};
    const secrets = new Map();
    try {
        for (const spec of values.target) {
            const eq = spec.indexOf("=");
            if (eq < 1) return fail(`--target takes name=url, not ${spec}`);
            const target = { name: spec.slice(0, eq), base_url: spec.slice(eq + 1).replace(/\/+$/, "") };
            resolved[target.name] = new Map();
            const c = { id: "record", request: { method: values.writes ? "POST" : "GET", path: "/" }, journey: draft };
            const obs = await runCase(browser, c, target, {}, target.base_url, secrets, { record: resolved[target.name] });
            if (obs.error) return fail(`not recorded: on ${target.name}: ${obs.error}`);
            if (!obs.journey?.passed) {
                const failed = obs.journey?.stopped ?? obs.journey?.checks.filter((k) => !k.passed).map((k) => k.name).join("; ");
                return fail(`not recorded: on ${target.name} the journey did not pass: ${failed}`);
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }
    const script = {
        cmtk_script: 1,
        ...draft,
        steps: mergeSteps(draft.steps, resolved),
        recorded: { from: String(values.journey).split("\\").join("/"), from_sha256: crypto.createHash("sha256").update(bytes).digest("hex"), targets: Object.keys(resolved), date: values.date ?? new Date().toISOString().slice(0, 10) },
    };
    const text = JSON.stringify(script, null, 2) + "\n";
    for (const [name, value] of secrets) {
        if (String(value).length >= 4 && text.includes(String(value))) return fail(`not recorded: the script would hold the value of ${name}`);
    }
    fs.writeFileSync(out, text, "utf8");
    process.stdout.write(`Recorded ${values.out}, verified on ${Object.keys(resolved).join(", ")}. A person reviews it before a case uses it.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
