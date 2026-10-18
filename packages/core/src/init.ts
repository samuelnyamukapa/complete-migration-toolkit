// `cmtk init`: a starting point for a project. Used by the command and by the MCP server.
import fs from "node:fs";
import path from "node:path";

import { loadManifest, ManifestError, STARTER_MANIFEST } from "./manifest.js";

export const EXAMPLE_CASES = `# Cases for \`cmtk run\` (one system, checked against expectations) and \`cmtk compare\`
# (the same request to the reference and the candidate). Each case says which requirement it answers for.
cases:
  - id: EXAMPLE-001
    name: the home page answers
    requirement: REQ-1
    request: GET /
    expect:
      status: 200
`;

export const DRIFT_HEADER = `# Approved drift: differences between the reference and the candidate that a named person accepted.
# Only a person adds an entry. Each needs id, where (from a report), reason and approved_by.
#  - id: DRIFT-001
#    case: "*"                      # or one case id
#    where: "header:content-type"   # a where value from REPORT.md; JSON paths may use [*]
#    reason: charset added to every JSON answer; consumers ignore it
#    approved_by: Jane Smith
#    date: 2026-10-16
drift: []
`;


/** Write cmtk.yaml and a first case file (and a drift ledger, when there is a legacy system). Refuses to overwrite. Returns the files written. */
export function initProject(manifestFile: string, o: { candidate: string; legacy?: string; system?: string }): string[] {
    if (fs.existsSync(manifestFile)) throw new ManifestError(`${path.basename(manifestFile)} already exists; edit it instead.`);
    const root = path.dirname(manifestFile);
    const system = (o.system ?? path.basename(root)).replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "system";
    fs.mkdirSync(path.join(root, "cmtk", "cases"), { recursive: true });
    fs.writeFileSync(manifestFile, STARTER_MANIFEST(system, o.legacy, o.candidate), "utf8");
    const written = [manifestFile];
    try {
        loadManifest(manifestFile); // proves what was written is valid, such as the URLs
    } catch (err) {
        fs.rmSync(manifestFile);
        throw err;
    }
    const example = path.join(root, "cmtk", "cases", "example.yaml");
    if (!fs.existsSync(example)) { fs.writeFileSync(example, EXAMPLE_CASES, "utf8"); written.push(example); }
    const drift = path.join(root, "cmtk", "drift.yaml");
    if (o.legacy && !fs.existsSync(drift)) { fs.writeFileSync(drift, DRIFT_HEADER, "utf8"); written.push(drift); }
    return written;
}
