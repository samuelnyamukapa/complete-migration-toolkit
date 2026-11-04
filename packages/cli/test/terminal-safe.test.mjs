// Finding 24 of the review of 0.6: text from a system under test can't move the cursor or reverse what a person reads,
// and a tool's summary tells an agent which part came from the system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import YAML from "yaml";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "main.js");
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/;

const server = (fn) => new Promise((resolve) => {
    const s = http.createServer(fn);
    s.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) }));
});
const cmtk = (cwd, args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
});
const project = (a, b, cases) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-term-"));
    fs.mkdirSync(path.join(dir, "cmtk/cases"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cmtk.yaml"), `system: s\ntargets:\n  legacy: { base_url: "${a}" }\n  candidate: { base_url: "${b}" }\nreference: legacy\n`);
    fs.writeFileSync(path.join(dir, "cmtk/cases/a.yaml"), YAML.stringify({ cases }));
    return dir;
};
const HOSTILE = "evil\u001b[2K\u001b]0;owned\u0007‮gnp.exe​";

test("a JSON key holding escapes reaches the screen as visible text, in the summary, a failure and a probe", async () => {
    const answer = (v) => (req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ [HOSTILE]: v })); };
    const [a, b] = [await server(answer(1)), await server(answer(2))];
    const dir = project(a.url, b.url, [{ id: "A", request: "GET /x", expect: { json: { "$.none": { equals: HOSTILE } } } }]);
    try {
        const compared = await cmtk(dir, ["compare"]);
        assert.match(compared.stdout, /DIFFERENT A/);
        assert.doesNotMatch(compared.stdout, UNSAFE);
        assert.match(compared.stdout, /\\u001b/, "shown, not hidden");
        const ran = await cmtk(dir, ["run", "--target", "legacy"]);
        assert.doesNotMatch(ran.stdout, UNSAFE);
        const probe = await cmtk(dir, ["probe", "legacy", "GET /x"]);
        assert.doesNotMatch(probe.stdout, UNSAFE);
        assert.match(probe.stdout, /evil/);
    } finally {
        await a.close(); await b.close();
    }
});

test("--json stays valid JSON that means the same, with nothing live for a terminal", async () => {
    const answer = (req, res) => { res.statusCode = 500; res.setHeader("content-type", "text/plain"); res.end(HOSTILE); };
    const a = await server(answer);
    const dir = project(a.url, a.url, [{ id: "A", request: "GET /x", expect: { body_contains: [HOSTILE] } }]);
    try {
        const r = await cmtk(dir, ["run", "--target", "legacy", "--json"]);
        assert.doesNotMatch(r.stdout, UNSAFE);
        assert.equal(JSON.parse(r.stdout).cases[0].id, "A");
    } finally {
        await a.close();
    }
});

test("a draft's text is shown plainly in review: a reversal or a zero-width character can't change what a person reads", async () => {
    const dir = project("http://127.0.0.1:9", "http://127.0.0.1:9", [{ id: "D", name: `harmless‮​`, draft_note: "safe‮", request: "GET /x​", draft: true }]);
    const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-tty-")), "tty.mjs");
    fs.writeFileSync(preload, "process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n");
    const out = await new Promise((resolve) => {
        const p = spawn(process.execPath, ["--import", pathToFileURL(preload).href, CLI, "review"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", seen = 0;
        const left = ["Jo Tester", "s"];
        p.stdout.on("data", (d) => {
            stdout += d;
            if (/(Your full name: |\[a\/(A\/)?r\/s\/q\] )$/.test(stdout.slice(seen).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))) {
                seen = stdout.length;
                if (left.length) p.stdin.write(`${left.shift()}\n`); else p.stdin.end();
            }
        });
        p.on("close", () => resolve(stdout));
    });
    assert.ok(out.includes("Draft case D"), out);
    assert.ok(!/[​‮]/.test(out), "the characters must not reach the screen raw");
    assert.ok(out.includes("\\u202e"), "they are shown as text instead");
});
