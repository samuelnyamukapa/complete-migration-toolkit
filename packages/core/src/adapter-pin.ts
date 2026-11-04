// Is an installed adapter still what a person approved? Reads files only, and starts nothing. It lives in core because
// `cmtk run`, `cmtk compare` and the MCP tools all start adapters, and none of them may start one that has changed.
// Installing and approving stay in the command, out of reach of the MCP server.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { ManifestError } from "./manifest.js";

/** What a build or an install writes. Never copied in an install, and never part of the source fingerprint. */
export const BUILD_FOLDERS = new Set(["bin", "obj", "node_modules"]);

const textHash = (data: Buffer) => {
    const text = data.subarray(0, 8000).includes(0) ? data : Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    return crypto.createHash("sha256").update(text).digest("hex");
};

/** One fingerprint for the source. Windows line endings count as the same text, so a checkout on Windows is not a change. */
export function fingerprint(dir: string): string {
    const hash = crypto.createHash("sha256");
    const walk = (at: string, prefix: string) => {
        for (const e of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (BUILD_FOLDERS.has(e.name)) continue;
            const rel = prefix + e.name;
            // A link cannot come from an install, so one here was added since: count it, without following it.
            if (e.isSymbolicLink()) { hash.update(`${rel}\0link\n`); continue; }
            if (e.isDirectory()) { walk(path.join(at, e.name), `${rel}/`); continue; }
            hash.update(`${rel}\0${textHash(fs.readFileSync(path.join(at, e.name)))}\n`);
        }
    };
    walk(dir, "");
    return `sha256:${hash.digest("hex")}`;
}

/** Everything in the build folders, at any depth: what `npm install` or `dotnet build` wrote, or what someone planted. Empty when there is none. */
export function buildFiles(dir: string): { print: string; files: string[] } {
    const hash = crypto.createHash("sha256");
    const files: string[] = [];
    const walk = (at: string, prefix: string, inBuild: boolean) => {
        for (const e of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const rel = prefix + e.name;
            const full = path.join(at, e.name);
            const under = inBuild || BUILD_FOLDERS.has(e.name);
            if (e.isSymbolicLink()) {
                if (under) { files.push(rel); hash.update(`${rel}\0link\0${fs.readlinkSync(full)}\n`); }
                continue;
            }
            if (e.isDirectory()) { walk(full, `${rel}/`, under); continue; }
            if (under) { files.push(rel); hash.update(`${rel}\0${textHash(fs.readFileSync(full))}\n`); }
        }
    };
    walk(dir, "", false);
    return { print: files.length ? `sha256:${hash.digest("hex")}` : "", files };
}

export type PinState = "ok" | "CHANGED since install" | "MISSING" | "BUILD FILES not approved";

export function readInstalled(root: string): Record<string, { fingerprint?: string; build_fingerprint?: string; [k: string]: unknown }> {
    const f = path.join(root, "adapters", "installed.yaml");
    if (!fs.existsSync(f)) return {};
    let doc: any;
    try { doc = YAML.parse(fs.readFileSync(f, "utf8")); } catch (err) { throw new ManifestError(`adapters/installed.yaml is not valid YAML: ${(err as Error).message.split("\n")[0]}`); }
    return (doc?.adapters ?? {}) as Record<string, { fingerprint?: string }>;
}

export function pinState(dir: string, rec: { fingerprint?: unknown; build_fingerprint?: unknown }): PinState {
    let st: fs.Stats;
    try { st = fs.lstatSync(dir); } catch { return "MISSING"; }
    if (st.isSymbolicLink() || !st.isDirectory()) return "CHANGED since install";
    if (fingerprint(dir) !== rec.fingerprint) return "CHANGED since install";
    return buildFiles(dir).print === (rec.build_fingerprint ?? "") ? "ok" : "BUILD FILES not approved";
}

/** Why this adapter must not be started, or undefined when it may. An adapter nobody installed from a registry has no pin to hold. */
export function adapterPinProblem(root: string, name: string): string | undefined {
    const installed = readInstalled(root);
    if (!Object.hasOwn(installed, name)) return undefined;
    const rec = installed[name];
    if (!rec || typeof rec !== "object") return undefined;
    const state = pinState(path.join(root, "adapters", name), rec);
    if (state === "ok") return undefined;
    if (state === "BUILD FILES not approved") return `adapter ${name} was not started: its bin, obj or node_modules files are not ones a person approved. If you built or installed them yourself, read them, then run \`cmtk adapter approve ${name}\` in a terminal`;
    return `adapter ${name} was not started: it no longer matches what a person approved (${state}). Read the changes, or remove the folder and its entry in adapters/installed.yaml and add it again`;
}
