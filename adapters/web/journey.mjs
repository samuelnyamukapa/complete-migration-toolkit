// Runs one case in one browser context: a page visit, or a journey written as steps with checks in code.
// Everything read from a page is data. It goes into the observation and nowhere else: no page text ever
// chooses a step, a locator or a result. This file holds no model client, and it makes no model calls.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { totpCode } from "./totp.mjs";

export const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const MODEL_HOSTS = /(^|\.)(api\.anthropic\.com|api\.openai\.com|openai\.azure\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.ai|api\.groq\.com|openrouter\.ai)$|^bedrock-runtime\..*\.amazonaws\.com$/i;
const SETTLE_MAX_MS = 3000;

/** A step that could not be taken. A failure like this makes the case an error: it never reads as a pass. */
export class StepError extends Error {
    constructor(message, repair) {
        super(message);
        this.repair = repair;
    }
}

/** A file named by a case: inside the folder the adapter runs in, never outside it. */
export function insideProject(rel, what) {
    const root = path.resolve(process.cwd());
    const full = path.resolve(root, String(rel));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`${what}: ${rel} is outside the project folder`);
    return full;
}

/** Page text as a report may hold it: one line, no control characters, not too long. */
export const clean = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return String(url); } };
const glob = (pattern) => new RegExp(`^${String(pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

const LOCATOR_KEYS = ["role", "name", "label", "text", "testid", "placeholder", "css", "nth"];

/** How a script finds an element, in words. */
export const describeLocator = (l) => (typeof l === "string" ? l : l?.role ? `${l.role}${l.name ? ` "${l.name}"` : ""}` : l?.label ? `the field labelled "${l.label}"` : l?.testid ? `test id "${l.testid}"` : l?.text ? `the text "${l.text}"` : l?.placeholder ? `the placeholder "${l.placeholder}"` : l?.css ? `css ${l.css}` : JSON.stringify(l));

function locatorOf(page, l) {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw new StepError(`a locator must be a mapping using ${LOCATOR_KEYS.join(", ")}, not ${JSON.stringify(l)}`);
    const unknown = Object.keys(l).filter((k) => !LOCATOR_KEYS.includes(k));
    if (unknown.length) throw new StepError(`a locator cannot hold ${unknown.join(", ")}; it uses ${LOCATOR_KEYS.join(", ")}`);
    let found;
    if (l.role) found = page.getByRole(l.role, l.name === undefined ? {} : { name: l.name, exact: true });
    else if (l.label) found = page.getByLabel(l.label, { exact: true });
    else if (l.testid) found = page.getByTestId(l.testid);
    else if (l.placeholder) found = page.getByPlaceholder(l.placeholder, { exact: true });
    else if (l.text) found = page.getByText(l.text, { exact: true });
    else if (l.css) found = page.locator(l.css);
    else throw new StepError(`a locator needs one of role, label, testid, placeholder, text or css: ${JSON.stringify(l)}`);
    return l.nth === undefined ? found : found.nth(Number(l.nth));
}

/** Roles that say nothing to a reader unless they carry a name: a reskin may swap them freely. */
const CONTAINER = new Set(["generic", "none", "presentation", "paragraph", "list", "listitem", "group", "Section", "div", "Pre", "blockquote", "figure", "Details", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "time", "strong", "emphasis", "code", "subscript", "superscript", "mark", "DescriptionList", "term", "definition"]);
/** Parts of drawing text, not elements. */
const NEVER = new Set(["InlineTextBox", "LineBreak", "ListMarker", "ignored", "RootWebArea", "WebArea"]);

/** The page's accessibility tree in reading order, flat: what a screen reader would announce, whatever the styling. */
export async function pageElements(cdp) {
    {
        const { nodes } = await cdp.send("Accessibility.getFullAXTree");
        const byId = new Map(nodes.map((n) => [n.nodeId, n]));
        const out = [];
        const fact = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;
        const walk = (n, parent) => {
            if (!n) return;
            const role = n.role?.value ?? "none";
            const name = clean(n.name?.value);
            let here = parent;
            const text = role === "StaticText";
            // Text inside a button or a label is already that element's name.
            const repeats = text && (parent.role === "LabelText" || (parent.name && parent.name.includes(name)));
            const shown = !n.ignored && !NEVER.has(role) && role !== "LabelText" && !repeats && (name || !CONTAINER.has(role)) && !(text && !name);
            if (shown) {
                const e = { role, name };
                const value = n.value?.value;
                if (value !== undefined && value !== "" && role !== "image") e.value = clean(value);
                for (const f of ["level", "required", "disabled", "readonly"]) { const v = fact(n, f); if (v !== undefined && v !== false) e[f] = v; }
                const checked = fact(n, "checked");
                if (checked !== undefined) e.checked = String(checked);
                out.push(e);
            }
            if (!n.ignored && (name || role === "LabelText")) here = { role, name };
            for (const id of n.childIds ?? []) walk(byId.get(id), here);
        };
        walk(nodes.find((n) => !n.parentId), { role: "", name: "" });
        return out;
    }
}

const ACTIONS = ["click", "fill", "select", "tick"];
const REPAIRABLE = ACTIONS;
const STEP_KINDS = ["goto", ...ACTIONS, "press", "reach", "read", "check", "capture"];

/** How alike two labels are, from 0 to 1: shared words first, then shared letters. */
function similarity(a, b) {
    const x = a.toLowerCase().trim(), y = b.toLowerCase().trim();
    if (x === y) return 1;
    const wx = new Set(x.split(/\s+/)), wy = new Set(y.split(/\s+/));
    const shared = [...wx].filter((w) => wy.has(w)).length;
    const words = shared / Math.max(1, new Set([...wx, ...wy]).size);
    const row = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
        let last = row[0];
        row[0] = i;
        for (let j = 1; j <= y.length; j++) {
            const keep = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, last + (x[i - 1] === y[j - 1] ? 0 : 1));
            last = keep;
        }
    }
    const letters = 1 - row[y.length] / Math.max(1, x.length, y.length);
    return Math.round(Math.max(words, letters) * 100) / 100;
}

/** A recorded script from a file inside the project, with a fingerprint for the evidence. */
export function loadScript(file) {
    const full = insideProject(file, "script");
    if (!fs.existsSync(full)) throw new StepError(`script: ${file} does not exist`);
    const bytes = fs.readFileSync(full);
    let doc;
    try {
        doc = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new StepError(`script: ${file} is not JSON`);
    }
    if (doc?.cmtk_script !== 1 || !Array.isArray(doc.steps)) throw new StepError(`script: ${file} is not a recorded script: it needs cmtk_script: 1 and steps`);
    return { ...doc, script_file: String(file).split(path.sep).join("/"), script_sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** What one target's browser did during a case. */
class Session {
    constructor(page, settings) {
        Object.assign(this, settings);
        this.page = page;
        this.pages = [];
        this.apiCalls = [];
        this.values = {};
        this.checks = [];
        this.shots = [];
        this.structure = [];
        this.inflight = new Set();
        this.lastStatus = undefined;
        page.on("request", (r) => this.inflight.add(r));
        page.on("requestfinished", (r) => this.inflight.delete(r));
        page.on("requestfailed", (r) => this.inflight.delete(r));
        page.on("response", (res) => {
            const req = res.request();
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) { if (res.status() < 300 || res.status() >= 400) this.lastStatus = res.status(); return; }
            if (["fetch", "xhr"].includes(req.resourceType())) {
                this.apiCalls.push({ page: pathOf(page.url()), method: req.method(), path: pathOf(req.url()), status: res.status() });
            }
        });
        page.on("framenavigated", (frame) => {
            if (frame !== page.mainFrame() || frame.url() === "about:blank") return;
            const p = pathOf(frame.url());
            const last = this.pages[this.pages.length - 1];
            if (last?.path === p) { if (this.lastStatus !== undefined) last.status = this.lastStatus; }
            else this.pages.push({ path: p, ...(this.lastStatus !== undefined ? { status: this.lastStatus } : {}) });
            this.lastStatus = undefined;
        });
        page.on("dialog", (d) => d.dismiss().catch(() => {}));
    }

    /** Waits until the page has loaded and its requests have stopped, for a short while at most. */
    async settle() {
        const page = this.page;
        await page.waitForLoadState("load", { timeout: this.stepMs }).catch(() => {});
        const end = Date.now() + SETTLE_MAX_MS;
        let quiet = 0;
        while (quiet < 100 && Date.now() < end) {
            quiet = this.inflight.size === 0 ? quiet + 25 : 0;
            await new Promise((r) => setTimeout(r, 25));
        }
    }

    current() { return pathOf(this.page.url()); }

    /** One DevTools session for the page's whole life: closing another would switch a virtual authenticator off. */
    devtools() { return (this.cdp ??= this.page.context().newCDPSession(this.page)); }

    masks() { return (this.mask ?? []).map((l) => locatorOf(this.page, l)); }

    async shoot(label) {
        const png = await this.page.screenshot({ fullPage: true, animations: "disabled", caret: "hide", mask: this.masks(), maskColor: "#808080" }).catch((err) => { process.stderr.write(`no screenshot of ${label}: ${err.message.split("\n")[0]}\n`); return undefined; });
        if (png) {
            this.shots = this.shots.filter((s) => s.page !== label);
            this.shots.push({ page: label, png_base64: png.toString("base64") });
        }
    }

    async capture(label) {
        await this.shoot(label);
        const elements = await this.devtools().then(pageElements).catch((err) => { process.stderr.write(`no structure for ${label}: ${String(err.message).split("\n")[0]}\n`); return []; });
        this.structure = this.structure.filter((p) => p.page !== label);
        this.structure.push({ page: label, elements });
    }

    /** An element that is on the screen now, or a StepError saying why not. */
    async find(l, stepNumber, action) {
        const found = locatorOf(this.page, l);
        try {
            await found.waitFor({ state: "visible", timeout: this.stepMs });
            if (this.resolved && ACTIONS.includes(action)) await this.remember(found, l, stepNumber, action);
            return found;
        } catch (err) {
            if (/strict mode violation/.test(err.message)) throw new StepError(`step ${stepNumber}: ${describeLocator(l)} matches more than one element; add \`nth\` or a closer locator`);
            throw new StepError(`step ${stepNumber}: nothing on the page matches ${describeLocator(l)} at ${this.current()}`, await this.repairFor(l, stepNumber, action));
        }
    }

    /**
     * When a step finds nothing: the elements on the page most like the one it wanted. These are suggestions for a
     * person, sent as data. Nothing here changes a script, and a step never runs on a suggestion.
     */
    async repairFor(l, stepNumber, action) {
        if (!REPAIRABLE.includes(action)) return undefined;
        const elements = await this.devtools().then(pageElements).catch(() => []);
        const wanted = String(l.name ?? l.label ?? l.text ?? l.placeholder ?? l.testid ?? "");
        const scored = elements
            .filter((e) => e.name && e.role !== "StaticText" && (!l.role || e.role === l.role))
            .map((e) => ({ locator: { role: e.role, name: e.name }, similarity: similarity(wanted, e.name) }))
            .sort((a, b) => b.similarity - a.similarity || a.locator.name.localeCompare(b.locator.name));
        return { step: stepNumber, target: this.target.name, action, was: l, candidates: scored.slice(0, 3), ...(this.scriptFile ? { script: this.scriptFile } : {}) };
    }

    /** While recording: the plainest stable way to find this element. It must find this element alone, or the step stays as written. */
    async remember(found, l, stepNumber, action) {
        const check = async (candidate) => (await locatorOf(this.page, candidate).count().catch(() => 0)) === 1 ? candidate : undefined;
        const testid = await found.getAttribute("data-testid").catch(() => null);
        let best = testid ? await check({ testid }) : undefined;
        if (!best) {
            const aria = await found.ariaSnapshot().catch(() => "");
            const m = /^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(aria);
            if (m?.[1] && m[2]) best = await check({ role: m[1], name: m[2].replace(/\\(.)/g, "$1") });
        }
        this.resolved.set(stepNumber, { action, locator: best ?? l });
    }
}

