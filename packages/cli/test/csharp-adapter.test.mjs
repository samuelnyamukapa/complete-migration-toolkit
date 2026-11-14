// `cmtk adapter new <name> --lang csharp`: what it writes, that the bundled command finds the template too,
// and, where the .NET SDK is installed, that the project compiles, speaks the protocol and passes the kit.
// A machine with no SDK skips those tests and says so; CMTK_REQUIRE_DOTNET=1 makes that a failure instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..", "..");
const CLI = path.join(HERE, "..", "dist", "main.js");
const TEMPLATE = path.join(HERE, "..", "templates", "adapter-csharp");

const hasDotnet = spawnSync("dotnet", ["--version"]).status === 0;
if (!hasDotnet && process.env.CMTK_REQUIRE_DOTNET) throw new Error("CMTK_REQUIRE_DOTNET is set, but dotnet is not installed");
const needsDotnet = hasDotnet ? {} : { skip: "the .NET SDK is not installed" };
const ENV = { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };

const cmtkAt = (cli, cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});
const cmtk = (cwd, ...args) => cmtkAt(CLI, cwd, ...args);
const project = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cmtk-csharp-"));
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

// No build servers: they would outlive the build and hold its output pipes open.
function dotnetBuild(folder) {
    const r = spawnSync("dotnet", ["build", "-c", "Release", "--nologo", "-nodeReuse:false", "-p:UseSharedCompilation=false", folder], { env: ENV, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
}

/** Send lines to the built program; give back its stdout lines and its stderr. */
function talk(dll, lines) {
    return new Promise((resolve) => {
        const p = spawn("dotnet", [dll], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        p.stdout.on("data", (d) => (stdout += d));
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolve({ status, stdout, stderr, replies: stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)) }));
        p.stdin.end(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
    });
}

test("adapter new --lang csharp writes the project, with the name filled in", async () => {
    const dir = project();
    const r = await cmtk(dir, "adapter", "new", "orders-feed.v2", "--lang", "csharp");
    assert.equal(r.status, 0, r.stderr);
    const a = path.join(dir, "adapters", "orders-feed.v2");
    assert.deepEqual(fs.readdirSync(a).sort(), [".gitignore", "Adapter.cs", "Program.cs", "README.md", "orders-feed.v2.csproj", "samples"]);
    for (const f of ["Adapter.cs", "Program.cs", "README.md", "orders-feed.v2.csproj", ".gitignore", path.join("samples", "cases.yaml")]) {
        assert.doesNotMatch(read(a, f), /__NAME__/, f);
    }
    assert.match(read(a, "orders-feed.v2.csproj"), /<TargetFramework>net8\.0<\/TargetFramework>/);
    assert.doesNotMatch(read(a, "orders-feed.v2.csproj"), /PackageReference/, "no packages, so it builds with no network");
    assert.match(read(a, "samples", "cases.yaml"), /surface: orders-feed\.v2/);
    // It tells people how to register it, as the built program; the README also gives `dotnet run`.
    assert.match(r.stdout, /orders-feed\.v2: \{ command: dotnet, args: \[adapters\/orders-feed\.v2\/bin\/Release\/net8\.0\/orders-feed\.v2\.dll\] \}/);
    assert.match(read(a, "README.md"), /args: \[run, --project, adapters\/orders-feed\.v2, -c, Release, --no-build\]/);
});

test("--lang: node stays the default, and anything else is refused", async () => {
    const dir = project();
    assert.equal((await cmtk(dir, "adapter", "new", "a")).status, 0);
    assert.ok(fs.existsSync(path.join(dir, "adapters", "a", "index.mjs")));
    assert.ok(!fs.existsSync(path.join(dir, "adapters", "a", "a.csproj")));
    assert.equal((await cmtk(dir, "adapter", "new", "b", "--lang", "node")).status, 0);
    assert.ok(fs.existsSync(path.join(dir, "adapters", "b", "index.mjs")));
    const ruby = await cmtk(dir, "adapter", "new", "c", "--lang", "ruby");
    assert.equal(ruby.status, 3);
    assert.match(ruby.stderr, /--lang must be node or csharp/);
    assert.ok(!fs.existsSync(path.join(dir, "adapters", "c")));
    await cmtk(dir, "adapter", "new", "d", "--lang", "csharp");
    assert.equal((await cmtk(dir, "adapter", "new", "d", "--lang", "csharp")).status, 3, "never over an existing adapter");
});

test("adapter check asks for a build, and refuses one older than the code", async () => {
    const dir = project();
    await cmtk(dir, "adapter", "new", "x", "--lang", "csharp");
    let r = await cmtk(dir, "adapter", "check", "x");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /has not been built\. Run: dotnet build -c Release adapters\/x/);
    const built = path.join(dir, "adapters", "x", "bin", "Release", "net8.0", "x.dll");
    fs.mkdirSync(path.dirname(built), { recursive: true });
    fs.writeFileSync(built, "");
    fs.utimesSync(built, new Date(0), new Date(0));
    r = await cmtk(dir, "adapter", "check", "x");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /is newer than the build/);
});

