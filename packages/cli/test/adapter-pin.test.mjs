// Findings 14 (in part), 16 and 23 of the review of 0.6: what a person approved is what runs, build folders included,
// an install stays inside the project, and a location holding a password is never echoed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");

const tmp = (tag = "cmtk-pin-") => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tag)));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const cmtk = (cwd, args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});
function person(cwd, args, answers = ["Jo Tester", "yes"]) {
    const preload = path.join(tmp("cmtk-tty-"), "tty.mjs");
    fs.writeFileSync(preload, "process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n");
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "", seen = 0;
        const left = [...answers];
        p.stdout.on("data", (d) => {
            stdout += d;
            if (/(Your full name: |anything else to stop: )$/.test(stdout.slice(seen).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))) {
                seen = stdout.length;
                if (left.length) p.stdin.write(`${left.shift()}\n`); else p.stdin.end();
            }
        });
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

/** A registry in a plain folder, holding an adapter that leaves a mark whenever it starts. */
function registry() {
    const dir = tmp("cmtk-pin-reg-");
    write(dir, "registry.yaml", YAML.stringify({ adapters: [{ name: "evil", kinds: ["email"], language: "node", level: "experimental", source: "evil", licence: "MIT", owner: "Acme" }] }));
    write(dir, "evil/LICENSE", "MIT\n");
    write(dir, "evil/index.mjs", `import fs from "node:fs";
import readline from "node:readline";
fs.appendFileSync("started.log", "started\\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
    const msg = JSON.parse(line);
    console.log(JSON.stringify(msg.op === "describe" ? { name: "evil", kinds: ["email"] } : msg.op === "reset" ? { ok: true } : { status: 200, headers: {}, body: "ok" }));
}
`);
    write(dir, "evil/samples/cases.yaml", "cases:\n  - { id: S, request: GET /x }\n");
    return dir;
}

async function installed() {
    const project = tmp();
    const added = await person(project, ["adapter", "add", "evil", "--registry", registry()]);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    write(project, "cmtk.yaml", `system: s\ntargets:\n  candidate: { x: 1 }\nadapters:\n  evil: { command: "${process.execPath.replace(/\\/g, "/")}", args: [adapters/evil/index.mjs] }\n`);
    write(project, "cmtk/cases/a.yaml", "cases:\n  - { id: M, surface: evil, request: GET /x, expect: { status: 200 } }\n");
    return project;
}
const started = (project) => fs.existsSync(path.join(project, "started.log"));
const state = async (project) => JSON.parse((await cmtk(project, ["adapter", "list", "--json"])).stdout).find((a) => a.name === "evil").state;

