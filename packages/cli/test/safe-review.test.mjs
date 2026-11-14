// Finding 5 of the review of 0.6: `cmtk review` shows every `safe: true` on its own. Bulk accept never includes one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");

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
            if (/(Your full name: |\[a\/(A\/)?r\/s\/q\] |Why reject it\?[^\n]* |Type yes to confirm: )$/.test(fresh)) {
                seen = stdout.length;
                if (left.length) p.stdin.write(`${left.shift()}\n`); else p.stdin.end();
            }
        });
        p.stderr.on("data", (d) => (stderr += d));
        p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

const project = (cases) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-safe-"));
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), "system: s\ntargets:\n  candidate: { base_url: \"http://127.0.0.1:9\" }\n");
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), YAML.stringify({ cases }));
    return dir;
};
const read = (dir) => Object.fromEntries(YAML.parse(fs.readFileSync(path.join(dir, "cmtk/cases/a.yaml"), "utf8")).cases.map((c) => [c.id, c]));

test("A accepts the plain drafts and leaves a draft carrying safe for a person to read", async () => {
    const dir = project([
        { id: "D1", request: "GET /a", draft: true },
        { id: "D2", request: "DELETE /everything", safe: true, draft: true },
        { id: "D3", request: "GET /c", draft: true },
    ]);
    const r = await review(dir, ["Jo Tester", "A", "yes", "s"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = read(dir);
    assert.equal(after.D1.accepted_by, "Jo Tester");
    assert.equal(after.D3.accepted_by, "Jo Tester");
    assert.equal(after.D2.draft, true, "the bulk accept must not reach it");
    assert.equal(after.D2.safe_confirmed_by, undefined);
    assert.match(r.stdout, /Draft case D2/, "it was shown");
    assert.match(r.stdout, /D2 is marked safe: true.*neither switch/s);
});

test("on a draft carrying safe the bulk answer is not even offered", async () => {
    const dir = project([
        { id: "D1", request: "DELETE /everything", safe: true, draft: true },
        { id: "D2", request: "GET /b", draft: true },
    ]);
    const r = await review(dir, ["Jo Tester", "A", "s", "s"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(/\[a\/[^\]]*\]/.exec(r.stdout)[0], /^\[a\/r\/s\/q\]$/, "the first question offers no A");
    assert.equal(read(dir).D1.draft, true);
});

test("review refuses a name that reads as an agent, and changes nothing", async () => {
    const dir = project([{ id: "D1", request: "GET /a", draft: true }]);
    const r = await review(dir, ["agent: claude", "a"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /A person's name/);
    assert.equal(read(dir).D1.draft, true);
});

test("safe written into an accepted case is shown on its own, and a person confirms or removes it", async () => {
    const dir = project([
        { id: "K", request: "POST /read", safe: true },
        { id: "L", request: "POST /wipe", safe: true },
    ]);
    const r = await review(dir, ["Jo Tester", "a", "r"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /K is marked safe: true/);
    const after = read(dir);
    assert.equal(after.K.safe_confirmed_by, "Jo Tester");
    assert.match(after.K.safe_print, /^sha256:/);
    assert.equal(after.L.safe, undefined, "rejected: it now needs both switches");
    assert.equal(after.L.safe_confirmed_by, undefined);
});
