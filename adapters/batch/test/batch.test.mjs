// The batch adapter: golden samples run through node on any system, the safety rules, the real
// conformance kit and a real `cmtk compare`. The local machine only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdapter, readSettings } from "../index.mjs";
import { byKey, checkLayout, CP037, decodeCp037, parseRecords } from "../records.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..");
const REPO = path.join(ADAPTER, "..", "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "main.js");
const SAMPLES = path.join(ADAPTER, "samples");
const MISBEHAVE = path.join(HERE, "support", "misbehave.mjs");

const job = (...args) => ({ command: "node", script: MISBEHAVE, args });
const POST = (name, extra = {}) => ({ id: "B", request: { method: "POST", path: `/jobs/${name}` }, ...extra });

function rig(jobs, extra = {}, env = process.env) {
    return createAdapter({ settings: { sys: { jobs, ...extra } }, root: SAMPLES, env });
}
const target = { name: "sys" };
const hashOf = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const tempDir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-batch-test-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test("EBCDIC: code page 037 maps its well-known bytes, and every byte to a different character", () => {
    assert.equal(CP037.length, 256);
    assert.equal(new Set(CP037).size, 256);
    for (const [byte, ch] of [[0x40, " "], [0x4b, "."], [0x5b, "$"], [0x6b, ","], [0x81, "a"], [0x91, "j"], [0xa2, "s"], [0xc1, "A"], [0xd1, "J"], [0xe2, "S"], [0xf0, "0"], [0xf9, "9"], [0xba, "["], [0xbb, "]"], [0xb0, "^"], [0x25, "\n"], [0xec, "\u00d6"]]) {
        assert.equal(CP037[byte], ch, byte.toString(16));
    }
    assert.equal(decodeCp037(Buffer.from([0xc8, 0x85, 0x93, 0x93, 0x96])), "Hello");
});

test("records: text, zoned and packed numbers, with signs and scale, in EBCDIC and ASCII", () => {
    const ebc = checkLayout({
        encoding: "cp037",
        record_length: 20,
        fields: [
            { name: "name", start: 0, length: 5 },
            { name: "z", start: 5, length: 4, type: "zoned", scale: 2 },
            { name: "p", start: 9, length: 3, type: "packed", scale: 1 },
        ],
    });
    const bytes = Buffer.alloc(20, 0x40);
    bytes.set([0xc1, 0xc2], 0); // "AB" then spaces
    bytes.set([0xf0, 0xf1, 0xf2, 0xd5], 5); // -1.25
    bytes.set([0x01, 0x23, 0x4d], 9); // -123.4
    assert.deepEqual(parseRecords(bytes, ebc).records, [{ name: "AB", z: "-1.25", p: "-123.4" }]);
    bytes.set([0xf0, 0xf1, 0xf2, 0xc5], 5);
    bytes.set([0x01, 0x23, 0x4c], 9);
    assert.deepEqual(parseRecords(bytes, ebc).records[0], { name: "AB", z: "1.25", p: "123.4" });
    bytes.set([0xf0, 0xf1, 0xf2, 0x05], 5);
    bytes.set([0x01, 0x2b, 0x45], 9);
    const bad = parseRecords(bytes, ebc).records[0];
    assert.match(bad.z, /^invalid:/, "wrong bytes are shown as wrong, never read as a number");
    assert.match(bad.p, /^invalid:/);

    const ascii = checkLayout({ line_breaks: true, fields: [{ name: "n", start: 0, length: 5, type: "zoned", scale: 2 }] });
    const lines = parseRecords(Buffer.from("00125\r\n-0125\n0012{\n0012J\n0012}\n1x\n"), checkLayout({ line_breaks: true, fields: [{ name: "n", start: 0, length: 2 }] }));
    assert.equal(lines.total, 6, "both line endings");
    assert.deepEqual(parseRecords(Buffer.from("00125\n-0125\n0012{\n0012J\n0012}\n"), ascii).records.map((r) => r.n), ["1.25", "-1.25", "1.20", "-1.21", "-1.20"]);
});

test("records: bytes that do not fit the layout are a reported problem; a bad layout stops the case", () => {
    const l = checkLayout({ record_length: 4, fields: [{ name: "a", start: 0, length: 4 }] });
    assert.match(parseRecords(Buffer.alloc(5), l).problem, /not a whole number of 4-byte records/);
    const short = checkLayout({ line_breaks: true, fields: [{ name: "a", start: 0, length: 4 }] });
    assert.match(parseRecords(Buffer.from("abc\n"), short).problem, /too short for a/);
    assert.throws(() => checkLayout({ encoding: "cp500", fields: [{ name: "a", start: 0, length: 1 }] }), /encoding must be/);
    assert.throws(() => checkLayout({ fields: [] }), /fields must list/);
    assert.throws(() => checkLayout({ fields: [{ name: "a", start: -1, length: 1 }] }), /needs a start/);
    assert.throws(() => checkLayout({ record_length: 1, fields: [{ name: "a", start: 0, length: 4 }] }), /record_length must cover/);
    assert.throws(() => checkLayout({ keys: ["b"], fields: [{ name: "a", start: 0, length: 4 }] }), /key b is not a field/);
    assert.throws(() => checkLayout({ keys: ["a"], ignore: ["a"], fields: [{ name: "a", start: 0, length: 4 }] }), /cannot be ignored/);
});

test("records: matching on keys ignores order, and a key held twice keeps both", () => {
    const a = byKey([{ k: "2", v: 1 }, { k: "1", v: 2 }, { k: "2", v: 0 }], ["k"]);
    const b = byKey([{ k: "2", v: 0 }, { k: "2", v: 1 }, { k: "1", v: 2 }], ["k"]);
    assert.deepEqual(a, b);
    assert.deepEqual(a.duplicates, ["2"]);
    assert.deepEqual(a.records["2"], [{ k: "2", v: 0 }, { k: "2", v: 1 }]);
});

test("golden samples: each job gives exactly the report in samples/golden", async () => {
    const { settings, root } = readSettings([]);
    const a = createAdapter({ settings, root });
    for (const [id, name, input] of [["BATCH-POST", "post", "input/trans.txt"], ["BATCH-LEDGER", "ledger", "input/ledger.ebc"]]) {
        const before = hashOf(path.join(SAMPLES, input));
        const o = await a.run(POST(name, { inputs: [input] }), { name: "check" });
        assert.equal(o.error, undefined, o.error);
        assert.deepEqual(o.effects, JSON.parse(fs.readFileSync(path.join(SAMPLES, "golden", `${id}.json`), "utf8")), id);
        assert.deepEqual(o.inputs, [{ path: input, sha256: before, bytes: fs.statSync(path.join(SAMPLES, input)).size }]);
        assert.equal(hashOf(path.join(SAMPLES, input)), before);
    }
});

test("the same records in another order, with a different ignored field, give the same report", async () => {
    const file = (args) => ({ command: "node", script: "jobs/post.mjs", args });
    const a = rig({ up: file([]), down: file(["--descending"]) }, { layouts: { "balances.dat": "layouts/balances.json" } });
    const up = await a.run(POST("up", { inputs: ["input/trans.txt"] }), target);
    const down = await a.run(POST("down", { inputs: ["input/trans.txt"] }), target);
    assert.deepEqual(up.effects.files[0], { ...down.effects.files[0] });
    up.effects.job = down.effects.job = "same";
    assert.deepEqual(up.effects, down.effects);
});

test("settings can name the keys for a file, over the layout's", async () => {
    const a = rig({ post: { command: "node", script: "jobs/post.mjs" } }, { layouts: { "balances.dat": "layouts/balances.json" }, keys: { "balances.dat": ["balance"] } });
    const o = await a.run(POST("post", { inputs: ["input/trans.txt"] }), target);
    assert.deepEqual(Object.keys(o.effects.files[0].records).sort(), ["0.99", "7.50", "74.50"]);
    const bad = rig({ post: { command: "node", script: "jobs/post.mjs" } }, { layouts: { "balances.dat": "layouts/balances.json" }, keys: { "balances.dat": ["run_date"] } });
    await assert.rejects(bad.run(POST("post", { inputs: ["input/trans.txt"] }), target), /run_date is not a field that is read/);
});

test("originals: the job works on a copy, in a fresh folder each time, and the folder is removed", async (t) => {
    const dir = tempDir(t);
    const original = path.join(dir, "trans.txt");
    fs.writeFileSync(original, "original");
    const before = fs.statSync(original).mtimeMs;
    const a = rig({ copy: job("change-copy"), where: job("where") }, { inputs_root: dir });
    const o = await a.run(POST("copy", { inputs: ["trans.txt"] }), target);
    assert.equal(o.effects.files[0].records[0], "changed", "the job changed its copy");
    assert.equal(fs.readFileSync(original, "utf8"), "original");
    assert.equal(fs.statSync(original).mtimeMs, before);

    const one = (await a.run(POST("where"), target)).effects.files[0].records[0];
    const two = (await a.run(POST("where"), target)).effects.files[0].records[0];
    assert.notEqual(one, two, "a fresh folder for each run");
    assert.equal(fs.existsSync(one), false, "removed afterwards");
    assert.equal(path.relative(dir, one).startsWith(".."), true, "not beside the originals");
});

test("originals: a job that changes one anyway is an error naming it", async (t) => {
    const dir = tempDir(t);
    const original = path.join(dir, "trans.txt");
    fs.writeFileSync(original, "original");
    const a = rig({ bad: { ...job("change-original"), node_permission: false, env_names: ["ORIGINAL_FILE"] } }, { inputs_root: dir }, { ...process.env, ORIGINAL_FILE: original });
    const o = await a.run(POST("bad", { inputs: ["trans.txt"] }), target);
    assert.match(o.error, /changed an original input.*trans\.txt/);
});

test("working folder: a node job cannot write outside it", async (t) => {
    const dir = tempDir(t);
    const outside = path.join(dir, "escaped.txt");
    const a = rig({ bad: { ...job("write-outside"), env_names: ["OUTSIDE_FILE"] } }, {}, { ...process.env, OUTSIDE_FILE: outside });
    const o = await a.run(POST("bad"), target);
    assert.notEqual(o.effects.exit_code, 0, "the write failed");
    assert.equal(fs.existsSync(outside), false, "nothing was written");
});

test("working folder: anything that names a place outside it is refused before the job runs", async (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const marker = rig({ ok: job("where") }, { inputs_root: dir });
    for (const arg of ["/etc/passwd", "C:\\Windows\\x", "..", "../x", "out/../../x", "--out=/tmp/x", "--out=../x", "file:///tmp/x", "..\\x"]) {
        const a = rig({ bad: job("args", arg) });
        await assert.rejects(a.run(POST("bad"), target), /outside the working folder/, arg);
    }
    await assert.rejects(rig({ ok: job("where") }, { outputs: "../x" }).run(POST("ok"), target), /outside the working folder/);
    await assert.rejects(rig({ ok: job("where") }, { outputs: "/tmp/x" }).run(POST("ok"), target), /outside the working folder/);
    await assert.rejects(rig({ ok: job("where") }, { outputs: "." }).run(POST("ok"), target), /whole working folder/);
    await assert.rejects(marker.run(POST("ok", { inputs: [{ from: "a.txt", as: "../a.txt" }] }), target), /outside the working folder/);
    await assert.rejects(marker.run(POST("ok", { inputs: ["../secret.txt"] }), target), /outside the inputs folder/);
    await assert.rejects(marker.run(POST("ok", { inputs: ["missing.txt"] }), target), /does not exist/);
});

test("working folder: a place outside it is refused however the argument wraps it", async () => {
    for (const arg of [
        "--out:/etc/nope", "-o../x", "-o/etc/nope", "--path=a=/etc/x", "--path=a=../x", "--list=a,/etc/x", "--list=a;../x", "a:/etc/x", "@/etc/args", "@../args",
        "-IC:\\Windows", "--dir=D:/x", "\\\\server\\share", "~/x", "--home=~/x", "file:/etc/x", "--u=file:///etc/x", "echo x > /tmp/y", "cd ..; echo x > y", "x=..",
    ]) {
        await assert.rejects(rig({ bad: job("args", arg) }).run(POST("bad"), target), /outside the working folder/, arg);
    }
});

test("working folder: an argument that only looks like a place still reaches the job", async () => {
    const list = ["--date=2026/11/04", "--ratio=1/2", "out/file.txt", "--out=out/x.txt", "a..b", "-v", "--name=a:b", "v1.2.3", "http", "in/a.txt,in/b.txt"];
    const o = await rig({ ok: job("args", ...list) }).run(POST("ok"), target);
    assert.equal(o.effects.exit_code, 0);
    assert.deepEqual(o.effects.files[0].records, list);
});

test("working folder: a shell is not a job, since its arguments can write anywhere", async () => {
    for (const command of ["sh", "bash", "/bin/sh", "/usr/bin/env", "zsh", "dash", "cmd", "cmd.exe", "powershell", "pwsh.exe", "C:\\Windows\\System32\\cmd.exe"]) {
        const a = rig({ bad: { command, args: ["-c", "echo x > y"] } });
        const o = await a.run(POST("bad"), target);
        assert.match(o.error ?? "", /shell/, command);
    }
});

test("working folder: a node job must name its script, so its arguments can't become Node's own switches", async (t) => {
    const dir = tempDir(t);
    const outside = path.join(dir, "escaped.txt");
    const a = rig({ bad: { command: "node", args: ["--allow-fs-write=*", "-e", `require("fs").writeFileSync(process.env.OUTSIDE_FILE,"x")`], env_names: ["OUTSIDE_FILE"] } }, {}, { ...process.env, OUTSIDE_FILE: outside });
    const o = await a.run(POST("bad"), target);
    assert.match(o.error ?? "", /needs a script/);
    assert.equal(fs.existsSync(outside), false);
});

test("working folder: a locked node job can't make a link to get out", { skip: process.platform === "win32" ? "making a link needs a privilege on Windows" : false }, async (t) => {
    const dir = tempDir(t);
    const outside = path.join(dir, "escaped.txt");
    const a = rig({ bad: { ...job("link-write"), env_names: ["OUTSIDE_FILE"] } }, {}, { ...process.env, OUTSIDE_FILE: outside });
    const o = await a.run(POST("bad"), target);
    assert.notEqual(o.effects.exit_code, 0);
    assert.equal(fs.existsSync(outside), false, "nothing was written through a link");
});

test("working folder: a locked node job can't start another program, and can still read, as the README says", async (t) => {
    const started = await rig({ bad: job("start-program") }).run(POST("bad"), target);
    assert.notEqual(started.effects.exit_code, 0);
    assert.deepEqual(started.effects.files, []);
    const dir = tempDir(t);
    const outside = path.join(dir, "readable.txt");
    fs.writeFileSync(outside, "read me");
    const read = await rig({ r: { ...job("read-outside"), env_names: ["OUTSIDE_FILE"] } }, {}, { ...process.env, OUTSIDE_FILE: outside }).run(POST("r"), target);
    assert.equal(read.effects.exit_code, 0, "the lock covers writes, and the README says so");
    assert.deepEqual(read.effects.files[0].records, ["read me"]);
});

test("inputs: a link is refused, wherever it points, and so is a folder reached through one", { skip: process.platform === "win32" ? "making a link needs a privilege on Windows" : false }, async (t) => {
    const dir = tempDir(t);
    const root = path.join(dir, "inputs");
    fs.mkdirSync(path.join(root, "real"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", "good.txt"), "good");
    fs.writeFileSync(path.join(dir, "secret.txt"), "secret");
    fs.mkdirSync(path.join(dir, "elsewhere"));
    fs.writeFileSync(path.join(dir, "elsewhere", "secret.txt"), "secret");
    fs.symlinkSync(path.join(dir, "secret.txt"), path.join(root, "out.txt"));
    fs.symlinkSync(path.join(root, "real", "good.txt"), path.join(root, "near.txt"));
    fs.symlinkSync(path.join(dir, "elsewhere"), path.join(root, "away"));
    const a = rig({ ok: job("where") }, { inputs_root: root });
    for (const name of ["out.txt", "near.txt", "away/secret.txt"]) {
        for (const method of ["POST", "GET"]) {
            await assert.rejects(a.run({ id: "B", request: { method, path: "/jobs/ok" }, inputs: [name] }, target), /is a link/, name);
        }
    }
    const fine = await a.run(POST("ok", { inputs: ["real/good.txt"] }), target);
    assert.equal(fine.error, undefined);
});

test("working folder: a link in the outputs that leads outside it is an error", { skip: process.platform === "win32" ? "making a link needs a privilege on Windows" : false }, async (t) => {
    const dir = tempDir(t);
    const outside = path.join(dir, "secret.txt");
    fs.writeFileSync(outside, "secret");
    const a = rig({ bad: { ...job("link-out"), node_permission: false, env_names: ["OUTSIDE_FILE"] } }, {}, { ...process.env, OUTSIDE_FILE: outside });
    const o = await a.run(POST("bad"), target);
    assert.match(o.error, /link in its outputs that leads outside/);
    assert.doesNotMatch(JSON.stringify(o), /secret"/);
});

test("the job runs with no shell: shell characters in its arguments stay plain text", async () => {
    const a = rig({ args: job("args", "a;b", "$(whoami)", "x|y", "%PATH%", "`id`", "a b") });
    const o = await a.run(POST("args"), target);
    assert.deepEqual(o.effects.files[0].records, ["a;b", "$(whoami)", "x|y", "%PATH%", "`id`", "a b"]);
});

test("the job gets a small environment: no secret unless settings name it", async () => {
    const env = { ...process.env, MY_SECRET_KEY: "v", NAMED_ONE: "w" };
    const a = rig({ plain: job("env"), named: { ...job("env"), env_names: ["NAMED_ONE"] } }, {}, env);
    assert.equal((await a.run(POST("plain"), target)).effects.files[0].records.includes("MY_SECRET_KEY"), false);
    assert.equal((await a.run(POST("named"), target)).effects.files[0].records.includes("NAMED_ONE"), true);
});

test("the time limit stops a job that hangs, and is an error", async () => {
    const a = rig({ hang: { ...job("hang"), time_limit_s: 0.5 } });
    const started = Date.now();
    const o = await a.run(POST("hang"), target);
    assert.match(o.error, /did not finish within its time limit of 0\.5s/);
    assert.equal(o.effects.timed_out, true);
    assert.ok(Date.now() - started < 10000, "it does not wait for the job");
});

test("a job that fails is a fact to compare, with what it left", async () => {
    const o = await rig({ fail: job("fail") }).run(POST("fail"), target);
    assert.equal(o.error, undefined);
    assert.equal(o.effects.exit_code, 3);
    assert.equal(o.effects.files[0].name, "partial.txt");
});

test("a read-only method only observes: it fingerprints the inputs and runs nothing", async () => {
    const a = rig({ post: { command: "node", script: "does/not/exist.mjs" } });
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const o = await a.run({ id: "B", request: { method, path: "/jobs/post" }, inputs: ["input/trans.txt"] }, target);
        assert.deepEqual(o.effects, { job: "post", ran: false, inputs: [{ name: "trans.txt", size: 80, sha256: hashOf(path.join(SAMPLES, "input", "trans.txt")) }] });
    }
});

test("a file over the record limit reads as an error, never a match; a file that does not fit its layout is reported", async () => {
    const o = await rig({ many: job("records", "5") }, { max_records: 2 }).run(POST("many"), target);
    assert.equal(o.effects.files[0].capped, true);
    assert.equal(o.effects.files[0].record_count, 5);
    assert.equal(o.effects.files[0].records.length, 2);
    assert.match(o.error, /more than max_records \(2\)/);
    const bad = await rig({ bad: job("bad-length") }, { layouts: { "ledger.ebc": "layouts/ledger.json" } }).run(POST("bad"), target);
    assert.match(bad.effects.files[0].problem, /27 bytes/);
    assert.ok(bad.effects.files[0].sha256);
});

test("settings and cases it cannot honour get a clear refusal", async () => {
    const a = rig({ ok: job("where"), none: { args: [] }, missing: { command: "node", script: "nope.mjs" }, absent: { command: "cmtk-no-such-program" } });
    assert.match((await a.run(POST("other"), target)).error, /no job named "other".*ok/);
    assert.match((await a.run(POST("none"), target)).error, /needs a command/);
    assert.match((await a.run(POST("missing"), target)).error, /script nope\.mjs does not exist/);
    assert.match((await a.run(POST("absent"), target)).error, /could not start: ENOENT/);
    for (const k of ["body_file", "body_form", "files", "before"]) {
        const o = await a.run({ id: "B", request: { method: "POST", path: "/jobs/ok", [k]: "x" } }, target);
        assert.match(o.error, new RegExp(k));
    }
    assert.match((await a.run({ id: "B", request: { method: "POST", path: "/jobs/ok", body: "x" } }, target)).error, /does not support `body`/);
    assert.deepEqual(await a.reset(target), { ok: true });
    assert.deepEqual(a.describe().kinds, ["files"]);
});

const cmtk = (cwd, env, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

test("conformance kit, real CLI: `cmtk adapter check batch` passes on the shipped golden samples", async () => {
    const r = await cmtk(REPO, {}, "adapter", "check", "batch");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pass {2}BATCH-LEDGER: the same case twice gives the same observation/);
    assert.match(r.stdout, /Adapter batch passes the conformance kit/);
});

function project(t, { candidateArgs = {}, allowUnsafe = true, marker } = {}) {
    const dir = tempDir(t);
    const script = (f) => path.join(SAMPLES, "jobs", f);
    const jobs = (extra = {}) => ({
        post: { command: "node", script: script("post.mjs"), args: extra.post ?? [] },
        ledger: { command: "node", script: script("ledger.mjs"), args: extra.ledger ?? [] },
    });
    const settingsFile = path.join(dir, "batch-settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({
        "*": {
            inputs_root: SAMPLES,
            layouts: { "balances.dat": path.join(SAMPLES, "layouts", "balances.json"), "ledger.ebc": path.join(SAMPLES, "layouts", "ledger.json") },
        },
        legacy: { jobs: jobs() },
        candidate: { jobs: jobs(candidateArgs) },
    }));
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), JSON.stringify({
        system: "cards",
        targets: { legacy: { label: "legacy" }, candidate: { label: "candidate" } },
        cases: ["cases/*.yaml"],
        allow_unsafe_methods: allowUnsafe,
        adapters: { batch: { command: process.execPath, args: [path.join(ADAPTER, "index.mjs"), "--settings", settingsFile], covers: ["files"] } },
    }, null, 2));
    fs.mkdirSync(path.join(dir, "cases"));
    fs.writeFileSync(path.join(dir, "cases", "a.yaml"), JSON.stringify({
        cases: [
            { id: "POST", surface: "batch", request: { method: "POST", path: "/jobs/post" }, inputs: ["input/trans.txt"] },
            { id: "LEDGER", surface: "batch", request: { method: "POST", path: "/jobs/ledger" }, inputs: ["input/ledger.ebc"] },
        ],
    }));
    return { dir, marker };
}

