// Adapter registries: `cmtk adapter add` and `cmtk adapter list`. An adapter is someone else's code,
// so this module fetches it without running anything: no hook, no filter, no checkout, no npm install.
// It lives in the command and not in @cmtk/core so that the MCP server, which only imports core, has
// no way to reach it. Only a person at a terminal installs. See docs/ADAPTER-CONTRIBUTING.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import { buildFiles, BUILD_FOLDERS as LEFT_OUT, fingerprint, ManifestError, pinState, readInstalled, type PinState } from "@cmtk/core";

export { fingerprint };

export class RegistryError extends Error {}

export const LEVELS = ["experimental", "verified", "core"] as const;
export type Level = (typeof LEVELS)[number];

const MAX_FILES = 5000;
const MAX_BYTES = 100 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PIN = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,127}$/;
/** Control characters and text-direction overrides could make a terminal show something other than what the file says. */
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

export interface RegistryEntry {
    name: string;
    kinds: string[];
    language: string;
    level: Level;
    /** A folder inside the registry, or another git repository at a commit the registry names. */
    source: string | { git: string; commit: string; path: string };
    licence: string;
    owner: string;
    version?: string;
}

export interface InstalledRecord {
    version?: string;
    /** Absent only when the source was a plain folder, which has no history; the fingerprint is then the pin. */
    commit?: string;
    fingerprint: string;
    /** What `npm install` or `dotnet build` wrote, once a person read it and said yes. */
    build_fingerprint?: string;
    build_approved_by?: string;
    build_approved_on?: string;
    level: Level;
    kinds: string[];
    language: string;
    licence: string;
    owner: string;
    registry: string;
    source: string;
    approved_by: string;
    date: string;
}

export interface ListedAdapter {
    name: string;
    level: Level | "none";
    state: "built in" | PinState | "ships here" | "written here" | "no folder";
    registered: boolean;
    origin: string;
    commit?: string;
    version?: string;
    licence?: string;
    owner?: string;
}

function shown(v: unknown, field: string, where: string): string {
    const s = typeof v === "number" ? String(v) : v;
    if (typeof s !== "string" || !s.trim()) throw new RegistryError(`${where} needs \`${field}\`.`);
    if (s.length > 200 || UNSHOWABLE.test(s)) throw new RegistryError(`${where}: \`${field}\` must be plain text of up to 200 characters.`);
    return s.trim();
}

