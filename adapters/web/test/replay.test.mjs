// Recording a verified journey, replaying it with no model, and a broken locator that is proposed and never applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { decideProposal, loadManifest, loadProposals } from "../../../packages/core/dist/index.js";
import { mergeSteps } from "../record.mjs";
import { ADAPTER, browserProblem, cmtk, manifest, newShop, oldShop, project, REPO, serve } from "./helpers.mjs";

const skip = await browserProblem();
const web = { skip, timeout: 240_000 };
const RECORD = path.join(ADAPTER, "record.mjs");
const SERVER = path.join(REPO, "packages", "mcp", "dist", "server.js");
const GUARD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "no-network.mjs")).href;

const record = (cwd, args, env = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [RECORD, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

/** Loose locators on purpose: a person or an agent worked these out. Recording tightens them. */
const DRAFT = {
    goal: "Find a red jacket and add it to the basket",
    step_timeout_ms: 2000,
    steps: [
        { goto: "/" },
        { fill: { css: "input" }, with: "red jacket" },
        { click: { css: "form button" }, on: { candidate: { click: { css: "#go" } } } },
        { click: { text: "Red jacket" } },
        { reach: "product", see: { role: "heading", name: "Red jacket" } },
        { read: "price", from: { testid: "price" }, on: { candidate: { from: { testid: "cost" } } } },
        { click: { css: "main button" }, on: { candidate: { click: { css: "section button" } } } },
        { reach: "basket", path: "/basket", on: { candidate: { path: "/cart" } } },
        { read: "items", from: { testid: "count" }, on: { candidate: { from: { css: "#n" } } } },
        { check: "the basket holds the jacket", value: "items", equals: 1 },
    ],
};
const CASE = "cases:\n  - { id: BASKET, requirement: SHOP-1, surface: web, match: journey, request: POST /, expect: { status: 200 }, journey: { script: cmtk/journeys/basket.json, step_timeout_ms: 800 } }\n";
const UNSAFE = "allow_unsafe_methods: true";
const SCRIPT = "cmtk/journeys/basket.json";
const recordArgs = (a, b) => ["--journey", "cmtk/journeys/basket.draft.json", "--out", SCRIPT, "--target", `legacy=${a.url}`, "--target", `candidate=${b.url}`, "--writes", "--date", "2026-11-04"];
const report = (dir, mode = "compare") => JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence", mode, "REPORT.json"), "utf8"));
const answer = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/answers", name), "utf8"));

async function recorded(a, b) {
    const dir = project({ "cmtk.yaml": manifest(a.url, b.url, UNSAFE), "cmtk/cases/shop.yaml": CASE, "cmtk/journeys/basket.draft.json": JSON.stringify(DRAFT, null, 2) });
    const r = await record(dir, recordArgs(a, b));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return dir;
}
const script = (dir) => JSON.parse(fs.readFileSync(path.join(dir, SCRIPT), "utf8"));

test("recording writes plain, stable locators for each target, and copies checks and values as written", web, async () => {
    const [a, b] = [await oldShop(), await newShop()];
    try {
        const s = script(await recorded(a, b));
        assert.equal(s.cmtk_script, 1);
        assert.equal(s.recorded.date, "2026-11-04");
        assert.deepEqual(s.recorded.targets, ["legacy", "candidate"]);
        assert.deepEqual(s.steps[2].click, { role: "button", name: "Search" });
        assert.deepEqual(s.steps[2].on.candidate.click, { role: "button", name: "Find" });
        assert.deepEqual(s.steps[3], { click: { role: "link", name: "Red jacket" } }, "what both share is written once");
        assert.deepEqual(s.steps[6].click, { role: "button", name: "Add to basket" });
        assert.deepEqual(s.steps[6].on.candidate.click, { role: "button", name: "Add to cart" });
        for (const i of [4, 5, 7, 8, 9]) assert.deepEqual(s.steps[i], DRAFT.steps[i], `step ${i + 1} is not an action, so it is copied`);
    } finally {
        await a.close(); await b.close();
    }
});

test("a journey that does not pass is not recorded: only a verified run becomes a script", web, async () => {
    const [a, b] = [await oldShop(), await newShop({ brokenBasket: true })];
    const dir = project({ "cmtk/journeys/basket.draft.json": JSON.stringify(DRAFT) });
    try {
        const r = await record(dir, recordArgs(a, b));
        assert.equal(r.status, 1);
        assert.match(r.stderr, /not recorded: on candidate the journey did not pass: the basket holds the jacket/);
        assert.ok(!fs.existsSync(path.join(dir, SCRIPT)));
        const noWrites = await record(dir, recordArgs(a, a).filter((x) => x !== "--writes"));
        assert.equal(noWrites.status, 1, "without --writes the browser refuses the write, so the check fails");
    } finally {
        await a.close(); await b.close();
    }
});

test("mergeSteps changes only the action's locator", () => {
    const steps = [{ click: { css: "x" }, on: { b: { click: { css: "y" } }, c: { other: 1 } } }, { check: "c", value: "v", equals: 1 }];
    const merged = mergeSteps(steps, { a: new Map([[1, { action: "click", locator: { role: "button", name: "A" } }]]), b: new Map([[1, { action: "click", locator: { role: "button", name: "A" } }]]) });
    assert.deepEqual(merged[0], { click: { role: "button", name: "A" }, on: { c: { other: 1 } } });
    assert.deepEqual(merged[1], steps[1]);
});

test("replay on both systems: no model, no network but the targets, zero in the report, the check decides", web, async () => {
    const [a, b] = [await oldShop(), await newShop()];
    const dir = await recorded(a, b);
    const log = path.join(dir, "network.log");
    fs.writeFileSync(log, "");
    const blank = Object.fromEntries(Object.keys(process.env).filter((k) => /ANTHROPIC|OPENAI|MODEL|AZURE_AI|GEMINI|GOOGLE_API/i.test(k)).map((k) => [k, ""]));
    const before = fs.readFileSync(path.join(dir, SCRIPT));
    try {
        const r = await cmtk(dir, ["compare", "--allow-unsafe"], { ...blank, NODE_OPTIONS: `--import=${GUARD}`, CMTK_NETWORK_LOG: log });
        const rep = report(dir);
        assert.equal(r.status, 0, r.stdout + r.stderr + JSON.stringify(rep.cases));
        assert.equal(rep.verdict, "PARITY");
        assert.deepEqual(rep.model_calls, { total: 0, cases_not_counted: 0 });
        assert.match(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.md"), "utf8"), /- Model calls: 0\n/);
        assert.equal(fs.readFileSync(log, "utf8"), "", "no process opened a connection beyond this machine");
        const x = answer(dir, "BASKET.reference.json");
        assert.equal(x.journey.script.file, SCRIPT);
        assert.match(x.journey.script.sha256, /^[0-9a-f]{64}$/);
        assert.deepEqual(fs.readFileSync(path.join(dir, SCRIPT)), before, "a replay never writes to its script");
    } finally {
        await a.close(); await b.close();
    }
});

test("the adapter holds no model client: no SDK in its code or its dependencies", () => {
    const code = fs.readdirSync(ADAPTER).filter((f) => f.endsWith(".mjs")).map((f) => fs.readFileSync(path.join(ADAPTER, f), "utf8"));
    for (const text of code) {
        const imports = [...text.matchAll(/(?:from\s+|require\(|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
        assert.ok(imports.every((i) => i.startsWith("node:") || i.startsWith("./") || i === "playwright"), imports.join());
    }
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(ADAPTER, "package.json"), "utf8")).dependencies), ["playwright"]);
});

/** The new shop with its button renamed, as a UI change would. */
const renamed = async () => {
    const inner = await newShop();
    const site = await serve(async (req, res) => {
        const r = await fetch(inner.url + req.url, { method: req.method, headers: { cookie: req.headers.cookie ?? "" }, redirect: "manual" });
        const text = (await r.text()).replace("Add to cart", "Add to bag");
        const headers = { "content-type": r.headers.get("content-type") ?? "text/plain" };
        const set = r.headers.get("set-cookie");
        if (set) headers["set-cookie"] = set;
        res.writeHead(r.status, headers);
        res.end(text);
    });
    return { url: site.url, close: async () => { await site.close(); await inner.close(); } };
};

async function agent(fn) {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

test("a renamed button: the replay reports it, a repair is proposed, and nothing changes until a person accepts it", web, async () => {
    const [a, good] = [await oldShop(), await newShop()];
    const dir = await recorded(a, good);
    await good.close();
    const b = await renamed();
    const file = path.join(dir, SCRIPT);
    const yaml = path.join(dir, "cmtk.yaml");
    fs.writeFileSync(yaml, manifest(a.url, b.url, UNSAFE));
    const original = fs.readFileSync(file, "utf8");
    const caseFile = path.join(dir, "cmtk/cases/shop.yaml");
    const caseText = fs.readFileSync(caseFile, "utf8");
    try {
        const r = await cmtk(dir, ["compare", "--allow-unsafe"]);
        const rep = report(dir);
        assert.equal(rep.cases[0].result, "ERROR", r.stdout + r.stderr);
        assert.notEqual(rep.verdict, "PARITY");
        assert.match(rep.cases[0].why, /candidate: step 7: nothing on the page matches button "Add to cart"/);
        assert.equal(fs.readFileSync(file, "utf8"), original, "the replay did not touch its script");

        const { repair } = answer(dir, "BASKET.candidate.json");
        assert.equal(repair.step, 7);
        assert.equal(repair.target, "candidate");
        assert.equal(repair.script, SCRIPT);
        assert.deepEqual(repair.was, { role: "button", name: "Add to cart" });
        assert.deepEqual(repair.candidates[0].locator, { role: "button", name: "Add to bag" }, "the likeliest element comes first");

        const out = await agent(async (client) => {
            const call = (args) => client.callTool({ name: "cmtk_propose", arguments: { manifest: yaml, agent: "repairer", reason: "the button was renamed", ...args } });
            const refused = {
                expect: await call({ kind: "locator", case: "BASKET", step: 7, target: "candidate", locator: repair.candidates[0].locator, expect: { status: 500 } }),
                check: await call({ kind: "locator", case: "BASKET", step: 10, target: "candidate", locator: { role: "button", name: "x" } }),
                read: await call({ kind: "locator", case: "BASKET", step: 9, target: "candidate", locator: { role: "button", name: "x" } }),
                extra: await call({ kind: "locator", case: "BASKET", step: 7, target: "candidate", locator: { role: "button", name: "x", equals: "1" } }),
                noTarget: await call({ kind: "locator", case: "BASKET", step: 7, locator: { role: "button", name: "x" } }),
            };
            return { refused, made: await call({ kind: "locator", case: "BASKET", step: repair.step, target: repair.target, locator: repair.candidates[0].locator }) };
        });
        assert.match(out.refused.expect.content[0].text, /changes how a step finds an element and nothing else/);
        assert.match(out.refused.check.content[0].text, /only a person edits it/);
        assert.match(out.refused.read.content[0].text, /only a person edits it/);
        assert.match(out.refused.extra.content[0].text, /and nothing else/);
        assert.match(out.refused.noTarget.content[0].text, /name the target/);
        assert.equal(out.made.isError, false, out.made.content[0].text);
        assert.match(out.made.content[0].text, /it would find it by: {4}\{"role":"button","name":"Add to bag"\}/);
        assert.match(out.made.content[0].text, /never what the case expects/);

        const m = loadManifest(yaml);
        const pending = loadProposals(m).filter((p) => p.status === "pending");
        assert.equal(pending.length, 1);
        assert.equal(pending[0].proposed_by, "agent: repairer");
        assert.equal(fs.readFileSync(file, "utf8"), original, "proposing applies nothing");
        await cmtk(dir, ["compare", "--allow-unsafe"]);
        assert.equal(report(dir).cases[0].result, "ERROR", "it is still broken until a person decides");

        const decided = decideProposal(m, pending[0].id, true, "Jane Smith", "2026-11-04", undefined, pending[0]);
        assert.equal(decided.applied, `step 7 of ${SCRIPT} on candidate`);
        const after = JSON.parse(fs.readFileSync(file, "utf8"));
        const was = JSON.parse(original);
        assert.deepEqual(after.steps[6].on.candidate.click, { role: "button", name: "Add to bag" });
        assert.deepEqual(after.steps[6].click, was.steps[6].click, "the other system's locator stays");
        assert.equal(after.recorded.repairs[0].accepted_by, "Jane Smith");
        // Nothing else changed: put the one repair back, and the file is what it was.
        after.steps[6].on.candidate.click = was.steps[6].on.candidate.click;
        delete after.recorded.repairs;
        assert.deepEqual(after, was);
        assert.equal(fs.readFileSync(caseFile, "utf8"), caseText, "the case, and its expect block, did not change");

        const again = await cmtk(dir, ["compare", "--allow-unsafe"]);
        assert.equal(report(dir).verdict, "PARITY", again.stdout + again.stderr);
    } finally {
        await a.close(); await b.close();
    }
});

test("a repair whose script changed after it was proposed is not applied; a rejected one changes nothing", web, async () => {
    const [a, b] = [await oldShop(), await newShop()];
    const dir = await recorded(a, b);
    const yaml = path.join(dir, "cmtk.yaml");
    const file = path.join(dir, SCRIPT);
    try {
        await agent((client) => client.callTool({ name: "cmtk_propose", arguments: { manifest: yaml, kind: "locator", case: "BASKET", step: 7, target: "candidate", locator: { role: "button", name: "Add to bag" }, reason: "r" } }));
        const m = loadManifest(yaml);
        const [p] = loadProposals(m);
        const before = fs.readFileSync(file, "utf8");
        decideProposal(m, p.id, false, "Jane Smith", "2026-11-04", "no");
        assert.equal(fs.readFileSync(file, "utf8"), before);
        await agent((client) => client.callTool({ name: "cmtk_propose", arguments: { manifest: yaml, kind: "locator", case: "BASKET", step: 7, target: "candidate", locator: { role: "button", name: "Other" }, reason: "r" } }));
        const q = loadProposals(m).find((x) => x.status === "pending");
        const s = JSON.parse(before);
        s.steps[6].on.candidate.click = { role: "button", name: "Changed by a person" };
        fs.writeFileSync(file, JSON.stringify(s));
        assert.throws(() => decideProposal(m, q.id, true, "Jane Smith", "2026-11-04"), /changed after this was proposed/);
    } finally {
        await a.close(); await b.close();
    }
});

test("a script that is missing, outside the project or not a script is an error, and a case with none cannot get a repair", web, async () => {
    const [a] = [await oldShop()];
    const dir = project({
        "cmtk.yaml": manifest(a.url, a.url, UNSAFE).replace(/ {2}candidate: .*\n/, ""),
        "cmtk/cases/c.yaml": "cases:\n  - { id: A, surface: web, request: GET /, expect: { status: 200 }, journey: { script: nope.json } }\n  - { id: B, surface: web, request: GET /, expect: { status: 200 }, journey: { script: ../out.json } }\n  - { id: C, surface: web, request: GET /, expect: { status: 200 }, journey: { script: bad.json } }\n  - { id: D, surface: web, request: GET /, expect: { status: 200 }, journey: { goal: g, steps: [{ click: { css: x } }, { check: c, path: / }] } }\n",
        "bad.json": "{}",
    });
    try {
        const ran = await cmtk(dir, ["run"]);
        assert.ok(fs.existsSync(path.join(dir, "cmtk/evidence/run/REPORT.json")), ran.stdout + ran.stderr);
        const why = Object.fromEntries(report(dir, "run").cases.map((c) => [c.id, c.why]));
        assert.match(why.A, /nope\.json does not exist/);
        assert.match(why.B, /outside the project folder/);
        assert.match(why.C, /not a recorded script/);
        const r = await agent((client) => client.callTool({ name: "cmtk_propose", arguments: { manifest: path.join(dir, "cmtk.yaml"), kind: "locator", case: "D", step: 1, target: "legacy", locator: { css: "y" }, reason: "r" } }));
        assert.match(r.content[0].text, /has no recorded script/);
    } finally {
        await a.close();
    }
});
