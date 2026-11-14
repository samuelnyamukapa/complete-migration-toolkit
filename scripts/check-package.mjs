// What would go to npm, checked before anything is published. Run with `node scripts/check-package.mjs`; the release
// workflow runs it too. It asks npm for each package's file list, so it checks what a person would really download:
// no test fixtures, no evidence folders, no secrets, and no file paths from a developer's machine.
// It publishes nothing and needs no token.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** In publishing order: each package needs the ones before it to be on npm already. */
export const PACKAGES = ["packages/core", "packages/cli", "packages/mcp", "packages/npx-cmtk"];
export const REPOSITORY = "git+https://github.com/samuelnyamukapa/complete-migration-toolkit.git";

const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|cmtk\.mjs|dist\/.+\.(js|d\.ts)|templates\/.+)$/;
const FORBIDDEN_PATH = [
    [/(^|\/)(test|tests|__tests__|fixtures?|__fixtures__)(\/|$)/i, "a test fixture"],
    [/(^|\/)(evidence|history)(\/|$)/i, "an evidence folder"],
    [/(^|\/)(REPORT\.(json|md)|SIGNOFF\.json|DEFECTS\.(json|md)|TREND\.(json|md)|capture\.jsonl)$/i, "evidence"],
    [/(^|\/)\.env(\.|$)/i, "an environment file"],
    [/(^|\/)\.npmrc$/i, "npm settings, which can hold a token"],
    [/\.(har|pem|key|pfx|p12|tsbuildinfo|log)$/i, "a recording, key, log or build file"],
];
const FORBIDDEN_TEXT = [
    [/\/home\/(?!runner\b|user\b|me\b|you\b|name\b)[a-z_][\w.-]*\//i, "a path from a developer's machine"],
    [/\/Users\/(?!name\b|you\b|me\b)[A-Za-z_][\w.-]*\//, "a path from a developer's machine"],
    [/[A-Za-z]:\\+Users\\+(?!name\b|you\b|me\b)[A-Za-z_][\w.-]*/, "a path from a developer's machine"],
    [/\/root\/[\w.-]/, "a path from a developer's machine"],
    [/\/tmp\/claude/, "a path from a developer's machine"],
    [/sk_live_[A-Za-z0-9]{8,}/, "a live payment key"],
    [/AKIA[0-9A-Z]{16}/, "a cloud access key"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "a GitHub token"],
    [/\bnpm_[A-Za-z0-9]{30,}/, "an npm token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
    [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/, "a signed token"],
    [/\bBearer [A-Za-z0-9._~+/-]{24,}/, "a bearer token"],
];

/** The problems in one package's files. `files` holds each file's path inside the package and its text. */
export function problemsIn(name, files) {
    const problems = [];
    const paths = files.map((f) => f.path);
    for (const want of ["package.json", "README.md", "LICENSE", "NOTICE"]) if (!paths.includes(want)) problems.push(`${name}: ${want} is missing`);
    for (const f of files) {
        if (!ALLOWED.test(f.path)) problems.push(`${name}: ${f.path} is not meant to be published`);
        for (const [rx, what] of FORBIDDEN_PATH) if (rx.test(f.path)) problems.push(`${name}: ${f.path} is ${what}`);
        // The rule and the problem never quote what was found, so this output cannot leak it.
        for (const [rx, what] of FORBIDDEN_TEXT) if (rx.test(f.text)) problems.push(`${name}: ${f.path} holds ${what}`);
    }
    return problems;
}

/** The settings npm and provenance need. Without `repository`, a publish with provenance is refused. */
export function metadataProblems(pkg) {
    const problems = [];
    if (pkg.private) problems.push(`${pkg.name}: it is marked private`);
    if (pkg.repository?.url !== REPOSITORY) problems.push(`${pkg.name}: repository.url must be ${REPOSITORY}, or provenance is refused`);
    if (pkg.publishConfig?.access !== "public") problems.push(`${pkg.name}: publishConfig.access must be public`);
    if (pkg.publishConfig?.provenance !== true) problems.push(`${pkg.name}: publishConfig.provenance must be true`);
    if (pkg.license !== "Apache-2.0") problems.push(`${pkg.name}: the licence must be Apache-2.0`);
    if (!pkg.engines?.node) problems.push(`${pkg.name}: engines.node must say which Node it needs`);
    return problems;
}

/** How to run npm with no shell: Windows has no npm executable, only a script. */
export function npmCommand() {
    const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
    const found = candidates.find((c) => c && /npm-cli\.[cm]?js$/.test(c) && fs.existsSync(c));
    if (!found) throw new Error("npm-cli.js was not found beside Node.");
    return [process.execPath, found];
}

export function npm(cwd, ...args) {
    const [cmd, script] = npmCommand();
    const r = spawnSync(cmd, [script, ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${path.basename(cwd)}: ${r.stderr}`);
    return r.stdout;
}

/** What npm would put in the package. */
export function packedFiles(dir) {
    const out = npm(dir, "pack", "--dry-run", "--json", "--ignore-scripts");
    const start = out.indexOf("[");
    return JSON.parse(out.slice(start))[0].files.map((f) => f.path.split(path.sep).join("/"));
}

export function checkPackage(rel) {
    const dir = path.join(ROOT, rel);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const files = packedFiles(dir).map((p) => ({ path: p, text: fs.readFileSync(path.join(dir, p), "latin1") }));
    return { name: pkg.name, count: files.length, problems: [...metadataProblems(pkg), ...problemsIn(pkg.name, files)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let bad = 0;
    for (const rel of PACKAGES) {
        const r = checkPackage(rel);
        if (r.count < 5) { console.error(`${r.name}: only ${r.count} files. Run \`npm run build\` first.`); bad++; }
        for (const p of r.problems) { console.error(p); bad++; }
        console.log(`${r.problems.length ? "FAIL" : "pass"}  ${r.name}: ${r.count} files`);
    }
    process.exit(bad ? 1 : 0);
}
