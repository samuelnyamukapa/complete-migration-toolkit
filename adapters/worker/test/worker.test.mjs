// The worker adapter, compiled and run against the tiny sample worker. A machine with no .NET SDK skips
// what needs one and says so; CMTK_REQUIRE_DOTNET=1 makes that a failure instead. Windows service control
// and the event log are driven here through stand-ins for sc.exe and wevtutil.exe, on Linux and macOS.
// The real ones need a Windows machine: the event log test below runs only there.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..");
const REPO = path.join(ADAPTER, "..", "..");
const CLI = path.join(REPO, "packages", "cli", "dist", "main.js");
const DLL = path.join(ADAPTER, "bin", "Release", "net8.0", "worker.dll");
const SAMPLE = path.join(ADAPTER, "sample-worker");
const SAMPLE_DLL = path.join(SAMPLE, "bin", "Release", "net8.0", "sample-worker.dll");

const hasDotnet = spawnSync("dotnet", ["--version"]).status === 0;
if (!hasDotnet && process.env.CMTK_REQUIRE_DOTNET) throw new Error("CMTK_REQUIRE_DOTNET is set, but dotnet is not installed");
const needsDotnet = hasDotnet ? { timeout: 180_000 } : { skip: "the .NET SDK is not installed" };
const notOnWindows = process.platform === "win32" ? { skip: "stand-ins for the Windows tools only work elsewhere" } : needsDotnet;
const ENV = { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };

before(() => {
    if (!hasDotnet) return;
    for (const folder of [ADAPTER, SAMPLE]) {
        // No build servers: they would outlive the build and hold its output pipes open.
        const r = spawnSync("dotnet", ["build", "-c", "Release", "--nologo", "-nodeReuse:false", "-p:UseSharedCompilation=false", folder], { env: ENV, encoding: "utf8" });
        assert.equal(r.status, 0, r.stdout + r.stderr);
    }
}, { timeout: 300_000 });

const cmtk = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

function adapter(env = {}) {
    const p = spawn("dotnet", [DLL], { env: { ...ENV, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = readline.createInterface({ input: p.stdout })[Symbol.asyncIterator]();
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    const closed = new Promise((resolve) => p.on("close", resolve));
    const send = async (m) => {
        p.stdin.write(JSON.stringify(m) + "\n");
        const n = await lines.next();
        assert.ok(!n.done, `the adapter stopped: ${stderr}`);
        return JSON.parse(n.value);
    };
    return {
        send,
        run: (target, method, requestPath, body) => send({ op: "run", case: { id: "c", request: { method, path: requestPath, ...(body === undefined ? {} : { body }) } }, target, headers: {} }),
        reset: (target) => send({ op: "reset", target }),
        stderr: () => stderr,
        close: () => { p.stdin.end(); return closed; },
    };
}

const quoted = (file) => `"${file}"`;
const startSample = (...args) => `dotnet ${quoted(SAMPLE_DLL)} ${args.join(" ")}`.trim();
const area = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cmtk-worker-"));
const target = (test_area, more = {}) => ({ name: "t", test_area, input_folder: "in", output_folder: "out", start: startSample(), finish: "input-gone", finish_quiet_ms: 100, finish_timeout_s: 30, ...more });
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test("describe gives its name, kinds and settings", needsDotnet, async () => {
    const a = adapter();
    const d = await a.send({ op: "describe" });
    await a.close();
    assert.equal(d.name, "worker");
    assert.deepEqual(d.kinds, ["worker", "files", "logs"]);
    for (const s of ["service", "start", "input_folder", "output_folder", "finish", "test_area"]) assert.ok(d.settings.includes(s), s);
});

test("the conformance kit passes against the sample worker, as the README says to run it", needsDotnet, async () => {
    const r = await cmtk(REPO, "adapter", "check", "worker");
    fs.rmSync(path.join(ADAPTER, "test-area", "check"), { recursive: true, force: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Adapter worker passes the conformance kit/);
});

test("run drops the input, waits, and reports the output files, with no time or process id", needsDotnet, async () => {
    const dir = area();
    const t = target(dir);
    const a = adapter();
    const reply = await a.run(t, "POST", "/order.txt", "one\ntwo\n");
    assert.deepEqual(reply, { status: 200, effects: { outputs: [{ path: "order.txt.out.txt", bytes: 8, text: "ONE\nTWO\n" }] } });
    assert.deepEqual(tree(path.join(dir, "in")), [], "the worker took the input");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".cmtk-drop")), [], "no half-written file is left");
    // The worker logged a time and a process id. They go to stderr, and not into the report.
    await new Promise((r) => setTimeout(r, 50));
    assert.match(a.stderr(), /sample worker started, pid \d+/);
    assert.doesNotMatch(JSON.stringify(reply), /pid|\d{4}-\d{2}-\d{2}T/);
    await a.close();
});

test("a binary output gives its hash in place of its text, and subfolders use forward slashes", needsDotnet, async () => {
    const dir = area();
    fs.mkdirSync(path.join(dir, "out", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "out", "sub", "b.bin"), Buffer.from([0, 1, 2]));
    const a = adapter();
    const reply = await a.run(target(dir), "GET", "/");
    await a.close();
    assert.deepEqual(reply.effects.outputs, [{ path: "sub/b.bin", bytes: 3, sha256: "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc" }]);
});

test("GET, HEAD and OPTIONS only observe: nothing starts, nothing changes", needsDotnet, async () => {
    const dir = area();
    fs.mkdirSync(path.join(dir, "in"));
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "in", "waiting.txt"), "untouched");
    fs.writeFileSync(path.join(dir, "out", "old.txt"), "old");
    const a = adapter();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const r = await a.run(target(dir, { start: `dotnet ${quoted(SAMPLE_DLL)}` }), method, "/waiting.txt");
        assert.deepEqual(r.effects.outputs, [{ path: "old.txt", bytes: 3, text: "old" }]);
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(path.join(dir, "in", "waiting.txt")), "no worker ran to take the file");
    assert.doesNotMatch(a.stderr(), /sample worker started/);
    await a.close();
    // Folders that do not exist yet stay that way on a read.
    const empty = area();
    const b = adapter();
    assert.deepEqual((await b.run(target(empty), "GET", "/")).effects.outputs, []);
    await b.close();
    assert.deepEqual(fs.readdirSync(empty), []);
});

