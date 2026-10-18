// Bundle the MCP server and the cmtk command into the plugin, so the plugin needs nothing
// installed but Node.js. Run with `npm run bundle` after `npm run build`; CI checks the result
// is up to date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "plugin", "server");
const version = JSON.parse(fs.readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8")).version;
fs.mkdirSync(out, { recursive: true });

const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: { __CMTK_VERSION__: JSON.stringify(version) },
    // Some bundled packages use require(); give the ES module one.
    banner: { js: "import { createRequire as __cmtkCreateRequire } from 'node:module'; const require = __cmtkCreateRequire(import.meta.url);" },
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
};
const packages = new Set();
for (const [entry, file] of [["packages/mcp/dist/server.js", "cmtk-mcp.mjs"], ["packages/cli/dist/main.js", "cmtk.mjs"]]) {
    const r = await build({ ...common, entryPoints: [path.join(root, entry)], outfile: path.join(out, file) });
    for (const input of Object.keys(r.metafile.inputs)) {
        const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join("/"));
        if (m && !m[1].startsWith("@cmtk/")) packages.add(m[1]);
    }
}

// The licence travels with the plugin.
for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(root, f), path.join(root, "plugin", f));

// The adapter template `cmtk adapter new` copies.
fs.cpSync(path.join(root, "packages", "cli", "templates"), path.join(root, "plugin", "templates"), { recursive: true });

// Licences of everything bundled.
const notices = ["Third-party software bundled in server/cmtk-mcp.mjs and server/cmtk.mjs", ""];
for (const name of [...packages].sort()) {
    const dir = path.join(root, "node_modules", name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const licenceFile = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    notices.push("=".repeat(72), `${name} ${pkg.version} (${pkg.license ?? "see below"})`, "=".repeat(72), "",
        licenceFile ? fs.readFileSync(path.join(dir, licenceFile), "utf8").trim() : "(no licence file in the package)", "");
}
fs.writeFileSync(path.join(out, "THIRD-PARTY-NOTICES.txt"), notices.join("\n").replace(/\r\n/g, "\n") + "\n", "utf8");
console.log(`bundled cmtk ${version}: ${packages.size} third-party packages`);
