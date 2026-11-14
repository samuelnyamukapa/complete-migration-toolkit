// A tag is a promise about a version, so check it before anything is published:
// `node scripts/check-release.mjs v1.2.3`. It publishes nothing and needs no token.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGES, ROOT } from "./check-package.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Why this tag cannot be released from the files in `root`. Empty when it can. */
export function releaseProblems(root, tag) {
    const problems = [];
    const version = String(tag).replace(/^v/, "");
    if (!/^v/.test(String(tag)) || !SEMVER.test(version)) return [`The tag ${tag} is not a version such as v1.2.3 (major.minor.patch).`];
    const pkgs = PACKAGES.map((rel) => JSON.parse(fs.readFileSync(path.join(root, rel, "package.json"), "utf8")));
    for (const p of pkgs) {
        if (p.version !== version) problems.push(`${p.name} is at ${p.version}, and the tag says ${version}.`);
        const deps = p.dependencies ?? {};
        if (deps["@cmtk/core"] !== undefined && deps["@cmtk/core"] !== `^${version}`) problems.push(`${p.name} needs @cmtk/core ${deps["@cmtk/core"]}. It should be ^${version}.`);
        if (deps["complete-migration-toolkit"] !== undefined && deps["complete-migration-toolkit"] !== version) problems.push(`${p.name} needs complete-migration-toolkit ${deps["complete-migration-toolkit"]}. It should be exactly ${version}.`);
    }
    const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    if (!new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`, "m").test(changelog)) problems.push(`CHANGELOG.md has no entry for ${version}. Add "## ${version} (date)".`);
    return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const tag = process.argv[2];
    if (!tag) { console.error("Give the tag, such as v1.2.3."); process.exit(2); }
    const problems = releaseProblems(ROOT, tag);
    for (const p of problems) console.error(p);
    console.log(problems.length ? `${tag} cannot be released.` : `${tag} can be released.`);
    process.exit(problems.length ? 1 : 0);
}
