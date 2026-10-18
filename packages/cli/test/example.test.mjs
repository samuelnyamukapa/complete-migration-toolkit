// The bookshop example works as the README says: version 1 against its starting case, and
// version 2 compared with version 1, with the planted differences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = path.join(ROOT, "packages", "cli", "dist", "main.js");
const run = (cwd, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("close", (status) => resolve({ status, stdout }));
});
const start = (dir, ...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, "server.mjs"), ...args], { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.once("data", () => resolve(p));
});

test("the bookshop example: run on version 1, compare version 2", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-bookshop-"));
    fs.cpSync(path.join(ROOT, "examples", "bookshop"), dir, { recursive: true });
    const p1 = 41000 + Math.floor(Math.random() * 2000), p2 = p1 + 1;
    for (const f of ["cmtk.yaml", "compare.yaml"]) {
        const file = path.join(dir, f);
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("localhost:4100", `localhost:${p1}`).replace("localhost:4101", `localhost:${p2}`));
    }
    const v1 = await start(dir, "--port", String(p1));
    const v2 = await start(dir, "--v2", "--port", String(p2));
    try {
        const r = await run(dir, "run");
        assert.equal(r.status, 0, r.stdout);
        const c = await run(dir, "compare", "--manifest", "compare.yaml");
        assert.equal(c.status, 1);
        assert.match(c.stdout, /\$\.version: 1 vs 2/);
        const probe = await run(dir, "probe", "candidate", "GET /api/books?page=-1");
        assert.match(probe.stdout, /^500 application\/json/, "the planted crash is there to find");
    } finally {
        v1.kill();
        v2.kill();
    }
});
