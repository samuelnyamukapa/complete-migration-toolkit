// Adapter registries (#24): a temp git repository or folder is the registry, and nothing leaves this machine.
// `cmtk adapter add` refuses a script, so most tests say the streams are a terminal and type the answers, as
// draft-expect.test.mjs does for `cmtk review`. One test on Linux uses a real terminal through `script`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

import { classifyLocation, commitInstall, fingerprint, parseRegistry, pathProblem, prepareInstall, sourceAllowed } from "../dist/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const CLI = path.join(HERE, "..", "dist", "main.js");

const tmp = (tag = "cmtk-registry-") => fs.mkdtempSync(path.join(os.tmpdir(), tag));
const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
};
const gitIn = (cwd, ...args) => {
    const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
};
const commitAll = (dir, message = "change") => { gitIn(dir, "add", "-A"); gitIn(dir, "commit", "-q", "-m", message); return gitIn(dir, "rev-parse", "HEAD"); };

/** Scripted: no terminal, and whatever is piped in. */
const cmtk = (cwd, args, input = "") => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.stdin.end(input);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});

const PROMPT = /(Your full name: |anything else to stop: )$/;

/** As a person would: the streams say they are a terminal, and each answer is typed when its prompt appears. */
function person(cwd, args, answers = ["Jo Tester", "yes"]) {
    const preload = path.join(tmp("cmtk-tty-"), "tty.mjs");
    fs.writeFileSync(preload, "process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n");
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "", seen = 0;
        const left = [...answers];
        p.stdout.on("data", (d) => {
            stdout += d;
            const fresh = stdout.slice(seen).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
            if (PROMPT.test(fresh)) {
                seen = stdout.length;
                if (left.length) p.stdin.write(`${left.shift()}\n`); else p.stdin.end();
            }
        });
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

const ENTRY = (over = {}) => ({ name: "mailbox", kinds: ["email"], language: "node", level: "experimental", source: "mailbox", licence: "MIT", owner: "Acme Testing", version: "1.0.0", ...over });

/** An adapter written as the guide says, by the real `cmtk adapter new`, in a registry that is a git repository. */
async function gitRegistry(entries = [ENTRY()]) {
    const dir = tmp("cmtk-registry-git-");
    gitIn(dir, "init", "-q");
    const r = await cmtk(dir, ["adapter", "new", "mailbox"]);
    assert.equal(r.status, 0, r.stderr);
    fs.renameSync(path.join(dir, "adapters", "mailbox"), path.join(dir, "mailbox"));
    fs.rmSync(path.join(dir, "adapters"), { recursive: true });
    write(dir, "mailbox/LICENSE", "MIT\n");
    write(dir, "registry.yaml", YAML.stringify({ adapters: entries }));
    const commit = commitAll(dir, "first");
    return { dir, commit };
}

const noneInstalled = (project) => {
    assert.ok(!fs.existsSync(path.join(project, "adapters", "mailbox")), "the adapter must not be installed");
    assert.ok(!fs.existsSync(path.join(project, "adapters", "installed.yaml")), "nothing may be recorded");
    const left = fs.existsSync(path.join(project, "adapters")) ? fs.readdirSync(path.join(project, "adapters")) : [];
    assert.deepEqual(left, [], "nothing is left behind");
};

test("install, list and check an adapter from a git registry, then run a case through it", async () => {
    const reg = await gitRegistry();
    const project = tmp();
    const added = await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir]);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    for (const shown of [reg.dir, "folder mailbox", `commit ${reg.commit}`, "Licence:  MIT", "Owner:    Acme Testing", "Level:    experimental", "someone else's code"]) assert.ok(added.stdout.includes(shown), `shows ${shown}:\n${added.stdout}`);
    assert.match(added.stdout, new RegExp(`Installed adapters/mailbox, pinned to commit ${reg.commit}`));
    assert.ok(!fs.readdirSync(path.join(project, "adapters")).some((f) => f.startsWith(".")), "the staging folder is gone");

    const rec = YAML.parse(fs.readFileSync(path.join(project, "adapters", "installed.yaml"), "utf8")).adapters.mailbox;
    assert.equal(rec.commit, reg.commit);
    assert.equal(rec.approved_by, "Jo Tester");
    assert.equal(rec.level, "experimental");
    assert.match(rec.fingerprint, /^sha256:[0-9a-f]{64}$/);

    const listed = await cmtk(project, ["adapter", "list"]);
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /^http\s+core\s+built in/m);
    assert.match(listed.stdout, /^mailbox\s+experimental\s+ok\s+no\s+[0-9a-f]{12}/m);
    const json = JSON.parse((await cmtk(project, ["adapter", "list", "--json"])).stdout);
    assert.equal(json.find((a) => a.name === "mailbox").commit, reg.commit);

    const kit = await cmtk(project, ["adapter", "check", "mailbox"]);
    assert.equal(kit.status, 0, kit.stdout + kit.stderr);
    assert.match(kit.stdout, /Adapter mailbox passes the conformance kit/);

    // The next step it prints is true: registered that way, a case runs through the installed adapter.
    const reg_ = /mailbox: \{ command: node, args: \[adapters\/mailbox\/index\.mjs\], covers: \[email\] \}/.exec(added.stdout);
    assert.ok(reg_, added.stdout);
    write(project, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: "http://127.0.0.1:9" }\nadapters:\n  ${reg_[0]}\n`);
    write(project, "cmtk/cases/a.yaml", "cases:\n  - { id: M1, requirement: R1, surface: mailbox, request: GET /inbox, expect: { status: 200 } }\n");
    const ran = await cmtk(project, ["run"]);
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    assert.match(ran.stdout, /verdict for s: PASS/);
    assert.match((await cmtk(project, ["adapter", "list"])).stdout, /^mailbox\s+experimental\s+ok\s+yes/m);
});

test("refuses without a terminal, before it fetches or checks anything, whatever is piped in", async () => {
    const reg = await gitRegistry();
    const project = tmp();
    for (const args of [["adapter", "add", "mailbox", "--registry", reg.dir], ["adapter", "add", "mailbox", "--registry", "/no/such/place"], ["adapter", "add"]]) {
        const r = await cmtk(project, args, "Jo Tester\nyes\n");
        assert.equal(r.status, 3);
        assert.match(r.stderr, /a person says yes at a keyboard/);
        noneInstalled(project);
    }
    // Only one of the two being a terminal is still a refusal.
    for (const stream of ["stdin", "stdout"]) {
        const preload = path.join(tmp("cmtk-tty-"), "tty.mjs");
        fs.writeFileSync(preload, `process.${stream}.isTTY = true;\n`);
        const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, CLI, "adapter", "add", "mailbox", "--registry", reg.dir], { cwd: project, input: "Jo\nyes\n", encoding: "utf8" });
        assert.equal(r.status, 3, stream);
        assert.match(r.stderr, /a person says yes at a keyboard/);
        noneInstalled(project);
    }
});

test("there is no flag or variable that says yes", async () => {
    const reg = await gitRegistry();
    const project = tmp();
    for (const flag of ["--yes", "-y", "--force", "--allow-unsafe"]) {
        const r = await cmtk(project, ["adapter", "add", "mailbox", "--registry", reg.dir, flag], "yes\n");
        assert.notEqual(r.status, 0, flag);
        noneInstalled(project);
    }
    const envs = { CMTK_YES: "1", CMTK_ASSUME_YES: "yes", CI: "true", CMTK_INSTALL: "yes" };
    const r = spawnSync(process.execPath, [CLI, "adapter", "add", "mailbox", "--registry", reg.dir], { cwd: project, input: "yes\n", encoding: "utf8", env: { ...process.env, ...envs } });
    assert.equal(r.status, 3);
    noneInstalled(project);
    const src = fs.readFileSync(path.join(HERE, "..", "src", "main.ts"), "utf8");
    const adding = src.slice(src.indexOf("async function adapterAdd"), src.indexOf("/** How to start a C# adapter"));
    assert.ok(!/process\.env/.test(adding), "installing reads no environment variable");
});

test("only the word yes installs, and a person's name is needed", async () => {
    const reg = await gitRegistry();
    const project = tmp();
    for (const answers of [["Jo", "no"], ["Jo", "y"], ["Jo", ""], ["Jo"]]) {
        const r = await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir], answers);
        assert.equal(r.status, 0, JSON.stringify(answers));
        assert.match(r.stdout, /Nothing was installed/);
        noneInstalled(project);
    }
    for (const answers of [["", "yes"], ["agent smith", "yes"]]) {
        const r = await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir], answers);
        assert.equal(r.status, 3, JSON.stringify(answers));
        assert.match(r.stdout, /Nothing was installed/);
        noneInstalled(project);
    }
});

test("a real terminal, not a stand-in: a person types yes and the adapter installs", { skip: process.platform !== "linux" || spawnSync("script", ["--version"]).status !== 0 ? "needs `script` from util-linux" : false }, async () => {
    const reg = await gitRegistry();
    const project = tmp();
    const line = [process.execPath, CLI, "adapter", "add", "mailbox", "--registry", reg.dir].map((a) => `'${a}'`).join(" ");
    const out = await new Promise((resolve) => {
        const p = spawn("script", ["-qec", line, "/dev/null"], { cwd: project, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", seen = 0;
        const left = ["Jo Tester", "yes"];
        p.stdout.on("data", (d) => {
            stdout += d;
            if (PROMPT.test(stdout.slice(seen).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))) {
                seen = stdout.length;
                if (left.length) p.stdin.write(`${left.shift()}\r`);
            }
        });
        p.on("close", (status) => resolve({ status, stdout }));
    });
    assert.equal(out.status, 0, out.stdout);
    assert.ok(fs.existsSync(path.join(project, "adapters", "mailbox", "index.mjs")), out.stdout);
    assert.equal(YAML.parse(fs.readFileSync(path.join(project, "adapters", "installed.yaml"), "utf8")).adapters.mailbox.commit, reg.commit);
});

test("nothing from the adapter runs during an install, and the person is warned about what could run later", async () => {
    const reg = await gitRegistry();
    const marker = path.join(tmp("cmtk-marker-"), "ran");
    const planted = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`;
    write(reg.dir, "mailbox/package.json", JSON.stringify({ name: "x", scripts: { postinstall: `node -e '${planted}'`, prepare: `node -e '${planted}'` }, dependencies: { leftpad: "1.0.0" } }));
    write(reg.dir, "mailbox/index.mjs", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    write(reg.dir, "mailbox/tool.exe", "not really");
    write(reg.dir, "mailbox/bin/Release/old.dll", "built");
    write(reg.dir, "mailbox/node_modules/x/index.js", "built");
    // A filter and an attribute a checkout would obey. There is no checkout.
    write(reg.dir, ".gitattributes", "* filter=evil\n");
    const hook = path.join(reg.dir, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    commitAll(reg.dir);
    const project = tmp();
    const r = await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(marker), "no code from the adapter or the registry ran");
    assert.match(r.stdout, /install scripts \(postinstall, prepare\)\. cmtk does not run them/);
    assert.match(r.stdout, /needs 1 npm package \(leftpad\)/);
    assert.match(r.stdout, /ready-to-run files .*tool\.exe/);
    assert.ok(!fs.existsSync(path.join(project, "adapters", "mailbox", "bin")), "a build is left out");
    assert.ok(!fs.existsSync(path.join(project, "adapters", "mailbox", "node_modules")), "packages are left out");
});

