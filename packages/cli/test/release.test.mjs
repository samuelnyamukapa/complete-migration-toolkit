// Getting ready to publish (#32). Nothing here reaches npm: the packages are packed and unpacked on this machine.
// `npx cmtk` from the registry on clean Windows and Linux machines waits for the first release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import YAML from "yaml";

import { checkPackage, metadataProblems, npm, PACKAGES, problemsIn, REPOSITORY } from "../../../scripts/check-package.mjs";
import { releaseProblems } from "../../../scripts/check-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pkgOf = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel, "package.json"), "utf8"));
const lf = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

test("the real packages hold nothing they should not", () => {
    for (const rel of PACKAGES) {
        const r = checkPackage(rel);
        assert.deepEqual(r.problems, [], rel);
        assert.ok(r.count >= 5, `${rel} has ${r.count} files`);
    }
});

test("the contents check catches fixtures with secrets, evidence and machine paths, and never quotes them", () => {
    const base = [{ path: "package.json", text: "{}" }, { path: "README.md", text: "" }, { path: "LICENSE", text: "" }, { path: "NOTICE", text: "" }];
    assert.deepEqual(problemsIn("x", base), []);
    const live = `sk_live_${"a1".repeat(12)}`;
    for (const [file, want] of [
        [{ path: "test/fixtures/a.json", text: "" }, /test fixture/],
        [{ path: "fixtures/a.json", text: "" }, /test fixture/],
        [{ path: "cmtk/evidence/compare/x.json", text: "" }, /evidence folder/],
        [{ path: "dist/REPORT.json", text: "" }, /evidence/],
        [{ path: "dist/capture.jsonl", text: "" }, /evidence/],
        [{ path: ".env", text: "" }, /environment file/],
        [{ path: ".npmrc", text: "" }, /npm settings/],
        [{ path: "recording.har", text: "" }, /recording/],
        [{ path: "src/main.ts", text: "" }, /not meant to be published/],
        [{ path: "dist/a.js", text: `const k = "${live}";` }, /live payment key/],
        [{ path: "dist/a.js", text: `AKIA${"A".repeat(16)}` }, /cloud access key/],
        [{ path: "dist/a.js", text: `npm_${"a".repeat(36)}` }, /npm token/],
        [{ path: "dist/a.js", text: `ghp_${"a".repeat(36)}` }, /GitHub token/],
        [{ path: "dist/a.js", text: `-----BEGIN RSA ${"PRIVATE KEY"}-----` }, /private key/],
        [{ path: "dist/a.js", text: "/* at /home/samuel/work/x.ts */" }, /developer's machine/],
        [{ path: "dist/a.js", text: "/* at /Users/samuel/work/x.ts */" }, /developer's machine/],
        [{ path: "dist/a.js", text: "/* at C:\\Users\\samuel\\work */" }, /developer's machine/],
    ]) {
        const problems = problemsIn("x", [...base, file]);
        assert.ok(problems.some((p) => want.test(p)), `${file.path}: ${problems}`);
        assert.ok(!problems.join().includes(live), "the output never quotes what it found");
    }
    assert.ok(problemsIn("x", [{ path: "dist/a.js", text: "" }]).some((p) => /LICENSE is missing/.test(p)));
});

test("each package has what provenance and npm need, the licence travels with it, and the versions agree", () => {
    const good = { name: "x", license: "Apache-2.0", repository: { url: REPOSITORY }, publishConfig: { access: "public", provenance: true }, engines: { node: ">=22.5" } };
    assert.deepEqual(metadataProblems(good), []);
    assert.ok(metadataProblems({ ...good, repository: undefined }).some((p) => /provenance is refused/.test(p)));
    assert.ok(metadataProblems({ ...good, private: true }).some((p) => /private/.test(p)));
    const names = PACKAGES.map((rel) => pkgOf(rel).name);
    assert.deepEqual(names, ["@cmtk/core", "complete-migration-toolkit", "@cmtk/mcp", "cmtk"]);
    assert.equal(new Set(PACKAGES.map((rel) => pkgOf(rel).version)).size, 1, "all four packages share one version");
    for (const rel of PACKAGES) {
        for (const f of ["LICENSE", "NOTICE"]) assert.equal(lf(path.join(ROOT, rel, f)), lf(path.join(ROOT, f)), `${rel}/${f}`);
        assert.equal(pkgOf(rel).engines.node, pkgOf(".").engines.node);
    }
    assert.ok(!pkgOf(".").workspaces.includes("packages/npx-cmtk"), "npm could not install it before its dependency is on the registry");
    assert.equal(pkgOf("packages/cli").bin.cmtk, "dist/main.js");
    assert.equal(pkgOf("packages/npx-cmtk").bin.cmtk, "cmtk.mjs");
});

test("a tag must match the versions, the dependencies between packages and the changelog", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-release-"));
    const write = (rel, name, dependencies = {}, version = "1.2.3") => {
        fs.mkdirSync(path.join(dir, rel), { recursive: true });
        fs.writeFileSync(path.join(dir, rel, "package.json"), JSON.stringify({ name, version, dependencies }));
    };
    write("packages/core", "@cmtk/core");
    write("packages/cli", "complete-migration-toolkit", { "@cmtk/core": "^1.2.3" });
    write("packages/mcp", "@cmtk/mcp", { "@cmtk/core": "^1.2.3" });
    write("packages/npx-cmtk", "cmtk", { "complete-migration-toolkit": "1.2.3" });
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## 1.2.3 (2027-01-01)\n");
    assert.deepEqual(releaseProblems(dir, "v1.2.3"), []);
    assert.match(releaseProblems(dir, "1.2.3")[0], /not a version/);
    assert.match(releaseProblems(dir, "v1.2")[0], /not a version/);
    assert.match(releaseProblems(dir, "v1.2.3-rc1")[0], /not a version/);
    assert.ok(releaseProblems(dir, "v1.2.4").some((p) => /@cmtk\/core is at 1\.2\.3/.test(p)));
    assert.ok(releaseProblems(dir, "v1.2.4").some((p) => /no entry for 1\.2\.4/.test(p)));
    write("packages/cli", "complete-migration-toolkit", { "@cmtk/core": "^1.2.2" });
    assert.ok(releaseProblems(dir, "v1.2.3").some((p) => /should be \^1\.2\.3/.test(p)));
    write("packages/cli", "complete-migration-toolkit", { "@cmtk/core": "^1.2.3" });
    write("packages/npx-cmtk", "cmtk", { "complete-migration-toolkit": "^1.2.3" });
    assert.ok(releaseProblems(dir, "v1.2.3").some((p) => /exactly 1\.2\.3/.test(p)));
});

test("the release workflow: tests first on both systems, provenance, and a token only the publish step can read", () => {
    const text = lf(path.join(ROOT, ".github/workflows/release.yml"));
    const wf = YAML.parse(text);
    assert.deepEqual(Object.keys(wf.on), ["push"], "only a tag starts it");
    assert.deepEqual(Object.keys(wf.on.push), ["tags"]);
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.deepEqual(wf.jobs.test.strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
    assert.deepEqual(wf.jobs["try-it"].strategy.matrix.os, ["ubuntu-latest", "windows-latest"]);
    assert.ok(wf.jobs.test.steps.some((s) => s.run === "npm test"));
    assert.equal(wf.jobs.publish.needs, "test");
    assert.equal(wf.jobs["try-it"].needs, "publish");
    assert.equal(wf.jobs.publish.environment, "npm");
    assert.equal(wf.jobs.publish.permissions["id-token"], "write", "provenance needs it");
    assert.ok(!wf.jobs.test.permissions?.["id-token"], "only publishing gets it");
    const step = wf.jobs.publish.steps.find((s) => /npm publish/.test(s.run ?? ""));
    assert.match(step.run, /--provenance/);
    assert.deepEqual(step.env, { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" });
    assert.match(step.run, new RegExp(PACKAGES.join(" ")), "published in dependency order");
    const uses = [...text.matchAll(/secrets\.\w+/g)].map((m) => m[0]);
    assert.deepEqual(uses, ["secrets.NPM_TOKEN"], "the token appears once, in that step's environment");
    assert.doesNotMatch(text, /echo[^\n]*(TOKEN|secrets)|set -x|_authToken|\.npmrc/, "never in a log, never on disk");
    for (const job of Object.values(wf.jobs)) for (const s of job.steps) if (s !== step) assert.equal(s.env?.NODE_AUTH_TOKEN, undefined);
    for (const s of wf.jobs.publish.steps) assert.equal(s.with?.cache, undefined, "no cache when building what is published");
    const script = [...wf.jobs.publish.steps.map((s) => s.run ?? ""), ...wf.jobs.test.steps.map((s) => s.run ?? "")].join("\n");
    assert.match(script, /check-package\.mjs/);
    assert.match(script, /check-release\.mjs/);
});

test("the install steps say what works today and what works after the first release", () => {
    const readme = lf(path.join(ROOT, "README.md"));
    assert.match(readme, /After the first release/);
    assert.match(readme, /npx cmtk/);
    assert.match(readme, /not on npm yet/);
    for (const f of ["docs/RUNBOOK.md", "docs/TESTER-RUNBOOK.md"]) assert.match(lf(path.join(ROOT, f)), /after the first release/i, f);
});

test("the packed packages work: unpacked with nothing but their own files, in the layout npm would make", async () => {
    // Inside the repository's node_modules, so third-party packages resolve from there and every @cmtk package and the CLI from the unpacked copy.
    const cache = path.join(ROOT, "node_modules", ".cache");
    fs.mkdirSync(cache, { recursive: true });
    const box = fs.mkdtempSync(path.join(cache, "cmtk-pack-"));
    const stand = await new Promise((resolve) => {
        const s = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
        s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
    });
    let client;
    try {
        const nm = path.join(box, "node_modules");
        for (const rel of PACKAGES) {
            const pkg = pkgOf(rel);
            const out = npm(path.join(ROOT, rel), "pack", "--json", "--ignore-scripts", "--pack-destination", box);
            const tgz = JSON.parse(out.slice(out.indexOf("[")))[0].filename.replace(/^@/, "").replace(/\//g, "-");
            const dest = path.join(nm, pkg.name);
            fs.mkdirSync(dest, { recursive: true });
            // Run in the box with a relative name: a Windows tar reads C: as a remote host.
            const t = spawnSync("tar", ["-xzf", tgz, "-C", path.relative(box, dest).split(path.sep).join("/"), "--strip-components=1"], { cwd: box, encoding: "utf8" });
            assert.equal(t.status, 0, t.stderr);
        }
        const version = pkgOf("packages/cli").version;
        const main = path.join(nm, "complete-migration-toolkit", "dist", "main.js");
        const shim = path.join(nm, "cmtk", "cmtk.mjs");
        const cmtk = (cwd, file, ...args) => new Promise((resolve) => {
            const p = spawn(process.execPath, [file, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "", stderr = "";
            p.stdout.on("data", (d) => (stdout += d));
            p.stderr.on("data", (d) => (stderr += d));
            p.on("close", (status) => resolve({ status, stdout, stderr }));
        });

        for (const file of [main, shim]) {
            const v = await cmtk(box, file, "--version");
            assert.equal(v.stdout.trim(), version, v.stderr);
        }
        assert.ok(!fs.existsSync(path.join(nm, "complete-migration-toolkit", "src")), "no source");
        assert.ok(!fs.existsSync(path.join(nm, "complete-migration-toolkit", "test")), "no tests");
        assert.deepEqual(fs.readdirSync(path.join(nm, "@cmtk", "core", "dist")).filter((f) => f.endsWith(".map")), [], "no source maps: they name build paths");

        // Part 1 of the runbook, through the pointer package: init, a case, run.
        const project = path.join(box, "project");
        fs.mkdirSync(project);
        const init = await cmtk(project, shim, "init", "--candidate", stand.url);
        assert.equal(init.status, 0, init.stderr);
        fs.writeFileSync(path.join(project, "cmtk/cases/example.yaml"), "cases:\n  - { id: A-1, requirement: S-1, request: GET /x, expect: { status: 200 } }\n");
        const check = await cmtk(project, shim, "check");
        assert.equal(check.status, 0, check.stderr);
        const run = await cmtk(project, shim, "run");
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.match(run.stdout, /PASS/);

        // The templates travel in the package.
        const made = await cmtk(project, main, "adapter", "new", "mailbox");
        assert.equal(made.status, 0, made.stderr);
        const conformance = await cmtk(project, main, "adapter", "check", "mailbox");
        assert.equal(conformance.status, 0, conformance.stdout + conformance.stderr);
        const csharp = await cmtk(project, main, "adapter", "new", "worker2", "--lang", "csharp");
        assert.equal(csharp.status, 0, csharp.stderr);
        assert.ok(fs.existsSync(path.join(project, "adapters/worker2/.gitignore")));

        // The MCP server starts from its package, and gives a command that exists after an install.
        client = new Client({ name: "test", version: "1" });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(nm, "@cmtk", "mcp", "dist", "server.js")], cwd: project, stderr: "ignore" }));
        const cmds = (await client.callTool({ name: "cmtk_commands_for_person", arguments: { manifest: path.join(project, "cmtk.yaml") } })).content[0].text;
        assert.match(cmds, new RegExp(`npx --yes -p complete-migration-toolkit@${version.replace(/\./g, "\\.")} cmtk signoff run`));
        assert.doesNotMatch(cmds, /cli[\\/]+dist/, "no path to a clone that is not there");
    } finally {
        await client?.close();
        await stand.close();
        fs.rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
});