/** What is wrong with a path inside an adapter, on any system. Empty means nothing. */
export function pathProblem(rel: string): string {
    if (!rel || rel.length > 200 || UNSHOWABLE.test(rel)) return "it is empty, too long, or holds control characters";
    for (const part of rel.split("/")) {
        if (!part || part === "." || part === "..") return "it climbs out of the folder";
        if (/^\.git$/i.test(part) || /^git~\d+$/i.test(part)) return "it writes into a .git folder";
        if (/[\\:<>"|?*]/.test(part) || /[. ]$/.test(part) || RESERVED.test(part)) return "Windows cannot hold that name, or would read it as something else";
    }
    return "";
}

function folderOf(raw: string, where: string): string {
    const clean = raw.trim().replace(/\/+$/, "").replace(/^\.\//, "");
    if (clean === "" || clean === ".") return ".";
    const problem = pathProblem(clean);
    if (problem) throw new RegistryError(`${where}: \`source\` is not a folder inside the registry: ${problem}.`);
    return clean;
}

function sourceOf(raw: any, where: string): RegistryEntry["source"] {
    if (typeof raw === "string") return folderOf(raw, where);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RegistryError(`${where} needs \`source\`: a folder inside the registry, or { git, commit, path }.`);
    const git = shown(raw.git, "source.git", where);
    const commit = shown(raw.commit, "source.commit", where);
    if (!FULL_COMMIT.test(commit)) throw new RegistryError(`${where}: \`source.commit\` must be a full commit id. A tag or a branch can move after a person said yes.`);
    return { git, commit, path: raw.path === undefined ? "." : folderOf(String(raw.path), where) };
}

/** Read a registry.yaml. One bad entry refuses the whole file: a person should not choose from a broken list. */
export function parseRegistry(text: string, label: string, opts: { allowCore?: boolean } = {}): RegistryEntry[] {
    let doc: any;
    try { doc = YAML.parse(text); } catch (err) { throw new RegistryError(`${label} is not valid YAML: ${(err as Error).message.split("\n")[0]}`); }
    if (!doc || !Array.isArray(doc.adapters)) throw new RegistryError(`${label} needs a list under \`adapters:\`.`);
    const seen = new Set<string>();
    return doc.adapters.map((e: any, i: number) => {
        const where = `${label}, entry ${i + 1}${typeof e?.name === "string" && !UNSHOWABLE.test(e.name) ? ` (${e.name.slice(0, 64)})` : ""}`;
        if (!e || typeof e !== "object") throw new RegistryError(`${where} must be a mapping.`);
        if (typeof e.name !== "string" || !NAME.test(e.name) || e.name === "http" || RESERVED.test(e.name)) throw new RegistryError(`${where}: \`name\` must be letters, digits, '.', '-' and '_', and not http, which is built in.`);
        if (seen.has(e.name.toLowerCase())) throw new RegistryError(`${where}: the name is listed twice.`);
        seen.add(e.name.toLowerCase());
        if (!Array.isArray(e.kinds) || !e.kinds.length || !e.kinds.every((k: unknown) => typeof k === "string" && NAME.test(k))) throw new RegistryError(`${where} needs \`kinds\`: a list such as [email].`);
        const language = shown(e.language, "language", where);
        if (!LEVELS.includes(e.level)) throw new RegistryError(`${where}: \`level\` must be ${LEVELS.join(", ")}.`);
        if (e.level === "core" && !opts.allowCore) throw new RegistryError(`${where}: \`level\` is core, and core means it ships with the toolkit. A registry cannot award that.`);
        if (e.license !== undefined && e.licence === undefined) throw new RegistryError(`${where} needs \`licence\`, spelled that way.`);
        return {
            name: e.name, kinds: e.kinds, language, level: e.level, source: sourceOf(e.source, where),
            licence: shown(e.licence, "licence", where), owner: shown(e.owner, "owner", where),
            ...(e.version !== undefined ? { version: shown(e.version, "version", where) } : {}),
        } satisfies RegistryEntry;
    });
}

const isRemote = (location: string) => /^(?:https|ssh):\/\/|^[\w.-]+@/i.test(location);

/** A registry on another machine may not reach into repositories on this one. */
export const sourceAllowed = (source: string, registry: string) => isRemote(source) || !isRemote(registry);

/**
 * Where a registry or a source lives. Never echoes a location that holds a credential: secrets come from the
 * person's own git setup, and nothing else may carry one to the disk, the screen or an error.
 */
export function classifyLocation(location: string, base: string): { kind: "git" | "folder"; at: string } {
    const refuse = (why: string) => new RegistryError(`That registry location is refused: ${why}`);
    if (typeof location !== "string" || !location.trim() || location.startsWith("-") || UNSHOWABLE.test(location)) throw refuse("it is empty or starts with a dash.");
    // user:password@host, written without a scheme. It is not a folder, and repeating it would print the password.
    if (/^[^/\s@]*:[^/\s@]*@/.test(location)) throw refuse("it holds a credential. Leave it out: git asks your credential helper or your ssh key. The location was not stored or printed.");
    if (/^[a-z0-9+.-]+::/i.test(location)) throw refuse("git's remote helpers can run commands. Use https, ssh or a folder.");
    const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(location);
    if (scheme) {
        const kind = scheme[1]!.toLowerCase();
        if (!["https", "ssh", "file"].includes(kind)) throw refuse(`${kind}:// is not allowed. Use https, ssh or a folder, so nobody on the network can swap the code.`);
        if (kind === "https" ? scheme[2]!.includes("@") : /:[^@]*@/.test(scheme[2]!)) throw refuse("it holds a credential. Leave it out: git asks your credential helper or your ssh key. The location was not stored or printed.");
        if (/[?#]/.test(location)) throw refuse("it holds a query or a fragment, which could carry a credential. The location was not stored or printed.");
        return { kind: "git", at: location };
    }
    if (/^[\w.-]+@[\w.-]+:/.test(location)) return { kind: "git", at: location };
    const at = path.resolve(base, location);
    if (!fs.existsSync(at) || !fs.statSync(at).isDirectory()) throw new RegistryError(`There is no folder at ${at}, and it is not an https or ssh address.`);
    const isGit = fs.existsSync(path.join(at, ".git")) || (fs.existsSync(path.join(at, "HEAD")) && fs.existsSync(path.join(at, "objects")));
    return { kind: isGit ? "git" : "folder", at };
}

/** Git runs with no hooks, no remote helpers, and none of the variables that aim it at some other repository. */
function git(args: string[], what: string): Buffer {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "https:ssh:file" };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_TEMPLATE_DIR"]) delete env[k];
    const safe = ["-c", `core.hooksPath=${os.devNull}`, "-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", "-c", "core.symlinks=false"];
    const r = spawnSync("git", [...safe, ...args], { env, stdio: ["inherit", "pipe", "pipe"], maxBuffer: MAX_BYTES + 1024 * 1024, timeout: 300_000, shell: false });
    if (r.error) throw new RegistryError((r.error as NodeJS.ErrnoException).code === "ENOENT" ? "A git registry needs git, and git was not found." : `${what}: ${r.error.message}`);
    if (r.status !== 0) {
        const said = String(r.stderr).trim().split(/\r?\n/).filter(Boolean).pop() ?? "git gave no reason";
        throw new RegistryError(`${what}: ${said.replace(/\/\/[^/@\s]*@/g, "//")}`);
    }
    return r.stdout as Buffer;
}

/** A bare copy: nothing is checked out, so no filter or attribute of the registry's can run. */
function cloneBare(at: string, into: string, what: string): string {
    git(["clone", "--bare", "--no-local", "--quiet", "--template=", "--", at, into], what);
    return into;
}

const inRepo = (repo: string, args: string[], what: string) => git([`--git-dir=${repo}`, ...args], what);

function resolveCommit(repo: string, ref: string, what: string): string {
    let out: string;
    try { out = String(inRepo(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], what)).trim(); }
    catch { throw new RegistryError(`${what}: there is no such commit.`); }
    if (!FULL_COMMIT.test(out)) throw new RegistryError(`${what}: there is no such commit.`);
    return out;
}

const keep = (rel: string) => !rel.split("/").some((p) => LEFT_OUT.has(p));

function writeFile(stage: string, rel: string, data: Buffer, executable: boolean) {
    const to = path.join(stage, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, data, { flag: "wx", mode: executable ? 0o755 : 0o644 });
}

/** Files are read one by one from git's objects, so a link or a submodule is refused rather than followed. */
function stageFromGit(repo: string, commit: string, sub: string, stage: string): string[] {
    const prefix = sub === "." ? "" : `${sub}/`;
    const listing = String(inRepo(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], "Reading the file list")).split("\0").filter(Boolean);
    const files: string[] = [];
    let bytes = 0;
    for (const line of listing) {
        const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
        if (!m || !m[4]!.startsWith(prefix)) continue;
        const rel = m[4]!.slice(prefix.length);
        if (!keep(rel)) continue;
        const problem = pathProblem(rel);
        if (problem) throw new RegistryError(`Refused: the adapter holds a file with a bad path: ${problem}.`);
        if (m[1] !== "100644" && m[1] !== "100755") throw new RegistryError(`Refused: ${rel} is ${m[1] === "120000" ? "a symbolic link" : m[1] === "160000" ? "a submodule" : "not a plain file"}. An adapter is plain files only, so what you approve is all you get.`);
        if (files.length >= MAX_FILES) throw new RegistryError(`Refused: the adapter holds more than ${MAX_FILES} files.`);
        const data = inRepo(repo, ["cat-file", "blob", m[3]!], `Reading ${rel}`);
        bytes += data.length;
        if (bytes > MAX_BYTES) throw new RegistryError(`Refused: the adapter is over ${MAX_BYTES / 1024 / 1024} MB.`);
        writeFile(stage, rel, data, m[1] === "100755");
        files.push(rel);
    }
    return files;
}

function stageFromFolder(root: string, sub: string, stage: string): string[] {
    const from = path.resolve(root, sub);
    const realRoot = fs.realpathSync(root);
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) throw new RegistryError(`The registry has no folder ${sub}.`);
    const real = fs.realpathSync(from);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new RegistryError(`Refused: ${sub} leaves the registry.`);
    const files: string[] = [];
    let bytes = 0;
    const walk = (dir: string, prefix: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (e.name === ".git" || LEFT_OUT.has(e.name)) continue;
            const rel = prefix + e.name;
            const problem = pathProblem(rel);
            if (problem) throw new RegistryError(`Refused: the adapter holds a file with a bad path: ${problem}.`);
            const full = path.join(dir, e.name);
            if (e.isSymbolicLink()) throw new RegistryError(`Refused: ${rel} is a symbolic link. An adapter is plain files only, so what you approve is all you get.`);
            if (e.isDirectory()) { walk(full, `${rel}/`); continue; }
            if (!e.isFile()) throw new RegistryError(`Refused: ${rel} is not a plain file.`);
            if (files.length >= MAX_FILES) throw new RegistryError(`Refused: the adapter holds more than ${MAX_FILES} files.`);
            const data = fs.readFileSync(full);
            bytes += data.length;
            if (bytes > MAX_BYTES) throw new RegistryError(`Refused: the adapter is over ${MAX_BYTES / 1024 / 1024} MB.`);
            writeFile(stage, rel, data, process.platform !== "win32" && (fs.statSync(full).mode & 0o111) !== 0);
            files.push(rel);
        }
    };
    walk(from, "");
    return files;
}