test("the template's code never prints a header: it uses their names, and nothing writes one out", () => {
    const adapter = read(TEMPLATE, "Adapter.cs");
    const program = read(TEMPLATE, "Program.cs");
    assert.deepEqual(adapter.split("\n").filter((l) => /\bheaders\b/.test(l) && !l.trim().startsWith("//")), [
        "    public static Task<JsonObject> Run(JsonObject testCase, JsonObject target, IReadOnlyDictionary<string, string> headers)",
        "        foreach (var header in headers.Keys.Order(StringComparer.Ordinal)) names.Add(header);",
    ]);
    assert.doesNotMatch(adapter, /Console\./);
    for (const line of program.split("\n").filter((l) => /(Console|stdout|stderr)\.Write/.test(l))) {
        assert.doesNotMatch(line.replace("Checked(reply.ToJsonString(), headers)", ""), /headers?\b|secrets?\b/, line);
    }
    assert.match(program, /stdout\.WriteLine\(Checked\(reply\.ToJsonString\(\), headers\)\)/, "every reply passes the check");
    assert.match(program, /Console\.SetOut\(stderr\)/, "Console.WriteLine cannot reach the protocol");
});

test("the plugin holds the same template, and the bundled command finds it", async () => {
    const copy = (rel) => {
        const walk = (d, at = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), `${at}${e.name}/`) : [`${at}${e.name}`]));
        return Object.fromEntries(walk(path.join(REPO, rel)).map((f) => [f, read(REPO, rel, f)]));
    };
    assert.deepEqual(copy("plugin/templates"), copy("packages/cli/templates"), "run `npm run bundle`");

    // Laid out as the plugin is: server/cmtk.mjs beside templates/.
    const plugin = project();
    const cli = path.join(plugin, "server", "cmtk.mjs");
    await build({
        entryPoints: [CLI], bundle: true, platform: "node", format: "esm", target: "node22", outfile: cli, logLevel: "error",
        define: { __CMTK_VERSION__: '"0.0.0"', __CMTK_FAKER_VERSION__: '"0.0.0"' },
        banner: { js: "import { createRequire as __cmtkCreateRequire } from 'node:module'; const require = __cmtkCreateRequire(import.meta.url);" },
    });
    fs.cpSync(path.join(REPO, "plugin", "templates"), path.join(plugin, "templates"), { recursive: true });
    const dir = project();
    const r = await cmtkAt(cli, dir, "adapter", "new", "viaplugin", "--lang", "csharp");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, "adapters", "viaplugin", "viaplugin.csproj")));
    assert.ok(fs.existsSync(path.join(dir, "adapters", "viaplugin", ".gitignore")));
    assert.equal((await cmtkAt(cli, dir, "adapter", "new", "viaplugin2")).status, 0, "and the Node one");
    assert.ok(fs.existsSync(path.join(dir, "adapters", "viaplugin2", "index.mjs")));
});

