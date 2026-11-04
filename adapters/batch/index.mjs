#!/usr/bin/env node
// The batch adapter: copy a case's input files to a fresh working folder for each target, run a
// job named in settings with a time limit and no shell, and report each output file as name, size,
// hash and records. Never runs on the originals. One JSON request per line on stdin, one JSON
// reply per line on stdout; see README.md.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { byKey, canonical, parseRecords, readLayout } from "./records.mjs";

const NAME = "batch";
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const inside = (root, full) => {
    const r = path.relative(root, full);
    return r === "" || !(r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r));
};

const positive = (v, key, fallback) => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a number above 0`);
    return n;
};

/** A name relative to the working folder: never absolute, and never out through `..`. */
function relativeName(name, what) {
    const text = String(name);
    const parts = text.split(/[\\/]/);
    if (!text || path.isAbsolute(text) || path.win32.isAbsolute(text) || path.posix.isAbsolute(text) || parts.includes("..")) {
        throw new Error(`${what} ${JSON.stringify(text)} would be outside the working folder, so the job was not run`);
    }
    return parts.filter((p) => p && p !== ".").join("/");
}

/** An argument that names a place outside the working folder, in itself or after `--flag=`. */
function checkArgument(arg, job) {
    const text = String(arg);
    const value = text.includes("=") ? text.slice(text.indexOf("=") + 1) : text;
    for (const v of [text, value]) {
        if (path.posix.isAbsolute(v) || path.win32.isAbsolute(v) || /^file:/i.test(v) || v.split(/[\\/]/).includes("..")) {
            throw new Error(`the job ${job} has the argument ${JSON.stringify(text)}, which points outside the working folder, so it was not run. Arguments are relative to the working folder`);
        }
    }
    return text;
}

/** Files under a folder, as sorted names relative to it. A link is reported, and not followed. */
function listFiles(dir) {
    const out = [];
    const walk = (d, prefix) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const name = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), name);
            else out.push({ name, full: path.join(d, e.name), link: e.isSymbolicLink(), regular: e.isFile() });
        }
    };
    if (fs.existsSync(dir)) walk(dir, "");
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A job gets only these from this process's environment, so no secret reaches it by accident. */
const PASSED_ON = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ"];
function jobEnvironment(job, env) {
    const out = {};
    for (const k of [...PASSED_ON, ...(job.env_names ?? [])]) if (env[k] !== undefined) out[k] = env[k];
    return out;
}

function killTree(child) {
    if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false }).on("error", () => child.kill());
        return;
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

/** Run one job in its working folder. Never through a shell. */
function runJob(command, args, { cwd, env, limitS }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
        let stderr = "";
        let timedOut = false;
        child.stdout.resume();
        child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, limitS * 1000);
        child.on("error", (err) => { clearTimeout(timer); reject(err); });
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ code, signal: timedOut ? "time limit" : signal, timedOut, stderr });
        });
    });
}

function layoutFor(name, s, root) {
    const layouts = s.layouts ?? {};
    for (const [pattern, file] of Object.entries(layouts)) {
        const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
        if (re.test(name)) return readLayout(path.resolve(root, file));
    }
    return undefined;
}

/** One output file as plain facts. A file with keys is hashed by its sorted records, so its order and ignored fields cannot change the hash. */
function describeFile(name, bytes, s, root, maxRecords) {
    const entry = { name, size: bytes.length };
    const layout = layoutFor(name, s, root);
    if (!layout) {
        const text = bytes.includes(0) ? undefined : (() => { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; } })();
        if (text !== undefined) {
            const lines = text.split(/\r?\n/);
            if (lines.at(-1) === "") lines.pop();
            entry.record_count = lines.length;
            entry.records = lines.slice(0, maxRecords);
            if (lines.length > maxRecords) entry.capped = true;
        }
        entry.sha256 = sha256(bytes);
        return entry;
    }
    const parsed = parseRecords(bytes, layout, maxRecords);
    entry.record_count = parsed.total;
    if (parsed.total > maxRecords) entry.capped = true;
    if (parsed.problem) {
        entry.sha256 = sha256(bytes);
        entry.problem = parsed.problem;
        return entry;
    }
    const keys = s.keys?.[name] ?? layout.keys;
    if (keys.length) {
        for (const k of keys) if (!layout.fields.some((f) => f.name === k) || layout.ignore.has(k)) throw new Error(`${name}: the key ${k} is not a field that is read`);
        const keyed = byKey(parsed.records, keys);
        entry.keys = keys;
        if (keyed.duplicates.length) entry.duplicate_keys = keyed.duplicates;
        // Records before the hash, so a report's first line about this file names the field that differs.
        entry.records = keyed.records;
        entry.sha256 = sha256(canonical(keyed.records));
        entry.hash_of = "records sorted by key";
    } else if (layout.ignore.size) {
        entry.records = parsed.records;
        entry.sha256 = sha256(canonical(parsed.records));
        entry.hash_of = "records without ignored fields";
    } else {
        entry.records = parsed.records;
        entry.sha256 = sha256(bytes);
    }
    return entry;
}

export function createAdapter({ settings = {}, root = process.cwd(), env = process.env } = {}) {
    const settingsOf = (target) => ({ ...settings["*"], ...settings[target.name], ...target });

    /** The case's input files, read where they are. Reading is all that ever happens to them. */
    function inputsOf(c, s) {
        const from = path.resolve(root, s.inputs_root ?? ".");
        const list = c.inputs ?? [];
        if (!Array.isArray(list)) throw new Error("`inputs` must be a list of files");
        return list.map((item) => {
            const rel = typeof item === "string" ? item : item?.from;
            if (typeof rel !== "string" || !rel) throw new Error("each input needs a file, or { from, as }");
            const full = path.resolve(from, rel);
            if (!inside(from, full)) throw new Error(`the input ${rel} is outside the inputs folder`);
            if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`the input ${rel} does not exist`);
            const as = relativeName(typeof item === "string" ? path.basename(rel) : item.as ?? path.basename(rel), "the input name");
            const bytes = fs.readFileSync(full);
            return { rel: rel.split(path.sep).join("/"), full, as, sha: sha256(bytes), size: bytes.length };
        });
    }

    async function run(c, target) {
        const req = c?.request ?? {};
        const method = String(req.method ?? "GET").toUpperCase();
        for (const k of ["body_file", "body_form", "files", "before"]) {
            if (req[k] !== undefined) return { error: `this adapter does not support \`${k}\`; name files in the case's \`inputs\`` };
        }
        if (req.body !== undefined && req.body !== null) return { error: "this adapter does not support `body`; name files in the case's `inputs`" };
        const s = settingsOf(target);
        const jobName = String(req.path ?? "").split("/").filter(Boolean).at(-1);
        const job = s.jobs?.[jobName];
        if (!job || typeof job !== "object") return { error: `target ${target.name} has no job named ${JSON.stringify(jobName)}. The path's last part names one of: ${Object.keys(s.jobs ?? {}).join(", ") || "none"}` };
        const inputs = inputsOf(c, s);
        const reported = inputs.map((i) => ({ path: i.rel, sha256: i.sha, bytes: i.size }));

        // A read-only method must only observe, and a job is the system's own code. So it is not run.
        if (READ_ONLY.has(method)) {
            return { status: 200, effects: { job: jobName, ran: false, inputs: inputs.map((i) => ({ name: i.as, size: i.size, sha256: i.sha })) } };
        }

        const outputsDir = relativeName(s.outputs ?? "out", "outputs");
        if (!outputsDir) throw new Error(`outputs ${JSON.stringify(s.outputs)} would be the whole working folder, inputs included`);
        const limitS = positive(job.time_limit_s ?? s.time_limit_s, "time_limit_s", 60);
        const maxRecords = positive(s.max_records, "max_records", 10000);
        const jobArgs = (job.args ?? []).map((a) => checkArgument(a, jobName));
        const command = String(job.command ?? "");
        if (!command) return { error: `the job ${jobName} needs a command` };
        const isNode = command === "node";
        const program = isNode ? process.execPath : /[\\/]/.test(command) ? path.resolve(root, command) : command;
        if (process.platform === "win32" && /\.(cmd|bat)$/i.test(program)) return { error: `the job ${jobName} is a ${path.extname(program)} file, which needs a shell. This adapter never uses one: name the program itself` };
        const script = job.script === undefined ? [] : [path.resolve(root, String(job.script))];
        if (script[0] && !fs.existsSync(script[0])) return { error: `the job ${jobName}: the script ${job.script} does not exist` };

        const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmtk-batch-")));
        try {
            fs.mkdirSync(path.join(work, "in"));
            fs.mkdirSync(path.join(work, outputsDir), { recursive: true });
            for (const i of inputs) {
                const dest = path.join(work, "in", ...i.as.split("/"));
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(i.full, dest);
            }
            // For a node job the file-system lock is real: writes outside the working folder fail. See README.md for other programs.
            const lock = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
            const guard = isNode && job.node_permission !== false ? [lock, "--allow-fs-read=*", `--allow-fs-write=${work}${path.sep}*`, "--no-warnings"] : [];

            let done;
            try {
                done = await runJob(program, [...guard, ...script, ...jobArgs], { cwd: work, env: jobEnvironment(job, env), limitS });
            } catch (err) {
                return { error: `the job ${jobName} could not start: ${err.code ?? err.message}` };
            }
            const changed = inputs.filter((i) => { try { return sha256(fs.readFileSync(i.full)) !== i.sha; } catch { return true; } });
            if (changed.length) return { error: `the job ${jobName} changed an original input, which must never happen: ${changed.map((i) => i.rel).join(", ")}. Stop and restore it from a clean copy` };
            if (done.timedOut) return { error: `the job ${jobName} did not finish within its time limit of ${limitS}s, and was stopped`, effects: { job: jobName, timed_out: true } };
            if (done.code !== 0 && done.stderr) process.stderr.write(`job ${jobName} on ${target.name} exited ${done.code ?? done.signal}: ${done.stderr.split(/\r?\n/)[0]}\n`);

            const files = [];
            let capped = false;
            for (const f of listFiles(path.join(work, outputsDir))) {
                if (!f.regular) {
                    if (f.link && !inside(work, fs.realpathSync(f.full))) return { error: `the job ${jobName} left a link in its outputs that leads outside the working folder: ${f.name}` };
                    files.push({ name: f.name, kind: f.link ? "link" : "other" });
                    continue;
                }
                const entry = describeFile(f.name, fs.readFileSync(f.full), s, root, maxRecords);
                capped = capped || entry.capped === true;
                files.push(entry);
            }
            return {
                status: 200,
                effects: { job: jobName, exit_code: done.code, ...(done.signal ? { signal: done.signal } : {}), files },
                ...(reported.length ? { inputs: reported } : {}),
                // An error too, so a partial reading can never count as a match.
                ...(capped ? { error: `an output file has more than max_records (${maxRecords}) records, so only part of it was read` } : {}),
            };
        } finally {
            if (s.keep_work === true) process.stderr.write(`kept the working folder: ${work}\n`);
            else fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
        }
    }

    /** Every run starts in a fresh folder, so there is nothing to put back. */
    const reset = async () => ({ ok: true });

    const describe = () => ({
        name: NAME,
        kinds: ["files"],
        settings: ["jobs", "layouts", "keys", "outputs", "inputs_root", "time_limit_s", "max_records", "keep_work"],
    });

    return { describe, run, reset };
}

