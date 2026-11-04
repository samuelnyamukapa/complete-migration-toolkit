// Dated evidence, `cmtk trend` and clean-up (#31). A series of stored reports with known patterns: the trend report
// must list each pattern correctly. Clean-up must never follow a link out of the evidence folder.
// No pilot has run this nightly for two weeks: these are stored reports and local stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { cleanHistory, compare, datedRuns, keepDated, loadManifest, shadow, sizeOf, stampOf, stampTime, trend } from "../../core/dist/index.js";

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

function project(extra = "") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-trend-"));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: nightly\ntargets:\n  legacy: { base_url: "http://127.0.0.1:9" }\n  candidate: { base_url: "http://127.0.0.1:9" }\n${extra}`);
    return dir;
}

const pass = (id) => ({ id, name: id, requirement: [], surface: "http", result: "MATCH" });
const diff = (id, ...wheres) => ({ id, name: id, requirement: [], surface: "http", result: "DIFFERENT", differences: wheres.map((where) => ({ where, reference: "1", candidate: "2" })) });
const drifted = (id, where, drift) => ({ id, name: id, requirement: [], surface: "http", result: "DRIFT", differences: [{ where, reference: "1", candidate: "2", drift }] });

function stored(dir, mode, stamp, report) {
    const d = path.join(dir, "cmtk/evidence/history", mode, stamp);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "REPORT.json"), typeof report === "string" ? report : JSON.stringify(report));
    return d;
}

const compareReport = (over) => ({
    tool: "cmtk", mode: "compare", system: "nightly", date: "2026-11-01", verdict: "NO PARITY", targets: {}, counts: {}, cases: [], contracts: [], requirements: [], unused_drift: [], suggested_scrubs: [], partial: false,
    settings: { manifest: "cmtk.yaml", manifest_sha256: "same", match: "exact", overrides: [], scrub: { json_paths: ["$.at", "$.mistyped"], xml_ignore: ["Stamp"], regex: [{ pattern: "req-[0-9]+" }] }, drift_file: "cmtk/drift.yaml", drift_entries: 3 },
    scrub_fired: { "json_path $.at": 4, "json_path $.mistyped": 0, "xml_ignore Stamp": 0, "regex req-[0-9]+": 0 },
    reason: "", next: "", ...over,
});

