// A small sample job on mainframe data: copy EBCDIC ledger records to the output, byte for byte.
//   --reverse  writes them in the other order, as a rebuild might
//   --plant    flips one digit in the first record's amount
import fs from "node:fs";

const SIZE = 26;
const bytes = fs.readFileSync("in/ledger.ebc");
const records = [];
for (let i = 0; i < bytes.length; i += SIZE) records.push(Buffer.from(bytes.subarray(i, i + SIZE)));
if (process.argv.includes("--plant")) records[0][7] = 0xf9;
if (process.argv.includes("--reverse")) records.reverse();
fs.writeFileSync("out/ledger.ebc", Buffer.concat(records));
