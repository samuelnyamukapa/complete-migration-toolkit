// Use legacy eShop in Microsoft Edge the way a catalog manager would, and save the traffic as a
// HAR file: what the browser's developer tools give you with "Export HAR".
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pilot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(path.join(pilot, "tools", "har", "package.json"));
const pw = await import(pathToFileURL(req.resolve("playwright-core")).href);
const { chromium } = pw.default ?? pw; // playwright-core is CommonJS
const base = "http://localhost:53190";
const out = path.join(pilot, "recording.har");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ recordHar: { path: out, mode: "full" } });
const page = await context.newPage();
const steps = [];
const step = async (what, fn) => { await fn(); steps.push(`${what}: ${page.url()}`); };
await step("open the catalog", () => page.goto(base + "/"));
await step("next page", () => page.click("text=Next"));
await step("previous page", () => page.click("text=Previous"));
await step("open an item", () => page.goto(base + "/Catalog/Details/5"));
await step("back to the list", () => page.goto(base + "/"));
await step("open the create form", () => page.click("text=Create New"));
await step("open an edit form", () => page.goto(base + "/Catalog/Edit/2"));
await step("open a delete confirmation", () => page.goto(base + "/Catalog/Delete/3"));
await step("show 12 per page", () => page.goto(base + "/Catalog/Index?pageSize=12&pageIndex=0"));
await step("brands API", () => page.goto(base + "/api/brands"));
await step("one brand", () => page.goto(base + "/api/brands/3"));
await context.close();
await browser.close();
console.log(steps.join("\n"));
console.log(`HAR saved: ${out}`);