test("a missing licence file is pointed out", async () => {
    const reg = await gitRegistry();
    fs.rmSync(path.join(reg.dir, "mailbox", "LICENSE"));
    commitAll(reg.dir);
    const r = await person(tmp(), ["adapter", "add", "mailbox", "--registry", reg.dir], ["Jo", "no"]);
    assert.match(r.stdout, /holds no LICENSE file/);
});

test("the version stays pinned: --pin takes a tag, and a later registry commit changes nothing here", async () => {
    const reg = await gitRegistry();
    gitIn(reg.dir, "tag", "v1");
    write(reg.dir, "mailbox/index.mjs", "// version two\n");
    const second = commitAll(reg.dir, "second");
    assert.notEqual(second, reg.commit);

    const older = tmp();
    assert.equal((await person(older, ["adapter", "add", "mailbox", "--registry", reg.dir, "--pin", "v1"])).status, 0);
    assert.equal(YAML.parse(fs.readFileSync(path.join(older, "adapters/installed.yaml"), "utf8")).adapters.mailbox.commit, reg.commit, "the tag is recorded as its commit");
    assert.ok(!fs.readFileSync(path.join(older, "adapters/mailbox/index.mjs"), "utf8").includes("version two"));

    const byCommit = tmp();
    assert.equal((await person(byCommit, ["adapter", "add", "mailbox", "--registry", reg.dir, "--pin", reg.commit])).status, 0);
    assert.ok(!fs.readFileSync(path.join(byCommit, "adapters/mailbox/index.mjs"), "utf8").includes("version two"));

    const latest = tmp();
    assert.equal((await person(latest, ["adapter", "add", "mailbox", "--registry", reg.dir])).status, 0);
    assert.equal(fs.readFileSync(path.join(latest, "adapters/mailbox/index.mjs"), "utf8"), "// version two\n");

    // Adding again never replaces what a person approved.
    const again = await person(older, ["adapter", "add", "mailbox", "--registry", reg.dir]);
    assert.equal(again.status, 3);
    assert.match(again.stderr, /already exists/);
    for (const bad of ["no-such-tag", "--evil", "a b"]) {
        const r = await person(tmp(), ["adapter", "add", "mailbox", "--registry", reg.dir, `--pin=${bad}`]);
        assert.equal(r.status, 3, bad);
    }
});