test("the generated project compiles, passes the kit, and registers as the built program or dotnet run", { ...needsDotnet, timeout: 300_000 }, async () => {
    const dir = project();
    await cmtk(dir, "adapter", "new", "mailbox", "--lang", "csharp");
    dotnetBuild(path.join(dir, "adapters", "mailbox"));

    // Not registered: the kit finds the build.
    let r = await cmtk(dir, "adapter", "check", "mailbox");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Adapter mailbox passes the conformance kit/);

    for (const args of [["adapters/mailbox/bin/Release/net8.0/mailbox.dll"], ["run", "--project", "adapters/mailbox", "-c", "Release", "--no-build"]]) {
        fs.writeFileSync(path.join(dir, "cmtk.yaml"), JSON.stringify({ system: "s", targets: { candidate: { base_url: "http://127.0.0.1:9" } }, adapters: { mailbox: { command: "dotnet", args } } }));
        r = await cmtk(dir, "adapter", "check", "mailbox");
        assert.equal(r.status, 0, args.join(" ") + r.stdout + r.stderr);
    }
});

test("the protocol: one JSON line each way, and a header value cannot leave", { ...needsDotnet, timeout: 300_000 }, async () => {
    const dir = project();
    await cmtk(dir, "adapter", "new", "leaky", "--lang", "csharp");
    const a = path.join(dir, "adapters", "leaky");
    // A careless adapter: it prints to stdout, reports a header, throws one, and writes one to stderr.
    const code = read(a, "Adapter.cs").replace("// Example only: echo what would be sent. Replace with the real interaction.", `Console.WriteLine("a stray line");
        var given = headers.Values.FirstOrDefault() ?? "";
        var mode = testCase["request"]?["path"]?.GetValue<string>();
        if (mode == "/report") return Task.FromResult(new JsonObject { ["effects"] = new JsonObject { ["key"] = given } });
        if (mode == "/throw") throw new InvalidOperationException("could not use " + given);
        if (mode == "/stderr") { Console.Error.WriteLine("key is " + given); Console.Error.WriteLine("key is {0}", given); Console.WriteLine(given); }
        if (mode == "/echo") return Task.FromResult(new JsonObject { ["body"] = testCase["request"]?["body"]?.GetValue<string>() });`);
    fs.writeFileSync(path.join(a, "Adapter.cs"), code);
    dotnetBuild(a);
    const dll = path.join(a, "bin", "Release", "net8.0", "leaky.dll");
    const secret = "s3cret+/value==with\"quote";
    const run = (p, body) => ({ op: "run", case: { id: "c", request: { method: "GET", path: p, body } }, target: { name: "t" }, headers: { "X-Key": secret } });

    const r = await talk(dll, [
        { op: "describe" }, { op: "reset", target: { name: "t" } }, { op: "nonsense" }, "not json",
        run("/fine"), run("/report"), run("/throw"), run("/stderr"), run("/echo", "café – 日本語"),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.replies.length, 9, "one reply per request, and nothing else on stdout");
    assert.deepEqual(r.replies[0], { name: "leaky", kinds: ["leaky"], settings: [] });
    assert.deepEqual(r.replies[1], { ok: true });
    assert.match(r.replies[2].error, /unknown op nonsense/);
    assert.ok(r.replies[3].error);
    assert.equal(r.replies[4].status, 200);
    assert.deepEqual(r.replies[4].effects.headerNames, ["X-Key"], "it reports the names of the headers, and no value");
    assert.equal(r.replies[5].error, "the adapter's reply held the value of the header X-Key, so it was not sent");
    assert.equal(r.replies[6].error, "the adapter's reply held the value of the header X-Key, so it was not sent");
    assert.equal(r.replies[8].body, "café – 日本語", "UTF-8 both ways");
    assert.match(r.stderr, /a stray line/, "Console.WriteLine goes to stderr");
    assert.match(r.stderr, /key is \[hidden\]/);
    for (const stream of [r.stdout, r.stderr]) {
        assert.ok(!stream.includes(secret) && !stream.includes(JSON.stringify(secret).slice(1, -1)) && !stream.includes("s3cret"), "the value appears nowhere");
    }

    // The kit fails an adapter that tries to report a header, and its output does not hold the value either.
    fs.writeFileSync(path.join(a, "samples", "cases.yaml"), 'cases:\n  - { id: S1, surface: leaky, request: { method: GET, path: /report } }\n');
    const kit = await cmtk(dir, "adapter", "check", "leaky");
    assert.equal(kit.status, 1, kit.stdout + kit.stderr);
    assert.match(kit.stdout, /FAIL  S1: answers with an observation \(the adapter's reply held the value of the header X-Cmtk-Check/);
    assert.doesNotMatch(kit.stdout + kit.stderr, /cmtk-check-/);
});