test("an untouched installed adapter runs as before", async () => {
    const project = await installed();
    assert.equal(await state(project), "ok");
    const r = await cmtk(project, ["run"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(started(project));
});

test("an installed adapter whose code changed is not started, and the report says why", async () => {
    const project = await installed();
    fs.appendFileSync(path.join(project, "adapters/evil/index.mjs"), "\n// changed since a person approved it\n");
    assert.equal(await state(project), "CHANGED since install");
    const r = await cmtk(project, ["run", "--json"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.cases[0].result, "ERROR");
    assert.match(report.cases[0].why, /no longer matches what a person approved/);
    assert.equal(started(project), false, "it must not be started");
    assert.equal((await cmtk(project, ["adapter", "check", "evil"])).status, 3);
    assert.equal(started(project), false, "the kit must not start it either");
    assert.equal((await cmtk(project, ["probe", "candidate", "GET /x", "--surface", "evil"])).status, 3);
    assert.equal(started(project), false, "nor a probe");
});

for (const planted of ["node_modules/x/index.js", "bin/x.dll", "obj/x.txt", "sub/node_modules/y.js"]) {
    test(`a file planted at ${planted} is seen: the adapter is flagged and does not start`, async () => {
        const project = await installed();
        write(project, `adapters/evil/${planted}`, "console.log('planted');\n");
        assert.equal(await state(project), "BUILD FILES not approved");
        const listed = await cmtk(project, ["adapter", "list"]);
        assert.match(listed.stdout, /Warning: evil/);
        const r = await cmtk(project, ["run", "--json"]);
        assert.equal(r.status, 2);
        assert.match(JSON.parse(r.stdout).cases[0].why, /adapter approve evil/);
        assert.equal(started(project), false);
    });
}

test("a person approves what a build wrote; a later change to it needs approving again", async () => {
    const project = await installed();
    write(project, "adapters/evil/node_modules/x/index.js", "// what npm install wrote\n");
    const refused = await cmtk(project, ["adapter", "approve", "evil"]);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /a person says yes at a keyboard/);

    const yes = await person(project, ["adapter", "approve", "evil"]);
    assert.equal(yes.status, 0, yes.stdout + yes.stderr);
    assert.match(yes.stdout, /1 file in node_modules/);
    assert.equal(await state(project), "ok");
    const rec = YAML.parse(fs.readFileSync(path.join(project, "adapters/installed.yaml"), "utf8")).adapters.evil;
    assert.equal(rec.build_approved_by, "Jo Tester");
    assert.equal((await cmtk(project, ["run"])).status, 0);

    write(project, "adapters/evil/node_modules/x/index.js", "// planted later\n");
    assert.equal(await state(project), "BUILD FILES not approved");
    assert.equal((await cmtk(project, ["run"])).status, 2);
});

test("approve is for build files only: changed code still needs a fresh install, and no answer changes nothing", async () => {
    const project = await installed();
    write(project, "adapters/evil/node_modules/x.js", "x\n");
    const no = await person(project, ["adapter", "approve", "evil"], ["Jo Tester", "no"]);
    assert.equal(no.status, 0);
    assert.equal(await state(project), "BUILD FILES not approved");
    fs.appendFileSync(path.join(project, "adapters/evil/index.mjs"), "// changed\n");
    const r = await person(project, ["adapter", "approve", "evil"]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /remove the folder/);
    assert.equal(await state(project), "CHANGED since install");
    const none = await person(project, ["adapter", "approve", "nothing-here"]);
    assert.equal(none.status, 3);
});

for (const name of ["AI agent", "The agent claude", "agent: claude", "claude-code"]) {
    test(`${JSON.stringify(name)} can't install or approve`, async () => {
        const project = tmp();
        const r = await person(project, ["adapter", "add", "evil", "--registry", registry()], [name, "yes"]);
        assert.equal(r.status, 3, r.stdout);
        assert.equal(fs.existsSync(path.join(project, "adapters/installed.yaml")), false);
        const done = await installed();
        write(done, "adapters/evil/bin/x", "x");
        const a = await person(done, ["adapter", "approve", "evil"], [name, "yes"]);
        assert.equal(a.status, 3, a.stdout);
        assert.equal(await state(done), "BUILD FILES not approved");
    });
}

const linked = (target, link) => { try { fs.symlinkSync(target, link, "junction"); return true; } catch { return false; } };

test("adapters as a link out of the project: add and new write nothing outside", async (t) => {
    const parent = tmp();
    const project = path.join(parent, "project");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(project); fs.mkdirSync(outside);
    if (!linked(outside, path.join(project, "adapters"))) return t.skip("this machine can't make links");
    const r = await person(project, ["adapter", "add", "evil", "--registry", registry()]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /outside the project/);
    assert.deepEqual(fs.readdirSync(outside), []);
    const n = await cmtk(project, ["adapter", "new", "mine"]);
    assert.equal(n.status, 3, n.stdout + n.stderr);
    assert.deepEqual(fs.readdirSync(outside), []);
});

for (const location of ["alice:hunter2@git.example.com:acme/registry.git", "alice:hunter2@git.example.com/acme/registry.git", "https://alice:hunter2@git.example.com/r.git", "ssh://alice:hunter2@git.example.com/r.git"]) {
    test(`a registry location with a password is refused and never echoed: ${location.slice(0, 22)}`, async () => {
        const project = tmp();
        const r = await person(project, ["adapter", "add", "evil", "--registry", location]);
        assert.equal(r.status, 3);
        assert.doesNotMatch(r.stdout + r.stderr, /hunter2/);
        assert.match(r.stderr, /credential/);
    });
}

test("cmtk.yaml refuses the same location, and does not repeat it", async () => {
    const project = tmp();
    write(project, "cmtk.yaml", "system: s\ntargets:\n  candidate: { x: 1 }\nadapter_registries:\n  mine: alice:hunter2@git.example.com:acme/registry.git\n");
    const r = await cmtk(project, ["check"]);
    assert.equal(r.status, 3);
    assert.doesNotMatch(r.stdout + r.stderr, /hunter2/);
});