export interface Prepared {
    entry: RegistryEntry;
    registry: string;
    /** In words: the repository or folder the files came from. */
    source: string;
    commit?: string;
    fingerprint: string;
    files: string[];
    /** Things a person should see before saying yes. */
    notes: string[];
    stage: string;
    cleanup(): void;
}

interface Opened { location: string; entries: RegistryEntry[]; kind: "git" | "folder"; at: string; repo?: string; commit?: string }

function openRegistry(location: string, base: string, work: string, pin: string | undefined, toolkitAdapters: string | undefined): Opened {
    const { kind, at } = classifyLocation(location, base);
    if (kind === "folder") {
        if (pin) throw new RegistryError(`${at} is a plain folder, which has no history to pin to. Leave --pin out; the fingerprint of the files is the pin.`);
        const file = path.join(at, "registry.yaml");
        if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new RegistryError(`${at} has no registry.yaml.`);
        return { location, kind, at, entries: parseRegistry(fs.readFileSync(file, "utf8"), `${location}/registry.yaml`, { allowCore: !!toolkitAdapters && path.resolve(at) === path.resolve(toolkitAdapters) }) };
    }
    if (pin && !PIN.test(pin)) throw new RegistryError("--pin must be a tag, a branch or a commit id.");
    const repo = cloneBare(at, fs.mkdtempSync(path.join(work, "registry-")), `Fetching registry ${location}`);
    const commit = resolveCommit(repo, pin ?? "HEAD", `Finding ${pin ?? "the latest commit"} in registry ${location}`);
    let text: string;
    try { text = String(inRepo(repo, ["cat-file", "blob", `${commit}:registry.yaml`], "Reading registry.yaml")); }
    catch { throw new RegistryError(`Registry ${location} has no registry.yaml at commit ${commit.slice(0, 12)}.`); }
    return { location, kind, at, repo, commit, entries: parseRegistry(text, `${location}/registry.yaml`) };
}

