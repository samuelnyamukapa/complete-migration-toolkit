#!/usr/bin/env node
// The desktop adapter: runs a recorded script against a desktop app and reports what the screens showed. Reads
// come from Windows UI Automation; on other systems only a stub app runs. The script's checks decide pass or fail.
// Screen text is data: it goes into values and nothing else. This file holds no model client. See README.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { matches, stubReader, uiaReader } from "./readers.mjs";

console.log = console.error; // nothing but the protocol on stdout

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITING_STEPS = ["invoke", "set_value"];

class StepError extends Error {
    constructor(message, repair) { super(message); this.repair = repair; }
}

const clean = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
const glob = (p) => new RegExp(`^${String(p).split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const describeLocator = (l) => (l?.automation_id ? `automation id "${l.automation_id}"` : `${l?.role ?? "element"} "${l?.name ?? ""}"`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function insideProject(rel, what) {
    const root = path.resolve(process.cwd());
    const full = path.resolve(root, String(rel));
    if (full !== root && !full.startsWith(root + path.sep)) throw new StepError(`${what}: ${rel} is outside the project folder`);
    return full;
}

function loadScript(journey) {
    if (!journey?.script) return journey;
    const full = insideProject(journey.script, "script");
    if (!fs.existsSync(full)) throw new StepError(`script: ${journey.script} does not exist`);
    const bytes = fs.readFileSync(full);
    let doc;
    try { doc = JSON.parse(bytes.toString("utf8")); } catch { throw new StepError(`script: ${journey.script} is not JSON`); }
    if (doc?.cmtk_script !== 1 || !Array.isArray(doc.steps)) throw new StepError(`script: ${journey.script} is not a recorded script: it needs cmtk_script: 1 and steps`);
    return { ...doc, ...journey, script_file: String(journey.script).split(path.sep).join("/"), script_sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** The real reader, under the conditions #27 sets; the stub only when a target asks for it by name. */
function readerFor(target, ms) {
    if (target.stub_app) {
        const file = insideProject(target.stub_app, "stub_app");
        if (!fs.existsSync(file)) throw new StepError(`stub_app: ${target.stub_app} does not exist`);
        return stubReader(file);
    }
    if (process.platform !== "win32" && !target.uia_host) throw new StepError(`the desktop adapter reads a real app through Windows UI Automation, so it needs Windows. On ${process.platform} only a target with stub_app runs`);
    if (target.isolated_vm !== true) throw new StepError(`target ${target.name}: set isolated_vm: true once this runs inside a virtual machine that can reach only allowed addresses. An app under test does not run on anyone's own desktop`);
    if (!target.app) throw new StepError(`target ${target.name} has no app: the program to start`);
    return uiaReader(target, ms);
}

function textFor(step, n, secrets) {
    if (step.with_env !== undefined) {
        const value = process.env[String(step.with_env)];
        if (value === undefined) throw new StepError(`step ${n}: the environment variable ${step.with_env} is not set`);
        secrets.set(String(step.with_env), value);
        return value;
    }
    if (step.with === undefined) throw new StepError(`step ${n}: set_value needs \`with\` or \`with_env\``);
    return String(step.with);
}

const similarity = (a, b) => {
    const x = String(a ?? "").toLowerCase(), y = String(b ?? "").toLowerCase();
    if (x === y) return 1;
    const wx = new Set(x.split(/[\s_-]+/)), wy = new Set(y.split(/[\s_-]+/));
    return Math.round(([...wx].filter((w) => wy.has(w)).length / Math.max(1, new Set([...wx, ...wy]).size)) * 100) / 100;
};