/** The text a step types, from the step or an environment variable. Secrets are remembered so the reply can never hold them. */
function textFor(step, session, n) {
    if (step.with_totp_env !== undefined) {
        const variable = String(step.with_totp_env);
        let code;
        try {
            code = totpCode(variable);
        } catch (err) {
            throw new StepError(`step ${n}: ${err.message}`);
        }
        // The seed and the code are both kept out of the reply, should a page ever show them.
        const seed = process.env[variable];
        session.secrets.set(variable, seed);
        session.secrets.set(`${variable} lower case`, seed.toLowerCase());
        session.secrets.set(`${variable} upper case`, seed.toUpperCase());
        session.secrets.set(`${variable} code`, code);
        return code;
    }
    if (step.with_code_from !== undefined) {
        throw new StepError(`step ${n}: reading a code from ${step.with_code_from} is not wired: this adapter does not use adapters/mailbox or adapters/sms yet`);
    }
    if (step.with_env !== undefined) {
        const value = process.env[String(step.with_env)];
        if (value === undefined) throw new StepError(`step ${n}: the environment variable ${step.with_env} is not set`);
        session.secrets.set(String(step.with_env), value);
        return value;
    }
    if (step.with === undefined) throw new StepError(`step ${n}: ${step.fill ? "fill" : "select"} needs \`with\`, \`with_env\` or \`with_totp_env\``);
    return String(step.with);
}