/**
 * Fetch an adapter into a staging folder beside its final place, and run nothing. What a person approves is
 * exactly what `commitInstall` moves into place: nothing is fetched twice.
 */
export function prepareInstall(o: { name: string; root: string; registries: string[]; base: string; pin?: string; toolkitAdapters?: string }): Prepared {
    const dir = adaptersFolder(o.root);
    if (fs.existsSync(path.join(dir, o.name))) throw new RegistryError(`adapters/${o.name} already exists. A person removes it first, then adds the version they want.`);
    fs.mkdirSync(dir, { recursive: true });
    const work = fs.mkdtempSync(path.join(dir, ".cmtk-staging-"));
    const cleanup = () => fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    try {
        const opened = o.registries.map((r) => openRegistry(r, o.base, work, o.pin, o.toolkitAdapters));
        const holders = opened.filter((r) => r.entries.some((e) => e.name === o.name));
        // Never a silent choice: a public entry must not be able to stand in for a private adapter of the same name.
        if (holders.length > 1) throw new RegistryError(`${o.name} is in more than one registry (${holders.map((h) => h.location).join(", ")}). Choose one with --registry.`);
        if (!holders.length) throw new RegistryError(`${o.name} is not in ${o.registries.join(", ")}.`);
        const reg = holders[0]!;
        const entry = reg.entries.find((e) => e.name === o.name)!;
        const stage = path.join(work, "adapter");
        fs.mkdirSync(stage);
        let files: string[], source: string, commit: string | undefined;
        if (typeof entry.source === "string") {
            source = `${reg.location}${entry.source === "." ? "" : `, folder ${entry.source}`}`;
            commit = reg.commit;
            files = reg.repo ? stageFromGit(reg.repo, commit!, entry.source, stage) : stageFromFolder(reg.at, entry.source, stage);
        } else {
            const where = classifyLocation(entry.source.git, o.base);
            if (where.kind !== "git") throw new RegistryError(`${o.name}: \`source.git\` is not a git repository.`);
            if (!sourceAllowed(entry.source.git, reg.location)) throw new RegistryError(`${o.name}: a remote registry may not point at a repository on this machine.`);
            const repo = cloneBare(where.at, fs.mkdtempSync(path.join(work, "source-")), `Fetching ${entry.source.git}`);
            commit = resolveCommit(repo, entry.source.commit, `Finding the commit the registry names in ${entry.source.git}`);
            source = `${entry.source.git}${entry.source.path === "." ? "" : `, folder ${entry.source.path}`}`;
            files = stageFromGit(repo, commit, entry.source.path, stage);
        }
        if (!files.length) throw new RegistryError(`${o.name}: the source holds no files${commit ? ` at commit ${commit.slice(0, 12)}` : ""}.`);
        return { entry, registry: reg.location, source, ...(commit ? { commit } : {}), fingerprint: fingerprint(stage), files, notes: notesOn(stage, files), stage, cleanup };
    } catch (err) {
        cleanup();
        throw err;
    }
}

