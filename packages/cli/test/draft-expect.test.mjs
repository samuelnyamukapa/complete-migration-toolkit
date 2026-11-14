// `cmtk import-har --draft-expect` (#41), end to end, and `cmtk review` driven by a person's keystrokes.
// The eShop pilot's HAR file is not kept in the repository, so the recording here is rebuilt from the 17 requests
// the pilot imported (examples/eshop-pilot/cmtk/cases/imported/har.yaml), with answers a local stand-in gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const CLI = path.join(HERE, "..", "dist", "main.js");

const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

/**
 * Run `cmtk review` as a person would. `cmtk review` refuses a script, so this says the streams are a
 * terminal (the refusal itself is tested in cli.test.mjs) and types each answer when a prompt appears.
 */
function review(cwd, answers) {
    const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-tty-")), "tty.mjs");
    fs.writeFileSync(preload, "process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n");
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, "review"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "", seen = 0;
        const left = [...answers];
        p.stdout.on("data", (d) => {
            stdout += d;
            const fresh = stdout.slice(seen).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
            if (/(Your full name: |\[a\/(A\/)?r\/s\/q\] |Why reject it\?[^\n]* )$/.test(fresh)) {
                seen = stdout.length;
                if (left.length) p.stdin.write(`${left.shift()}\n`); else p.stdin.end();
            }
        });
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

const SECRET_BODY = "Dear Jane Doe, your order for jane.doe@example.com";

/** A recording of the pilot's 17 requests, whose answers hold text and headers no case may ever copy. */
function recording() {
    const { cases } = YAML.parse(fs.readFileSync(path.join(ROOT, "examples/eshop-pilot/cmtk/cases/imported/har.yaml"), "utf8"));
    assert.equal(cases.length, 17, "the pilot imported 17 cases");
    return {
        paths: cases.map((c) => c.request.path),
        har: { log: { entries: cases.map((c, i) => ({
            request: { method: c.request.method, url: `http://localhost:53190${c.request.path}`, headers: Object.entries(c.request.headers ?? {}).map(([name, value]) => ({ name, value })) },
            response: {
                status: 200,
                headers: [
                    { name: "Content-Type", value: `text/html; charset=utf-8; name="Jane Doe ${i}"` },
                    { name: "Set-Cookie", value: "session=jane-doe-cookie" },
                    { name: "X-User-Email", value: "jane.doe@example.com" },
                    { name: "Location", value: "/users/jane-doe" },
                ],
                content: { mimeType: "text/html", text: SECRET_BODY },
            },
        })) } },
    };
}

function standIn() {
    const seen = [];
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            seen.push(req.url);
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<html></html>");
        });
        s.listen(0, "127.0.0.1", () => resolve({ seen, url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
}

async function imported(url, har = recording().har) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-draft-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: eshop\ntargets:\n  legacy: { base_url: "${url}" }\ndefault_target: legacy\ncases: [cmtk/cases/*.yaml]\n`);
    fs.writeFileSync(path.join(dir, "recording.har"), JSON.stringify(har));
    const r = await cmtk(dir, "import-har", "recording.har", "--draft-expect");
    assert.equal(r.status, 0, r.stderr);
    return { dir, stdout: r.stdout, file: path.join(dir, "cmtk/cases/har.yaml") };
}

test("the eShop requests: every case gets a draft, the drafts are skipped, and confirming one makes it run", async () => {
    const s = await standIn();
    try {
        const { dir, file, stdout } = await imported(s.url);
        assert.match(stdout, /Drafted an expectation for 17 cases/);
        const { cases } = YAML.parse(fs.readFileSync(file, "utf8"));
        assert.equal(cases.length, 17);
        for (const c of cases) {
            assert.equal(c.expect_draft, true, c.id);
            assert.deepEqual(c.expect, { status: 200, headers: { "Content-Type": { matches: "^text/html\\s*(;|$)" } } }, c.id);
        }

        let r = await cmtk(dir, "run");
        assert.equal(r.status, 2, r.stdout);
        assert.match(r.stdout, /verdict for eshop: NO EVIDENCE/);
        assert.match(r.stdout, /17 skipped/);
        assert.deepEqual(s.seen, [], "a drafted expectation sends nothing");
        const report = fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.md"), "utf8");
        assert.equal(report.match(/SKIPPED — draft expectation: review it/g).length, 17);

        const c = await cmtk(dir, "check");
        assert.match(c.stdout, /17 drafted expectations wait for a person/);

        const person = await review(dir, ["Jane Smith", "a", "q"]);
        assert.equal(person.status, 0, person.stdout + person.stderr);
        assert.match(person.stdout, /Drafted expectation for case HAR-001/);
        assert.doesNotMatch(person.stdout, /a\/A\/r\/s\/q/, "no accept-all for a drafted expectation");
        assert.match(person.stdout, /Accepted 1, rejected 0/);
        const after = YAML.parse(fs.readFileSync(file, "utf8")).cases;
        assert.equal(after[0].expect_draft, undefined);
        assert.equal(after[0].expect_confirmed_by, "Jane Smith");
        assert.match(after[0].note, /not the requirement/);
        assert.equal(after[1].expect_draft, true, "the others still wait");

        r = await cmtk(dir, "run", "--json");
        const out = JSON.parse(r.stdout);
        assert.equal(out.verdict, "INCOMPLETE");
        assert.equal(out.counts.PASS, 1, "the confirmed one ran, and passed");
        assert.equal(out.counts.SKIPPED, 16);
        assert.equal(s.seen.length, 1);

        // One pass of review turns the rest into runnable cases.
        const rest = await review(dir, ["Jane Smith", ...Array(16).fill("a")]);
        assert.match(rest.stdout, /Accepted 16/);
        r = await cmtk(dir, "run");
        assert.equal(r.status, 0, r.stdout);
        assert.match(r.stdout, /verdict for eshop: PASS/);
    } finally {
        await s.close();
    }
});

test("no body text and no header but the media type reaches a case, its report or its output", async () => {
    const s = await standIn();
    try {
        const { dir, file, stdout } = await imported(s.url);
        const text = fs.readFileSync(file, "utf8") + stdout + (await cmtk(dir, "run")).stdout + fs.readFileSync(path.join(dir, "cmtk/evidence/run/REPORT.json"), "utf8");
        for (const leak of ["Jane", "jane", "Doe", "example.com", "session", "Set-Cookie", "X-User-Email", "Location", "charset"]) assert.ok(!text.includes(leak), leak);
    } finally {
        await s.close();
    }
});

test("what a recorded answer gives: a redirect, a browser's own copy, odd content types and no answer", async () => {
    const entry = (p, response) => ({ request: { method: "GET", url: `http://l${p}`, headers: [] }, response });
    const { dir, file, stdout } = await imported("http://127.0.0.1:9", { log: { entries: [
        entry("/moved", { status: 302, headers: [{ name: "location", value: "/users/jane" }] }),
        entry("/cached", { status: 304, headers: [{ name: "content-type", value: "text/html" }] }),
        entry("/plus", { status: 200, headers: [{ name: "CONTENT-TYPE", value: "application/vnd.api+json" }] }),
        entry("/mime", { status: 200, headers: [], content: { mimeType: "application/json; charset=utf-8", text: SECRET_BODY } }),
        entry("/bad", { status: 200, headers: [{ name: "content-type", value: "jane doe <jane@example.com>" }] }),
        entry("/cancelled", { status: 0, headers: [], content: { text: SECRET_BODY } }),
        entry("/none", undefined),
    ] } });
    const by = Object.fromEntries(YAML.parse(fs.readFileSync(file, "utf8")).cases.map((c) => [c.request.path, c]));
    assert.deepEqual(by["/moved"].expect, { status: 302 });
    assert.deepEqual(by["/cached"].expect, { status: [200, 304] });
    assert.match(by["/cached"].draft_note, /allows 200 or 304/);
    assert.equal(by["/plus"].expect.headers["Content-Type"].matches, "^application/vnd\\.api\\+json\\s*(;|$)");
    assert.ok(new RegExp(by["/plus"].expect.headers["Content-Type"].matches).test("application/vnd.api+json; charset=utf-8"));
    assert.ok(!new RegExp(by["/mime"].expect.headers["Content-Type"].matches).test("application/json-patch"), "the type, not a longer one");
    assert.deepEqual(by["/bad"].expect, { status: 200 }, "text that is no media type is dropped");
    for (const p of ["/cancelled", "/none"]) {
        assert.equal(by[p].expect, undefined, p);
        assert.equal(by[p].expect_draft, undefined, p);
        assert.match(by[p].draft_note, /no answer/, p);
    }
    assert.match(stdout, /holds no answer for HAR-006, HAR-007/);
    const r = await cmtk(dir, "run", "--json");
    assert.match(JSON.parse(r.stdout).cases.find((c) => c.id === "HAR-006").why, /no `expect:` block/);
    assert.ok(!fs.readFileSync(file, "utf8").includes("jane"));
});

test("rejecting a draft keeps the case with no expectation; a compare and --accepted-only treat drafts as documented", async () => {
    const a = await standIn(), b = await standIn();
    try {
        const { dir, file } = await imported(a.url);
        const person = await review(dir, ["Jane Smith", "r", "legacy is wrong here", "q"]);
        assert.match(person.stdout, /rejected 1/);
        const first = YAML.parse(fs.readFileSync(file, "utf8")).cases[0];
        assert.equal(first.expect, undefined);
        assert.equal(first.expect_draft, undefined);
        const kept = YAML.parse(fs.readFileSync(path.join(dir, "cmtk/rejected.yaml"), "utf8")).rejected[0];
        assert.equal(kept.id, "HAR-001");
        assert.equal(kept.rejected_by, "Jane Smith");
        assert.equal(kept.rejected_because, "legacy is wrong here");
        assert.equal(kept.expect.status, 200);

        const ci = await cmtk(dir, "run", "--accepted-only", "--json");
        const out = JSON.parse(ci.stdout);
        assert.equal(out.excluded_drafts, 16, "--accepted-only leaves drafted expectations out");

        // A comparison never reads `expect`, so a drafted expectation does not hold a case back from it.
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: eshop\ntargets:\n  legacy: { base_url: "${a.url}" }\n  candidate: { base_url: "${b.url}" }\ndefault_target: legacy\nreference: legacy\ncases: [cmtk/cases/*.yaml]\n`);
        const c = await cmtk(dir, "compare", "--json");
        assert.equal(JSON.parse(c.stdout).counts.MATCH, 17);
    } finally {
        await a.close();
        await b.close();
    }
});

test("a person accepting an agent's draft sees the drafted expectation, confirms it with the case, and gets no accept-all", async () => {
    const s = await standIn();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-draft-"));
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: D1, request: GET /1, draft: true, expect_draft: true, draft_note: from a recording, expect: { status: 200 } }\n  - { id: D2, request: GET /2, draft: true, expect_draft: true, expect: { status: 200 } }\n");
        const person = await review(dir, ["Jane Smith", "a", "q"]);
        assert.doesNotMatch(person.stdout, /a\/A\/r\/s\/q/);
        const [d1, d2] = YAML.parse(fs.readFileSync(path.join(dir, "cmtk/cases/a.yaml"), "utf8")).cases;
        assert.equal(d1.draft, undefined);
        assert.equal(d1.expect_draft, undefined);
        assert.equal(d1.accepted_by, "Jane Smith");
        assert.equal(d1.expect_confirmed_by, "Jane Smith");
        assert.equal(d2.expect_draft, true);
        const out = JSON.parse((await cmtk(dir, "run", "--json")).stdout);
        assert.equal(out.counts.PASS, 1);
        assert.match(out.cases[1].why, /^draft expectation: review it/);
    } finally {
        await s.close();
    }
});

test("a drafted expectation needs an expect: block", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-draft-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\n");
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: D1, request: GET /1, expect_draft: true }\n");
    const r = await cmtk(dir, "check");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /marks a drafted `expect:` block/);
});

test("without --draft-expect, an import writes no expectation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-draft-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\n");
    fs.writeFileSync(path.join(dir, "r.har"), JSON.stringify(recording().har));
    const r = await cmtk(dir, "import-har", "r.har");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "cmtk/cases/har.yaml"), "utf8"), /^\s+expect/m);
});

test("cmtk review applies a known issue with the person's name, and accepting a recipe's drafts still offers accept-all", async () => {
    const s = await standIn();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-draft-"));
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  candidate: { base_url: "${s.url}" }\n`);
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: A, request: GET /, expect: { status: 201 } }\n  - { id: D1, request: GET /1, draft: true, expect: { status: 200 } }\n  - { id: D2, request: GET /2, draft: true, expect: { status: 200 } }\n");
        fs.writeFileSync(path.join(dir, "cmtk/proposals.yaml"), `proposals:\n  - { id: P-001, kind: known_issue, status: pending, reason: legacy defect, proposed_by: "agent: t", proposed_on: 2026-11-04, case: A, issue_id: LEG-9, fails: [{ check: status, expected: "201", actual: "200" }] }\n`);
        assert.equal((await cmtk(dir, "run")).status, 1);
        const person = await review(dir, ["Jane Smith", "s", "s", "a"]);
        assert.match(person.stdout, /a\/A\/r\/s\/q/, "drafts a recipe wrote keep accept-all");
        assert.match(person.stdout, /applied: LEG-9 in cmtk\/known-issues\.yaml/);
        assert.match(fs.readFileSync(path.join(dir, "cmtk/known-issues.yaml"), "utf8"), /accepted_by: Jane Smith/);
        const r = await cmtk(dir, "run", "--accepted-only");
        assert.equal(r.status, 4, r.stdout);
        assert.match(r.stdout, /PASS WITH KNOWN ISSUES/);
    } finally {
        await s.close();
    }
});