async function takeStep(session, step, n) {
    const page = session.page;
    if (step.goto !== undefined) {
        const to = String(step.goto);
        if (!to.startsWith("/") || to.startsWith("//")) throw new StepError(`step ${n}: goto takes a path on the target, never a host: ${to}`);
        await open(session, to);
        return;
    }
    if (step.click !== undefined) { await (await session.find(step.click, n, "click")).click({ timeout: session.stepMs }); await session.settle(); return; }
    if (step.fill !== undefined) {
        const field = await session.find(step.fill, n, "fill");
        const type = await field.getAttribute("type").catch(() => null);
        if (String(type).toLowerCase() === "password" && step.with !== undefined) throw new StepError(`step ${n}: a password comes from an environment variable: use \`with_env\``);
        await field.fill(await textFor(step, session, n), { timeout: session.stepMs });
        return;
    }
    if (step.select !== undefined) { await (await session.find(step.select, n, "select")).selectOption({ label: textFor(step, session, n) }, { timeout: session.stepMs }); await session.settle(); return; }
    if (step.tick !== undefined) { await (await session.find(step.tick, n, "tick")).check({ timeout: session.stepMs }); await session.settle(); return; }
    if (step.press !== undefined) {
        if (step.in) await (await session.find(step.in, n, "press")).press(String(step.press), { timeout: session.stepMs });
        else await page.keyboard.press(String(step.press));
        await session.settle();
        return;
    }
    if (step.capture !== undefined) { await session.capture(String(step.capture)); return; }
    throw new StepError(`step ${n}: it needs one of ${STEP_KINDS.join(", ")}`);
}