/** The project's adapters folder, or a refusal if it is a link that leads somewhere else: nothing is ever written outside the project. */
export function adaptersFolder(root: string): string {
    const dir = path.join(root, "adapters");
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new RegistryError("adapters/ is a link, and could lead outside the project. Nothing was written. Make it a plain folder.");
    return dir;
}

function notesOn(stage: string, files: string[]): string[] {
    const notes: string[] = [];
    if (!files.some((f) => !f.includes("/") && /^(?:licen[sc]e|copying)/i.test(f))) notes.push("It holds no LICENSE file, so only the registry's word says what the licence is.");
    if (files.includes("package.json")) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
            const hooks = ["preinstall", "install", "postinstall", "prepare"].filter((k) => pkg.scripts?.[k]);
            if (hooks.length) notes.push(`package.json has install scripts (${hooks.join(", ")}). cmtk does not run them, but npm install would.`);
            const deps = Object.keys(pkg.dependencies ?? {});
            if (deps.length) notes.push(`It needs ${deps.length} npm package${deps.length === 1 ? "" : "s"} (${deps.slice(0, 5).join(", ")}${deps.length > 5 ? ", …" : ""}). cmtk does not install them, and did not check them.`);
        } catch { notes.push("Its package.json cannot be read."); }
    }
    const runnable = files.filter((f) => /\.(?:exe|dll|so|dylib|node|wasm|jar|class|bat|cmd|ps1|sh)$/i.test(f));
    if (runnable.length) notes.push(`It holds ready-to-run files you cannot read as source: ${runnable.slice(0, 5).join(", ")}${runnable.length > 5 ? ", …" : ""}.`);
    return notes;
}