test("how to tell it has finished: a marker file, or a quiet output folder, and a time limit", needsDotnet, async () => {
    const dir = area();
    const a = adapter();
    const marked = await a.run(target(dir, { name: "marked", start: startSample("--done-file", "done.flag"), finish: "file:done.flag" }), "POST", "/a.txt", "x\n");
    assert.deepEqual(marked.effects.outputs.map((o) => o.path), ["a.txt.out.txt"], "the marker is left out of the report");

    const quiet = area();
    fs.mkdirSync(path.join(quiet, "out"));
    fs.writeFileSync(path.join(quiet, "out", "still.txt"), "here");
    const q = await a.run(target(quiet, { name: "quiet", finish: "quiet", finish_quiet_ms: 1500 }), "POST", "/a.txt", "x\n");
    assert.deepEqual(q.effects.outputs.map((o) => o.path), ["a.txt.out.txt", "still.txt"], "it waited long enough for the worker to write");

    // A worker that stops is an error, and does not count as finished.
    const stops = await a.run(target(area(), { name: "stops", start: "dotnet --version", finish: "file:never.flag" }), "POST", "/a.txt", "x\n");
    assert.match(stops.error, /stopped while the case ran/);

    const slow = area();
    const never = await a.run(target(slow, { name: "never", start: startSample(), finish: "file:never.flag", finish_timeout_s: 1 }), "POST", "/a.txt", "x\n");
    assert.match(never.error, /did not finish within 1s \(finish: file:never\.flag\)/);
    await a.close();
});

test("settings that are missing or wrong are refused by name", needsDotnet, async () => {
    const dir = area();
    const a = adapter();
    const cases = [
        [{ test_area: undefined }, /needs test_area/],
        [{ test_area: path.join(dir, "missing") }, /does not exist/],
        [{ input_folder: undefined }, /needs input_folder/],
        [{ output_folder: undefined }, /needs output_folder/],
        [{ start: undefined }, /exactly one of service/],
        [{ service: "Svc" }, /exactly one of service/],
        [{ start: undefined, service: "bad;name" }, /not a valid service name/],
        [{ finish: "whenever" }, /finish must be/],
        [{ finish: undefined }, /needs finish/],
        [{ finish: "file:../escape" }, /inside output_folder/],
        [{ finish_timeout_s: "soon" }, /finish_timeout_s must be a whole number/],
        [{ event_source: "x']] or [[" }, /event_source has characters/],
        [{ start: "\"no closing quote" }, /opening quote/],
        [{ start: "this-program-does-not-exist-anywhere" }, /could not start the worker/],
    ];
    for (const [more, why] of cases) {
        const r = await a.run(target(dir, more), "POST", "/a.txt", "x");
        assert.match(r.error ?? "", why, JSON.stringify(more));
    }
    await a.close();
});