test("end to end, real CLI: a rebuilt job writing another order reads as PARITY", async (t) => {
    const { dir } = project(t, { candidateArgs: { post: ["--descending"], ledger: ["--reverse"] } });
    const r = await cmtk(dir, {}, "compare", "--allow-unsafe", "--json");
    assert.equal(JSON.parse(r.stdout).verdict, "PARITY", r.stdout + r.stderr);
});

test("end to end, real CLI: a planted difference is caught, in fixed-width text and in EBCDIC", async (t) => {
    const { dir } = project(t, { candidateArgs: { post: ["--descending", "--plant"], ledger: ["--reverse", "--plant"] } });
    const r = await cmtk(dir, {}, "compare", "--allow-unsafe");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /NO PARITY/);
    assert.match(r.stdout, /records\['100002'\]\.balance: "7\.50" vs "7\.51"/);
    assert.match(r.stdout, /records\['100001'\]\.amount: "125\.50" vs "9125\.50"/);
});

test("running a job needs both unsafe switches: with either alone it is skipped", async (t) => {
    for (const [allowUnsafe, flag] of [[false, false], [true, false], [false, true]]) {
        const { dir } = project(t, { allowUnsafe });
        const r = await cmtk(dir, {}, "compare", ...(flag ? ["--allow-unsafe"] : []), "--json");
        const report = JSON.parse(r.stdout);
        assert.deepEqual(report.cases.map((c) => c.result), ["SKIPPED", "SKIPPED"], r.stdout + r.stderr);
        assert.notEqual(report.verdict, "PARITY");
    }
});