/** What a person reads before saying yes. Nothing here has been run, or reviewed by cmtk. */
export function describeInstall(p: Prepared): string[] {
    const e = p.entry;
    return [
        `Adapter ${e.name} from registry ${p.registry}`,
        `  Source:   ${p.source}`,
        `  Pin:      ${p.commit ? `commit ${p.commit}` : "no commit, because a plain folder has no history; the fingerprint below is the pin"}`,
        `  Version:  ${e.version ?? "not stated"}`,
        `  Licence:  ${e.licence} (as the registry states it)`,
        `  Owner:    ${e.owner}`,
        `  Level:    ${e.level} (as the registry states it)`,
        `  Kinds:    ${e.kinds.join(", ")}; language ${e.language}`,
        `  Files:    ${p.files.length}: ${p.files.slice(0, 12).join(", ")}${p.files.length > 12 ? ", …" : ""}`,
        `  Print:    ${p.fingerprint}`,
        ...p.notes.map((n) => `  Note:     ${n}`),
        "",
        "This is someone else's code. Nothing has been run yet, and cmtk has not reviewed it.",
        "Once installed, it runs with your rights whenever you run `cmtk adapter check`, `run` or `compare`.",
    ];
}

const installedFile = (root: string) => path.join(root, "adapters", "installed.yaml");

export function loadInstalled(root: string): Record<string, InstalledRecord> {
    try {
        return readInstalled(root) as unknown as Record<string, InstalledRecord>;
    } catch (err) {
        throw err instanceof ManifestError ? new RegistryError(err.message) : err;
    }
}

function writeInstalled(root: string, all: Record<string, InstalledRecord>): string {
    const tmp = `${installedFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `# Written by \`cmtk adapter add\`, once a person said yes. Each entry pins what was installed.\n${YAML.stringify({ adapters: all }, { lineWidth: 0 })}`, "utf8");
    return tmp;
}

/** What `cmtk adapter approve` shows: the build files as they are now, or why there is nothing it may approve. */
export function describeBuild(root: string, name: string): string[] {
    const rec = loadInstalled(root)[name];
    if (!rec || !Object.hasOwn(loadInstalled(root), name)) throw new RegistryError(`${name} was not installed from a registry, so it has no pin to approve.`);
    const dir = path.join(root, "adapters", name);
    const state = pinState(dir, rec);
    if (state === "MISSING" || state === "CHANGED since install") throw new RegistryError(`adapters/${name} is ${state}: its code no longer matches what a person approved, and this command only covers build files. Read the changes, or remove the folder and its entry in adapters/installed.yaml and add it again.`);
    const { files } = buildFiles(dir);
    const by = new Map<string, number>();
    for (const f of files) { const top = f.split("/").find((p) => LEFT_OUT.has(p))!; by.set(top, (by.get(top) ?? 0) + 1); }
    return [
        `Adapter ${name}: its code still matches what ${rec.approved_by} approved.`,
        files.length ? `Build files now: ${[...by].map(([k, n]) => `${n} file${n === 1 ? "" : "s"} in ${k}`).join(", ")}.` : "It has no build files now.",
        ...files.slice(0, 12).map((f) => `  ${f}`),
        ...(files.length > 12 ? [`  and ${files.length - 12} more`] : []),
        "",
        "These run with your rights whenever the adapter does. Say yes only if you wrote them, or ran the build or the install yourself.",
    ];
}