/** Opens a path. A system that does not answer is reported the way the engine knows, so it stops waiting on it. */
async function open(session, to) {
    let res;
    try {
        res = await session.page.goto(to, { waitUntil: "load", timeout: session.navMs });
    } catch (err) {
        const m = String(err.message);
        if (/ERR_CONNECTION_REFUSED/.test(m)) throw new StepError(`ECONNREFUSED: nothing answered at ${to}`);
        if (/ERR_NAME_NOT_RESOLVED/.test(m)) throw new StepError(`ENOTFOUND: the target's host name did not resolve`);
        if (/Timeout/.test(m)) throw new StepError(`ETIMEDOUT: ${to} did not load within ${session.navMs / 1000}s`);
        if (/ERR_FAILED|ERR_BLOCKED/.test(m)) throw new StepError(`${to} was blocked: see \`blocked\` in the answer`);
        throw new StepError(`${to} could not be opened: ${m.split("\n")[0]}`);
    }
    await session.settle();
    return res;
}

/** One milestone: the page must get there, by path, by what is on the screen, or both. */
async function reach(session, step) {
    const name = String(step.reach);
    const end = Date.now() + session.stepMs;
    if (step.path !== undefined) {
        const want = glob(step.path);
        while (!want.test(session.current())) {
            if (Date.now() > end) return `the path is ${session.current()}, not ${step.path}`;
            await new Promise((r) => setTimeout(r, 25));
        }
    }
    if (step.see !== undefined) {
        const ok = await locatorOf(session.page, step.see).first().waitFor({ state: "visible", timeout: Math.max(1, end - Date.now()) }).then(() => true, () => false);
        if (!ok) return `${describeLocator(step.see)} is not on the page`;
    }
    if (step.path === undefined && step.see === undefined) throw new StepError(`reach ${name}: say how to know it: \`path\`, \`see\` or both`);
    const last = session.pages[session.pages.length - 1];
    if (last && !last.name) last.name = name;
    else session.pages.push({ name, path: session.current() });
    await session.capture(name);
    return undefined;
}

