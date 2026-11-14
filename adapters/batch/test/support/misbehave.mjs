// A job for the tests, doing one thing a good job would not. The first argument says what.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [what, ...rest] = process.argv.slice(2);
switch (what) {
    case "write-outside":
        fs.writeFileSync(process.env.OUTSIDE_FILE, "escaped");
        break;
    case "change-original":
        fs.writeFileSync(process.env.ORIGINAL_FILE, "changed");
        break;
    case "change-copy":
        fs.writeFileSync("in/trans.txt", "changed");
        fs.writeFileSync("out/saw.txt", fs.readFileSync("in/trans.txt"));
        break;
    case "where":
        fs.writeFileSync("out/where.txt", process.cwd());
        break;
    case "args":
        fs.writeFileSync("out/args.txt", rest.join("\n"));
        break;
    case "env":
        fs.writeFileSync("out/env.txt", Object.keys(process.env).sort().join("\n"));
        break;
    case "hang":
        setInterval(() => {}, 1000);
        break;
    case "fail":
        process.stderr.write("the job failed on purpose\n");
        fs.writeFileSync("out/partial.txt", "some");
        process.exit(3);
        break;
    case "link-out":
        fs.symlinkSync(path.resolve(process.env.OUTSIDE_FILE), "out/link.txt");
        break;
    case "link-write":
        fs.symlinkSync(path.dirname(path.resolve(process.env.OUTSIDE_FILE)), "out/away");
        fs.writeFileSync(`out/away/${path.basename(process.env.OUTSIDE_FILE)}`, "escaped");
        break;
    case "start-program":
        execFileSync(process.execPath, ["--version"]);
        fs.writeFileSync("out/started.txt", "started");
        break;
    case "read-outside":
        fs.writeFileSync("out/read.txt", fs.readFileSync(process.env.OUTSIDE_FILE));
        break;
    case "records":
        fs.writeFileSync("out/many.txt", Array.from({ length: Number(rest[0]) }, (_, i) => `line ${i}`).join("\n"));
        break;
    case "bad-length":
        fs.writeFileSync("out/ledger.ebc", Buffer.alloc(27, 0x40));
        break;
    default:
        throw new Error(`unknown: ${what}`);
}