/** Records what a build wrote, with the person who said yes. */
export function approveBuild(root: string, name: string, approvedBy: string, date: string): void {
    const all = loadInstalled(root);
    const rec = all[name]!;
    const { print } = buildFiles(path.join(root, "adapters", name));
    const { build_fingerprint: _p, build_approved_by: _b, build_approved_on: _o, ...rest } = rec;
    all[name] = { ...rest, ...(print ? { build_fingerprint: print, build_approved_by: approvedBy, build_approved_on: date } : {}) };
    fs.renameSync(writeInstalled(root, all), installedFile(root));
}

/** Moves the approved files into place, and records who said yes. Either both happen or neither does. */
export function commitInstall(p: Prepared, root: string, approvedBy: string, date: string): InstalledRecord {
    const e = p.entry;
    const to = path.join(root, "adapters", e.name);
    if (fs.existsSync(to)) throw new RegistryError(`adapters/${e.name} appeared while you were reading. Nothing was changed.`);
    if (fingerprint(p.stage) !== p.fingerprint) throw new RegistryError("The fetched files changed while you were reading. Nothing was installed.");
    const record: InstalledRecord = {
        ...(e.version ? { version: e.version } : {}), ...(p.commit ? { commit: p.commit } : {}), fingerprint: p.fingerprint,
        level: e.level, kinds: e.kinds, language: e.language, licence: e.licence, owner: e.owner, registry: p.registry, source: p.source, approved_by: approvedBy, date,
    };
    const all = { ...loadInstalled(root), [e.name]: record };
    const f = installedFile(root);
    const tmp = writeInstalled(root, all);
    fs.renameSync(p.stage, to);
    try {
        fs.renameSync(tmp, f);
    } catch (err) {
        fs.rmSync(to, { recursive: true, force: true });
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    return record;
}

/** Every adapter this project can use, and what is known about each. Reads files only; it starts no adapter. */
export function listAdapters(root: string, registered: Record<string, unknown>): ListedAdapter[] {
    const dir = path.join(root, "adapters");
    const installed = loadInstalled(root);
    const shippedFile = path.join(dir, "registry.yaml");
    const shipped = fs.existsSync(shippedFile) ? parseRegistry(fs.readFileSync(shippedFile, "utf8"), "adapters/registry.yaml", { allowCore: true }) : [];
    const folders = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name) : [];
    const rows: ListedAdapter[] = [{ name: "http", level: "core", state: "built in", registered: true, origin: "the toolkit" }];
    for (const name of [...new Set([...folders, ...Object.keys(installed), ...Object.keys(registered)])].sort()) {
        const has = folders.includes(name);
        const reg = Object.hasOwn(registered, name);
        const rec = Object.hasOwn(installed, name) ? installed[name] : undefined;
        if (rec && typeof rec === "object") {
            rows.push({
                name, level: LEVELS.includes(rec.level) ? rec.level : "none", registered: reg, origin: `${rec.source}, approved by ${rec.approved_by} on ${rec.date}`,
                state: pinState(path.join(dir, name), rec),
                ...(rec.commit ? { commit: rec.commit } : {}), ...(rec.version ? { version: rec.version } : {}), licence: rec.licence, owner: rec.owner,
            });
            continue;
        }
        const entry = shipped.find((e) => e.name === name);
        if (has && entry) rows.push({ name, level: entry.level, state: "ships here", registered: reg, origin: "listed in adapters/registry.yaml", licence: entry.licence, owner: entry.owner });
        else if (has) rows.push({ name, level: "none", state: "written here", registered: reg, origin: "not from a registry" });
        else rows.push({ name, level: "none", state: "no folder", registered: reg, origin: "only in cmtk.yaml" });
    }
    return rows;
}

export function describeList(rows: ListedAdapter[]): string[] {
    const table = [["NAME", "LEVEL", "STATE", "IN CMTK.YAML", "PIN", "ORIGIN"], ...rows.map((r) => [r.name, r.level, r.state, r.registered ? "yes" : "no", r.commit ? r.commit.slice(0, 12) : "-", r.origin])];
    const width = table[0]!.map((_, i) => Math.max(...table.map((t) => t[i]!.length)));
    return table.map((t) => t.map((c, i) => (i === t.length - 1 ? c : c.padEnd(width[i]!))).join("  "));
}