async function readValue(session, step) {
    const name = String(step.read);
    if (step.from === undefined) throw new StepError(`read ${name}: say where from, with \`from\``);
    const found = locatorOf(session.page, step.from);
    const shown = await found.waitFor({ state: "visible", timeout: session.stepMs }).then(() => true, () => false);
    if (!shown) { session.values[name] = null; return; }
    const tag = await found.evaluate((el) => el.tagName.toLowerCase());
    session.values[name] = clean(["input", "textarea", "select"].includes(tag) ? await found.inputValue() : await found.innerText());
}

/** A check in code. Only this, and a project's own checks module, decides pass or fail. */
async function checkStep(session, step) {
    const name = clean(step.check);
    const test = (actual) => {
        if (step.equals !== undefined) return [actual === String(step.equals), String(step.equals)];
        if (step.not_equals !== undefined) return [actual !== null && actual !== String(step.not_equals), `not ${step.not_equals}`];
        if (step.contains !== undefined) return [actual !== null && actual.includes(String(step.contains)), `contains ${step.contains}`];
        if (step.matches !== undefined) return [actual !== null && new RegExp(String(step.matches)).test(actual), `matches /${step.matches}/`];
        if (step.at_least !== undefined) return [actual !== null && Number(actual.replace(/[^0-9.-]/g, "")) >= Number(step.at_least), `at least ${step.at_least}`];
        return [actual !== null, "shown"];
    };
    let actual, ok, expected;
    if (step.value !== undefined) {
        actual = session.values[String(step.value)] ?? null;
        [ok, expected] = test(actual);
    } else if (step.see !== undefined) {
        ok = !session.stopped && await locatorOf(session.page, step.see).first().waitFor({ state: "visible", timeout: session.stepMs }).then(() => true, () => false);
        expected = `${describeLocator(step.see)} on the page`;
        actual = ok ? "shown" : "not shown";
    } else if (step.path !== undefined) {
        actual = session.current();
        ok = glob(step.path).test(actual);
        expected = String(step.path);
    } else throw new StepError(`check ${name}: say what it checks: \`value\`, \`see\` or \`path\``);
    session.checks.push({ name, passed: !!ok, expected, actual: actual === null ? "(not shown)" : String(actual) });
}

/** A project's own checks, in JavaScript: plain data in, results out. It never sees the page. */
async function moduleChecks(session, file, outcome) {
    const full = insideProject(file, "checks_module");
    if (!fs.existsSync(full)) throw new StepError(`checks_module: ${file} does not exist`);
    const mod = await import(pathToFileURL(full).href);
    const results = await mod.default(JSON.parse(JSON.stringify(outcome)));
    if (!Array.isArray(results)) throw new StepError(`checks_module: ${file} must return a list of { name, passed, expected?, actual? }`);
    for (const r of results) {
        if (typeof r?.name !== "string" || typeof r?.passed !== "boolean") throw new StepError(`checks_module: ${file}: each result needs a name and passed: true or false`);
        session.checks.push({ name: clean(r.name), passed: r.passed, ...(r.expected !== undefined ? { expected: clean(r.expected) } : {}), ...(r.actual !== undefined ? { actual: clean(r.actual) } : {}) });
    }
}