test("list says when the files no longer match what a person approved; line endings alone do not count", async () => {
    const reg = await gitRegistry();
    const project = tmp();
    assert.equal((await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir])).status, 0);
    const file = path.join(project, "adapters", "mailbox", "index.mjs");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace(/\n/g, "\r\n"));
    assert.match((await cmtk(project, ["adapter", "list"])).stdout, /^mailbox\s+experimental\s+ok/m, "a Windows checkout is not a change");
    fs.writeFileSync(file, `${original}// added later\n`);
    const changed = await cmtk(project, ["adapter", "list"]);
    assert.match(changed.stdout, /^mailbox\s+experimental\s+CHANGED since install/m);
    assert.match(changed.stdout, /no longer match what a person approved/);
    fs.writeFileSync(file, original);
    write(project, "adapters/mailbox/extra.mjs", "// added later\n");
    assert.match((await cmtk(project, ["adapter", "list"])).stdout, /CHANGED since install/, "a new file is a change");
    fs.rmSync(path.join(project, "adapters", "mailbox"), { recursive: true });
    assert.match((await cmtk(project, ["adapter", "list"])).stdout, /^mailbox\s+experimental\s+MISSING/m);
});

test("list shows every other adapter honestly: written here, registered only, and none has a level it did not earn", async () => {
    const project = tmp();
    assert.equal((await cmtk(project, ["adapter", "new", "mine"])).status, 0);
    write(project, "cmtk.yaml", "system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\nadapters:\n  elsewhere: { command: tool }\n");
    const out = (await cmtk(project, ["adapter", "list"])).stdout;
    assert.match(out, /^mine\s+none\s+written here\s+no/m);
    assert.match(out, /^elsewhere\s+none\s+no folder\s+yes/m);
});