test("input, output and baseline folders outside the test area are refused, and nothing is touched", needsDotnet, async () => {
    const parent = area();
    const dir = path.join(parent, "area");
    const sibling = path.join(parent, "area-evil");
    fs.mkdirSync(dir);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "precious.txt"), "keep");
    const a = adapter();
    const bad = [
        { input_folder: sibling }, { output_folder: sibling }, { baseline_folder: sibling },
        { input_folder: "../area-evil" }, { output_folder: "../area-evil" },
        { input_folder: "x/../../area-evil" },
        { input_folder: os.tmpdir() },
        { input_folder: "." }, { output_folder: "." },
    ];
    for (const more of bad) {
        for (const reply of [await a.reset(target(dir, more)), await a.run(target(dir, more), "POST", "/a.txt", "x"), await a.run(target(dir, more), "GET", "/")]) {
            assert.match(reply.error ?? "", /outside the test area/, JSON.stringify(more));
        }
    }
    assert.deepEqual(fs.readdirSync(sibling), ["precious.txt"]);
    assert.doesNotMatch(a.stderr(), /sample worker started/, "no worker started");

    // Folders must also be apart, or a reset of one would wipe the other.
    for (const [more, why] of [[{ output_folder: "in" }, /must be separate/], [{ output_folder: "in/sub" }, /must be separate/], [{ baseline_folder: "in/base" }, /must be separate/], [{ baseline_folder: "out" }, /must be separate/]]) {
        assert.match((await a.reset(target(dir, more))).error ?? "", why);
    }
    // A test area as wide as the machine or the home folder is not a test area.
    for (const wide of [path.parse(dir).root, os.homedir()]) {
        assert.match((await a.reset(target(wide, { input_folder: path.join(wide, "cmtk-in"), output_folder: path.join(wide, "cmtk-out") }))).error ?? "", /too broad/, wide);
    }
    await a.close();
});

test("a link cannot lead out of the test area", needsDotnet, async (t) => {
    const parent = area();
    const dir = path.join(parent, "area");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(dir);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "precious.txt"), "keep");
    try {
        fs.symlinkSync(outside, path.join(dir, "link"), "junction");
    } catch {
        return t.skip("this machine does not allow links");
    }
    const a = adapter();
    assert.match((await a.reset(target(dir, { input_folder: "link" }))).error ?? "", /through a link/);
    assert.match((await a.reset(target(dir, { output_folder: "link/sub" }))).error ?? "", /through a link/);

    // A link that appears in the output later: it is not followed when reporting, and a reset removes only the link.
    fs.mkdirSync(path.join(dir, "out"));
    fs.symlinkSync(outside, path.join(dir, "out", "peek"), "junction");
    fs.mkdirSync(path.join(dir, "in"));
    fs.symlinkSync(outside, path.join(dir, "in", "peek"), "junction");
    const seen = await a.run(target(dir), "GET", "/");
    assert.deepEqual(seen.effects.outputs, []);
    assert.match((await a.run(target(dir), "POST", "/peek/planted.txt", "x")).error ?? "", /through a link/);
    assert.deepEqual((await a.reset(target(dir))), { ok: true });
    await a.close();
    assert.deepEqual(fs.readdirSync(path.join(dir, "out")), []);
    assert.deepEqual(fs.readdirSync(outside), ["precious.txt"]);
});

test("a case cannot drop a file outside the input folder, or use what the adapter does not support", needsDotnet, async () => {
    const dir = area();
    const a = adapter();
    const t = target(dir);
    for (const p of ["/../escape.txt", "/a/../../escape.txt", "/", "", "/c:/x.txt", "/a.txt?x=1"]) {
        assert.ok((await a.run(t, "POST", p, "x")).error, p);
    }
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes("escape")), []);
    assert.match((await a.run(t, "DELETE", "/a.txt")).error, /not DELETE/);
    for (const [where, field] of [["case", "before"], ["request", "body_form"], ["request", "files"]]) {
        const c = { id: "c", request: { method: "POST", path: "/a.txt" } };
        (where === "case" ? c : c.request)[field] = field === "files" ? [] : {};
        assert.match((await a.send({ op: "run", case: c, target: t, headers: {} })).error, new RegExp(`does not support ${field}`));
    }
    await a.close();
    assert.deepEqual(tree(path.join(dir, "in")), []);
});