async function runJourney(session, journey, target) {
    const steps = journey.steps;
    if (typeof journey.goal !== "string" || !journey.goal.trim()) throw new StepError("a journey needs a `goal`, in words");
    if (!Array.isArray(steps) || !steps.length) throw new StepError("a journey needs `steps`");
    if (!steps.some((s) => s?.check !== undefined) && !journey.checks_module) throw new StepError("a journey needs at least one `check`: checks in code decide pass or fail");
    let stopped;
    for (const [i, raw] of steps.entries()) {
        const n = i + 1;
        // What differs on one target, such as a label in a new UI, is written under `on: { <target>: { … } }`.
        const { on, ...base } = raw ?? {};
        const step = { ...base, ...(on?.[target.name] ?? {}) };
        if (step.check !== undefined) { await checkStep(session, step); continue; }
        if (step.read !== undefined) {
            if (stopped) session.values[String(step.read)] = null;
            else await readValue(session, step);
            continue;
        }
        if (stopped) continue;
        if (step.reach !== undefined) {
            const missed = await reach(session, step);
            if (missed) { stopped = `step ${n}: did not reach ${clean(step.reach)}: ${missed}`; session.stopped = stopped; }
            continue;
        }
        await takeStep(session, step, n);
    }
    return stopped;
}

/** Watches every request the browser makes: the target only, and no writes unless the case may write. */
async function guardRequests(context, session, allowedOrigins, writes) {
    session.blocked = [];
    session.modelCalls = 0;
    const seen = new Set();
    const block = (why, request) => {
        const key = `${why}|${request}`;
        if (!seen.has(key)) { seen.add(key); session.blocked.push({ why, request }); }
    };
    await context.route("**/*", (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
        if (MODEL_HOSTS.test(url.hostname)) {
            session.modelCalls++;
            block("a call to a model", `${req.method()} ${url.origin}`);
            return route.abort("blockedbyclient");
        }
        if (!allowedOrigins.has(url.origin)) {
            block("not a target in cmtk.yaml", `${req.method()} ${url.origin}`);
            return route.abort("blockedbyclient");
        }
        if (!writes && !SAFE.has(req.method())) {
            block("changes data: write the case's request as POST, with both unsafe switches on, or mark it safe", `${req.method()} ${url.pathname}`);
            return route.abort("blockedbyclient");
        }
        return route.continue();
    });
    await context.routeWebSocket(/.*/, (ws) => {
        const url = new URL(ws.url());
        const http = url.origin.replace(/^ws/, "http");
        if (!allowedOrigins.has(http)) { block("not a target in cmtk.yaml", `WEBSOCKET ${url.origin}`); return ws.close(); }
        if (!writes) { block("a web socket can change data, and this case only reads", `WEBSOCKET ${url.pathname}`); return ws.close(); }
        return ws.connectToServer();
    });
}

const sortCalls = (session) => {
    const order = new Map(session.pages.map((p, i) => [p.path, i]).reverse());
    return [...session.apiCalls].sort((a, b) => (order.get(a.page) ?? 99) - (order.get(b.page) ?? 99) || `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`) || (a.status ?? 0) - (b.status ?? 0));
};

const pageBody = (session) => ({
    pages: session.pages,
    api_calls: sortCalls(session),
    ...(session.blocked.length ? { blocked: session.blocked } : {}),
});

/**
 * A virtual authenticator in this browser, so passkeys and security keys need no hardware. It answers every
 * request by itself, and its keys stay in the browser: nothing here asks for them.
 */