test("a symbolic link or a submodule in the adapter refuses the install", async () => {
    for (const [mode, what] of [["120000", /symbolic link/], ["160000", /submodule/]]) {
        const reg = await gitRegistry();
        // Written straight into git's index, so this works on Windows too, and no real link is needed.
        const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: reg.dir, input: "/etc/passwd", encoding: "utf8" }).stdout.trim();
        gitIn(reg.dir, "update-index", "--add", "--cacheinfo", `${mode},${mode === "160000" ? reg.commit : blob},mailbox/planted`);
        gitIn(reg.dir, "commit", "-q", "-m", "plant");
        const project = tmp();
        const r = await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir]);
        assert.equal(r.status, 3, r.stdout);
        assert.match(r.stderr, what);
        noneInstalled(project);
    }
});

test("a link in a folder registry refuses the install", { skip: process.platform === "win32" ? "making a link on Windows needs extra rights" : false }, async () => {
    const dir = tmp();
    write(dir, "mailbox/index.mjs", "// x\n");
    fs.symlinkSync("/etc/passwd", path.join(dir, "mailbox", "planted"));
    write(dir, "registry.yaml", YAML.stringify({ adapters: [ENTRY()] }));
    const project = tmp();
    const r = await person(project, ["adapter", "add", "mailbox", "--registry", dir]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /symbolic link/);
    noneInstalled(project);
});

test("paths that climb out, or that Windows would misread, are refused", () => {
    for (const bad of ["../x", "a/../../x", "a//b", "/etc/x", ".git/hooks/pre-commit", "a/.GIT/config", "git~1/config", "C:/x", "a\\..\\x", "CON", "a/nul.txt", "a/b.", "a/b ", "x:stream", "a\u0000b", "a\u202eb", ""]) {
        assert.notEqual(pathProblem(bad), "", JSON.stringify(bad));
    }
    for (const fine of ["index.mjs", "samples/cases.yaml", ".gitignore", "a.b/c-d_e.txt", "console.js"]) assert.equal(pathProblem(fine), "", fine);
});

test("a registry entry must be complete and truthful", () => {
    const parse = (entry, opts) => parseRegistry(YAML.stringify({ adapters: [entry] }), "r", opts);
    assert.equal(parse(ENTRY())[0].name, "mailbox");
    for (const field of ["name", "kinds", "language", "level", "source", "licence", "owner"]) {
        const e = ENTRY();
        delete e[field];
        assert.throws(() => parse(e), new RegExp(field === "source" ? "source" : field), field);
    }
    const refused = [
        [{ name: "../evil" }, /name/], [{ name: "http" }, /http/], [{ name: "nul" }, /name/], [{ kinds: [] }, /kinds/], [{ level: "gold" }, /level/],
        [{ source: "../../etc" }, /source/], [{ source: "/etc" }, /source/], [{ source: { git: "https://x.example/a.git", commit: "v1.0" } }, /full commit/],
        [{ source: { git: "https://x.example/a.git", commit: "main" } }, /full commit/], [{ owner: "x\u001b[2Jfake" }, /plain text/], [{ licence: "MIT\nOwner: Someone trusted" }, /plain text/],
        [{ licence: undefined, license: "MIT" }, /licence/],
    ];
    for (const [over, why] of refused) assert.throws(() => parse(ENTRY(over)), why, JSON.stringify(over));
    assert.throws(() => parseRegistry(YAML.stringify({ adapters: [ENTRY(), ENTRY({ name: "MAILBOX" })] }), "r"), /listed twice/);
    assert.throws(() => parseRegistry("adapters: {", "r"), /not valid YAML/);
    assert.throws(() => parseRegistry("other: 1", "r"), /adapters/);
    // Core means it ships with the toolkit. A registry cannot award that, whatever it says.
    assert.throws(() => parse(ENTRY({ level: "core" })), /cannot award/);
    assert.equal(parse(ENTRY({ level: "core" }), { allowCore: true })[0].level, "core");
});