test("reset stops the worker, restores the starting state and starts it again", needsDotnet, async () => {
    const dir = area();
    const t = target(dir, { baseline_folder: "base" });
    fs.mkdirSync(path.join(dir, "base", "output", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "base", "output", "sub", "start.txt"), "start");
    const a = adapter();
    assert.deepEqual(await a.reset(t), { ok: true });
    assert.deepEqual((await a.run(t, "GET", "/")).effects.outputs, [{ path: "sub/start.txt", bytes: 5, text: "start" }]);
    await a.run(t, "POST", "/made.txt", "x\n");
    fs.writeFileSync(path.join(dir, "out", "stray.txt"), "stray");
    assert.equal((await a.run(t, "GET", "/")).effects.outputs.length, 3);

    assert.deepEqual(await a.reset(t), { ok: true });
    assert.deepEqual((await a.run(t, "GET", "/")).effects.outputs.map((o) => o.path), ["sub/start.txt"]);
    assert.equal(fs.readFileSync(path.join(dir, "base", "output", "sub", "start.txt"), "utf8"), "start", "the baseline itself is untouched");
    // Started again, and only one worker: the old one is gone, so each input gives one output.
    assert.deepEqual((await a.run(t, "POST", "/again.txt", "y\n")).effects.outputs.map((o) => o.path), ["again.txt.out.txt", "sub/start.txt"]);
    assert.equal((a.stderr().match(/sample worker started/g) ?? []).length >= 2, true);
    await a.close();

    // When the adapter ends, its worker ends too: a new file is left alone.
    fs.writeFileSync(path.join(dir, "in", "after.txt"), "z");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(fs.existsSync(path.join(dir, "in", "after.txt")));
});

test("headers are not used: the adapter's code reads no value, and the protocol is the template's, unchanged", () => {
    const code = fs.readFileSync(path.join(ADAPTER, "Adapter.cs"), "utf8");
    assert.deepEqual(code.split("\n").filter((l) => /\bheaders\b/.test(l)), [
        "    public static async Task<JsonObject> Run(JsonObject testCase, JsonObject target, IReadOnlyDictionary<string, string> headers)",
        "        // `headers` is not used: nothing here needs a credential, so none can be reported.",
    ]);
    const template = fs.readFileSync(path.join(REPO, "packages", "cli", "templates", "adapter-csharp", "Program.cs"), "utf8");
    assert.equal(fs.readFileSync(path.join(ADAPTER, "Program.cs"), "utf8"), template);
});

function standIns(dir) {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const log = path.join(dir, "tools.log");
    const state = path.join(dir, "state");
    fs.writeFileSync(state, "1");
    fs.writeFileSync(log, "");
    const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    script("sc.exe", `case "$1" in
  query) printf 'SERVICE_NAME: %s\\n        STATE              : %s  WORD\\n' "$2" "$(cat "${state}")" ;;
  start) printf 4 > "${state}" ;;
  stop) printf 1 > "${state}" ;;
esac`);
    script("wevtutil.exe", `case "$*" in
  *"/c:1"*) printf '<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><EventRecordID>41</EventRecordID></System></Event>' ;;
  *) cat <<'XML'
<Events><Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='OrderSvc'/><EventID>100</EventID><Level>4</Level><TimeCreated SystemTime='2026-11-04T09:10:11.123Z'/><EventRecordID>42</EventRecordID><Execution ProcessID='4242' ThreadID='77'/><Computer>TESTBOX</Computer><Security UserID='S-1-5-18'/></System><RenderingInfo Culture='en-GB'><Message>Finished order.txt at 2026-11-04 09:10:11 in pid 4242, thread id: 77, on 04/11/2026 09:10:11.</Message></RenderingInfo></Event><Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='OrderSvc'/><EventID>200</EventID><Level>2</Level><TimeCreated SystemTime='2026-11-04T09:10:12.123Z'/></System><EventData><Data>disk</Data><Data>full</Data></EventData></Event></Events>
XML
  ;;
esac`);
    return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
}
const serviceTarget = (dir, more = {}) => target(dir, { start: undefined, service: "OrderSvc", finish: "quiet", ...more });