test("a series of stored reports: the trend report lists each known pattern", async () => {
    const dir = project();
    const series = [
        // STEADY: never differs. FLAKY: fails, passes, fails, passes. FIXED: fails twice, then passes. BROKE: passes, then fails from day 3.
        { stamp: "2026-11-01T02-17-00Z", verdict: "NO PARITY", cases: [pass("STEADY"), diff("FLAKY", "$.items[0].price"), diff("FIXED", "$.gone"), pass("BROKE"), diff("LATE", "$.keeps"), drifted("DR", "header:etag", "D-STOPPED")], unused_drift: ["D-NEVER"] },
        { stamp: "2026-11-02T02-17-00Z", verdict: "DRIFT ONLY", cases: [pass("STEADY"), pass("FLAKY"), diff("FIXED", "$.gone"), pass("BROKE"), diff("LATE", "$.keeps"), drifted("DR", "header:etag", "D-STOPPED")], unused_drift: ["D-NEVER"], scrub_fired: { "json_path $.at": 0, "json_path $.mistyped": 0, "xml_ignore Stamp": 0, "regex req-[0-9]+": 3 } },
        { stamp: "2026-11-03T02-17-00Z", verdict: "NO PARITY", cases: [pass("STEADY"), diff("FLAKY", "$.items[3].price"), pass("FIXED"), diff("BROKE", "status"), diff("LATE", "$.keeps"), pass("DR")], unused_drift: ["D-NEVER"] },
        { stamp: "2026-11-04T02-17-00Z", verdict: "NO PARITY", cases: [pass("STEADY"), pass("FLAKY"), pass("FIXED"), diff("BROKE", "status", "$.brand.new"), diff("LATE", "$.keeps"), pass("DR")], unused_drift: ["D-NEVER", "D-STOPPED"] },
    ];
    for (const s of series) stored(dir, "compare", s.stamp, compareReport(s));
    stored(dir, "compare", "2026-10-31T02-17-00Z", "{ this is not json");

    const r = await cmtk(dir, "trend", "--mode", "compare");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const t = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/trend/compare/TREND.json"), "utf8"));

    assert.deepEqual(t.runs.map((x) => [x.run, x.verdict]), series.map((s) => [s.stamp, s.verdict]), "the verdict over time, oldest first");
    assert.deepEqual(t.unreadable, ["2026-10-31T02-17-00Z"], "a broken report is named and not counted");

    const state = Object.fromEntries(t.differences.map((d) => [d.where, d.state]));
    assert.deepEqual(state, {
        "$.brand.new": "new",
        "$.keeps": "keeps coming back",
        status: "keeps coming back",
        "$.gone": "gone",
        "$.items[*].price": "gone",
        "header:etag": "gone",
    });
    const by = Object.fromEntries(t.differences.map((d) => [d.where, d]));
    assert.equal(by["$.items[*].price"].runs, 2, "positions are grouped, so [0] and [3] are one place");
    assert.equal(by["$.keeps"].runs, 4);
    assert.equal(by["$.keeps"].first_seen, "2026-11-01T02-17-00Z");
    assert.equal(by.status.first_seen, "2026-11-03T02-17-00Z");
    assert.equal(by["$.gone"].last_seen, "2026-11-02T02-17-00Z");
    assert.equal(by["header:etag"].approved, true);
    assert.equal(by["$.keeps"].approved, false);

    assert.deepEqual(t.flaky.map((f) => [f.case, f.passed, f.failed, f.flips]), [["FLAKY", 2, 2, 3]]);
    assert.deepEqual(t.fixed, ["FIXED"], "one change is not flaky");
    assert.deepEqual(t.regressed, ["BROKE"], "one change is not flaky");
    assert.deepEqual(t.drift_stopped_matching, ["D-STOPPED"]);
    assert.deepEqual(t.drift_never_matched, ["D-NEVER"]);
    assert.deepEqual(t.scrubs_never_fired, ["json_path $.mistyped", "xml_ignore Stamp"], "a rule that fired in any run is not listed");
    assert.deepEqual(t.settings_changed, []);

    const md = fs.readFileSync(path.join(dir, "cmtk/evidence/trend/compare/TREND.md"), "utf8");
    for (const want of ["## Verdict over time", "## Differences by where", "## Flaky cases", "FLAKY", "D-STOPPED", "json_path $.mistyped", "`$.brand.new` | new", "2026-10-31T02-17-00Z"]) assert.ok(md.includes(want), want);
    assert.match(r.stdout, /new: \$\.brand\.new/);
    assert.match(r.stdout, /flaky: FLAKY/);

    const last = await cmtk(dir, "trend", "--mode", "compare", "--last", "2", "--json");
    assert.equal(JSON.parse(last.stdout).runs.length, 2);
    assert.equal((await cmtk(dir, "trend", "--mode", "nope")).status, 3);
});

test("a run that did not reach a case claims nothing about it, and a changed settings file is said out loud", () => {
    const dir = project();
    stored(dir, "compare", "2026-11-01T02-17-00Z", compareReport({ cases: [diff("A", "$.a"), diff("B", "$.b")] }));
    stored(dir, "compare", "2026-11-02T02-17-00Z", compareReport({ partial: true, verdict: "INCOMPLETE", cases: [{ id: "A", name: "A", requirement: [], surface: "http", result: "ERROR", why: "x" }, pass("B")], settings: { ...compareReport({}).settings, manifest_sha256: "changed", scrub: { json_paths: [], xml_ignore: [], regex: [] } } }));
    const { report } = trend(loadManifest(path.join(dir, "cmtk.yaml")), { mode: "compare" });
    const state = Object.fromEntries(report.differences.map((d) => [d.where, d.state]));
    assert.equal(state["$.a"], "not checked", "an error is not a fix");
    assert.equal(state["$.b"], "gone");
    assert.deepEqual(report.settings_changed, ["2026-11-02T02-17-00Z"]);
    assert.deepEqual(report.runs[1].partial, true);
});