test("a bad registry refuses the install, and says which entry", async () => {
    const reg = await gitRegistry([ENTRY({ level: "core" })]);
    const project = tmp();
    const r = await person(project, ["adapter", "add", "mailbox", "--registry", reg.dir]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /entry 1 \(mailbox\).*cannot award/);
    noneInstalled(project);
    const other = await person(project, ["adapter", "add", "other", "--registry", (await gitRegistry()).dir]);
    assert.equal(other.status, 3);
    assert.match(other.stderr, /other is not in/);
    const empty = tmp();
    gitIn(empty, "init", "-q");
    write(empty, "a.txt", "x");
    commitAll(empty);
    const none = await person(project, ["adapter", "add", "mailbox", "--registry", empty]);
    assert.equal(none.status, 3);
    assert.match(none.stderr, /no registry\.yaml/);
    noneInstalled(project);
});

test("locations: credentials are refused and never echoed; so are unencrypted addresses and remote helpers", async () => {
    const SECRET = "s3cret-token-value";
    const project = tmp();
    const cases = [
        [`https://user:${SECRET}@git.example/x.git`, /holds a credential/],
        [`https://${SECRET}@git.example/x.git`, /holds a credential/],
        [`ssh://git:${SECRET}@git.example/x.git`, /holds a credential/],
        [`https://git.example/x.git?token=${SECRET}`, /query or a fragment/],
        [`http://git.example/${SECRET}.git`, /http:\/\/ is not allowed/],
        [`git://git.example/${SECRET}.git`, /git:\/\/ is not allowed/],
        [`ext::sh -c touch${SECRET}`, /remote helpers/],
        [`--upload-pack=touch${SECRET}`, /starts with a dash/],
    ];
    for (const [at, why] of cases) {
        const r = await person(project, ["adapter", "add", "mailbox", `--registry=${at}`]);
        assert.equal(r.status, 3, at);
        assert.match(r.stderr, why, at);
        assert.ok(!(r.stdout + r.stderr).includes(SECRET), `no secret is printed for ${why}`);
        noneInstalled(project);
    }
    assert.equal(classifyLocation("https://git.example/x.git", project).kind, "git");
    assert.equal(classifyLocation("ssh://git@git.example/x.git", project).kind, "git");
    assert.equal(classifyLocation("git@git.example:team/x.git", project).kind, "git");
    assert.equal(classifyLocation(project, project).kind, "folder");

    write(project, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\nadapter_registries:\n  acme: https://me:${SECRET}@git.example/x.git\n`);
    const r = await person(project, ["adapter", "add", "mailbox"]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /adapter_registries\.acme holds a credential/);
    assert.ok(!r.stderr.includes(SECRET));
});

test("private registries: named in cmtk.yaml, one chosen, no fallback, and the same name twice is refused", async () => {
    const a = await gitRegistry();
    const b = await gitRegistry();
    const project = tmp();
    write(project, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\nadapter_registries:\n  acme: ${JSON.stringify(a.dir)}\n  bravo: ${JSON.stringify(b.dir)}\n`);

    // No flag: it looks in each, and will not guess.
    const both = await person(project, ["adapter", "add", "mailbox"]);
    assert.equal(both.status, 3);
    assert.match(both.stderr, /in more than one registry/);
    noneInstalled(project);

    const picked = await person(project, ["adapter", "add", "mailbox", "--registry", "bravo"]);
    assert.equal(picked.status, 0, picked.stdout + picked.stderr);
    assert.equal(YAML.parse(fs.readFileSync(path.join(project, "adapters/installed.yaml"), "utf8")).adapters.mailbox.commit, b.commit);

    // One registry listed: no flag needed. A registry that can't be reached is an error, not a reason to look elsewhere.
    const single = tmp();
    write(single, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\nadapter_registries:\n  acme: ${JSON.stringify(a.dir)}\n`);
    assert.equal((await person(single, ["adapter", "add", "mailbox"])).status, 0);
    const down = tmp();
    write(down, "cmtk.yaml", `system: s\ntargets:\n  candidate: { base_url: 'http://127.0.0.1:9' }\nadapter_registries:\n  gone: ${JSON.stringify(path.join(a.dir, "no-such"))}\n  acme: ${JSON.stringify(a.dir)}\n`);
    assert.equal((await person(down, ["adapter", "add", "mailbox"])).status, 3);
    noneInstalled(down);

    // No registry named anywhere: it reaches for nothing.
    const bare = tmp();
    const r = await person(bare, ["adapter", "add", "mailbox"]);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /no default registry/);
    noneInstalled(bare);
});