/** Settings from --settings <file>, relative to that file. With no file, the golden samples, for the conformance kit's check target only. */
export function readSettings(args, cwd = process.cwd()) {
    const i = args.indexOf("--settings");
    if (i < 0) {
        const samples = path.join(HERE, "samples");
        const file = JSON.parse(fs.readFileSync(path.join(samples, "settings.json"), "utf8"));
        return { settings: { check: { ...file["*"], ...file.check } }, root: samples };
    }
    const file = path.resolve(cwd, args[i + 1] ?? "");
    try {
        return { settings: JSON.parse(fs.readFileSync(file, "utf8")), root: path.dirname(file) };
    } catch (err) {
        throw new Error(`the settings file ${args[i + 1]} could not be read as JSON: ${err.message}`);
    }
}

export async function serve(adapter, input = process.stdin, output = process.stdout) {
    for await (const line of readline.createInterface({ input })) {
        let reply;
        try {
            const msg = JSON.parse(line);
            if (msg.op === "describe") reply = adapter.describe();
            else if (msg.op === "run") reply = await adapter.run(msg.case, msg.target, msg.headers);
            else if (msg.op === "reset") reply = await adapter.reset(msg.target);
            else reply = { error: `unknown op ${msg.op}` };
        } catch (err) {
            reply = { ok: false, error: err?.message ?? String(err) };
        }
        output.write(JSON.stringify(reply) + "\n");
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    let opened = {};
    let startup;
    try { opened = readSettings(process.argv.slice(2)); } catch (err) { startup = err; }
    const adapter = createAdapter(opened);
    await serve(startup ? { ...adapter, run: () => { throw startup; }, reset: () => { throw startup; } } : adapter);
}
