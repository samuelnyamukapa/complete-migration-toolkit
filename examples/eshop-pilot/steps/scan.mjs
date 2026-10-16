// scan.mjs <folder> <text>: the longest file path under <folder>, and every file that contains <text>.
import fs from "node:fs";
import path from "node:path";
const [dir, needle] = process.argv.slice(2);
let longest = "";
const hits = [];
const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else {
            if (full.length > longest.length) longest = full;
            if (fs.readFileSync(full, "utf8").includes(needle)) hits.push(full);
        }
    }
};
walk(dir);
console.log(`longest path: ${longest.length} characters (${longest})`);
console.log(`files holding the text: ${hits.length ? hits.join(", ") : "none"}`);