test("a plain folder registry: no history, so the fingerprint is the pin", async () => {
    const dir = tmp();
    write(dir, "registry.yaml", YAML.stringify({ adapters: [ENTRY({ source: "./tools/mailbox/" })] }));
    write(dir, "tools/mailbox/index.mjs", "// x\n");
    write(dir, "tools/mailbox/run.sh", "#!/bin/sh\n");
    write(dir, "tools/mailbox/.git/config", "[core]\n");
    const project = tmp();
    const refused = await person(project, ["adapter", "add", "mailbox", "--registry", dir, "--pin", "v1"]);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /no history/);
    const r = await person(project, ["adapter", "add", "mailbox", "--registry", dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pinned to sha256:/);
    assert.ok(!fs.existsSync(path.join(project, "adapters/mailbox/.git")));
    const rec = YAML.parse(fs.readFileSync(path.join(project, "adapters/installed.yaml"), "utf8")).adapters.mailbox;
    assert.equal(rec.commit, undefined);
    assert.match(rec.fingerprint, /^sha256:/);
});

test("an adapter in another repository installs at the commit the registry names, not the latest", async () => {
    const source = await gitRegistry();
    const named = source.commit;
    write(source.dir, "mailbox/index.mjs", "// later\n");
    commitAll(source.dir);
    const reg = tmp();
    write(reg, "registry.yaml", YAML.stringify({ adapters: [ENTRY({ source: { git: pathToFileURL(source.dir).href, commit: named, path: "mailbox" } })] }));
    const project = tmp();
    const r = await person(project, ["adapter", "add", "mailbox", "--registry", reg]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.readFileSync(path.join(project, "adapters/mailbox/index.mjs"), "utf8").includes("later"));
    assert.equal(YAML.parse(fs.readFileSync(path.join(project, "adapters/installed.yaml"), "utf8")).adapters.mailbox.commit, named);

    const wrong = tmp();
    write(wrong, "registry.yaml", YAML.stringify({ adapters: [ENTRY({ source: { git: pathToFileURL(source.dir).href, commit: "0".repeat(40), path: "mailbox" } })] }));
    const bad = await person(project, ["adapter", "add", "other", "--registry", wrong]);
    assert.equal(bad.status, 3);
    const absent = tmp();
    const noCommit = await person(absent, ["adapter", "add", "mailbox", "--registry", wrong]);
    assert.equal(noCommit.status, 3);
    assert.match(noCommit.stderr, /no such commit/);
    noneInstalled(absent);
});

test("a remote registry may not point at a repository on this machine", () => {
    assert.equal(sourceAllowed("file:///home/me/secret-repo", "https://git.example/reg.git"), false);
    assert.equal(sourceAllowed("/home/me/secret-repo", "git@git.example:reg.git"), false);
    assert.equal(sourceAllowed("https://git.example/a.git", "https://git.example/reg.git"), true);
    assert.equal(sourceAllowed("file:///srv/a", "/srv/registry"), true);
});

test("what a person approved is what lands: files changed after the question, or a folder that appeared, stop the install", () => {
    const dir = tmp();
    write(dir, "registry.yaml", YAML.stringify({ adapters: [ENTRY()] }));
    write(dir, "mailbox/index.mjs", "// x\n");
    const project = tmp();
    const swapped = prepareInstall({ name: "mailbox", root: project, registries: [dir], base: project });
    fs.appendFileSync(path.join(swapped.stage, "index.mjs"), "// swapped after the person read it\n");
    assert.throws(() => commitInstall(swapped, project, "Jo", "2026-11-04"), /changed while you were reading/);
    swapped.cleanup();
    noneInstalled(project);

    const raced = prepareInstall({ name: "mailbox", root: project, registries: [dir], base: project });
    write(project, "adapters/mailbox/other.mjs", "// x\n");
    assert.throws(() => commitInstall(raced, project, "Jo", "2026-11-04"), /appeared while you were reading/);
    raced.cleanup();

    // The same files give the same fingerprint, wherever they sit.
    const a = tmp(), b = tmp();
    write(a, "x/y.txt", "one\n");
    write(b, "x/y.txt", "one\r\n");
    assert.equal(fingerprint(a), fingerprint(b));
    write(b, "x/z.txt", "");
    assert.notEqual(fingerprint(a), fingerprint(b));
});