test("service control is refused unless a person named this machine as a test machine", notOnWindows, async () => {
    for (const named of [undefined, "some-other-machine"]) {
        const dir = area();
        const tools = standIns(dir);
        const a = adapter({ ...tools.env, ...(named ? { CMTK_WORKER_TEST_MACHINE: named } : {}) });
        const t = serviceTarget(dir);
        assert.match((await a.reset(t)).error ?? "", /refusing to control the service OrderSvc: set CMTK_WORKER_TEST_MACHINE/);
        assert.match((await a.run(t, "POST", "/a.txt", "x")).error ?? "", /refusing to control the service/);
        await a.close();
        assert.deepEqual(tools.calls(), [], "sc.exe was never run");
        assert.deepEqual(tree(path.join(dir, "in")), [], "and no file was dropped");
    }
});

test("a service: reset stops it then starts it through sc.exe, and run reports its event log entries with no time or id", notOnWindows, async () => {
    const dir = area();
    const tools = standIns(dir);
    const a = adapter({ ...tools.env, CMTK_WORKER_TEST_MACHINE: os.hostname() });
    const t = serviceTarget(dir, { event_source: "OrderSvc" });

    fs.writeFileSync(path.join(dir, "state"), "4");
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "stale.txt"), "stale");
    assert.deepEqual(await a.reset(t), { ok: true });
    assert.deepEqual(tree(path.join(dir, "out")), []);
    let calls = tools.calls();
    assert.ok(calls.includes("sc.exe stop OrderSvc") && calls.includes("sc.exe start OrderSvc"), calls.join("; "));
    assert.ok(calls.indexOf("sc.exe stop OrderSvc") < calls.indexOf("sc.exe start OrderSvc"));

    const r = await a.run(t, "POST", "/order.txt", "x\n");
    await a.close();
    assert.deepEqual(r.effects.events, [
        { source: "OrderSvc", level: "4", id: "100", message: "Finished order.txt at <time> in pid <id>, thread id: <id>, on <date> <time>." },
        { source: "OrderSvc", level: "2", id: "200", message: "disk full" },
    ]);
    assert.doesNotMatch(JSON.stringify(r), /4242|77|TESTBOX|S-1-5-18|2026|SystemTime/);
    calls = tools.calls();
    const query = calls.find((c) => c.includes("/q:"));
    assert.match(query, /wevtutil\.exe qe Application \/q:\*\[System\[Provider\[@Name='OrderSvc'\] and EventRecordID > 41\]\] \/f:RenderedXml \/e:Events/, "only entries written during this case");
    assert.ok(!calls.slice(calls.indexOf("sc.exe start OrderSvc") + 1).includes("sc.exe start OrderSvc"), "already running: not started twice");
    assert.ok(!calls.slice(calls.indexOf("sc.exe start OrderSvc")).includes("sc.exe stop OrderSvc"), "and closing the adapter leaves the service alone");
});

test("a service that does not stop gives an error, and a missing tool says what is missing", notOnWindows, async () => {
    const dir = area();
    const tools = standIns(dir);
    const stuck = path.join(dir, "bin", "sc.exe");
    fs.writeFileSync(stuck, `#!/bin/sh\nprintf 'STATE : 3  STOP_PENDING\\n'\n`, { mode: 0o755 });
    const a = adapter({ ...tools.env, CMTK_WORKER_TEST_MACHINE: os.hostname() });
    assert.match((await a.reset(serviceTarget(dir, { finish_timeout_s: 1 }))).error ?? "", /did not reach state 1 within 1s/);
    await a.close();

    const b = adapter({ CMTK_WORKER_TEST_MACHINE: os.hostname() });
    assert.match((await b.reset(serviceTarget(area()))).error ?? "", /could not start sc\.exe, which is part of Windows/);
    await b.close();
});

test("real Windows event log: entries the worker wrote during the case, with no time or process id", process.platform === "win32" ? needsDotnet : { skip: "needs Windows" }, async () => {
    const dir = area();
    const t = target(dir, { start: startSample("--event-source", "CmtkSampleWorker"), event_source: "CmtkSampleWorker" });
    const a = adapter();
    assert.deepEqual(await a.reset(t), { ok: true });
    const r = await a.run(t, "POST", "/order.txt", "x\n");
    await a.close();
    assert.equal(r.effects.events.length, 1, JSON.stringify(r));
    assert.match(r.effects.events[0].message, /finished order\.txt at <time> in pid <id>/);
});

