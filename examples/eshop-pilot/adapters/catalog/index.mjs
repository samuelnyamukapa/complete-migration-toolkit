#!/usr/bin/env node
// cmtk adapter "catalog": calls the eShop catalog service directly, not over HTTP.
// CatalogCore is a class library with no web host yet, so its boundary is the service interface.
// The target's `probe` setting names the program to run for it: the probe built for .NET Framework
// 4.7.2 against the legacy assembly, or for .NET 8 against CatalogCore. Each case's request path
// is an operation (see probe/Program.cs); only GET is accepted, and nothing is stored anywhere.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const probes = new Map();

function probeFor(target) {
    if (probes.has(target.name)) return probes.get(target.name);
    if (typeof target.probe !== "string") throw new Error(`target ${target.name} needs a \`probe\` setting: the probe program to run for it`);
    const exe = path.resolve(HERE, target.probe);
    const child = spawn(exe, [], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const p = { child, lines, startError: undefined };
    child.on("error", (err) => { p.startError = err; });
    probes.set(target.name, p);
    return p;
}

async function run(testCase, target) {
    if (testCase.request.method !== "GET") return { error: "the catalog adapter only reads: use GET" };
    const p = probeFor(target);
    p.child.stdin.write(testCase.request.path + "\n");
    const next = await p.lines.next();
    if (next.done) return { error: `the ${target.name} probe stopped${p.startError ? `: ${p.startError.message}` : ""}` };
    return JSON.parse(next.value);
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
    let reply;
    try {
        const msg = JSON.parse(line);
        if (msg.op === "describe") reply = { name: "catalog", kinds: ["catalog"], settings: ["probe"] };
        else if (msg.op === "run") reply = await run(msg.case, msg.target);
        else if (msg.op === "reset") reply = { ok: true }; // every request already gets a new in-memory catalog
        else reply = { error: `unknown op ${msg.op}` };
    } catch (err) {
        reply = { error: `${err?.name ?? "Error"}: ${err?.message ?? err}` };
    }
    process.stdout.write(JSON.stringify(reply) + "\n");
}
for (const p of probes.values()) p.child.stdin.end();