test("only the toolkit's own adapters folder may list a core adapter", () => {
    const dir = tmp();
    write(dir, "registry.yaml", YAML.stringify({ adapters: [ENTRY({ level: "core" })] }));
    write(dir, "mailbox/index.mjs", "// x\n");
    const project = tmp();
    assert.throws(() => prepareInstall({ name: "mailbox", root: project, registries: [dir], base: project, toolkitAdapters: tmp() }), /cannot award/);
    const ok = prepareInstall({ name: "mailbox", root: project, registries: [dir], base: project, toolkitAdapters: dir });
    assert.equal(ok.entry.level, "core");
    ok.cleanup();
});

test("a hand-edited record of an install does not crash the list or award a level", async () => {
    const project = tmp();
    write(project, "adapters/installed.yaml", "adapters:\n  odd: { level: gold }\n  broken: 7\n");
    write(project, "adapters/odd/index.mjs", "// x\n");
    const r = await cmtk(project, ["adapter", "list"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^odd\s+none\s+CHANGED since install/m);
    assert.match(r.stdout, /^broken\s+none\s+no folder/m);
});

test("the adapters that ship here: each is listed, with a level of core or experimental, and each can be installed", async () => {
    const entries = parseRegistry(fs.readFileSync(path.join(ROOT, "adapters", "registry.yaml"), "utf8"), "adapters/registry.yaml", { allowCore: true });
    const folders = fs.readdirSync(path.join(ROOT, "adapters"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    assert.deepEqual(entries.map((e) => e.name).sort(), folders, "add each adapter in adapters/ to adapters/registry.yaml, with its level");
    for (const e of entries) {
        assert.ok(["core", "experimental"].includes(e.level), `${e.name} ships, so it is core or experimental`);
        assert.equal(e.licence, "Apache-2.0");
    }
    const listed = await cmtk(ROOT, ["adapter", "list", "--json"]);
    assert.equal(listed.status, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout);
    assert.equal(rows.find((r) => r.name === "http").level, "core");
    for (const e of entries) assert.equal(rows.find((r) => r.name === e.name).level, e.level, e.name);

    const project = tmp();
    const worker = await person(project, ["adapter", "add", "worker", "--registry", path.join(ROOT, "adapters")]);
    assert.equal(worker.status, 0, worker.stdout + worker.stderr);
    assert.match(worker.stdout, /dotnet build -c Release adapters\/worker/);
    assert.ok(fs.existsSync(path.join(project, "adapters/worker/Adapter.cs")));
    assert.ok(!fs.existsSync(path.join(project, "adapters/worker/bin")));
});

test("the guide: its registry entry is valid, its links resolve, and following its steps gives an installed adapter", async () => {
    const guide = fs.readFileSync(path.join(ROOT, "docs", "ADAPTER-CONTRIBUTING.md"), "utf8");
    const blocks = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    const entry = parseRegistry(blocks.find((b) => b.includes("level: experimental")), "guide")[0];
    assert.equal(entry.name, "mailbox");
    assert.equal(entry.source, "mailbox");
    const other = parseRegistry(`adapters:\n  - name: mailbox\n    kinds: [email]\n    language: node\n    level: experimental\n    licence: MIT\n    owner: A\n${blocks.find((b) => b.includes("source: { git"))}`, "guide");
    assert.equal(other[0].source.path, ".");
    for (const [, link] of guide.matchAll(/\]\(((?!http|#)[^)#]+)(?:#[^)]*)?\)/g)) assert.ok(fs.existsSync(path.join(ROOT, "docs", link)), link);

    // Step by step, as an author outside the team would. The guide's text is the only input for what the entry says.
    const author = tmp();
    assert.equal((await cmtk(author, ["adapter", "new", "mailbox"])).status, 0);
    assert.equal((await cmtk(author, ["adapter", "check", "mailbox"])).status, 0, "step 2: the kit passes on the template");
    write(author, "adapters/mailbox/LICENSE", "MIT\n");
    fs.writeFileSync(path.join(author, "adapters", "registry.yaml"), blocks.find((b) => b.includes("level: experimental")));
    const project = tmp();
    const r = await person(project, ["adapter", "add", "mailbox", "--registry", path.join(author, "adapters")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await cmtk(project, ["adapter", "check", "mailbox"])).status, 0, "step 5: the kit passes where it was installed");
});

// The gap in a report: a case whose surface has no adapter.
async function halfCovered() {
    const seen = [];
    const srv = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const dir = tmp();
    write(dir, "cmtk.yaml", `system: s\ntargets:\n  legacy: { base_url: "${url}" }\n  candidate: { base_url: "${url}" }\n`);
    write(dir, "cmtk/cases/a.yaml", "cases:\n  - { id: WEB, requirement: R1, request: GET /web, expect: { status: 200 } }\n  - { id: Q1, requirement: R2, surface: queue, request: GET /queue-only, expect: { status: 200 } }\n  - { id: Q2, requirement: R2, surface: queue, request: GET /queue-only, expect: { status: 200 } }\n  - { id: M1, requirement: R3, surface: mailbox, request: GET /mailbox-only, expect: { status: 200 } }\n");
    return { dir, seen, close: () => srv.close() };
}

test("cmtk run and cmtk compare flag a case whose surface has no adapter, send nothing for it, and cannot pass", async () => {
    const h = await halfCovered();
    try {
        for (const [cmd, verdict] of [["run", "INCOMPLETE"], ["compare", "INCOMPLETE"]]) {
            h.seen.length = 0;
            const r = await cmtk(h.dir, [cmd]);
            assert.equal(r.status, 2, r.stdout + r.stderr);
            assert.match(r.stdout, new RegExp(`verdict for s: ${verdict}`));
            assert.match(r.stdout, /No adapter for surface queue, so nothing was sent for: Q1, Q2/);
            assert.match(r.stdout, /No adapter for surface mailbox, so nothing was sent for: M1/);
            assert.ok(h.seen.length > 0 && h.seen.every((u) => u === "/web"), `only the http case was sent: ${h.seen}`);
            const report = JSON.parse(fs.readFileSync(path.join(h.dir, "cmtk/evidence", cmd, "REPORT.json"), "utf8"));
            assert.equal(report.verdict, verdict);
            assert.deepEqual(report.no_adapter, [{ surface: "mailbox", cases: ["M1"] }, { surface: "queue", cases: ["Q1", "Q2"] }]);
            assert.equal(report.cases.find((c) => c.id === "Q1").result, "ERROR");
            assert.match(report.reason, /3 cases on a surface with no adapter \(mailbox, queue\): nothing was sent for them/);
            const md = fs.readFileSync(path.join(h.dir, "cmtk/evidence", cmd, "REPORT.md"), "utf8");
            assert.match(md, /## Cases with no adapter/);
            assert.match(md, /- queue: Q1, Q2/);
            assert.match(md, /Q1 .*surface "queue" has no adapter/);
        }
    } finally { h.close(); }
});

test("when no case has an adapter there is no evidence, and leaving the gap out with --only is still partial", async () => {
    const h = await halfCovered();
    try {
        const none = await cmtk(h.dir, ["run", "--only", "Q1"]);
        assert.equal(none.status, 2);
        assert.match(none.stdout, /NO EVIDENCE/);
        assert.match(none.stdout, /No adapter for surface queue/);
        assert.equal(h.seen.length, 0);
        // A case elsewhere with no adapter does not block the one named, and the verdict still says it was only part.
        const part = await cmtk(h.dir, ["run", "--only", "WEB"]);
        assert.equal(part.status, 2);
        assert.match(part.stdout, /INCOMPLETE/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "cmtk/evidence/run/REPORT.json"), "utf8")).no_adapter, undefined);
        // A surface named like an Object method is still a surface with no adapter.
        write(h.dir, "cmtk/cases/b.yaml", "cases:\n  - { id: P1, requirement: R4, surface: constructor, request: GET /x, expect: { status: 200 } }\n");
        const proto = await cmtk(h.dir, ["run", "--only", "P1"]);
        assert.match(proto.stdout, /No adapter for surface constructor/);
    } finally { h.close(); }
});

test("once the adapter is installed and registered, the gap closes", async () => {
    const h = await halfCovered();
    try {
        fs.writeFileSync(path.join(h.dir, "cmtk/cases/a.yaml"), "cases:\n  - { id: WEB, requirement: R1, request: GET /web, expect: { status: 200 } }\n  - { id: M1, requirement: R3, surface: mailbox, request: GET /mailbox-only, expect: { status: 200 } }\n");
        assert.equal((await cmtk(h.dir, ["run"])).status, 2);
        const reg = await gitRegistry();
        assert.equal((await person(h.dir, ["adapter", "add", "mailbox", "--registry", reg.dir])).status, 0);
        fs.appendFileSync(path.join(h.dir, "cmtk.yaml"), "adapters:\n  mailbox: { command: node, args: [adapters/mailbox/index.mjs] }\n");
        const r = await cmtk(h.dir, ["run"]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /PASS/);
        assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "cmtk/evidence/run/REPORT.json"), "utf8")).no_adapter, undefined);
    } finally { h.close(); }
});