test("cmtk run: each failed check is a place, and known issues read as accepted", () => {
    const dir = project();
    const fail = (id, check, known) => ({ id, name: id, requirement: [], surface: "http", result: "FAIL", failures: [{ check, expected: "1", actual: "2", ...(known ? { known_issue: known } : {}) }], ...(known ? { known_issues: [known] } : {}) });
    const ok = (id) => ({ id, name: id, requirement: [], surface: "http", result: "PASS" });
    stored(dir, "run", "2026-11-01T02-17-00Z", { verdict: "FAIL", cases: [fail("A", "status"), fail("B", "$.x", "LEG-1")] });
    stored(dir, "run", "2026-11-02T02-17-00Z", { verdict: "FAIL", cases: [ok("A"), fail("B", "$.x", "LEG-1")] });
    const { report } = trend(loadManifest(path.join(dir, "cmtk.yaml")), { mode: "run" });
    const by = Object.fromEntries(report.differences.map((d) => [d.where, d]));
    assert.equal(by.status.state, "gone");
    assert.equal(by["$.x"].state, "keeps coming back");
    assert.equal(by["$.x"].approved, true);
    assert.deepEqual(report.scrubs_never_fired, [], "no run records it, so nothing is claimed");
});

test("real runs: --dated keeps each one, status still reads the latest, scrub rules are counted, and a shadow run has a trend too", async () => {
    let v = 0;
    const servers = await Promise.all([0, 1].map((n) => new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ at: `${Math.random()}`, value: n === 1 && v % 2 === 1 ? "planted" : "same" }));
        });
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    })));
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-trend-real-"));
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: nightly\ntargets:\n  legacy: { base_url: "${servers[0].url}" }\n  candidate: { base_url: "${servers[1].url}" }\nscrub:\n  json_paths: ["$.at", "$.mistyped"]\n`);
        fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
        fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: A-1, request: GET /x }\n");
        const codes = [];
        for (v = 0; v < 4; v++) {
            const r = await cmtk(dir, "compare", "--dated");
            codes.push(r.status);
            assert.match(r.stderr, /Kept a dated copy: cmtk\/evidence\/history\/compare\//);
        }
        assert.deepEqual(codes, [0, 1, 0, 1]);
        const folders = fs.readdirSync(path.join(dir, "cmtk/evidence/history/compare"));
        assert.equal(folders.length, 4, "the same second gets its own folder");
        assert.ok(folders.every((f) => stampTime(f) !== undefined));
        assert.ok(fs.existsSync(path.join(dir, "cmtk/evidence/compare/REPORT.json")), "the latest run stays where status and signoff read it");
        assert.ok(fs.existsSync(path.join(dir, "cmtk/evidence/history/compare", folders[0], "answers", "A-1.reference.json")));
        const latest = JSON.parse(fs.readFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.json"), "utf8"));
        assert.equal(latest.scrub_fired["json_path $.at"], 2, "fired once on each side");
        assert.equal(latest.scrub_fired["json_path $.mistyped"], 0);
        assert.match((await cmtk(dir, "status")).stdout, /compare: NO PARITY/);

        const t = await cmtk(dir, "trend", "--json");
        assert.equal(t.status, 0);
        const report = JSON.parse(t.stdout);
        assert.equal(report.mode, "compare");
        assert.deepEqual(report.runs.map((x) => x.verdict), ["PARITY", "NO PARITY", "PARITY", "NO PARITY"]);
        assert.deepEqual(report.flaky.map((f) => f.case), ["A-1"]);
        assert.deepEqual(report.differences.map((d) => [d.where, d.state, d.runs]), [["$.value", "keeps coming back", 2]]);
        assert.deepEqual(report.scrubs_never_fired, ["json_path $.mistyped"]);

        // Without the flag and without the setting, nothing new is kept.
        await cmtk(dir, "compare");
        assert.equal(fs.readdirSync(path.join(dir, "cmtk/evidence/history/compare")).length, 4);

        // The setting does what the flag does.
        const withSetting = fs.readFileSync(path.join(dir, "cmtk.yaml"), "utf8") + "evidence_history: { dated: true }\n";
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), withSetting);
        await compare(loadManifest(path.join(dir, "cmtk.yaml")), { note: () => {} });
        assert.equal(fs.readdirSync(path.join(dir, "cmtk/evidence/history/compare")).length, 5);

        // Shadow runs: an endpoint is a case.
        fs.writeFileSync(path.join(dir, "t.log"), '1.1.1.1 - - [x] "GET /x HTTP/1.1" 200 1\n');
        const m = loadManifest(path.join(dir, "cmtk.yaml"));
        for (v = 0; v < 3; v++) await shadow(m, { from: [path.join(dir, "t.log")], rate: 1000, note: () => {} });
        const s = trend(m, { mode: "shadow" }).report;
        assert.deepEqual(s.runs.map((x) => x.verdict), ["NO UNEXPLAINED DIFFERENCES", "UNEXPLAINED DIFFERENCES", "NO UNEXPLAINED DIFFERENCES"]);
        assert.deepEqual(s.flaky.map((f) => f.case), ["GET /x"]);
        assert.deepEqual(s.scrubs_never_fired, ["json_path $.mistyped"]);
    } finally {
        for (const s of servers) await s.close();
    }
});

test("no dated runs: says so, and exits 2", async () => {
    const dir = project();
    const r = await cmtk(dir, "trend");
    assert.equal(r.status, 2);
    assert.match(r.stdout, /No dated runs/);
    assert.ok(!fs.existsSync(path.join(dir, "cmtk/evidence/trend")));
});

/** A link that also works on Windows without special rights: a junction for a folder. A file link may be refused there. */
const linkDir = (target, at) => fs.symlinkSync(target, at, "junction");
const linkFile = (target, at) => { try { fs.symlinkSync(target, at, "file"); } catch { /* Windows may refuse: the folder link still tests the rule */ } };

test("clean-up: by age, by count and by size, and it keeps the newest and anything signed", async () => {
    const dir = project();
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    const now = new Date("2026-11-30T00:00:00Z");
    const day = (d) => `2026-11-${String(d).padStart(2, "0")}T00-00-00Z`;
    const fill = (mode, d, kb) => {
        const f = stored(dir, mode, day(d), compareReport({}));
        fs.writeFileSync(path.join(f, "blob.bin"), Buffer.alloc(kb * 1024));
        return f;
    };
    for (const d of [1, 2, 3, 28, 29]) fill("compare", d, 1);
    const signed = day(2);
    fs.writeFileSync(path.join(dir, "cmtk/evidence/history/compare", signed, "SIGNOFF.json"), "{}");
    fs.mkdirSync(path.join(dir, "cmtk/evidence/history/compare/notes-keep-me"));
    fs.writeFileSync(path.join(dir, "cmtk/evidence/history/compare/notes-keep-me/n.txt"), "mine");
    fs.mkdirSync(path.join(dir, "cmtk/evidence/compare"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk/evidence/compare/REPORT.json"), "{}");

    const dry = cleanHistory(m(), { keepDays: 7, now, dryRun: true });
    assert.deepEqual(dry.removed.sort(), [`compare/${day(1)}`, `compare/${day(3)}`]);
    assert.equal(datedRuns(m(), "compare").length, 5, "a dry run removes nothing");

    const age = cleanHistory(m(), { keepDays: 7, now });
    assert.deepEqual(age.removed.sort(), [`compare/${day(1)}`, `compare/${day(3)}`]);
    assert.deepEqual(datedRuns(m(), "compare").map((r) => r.name), [day(2), day(28), day(29)], "the signed run stays");
    assert.ok(fs.existsSync(path.join(dir, "cmtk/evidence/history/compare/notes-keep-me/n.txt")), "only dated folders are ever removed");
    assert.ok(fs.existsSync(path.join(dir, "cmtk/evidence/compare/REPORT.json")), "the latest run is not part of the history");

    const count = cleanHistory(m(), { keepDays: 3650, keepRuns: 1, now });
    assert.deepEqual(count.removed, [`compare/${day(28)}`]);

    for (const d of [10, 11, 12, 13]) fill("run", d, 400);
    const size = cleanHistory(m(), { keepDays: 3650, maxMb: 1, now });
    assert.deepEqual(size.removed, [`run/${day(10)}`, `run/${day(11)}`], "the oldest goes until it fits");
    assert.ok(sizeOf(path.join(dir, "cmtk/evidence/history")) <= 1024 * 1024 + 8192);

    const over = cleanHistory(m(), { keepDays: 3650, maxMb: 0.01, now });
    assert.ok(datedRuns(m(), "run").length === 1, "the newest is always kept");
    assert.match(over.warnings.join(), /over the limit/);

    const viaCli = await cmtk(dir, "trend", "clean", "--max-mb", "0.01", "--dry-run");
    assert.equal(viaCli.status, 0);
    assert.match(viaCli.stdout, /Would remove 0 dated runs/);
    assert.equal((await cmtk(dir, "trend", "clean", "--keep-days", "0")).status, 3);
});

test("dated runs apply the rule from cmtk.yaml, and a bad rule is refused", () => {
    const dir = project("evidence_history: { dated: true, keep_runs: 2 }\n");
    const m = loadManifest(path.join(dir, "cmtk.yaml"));
    assert.deepEqual(m.evidence_history, { dated: true, keep_days: 90, keep_runs: 2, max_mb: 1024 });
    const latest = path.join(dir, "cmtk/evidence/compare");
    fs.mkdirSync(latest, { recursive: true });
    fs.writeFileSync(path.join(latest, "REPORT.json"), "{}");
    const start = Date.parse("2026-11-01T00:00:00Z");
    let removed = [];
    for (let i = 0; i < 4; i++) removed = removed.concat(keepDated(m, "compare", latest, new Date(start + i * 60_000)).removed);
    assert.equal(datedRuns(m, "compare").length, 2);
    assert.equal(removed.length, 2);
    assert.equal(stampOf(new Date(start)), "2026-11-01T00-00-00Z");

    for (const bad of ["evidence_history: 3", "evidence_history: { dated: yes-please }", "evidence_history: { max_mb: 0 }", "evidence_history: { keep_days: -1 }"]) {
        fs.writeFileSync(path.join(dir, "bad.yaml"), `system: x\ntargets: { a: "http://h.example.com" }\n${bad}\n`);
        assert.throws(() => loadManifest(path.join(dir, "bad.yaml")), /evidence_history/, bad);
    }
});

test("clean-up never follows a link outside the evidence folder, at any level", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-outside-"));
    const dirTarget = path.join(outside, "precious");
    fs.mkdirSync(dirTarget);
    fs.writeFileSync(path.join(dirTarget, "keep.txt"), "must survive");
    const fileTarget = path.join(outside, "file.txt");
    fs.writeFileSync(fileTarget, "must survive too");
    const dir = project();
    const m = () => loadManifest(path.join(dir, "cmtk.yaml"));
    const now = new Date("2026-11-30T00:00:00Z");
    const old = (mode, name) => stored(dir, mode, name, compareReport({}));

    // A link inside an old run: the run goes, the link goes, and what it points to stays.
    const run1 = old("compare", "2026-01-01T00-00-00Z");
    linkDir(dirTarget, path.join(run1, "link-to-folder"));
    linkFile(fileTarget, path.join(run1, "link-to-file"));
    old("compare", "2026-11-29T00-00-00Z");
    // A dated name that is itself a link: not a run, so it is left alone.
    linkDir(dirTarget, path.join(dir, "cmtk/evidence/history/compare/2026-01-02T00-00-00Z"));
    // A whole mode folder that is a link: never walked.
    linkDir(outside, path.join(dir, "cmtk/evidence/history/run"));

    const before = sizeOf(run1);
    assert.ok(before < 1024 * 1024, "a link is counted for itself, never for what it points to");
    const r = cleanHistory(m(), { keepDays: 7, now });
    assert.deepEqual(r.removed, ["compare/2026-01-01T00-00-00Z"]);
    assert.ok(!fs.existsSync(run1));
    assert.match(r.warnings.join("\n"), /history\/compare\/2026-01-02T00-00-00Z is a link/);
    assert.match(r.warnings.join("\n"), /history\/run is a link/);
    assert.equal(fs.readFileSync(path.join(dirTarget, "keep.txt"), "utf8"), "must survive");
    assert.equal(fs.readFileSync(fileTarget, "utf8"), "must survive too");
    assert.deepEqual(datedRuns(m(), "run"), [], "a mode folder that is a link holds no runs");

    // A dated copy is never written through a link either, and the run itself is not lost.
    const latest = path.join(dir, "cmtk/evidence/run");
    fs.mkdirSync(latest, { recursive: true });
    assert.throws(() => keepDated(m(), "run", latest), /is a link/);
    assert.deepEqual(fs.readdirSync(outside).sort(), ["file.txt", "precious"]);

    // A link in the latest run is not copied into the history.
    const compareLatest = path.join(dir, "cmtk/evidence/compare");
    fs.mkdirSync(compareLatest, { recursive: true });
    fs.writeFileSync(path.join(compareLatest, "REPORT.json"), "{}");
    linkDir(dirTarget, path.join(compareLatest, "out"));
    const kept = keepDated(m(), "compare", compareLatest, now);
    assert.ok(!fs.existsSync(path.join(dir, "cmtk/evidence/history/compare", kept.name, "out")));

    // The history folder itself leading out of the project is refused outright.
    const dir2 = project();
    fs.mkdirSync(path.join(dir2, "cmtk/evidence"), { recursive: true });
    linkDir(outside, path.join(dir2, "cmtk/evidence/history"));
    const refused = await cmtk(dir2, "trend", "clean");
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /outside the project folder/);
    assert.equal(fs.readFileSync(fileTarget, "utf8"), "must survive too");
});

test("the nightly examples use commands that exist, and hold no secret", async () => {
    const dir = path.join(ROOT, "examples", "nightly");
    const wf = YAML.parse(fs.readFileSync(path.join(dir, "github-nightly.yml"), "utf8"));
    assert.ok(wf.on.schedule[0].cron, "it runs on a schedule");
    assert.deepEqual(wf.permissions, { contents: "read" });
    const script = wf.jobs.compare.steps.find((s) => s.id === "nightly").run;
    assert.match(script, /cmtk compare --dated/);
    assert.match(script, /cmtk trend --mode compare/);
    assert.ok(script.indexOf("code=$?") < script.indexOf("cmtk trend"), "the comparison's exit code is kept before the trend runs");
    assert.equal(wf.jobs.compare.env.CMTK_TOKEN, "${{ secrets.CMTK_TOKEN }}", "a token only from the secret store");
    assert.ok(wf.jobs.compare.steps.some((s) => s.uses?.startsWith("actions/cache/restore")));
    const save = wf.jobs.compare.steps.find((s) => s.uses?.startsWith("actions/cache/save"));
    assert.equal(save.if, "always()", "the history is saved on a bad night too");
    const ps = fs.readFileSync(path.join(dir, "nightly.ps1"), "utf8");
    assert.match(ps, /cmtk compare --dated/);
    assert.match(ps, /cmtk trend --mode compare/);
    assert.match(ps, /exit \$code/);
    const help = (await cmtk(os.tmpdir(), "help")).stdout;
    for (const flag of ["cmtk trend", "--dated", "--mode run|compare|shadow"]) assert.ok(help.includes(flag), flag);
});