/** An element on the window now, waiting a little; or a StepError with the likeliest elements, as data for a person. */
async function find(reader, l, n, action, ms, target, script) {
    const end = Date.now() + ms;
    let shot;
    do {
        shot = await reader.snapshot();
        const hit = shot.elements.filter((e) => matches(e, l));
        if (hit.length === 1) return hit[0];
        if (hit.length > 1) throw new StepError(`step ${n}: ${describeLocator(l)} matches ${hit.length} elements; name it more closely`);
        await sleep(50);
    } while (Date.now() < end);
    const wanted = l.name ?? l.automation_id;
    const candidates = shot.elements.filter((e) => e.name || e.automation_id).map((e) => ({ locator: e.automation_id ? { automation_id: e.automation_id } : { name: e.name }, name: clean(e.name), similarity: Math.max(similarity(wanted, e.name), similarity(wanted, e.automation_id)) })).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
    throw new StepError(`step ${n}: nothing in the window "${clean(shot.title)}" matches ${describeLocator(l)}`, action ? { step: n, target: target.name, action, was: l, candidates, ...(script ? { script } : {}) } : undefined);
}

async function runCase(written, target, headers, secrets) {
    const line = typeof written.request === "string" ? /^(\S+)\s+(\S+)$/.exec(written.request.trim()) : undefined;
    const c = line ? { ...written, request: { method: line[1], path: line[2] } } : written;
    const method = String(c.request?.method ?? "GET").toUpperCase();
    const writes = !SAFE.has(method) || c.safe === true;
    const outcome = { goal: "", reader: "", passed: false, checks: [], values: {}, pages: [] };
    const structure = [];
    const obs = () => ({ structure: { pages: structure }, journey: outcome, model_calls: 0 });
    let reader;
    try {
        const journey = loadScript(c.journey);
        if (!journey) throw new StepError("a desktop case needs `journey`: steps with checks, or `script`: a recorded file");
        if (typeof journey.goal !== "string" || !journey.goal.trim()) throw new StepError("a journey needs a `goal`, in words");
        const steps = journey.steps;
        if (!Array.isArray(steps) || !steps.length) throw new StepError("a journey needs `steps`");
        if (!steps.some((s) => s?.check !== undefined)) throw new StepError("a journey needs at least one `check`: checks in code decide pass or fail");
        outcome.goal = clean(journey.goal);
        if (journey.script_file) outcome.script = { file: journey.script_file, sha256: journey.script_sha256 };
        const ms = Number(journey.step_timeout_ms ?? target.step_timeout_ms ?? 10000);
        // Refused before anything starts, so a case that only reads can never press a button.
        for (const [i, raw] of steps.entries()) {
            const n = i + 1;
            const s = { ...raw, ...(raw.on?.[target.name] ?? {}) };
            if (!writes && WRITING_STEPS.some((k) => k in s)) throw new StepError(`step ${n}: this case is written as ${method}, so it only reads. A step that presses or fills is written as POST, with both unsafe switches on, or marked safe by a person`);
            if (s.leaves_sandbox && (typeof s.approved_by !== "string" || !s.approved_by.trim() || /^agent\b/i.test(s.approved_by.trim()))) throw new StepError(`step ${n} would leave the sandbox: a named person approves it with approved_by. An agent never does`);
        }
        reader = readerFor(target, ms);
        outcome.reader = reader.kind;
        await reader.start();
        const capture = async (name) => {
            const shot = await reader.snapshot();
            structure.splice(0, structure.length, ...structure.filter((p) => p.page !== name), { page: name, elements: shot.elements.map((e) => ({ role: clean(e.role), name: clean(e.name), ...(e.value !== undefined && !e.password ? { value: clean(e.value) } : {}), ...(e.disabled ? { disabled: true } : {}) })) });
            return shot;
        };
        let stopped;
        for (const [i, raw] of steps.entries()) {
            const n = i + 1;
            const { on, ...base } = raw ?? {};
            const s = { ...base, ...(on?.[target.name] ?? {}) };
            if (s.check !== undefined) {
                if (s.value === undefined) throw new StepError(`check ${clean(s.check)}: say which value, with \`value\``);
                const actual = outcome.values[String(s.value)] ?? null;
                let ok, expected;
                if (s.equals !== undefined) { ok = actual === String(s.equals); expected = String(s.equals); }
                else if (s.contains !== undefined) { ok = actual !== null && actual.includes(String(s.contains)); expected = `contains ${s.contains}`; }
                else if (s.matches !== undefined) { ok = actual !== null && new RegExp(String(s.matches)).test(actual); expected = `matches /${s.matches}/`; }
                else { ok = actual !== null; expected = "shown"; }
                outcome.checks.push({ name: clean(s.check), passed: !!ok, expected, actual: actual ?? "(not shown)" });
                continue;
            }
            if (s.read !== undefined) {
                if (stopped) { outcome.values[String(s.read)] = null; continue; }
                const shot = await reader.snapshot();
                const hit = shot.elements.find((e) => matches(e, s.from ?? {}));
                outcome.values[String(s.read)] = !hit || hit.password ? null : clean(hit.value ?? hit.name);
                continue;
            }
            if (stopped) continue;
            if (s.reach !== undefined) {
                const want = glob(s.window ?? "*");
                const end = Date.now() + ms;
                let title = "";
                do {
                    title = clean((await reader.snapshot()).title);
                    if (want.test(title)) break;
                    await sleep(50);
                } while (Date.now() < end);
                if (!want.test(title)) { stopped = `step ${n}: did not reach ${clean(s.reach)}: the window is "${title}"`; outcome.stopped = stopped; continue; }
                outcome.pages.push({ name: clean(s.reach), path: title });
                await capture(clean(s.reach));
                continue;
            }
            if (s.invoke !== undefined) { await find(reader, s.invoke, n, "invoke", ms, target, journey.script_file); await reader.invoke(s.invoke); continue; }
            if (s.set_value !== undefined) {
                const e = await find(reader, s.set_value, n, "set_value", ms, target, journey.script_file);
                if (e.password && s.with !== undefined) throw new StepError(`step ${n}: a password comes from an environment variable: use \`with_env\``);
                await reader.setValue(s.set_value, textFor(s, n, secrets));
                continue;
            }
            if (s.capture !== undefined) { await capture(clean(s.capture)); continue; }
            throw new StepError(`step ${n}: it needs one of invoke, set_value, read, reach, check or capture`);
        }
        await capture("end");
        outcome.passed = !stopped && outcome.checks.every((k) => k.passed);
        return { status: outcome.passed ? 200 : 417, headers: { "content-type": "application/json" }, body: JSON.stringify(outcome), ...obs() };
    } catch (err) {
        if (err instanceof StepError) return { error: err.message, ...obs(), ...(err.repair ? { repair: err.repair } : {}) };
        return { error: `${err?.name ?? "Error"}: ${String(err?.message ?? err).split("\n")[0]}`, ...obs() };
    } finally {
        await reader?.close().catch(() => {});
    }
}

function redact(reply, secrets) {
    let text = JSON.stringify(reply);
    for (const [name, value] of secrets) {
        if (String(value).length < 4) continue;
        text = text.split(JSON.stringify(String(value)).slice(1, -1)).join(`<secret ${clean(name)}>`);
    }
    return JSON.parse(text);
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
    let reply;
    try {
        const msg = JSON.parse(line);
        if (msg.op === "describe") reply = { name: "desktop", kinds: ["ui"], settings: ["app", "app_args", "isolated_vm", "step_timeout_ms", "stub_app"] };
        else if (msg.op === "run") {
            const secrets = new Map(Object.entries(msg.headers ?? {}));
            reply = redact(await runCase(msg.case, msg.target, msg.headers ?? {}, secrets), secrets);
        }
        // The app is started for each case and stopped after it, so each case starts clean.
        else if (msg.op === "reset") reply = { ok: true };
        else reply = { error: `unknown op ${msg.op}` };
    } catch (err) {
        reply = { error: `${err?.name ?? "Error"}: ${String(err?.message ?? err).split("\n")[0]}` };
    }
    process.stdout.write(JSON.stringify(reply) + "\n");
}