async function addAuthenticator(session, spec) {
    const known = { passkey: { protocol: "ctap2", transport: "internal" }, "security-key": { protocol: "ctap2", transport: "usb" } };
    const options = known[spec === true ? "passkey" : spec];
    if (!options) throw new StepError(`authenticator must be passkey or security-key, not ${JSON.stringify(spec)}`);
    const cdp = await session.devtools();
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { ...options, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

/** Runs one case on one target and returns an observation. */
export async function runCase(browser, written, target, headers, baseUrl, secrets, { record } = {}) {
    // The conformance kit sends a case as written, so a request may still be one line.
    const line = typeof written.request === "string" ? /^(\S+)\s+(\S+)$/.exec(written.request.trim()) : undefined;
    const c = line ? { ...written, request: { method: line[1], path: line[2] } } : written;
    const method = String(c.request?.method ?? "GET").toUpperCase();
    // The engine only sends a non-GET case when both unsafe switches are on, or when a person marked it safe.
    const writes = !SAFE.has(method) || c.safe === true;
    const origin = new URL(baseUrl).origin;
    const allowed = new Set([origin, ...String(target.allow_origins ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => new URL(s).origin)]);
    const context = await browser.newContext({
        baseURL: baseUrl,
        serviceWorkers: "block",
        extraHTTPHeaders: { ...(c.request?.headers ?? {}), ...headers },
        viewport: { width: 1280, height: 800 },
        locale: "en-GB",
        timezoneId: "UTC",
        colorScheme: "light",
        reducedMotion: "reduce",
        ignoreHTTPSErrors: target.insecure_tls === true,
    });
    let journey = c.journey;
    if (journey?.script) {
        try {
            journey = { ...loadScript(journey.script), ...(journey.step_timeout_ms ? { step_timeout_ms: journey.step_timeout_ms } : {}) };
        } catch (err) {
            await context.close().catch(() => {});
            if (err instanceof StepError) return { error: err.message, model_calls: 0 };
            throw err;
        }
    }
    const stepMs = Number(journey?.step_timeout_ms ?? target.step_timeout_ms ?? 5000);
    const page = await context.newPage();
    const session = new Session(page, { stepMs, navMs: Number(target.navigation_timeout_ms ?? 30000), secrets, mask: c.mask ?? journey?.mask, target, scriptFile: journey?.script_file, resolved: record });
    await guardRequests(context, session, allowed, writes);
    const finish = async (obs) => ({ ...obs, ...(session.structure.length ? { structure: { pages: session.structure } } : {}), ...(session.shots.length ? { screenshots: session.shots } : {}), model_calls: session.modelCalls });
    try {
        if (!journey) {
            try {
                const res = await open(session, c.request.path);
                await session.capture(session.current());
                return await finish({ status: res?.status(), headers: { "content-type": "application/json" }, body: JSON.stringify({ ...pageBody(session), elements: session.structure[0]?.elements ?? [] }) });
            } catch (err) {
                if (err instanceof StepError) return await finish({ error: err.message });
                throw err;
            }
        }
        const outcome = {};
        const build = (stopped) => {
            Object.assign(outcome, {
                goal: clean(journey.goal),
                ...(journey.script_file ? { script: { file: journey.script_file, sha256: journey.script_sha256 } } : {}),
                passed: !stopped && session.checks.every((k) => k.passed),
                ...(stopped ? { stopped } : {}),
                checks: session.checks,
                values: session.values,
                ...pageBody(session),
                ...(journey.compare_api ? { api_compared: sortCalls(session).map((a) => `${a.method} ${a.path} ${a.status}`) } : {}),
            });
            return outcome;
        };
        try {
            if (journey.authenticator) await addAuthenticator(session, journey.authenticator);
            const stopped = await runJourney(session, journey, target);
            build(stopped);
            if (journey.checks_module) { await moduleChecks(session, journey.checks_module, outcome); build(stopped); }
            await session.capture("end");
            return await finish({ status: outcome.passed ? 200 : 417, headers: { "content-type": "application/json" }, body: JSON.stringify(outcome), journey: outcome });
        } catch (err) {
            if (!(err instanceof StepError)) throw err;
            await session.shoot("where it stopped");
            return await finish({ error: err.message, journey: build(err.message), ...(err.repair ? { repair: err.repair } : {}) });
        }
    } finally {
        await context.close().catch(() => {});
    }
}
