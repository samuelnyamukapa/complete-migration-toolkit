// A small sample job, like a nightly posting run: read fixed-width transactions and write one
// fixed-width balance per account, plus a text summary. Written twice over by real migrations;
// here the flags stand in for the rebuild.
//   --descending  writes the same balances in the other order, as a rebuild might
//   --plant       gets one balance wrong by a penny, to prove the comparison catches it
import fs from "node:fs";

const descending = process.argv.includes("--descending");
const plant = process.argv.includes("--plant");

const balances = new Map();
for (const line of fs.readFileSync("in/trans.txt", "latin1").split(/\r?\n/)) {
    if (!line) continue;
    const account = line.slice(0, 6);
    const cents = Number(line.slice(6, 14));
    balances.set(account, (balances.get(account) ?? 0) + (line[14] === "D" ? -cents : cents));
}
if (plant) balances.set("100002", balances.get("100002") + 1);

const accounts = [...balances.keys()].sort();
if (descending) accounts.reverse();
const runDate = new Date().toISOString().slice(0, 10).replaceAll("-", ""); // changes every day, so the layout ignores it
const records = accounts.map((a) => `${a}${String(balances.get(a)).padStart(10, "0")}${runDate}\n`);
fs.writeFileSync("out/balances.dat", records.join(""), "latin1");
const total = [...balances.values()].reduce((x, y) => x + y, 0);
fs.writeFileSync("out/summary.txt", `accounts=${balances.size}\ntotal=${total}\n`, "latin1");