/** Two systems in one project: the reference and the candidate each have a sample worker. */
function comparison(candidateStart, withUnsafe = true) {
    const dir = area();
    const folders = (name) => {
        fs.mkdirSync(path.join(dir, name));
        return { test_area: path.join(dir, name).split(path.sep).join("/"), input_folder: "in", output_folder: "out", finish: "input-gone", finish_quiet_ms: 100, finish_timeout_s: 60 };
    };
    fs.mkdirSync(path.join(dir, "cmtk", "cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), JSON.stringify({
        system: "orders",
        targets: { legacy: { ...folders("legacy"), start: startSample() }, candidate: { ...folders("candidate"), start: candidateStart } },
        reference: "legacy", candidate: "candidate", allow_unsafe_methods: withUnsafe,
        cases: ["cmtk/cases/*.yaml"],
        adapters: { worker: { command: "dotnet", args: [DLL], covers: ["worker"] } },
    }));
    fs.writeFileSync(path.join(dir, "cmtk", "cases", "worker.yaml"), JSON.stringify({ cases: [{ id: "ORDER-1", name: "an order file", surface: "worker", request: { method: "POST", path: "/order.txt", body: "first line\nlast line\n" } }] }));
    return dir;
}

test("cmtk compare, read-only: different outputs are NO PARITY, the folders are kept, and no worker starts", needsDotnet, async () => {
    // A start that leaves a mark, so a launch can't pass unseen. A read must not launch one.
    const marks = area();
    const started = path.join(marks, "started.log");
    const script = path.join(marks, "start.cjs");
    fs.writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(started)}, "started\\n");\n`);
    const dir = comparison(startSample());
    const yaml = JSON.parse(fs.readFileSync(path.join(dir, "cmtk.yaml"), "utf8"));
    for (const t of Object.values(yaml.targets)) t.start = `${quoted(process.execPath)} ${quoted(script)}`;
    yaml.allow_unsafe_methods = false;
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), JSON.stringify(yaml));
    fs.writeFileSync(path.join(dir, "cmtk", "cases", "worker.yaml"), JSON.stringify({ cases: [{ id: "LOOK", surface: "worker", request: { method: "GET", path: "/" } }] }));
    for (const [side, text] of [["legacy", "ONE"], ["candidate", "TWO"]]) {
        fs.mkdirSync(path.join(dir, side, "in"), { recursive: true });
        fs.mkdirSync(path.join(dir, side, "out"), { recursive: true });
        fs.writeFileSync(path.join(dir, side, "out", "order.txt"), text);
    }
    const r = await cmtk(dir, "compare");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /verdict for orders: NO PARITY/);
    assert.deepEqual(tree(path.join(dir, "legacy", "out")), ["order.txt"]);
    assert.deepEqual(tree(path.join(dir, "candidate", "out")), ["order.txt"]);
    assert.equal(fs.existsSync(started), false, "a read starts nothing");
});

test("cmtk compare: the planted difference is caught, and the worker and dotnet run agree when nothing differs", needsDotnet, async () => {
    const run = `dotnet run --project ${quoted(SAMPLE)} -c Release --no-build`;
    const same = await cmtk(comparison(run), "compare", "--allow-unsafe");
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /verdict for orders: PARITY/);

    const bug = await cmtk(comparison(startSample("--drop-last-line")), "compare", "--allow-unsafe");
    assert.equal(bug.status, 1, bug.stdout + bug.stderr);
    assert.match(bug.stdout, /verdict for orders: NO PARITY/);
    assert.match(bug.stdout, /DIFFERENT ORDER-1/);
    assert.match(bug.stdout, /effects:\$\.outputs\[0\]\.(text|bytes)/);

    // Dropping a file changes data: without both switches it is skipped, and nothing runs.
    const dir = comparison(startSample());
    const skipped = await cmtk(dir, "compare");
    assert.notEqual(skipped.status, 0);
    assert.doesNotMatch(skipped.stdout, /verdict for orders: PARITY/);
    assert.deepEqual(tree(path.join(dir, "legacy", "out")), []);
});
