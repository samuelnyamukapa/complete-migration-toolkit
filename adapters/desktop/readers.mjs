// How the desktop adapter sees and works a screen. Each reader starts an app, says what its window shows, and
// presses and fills what a step names. The real one is Windows UI Automation. The stub plays a small app written
// as JSON: it proves the script runner and the comparison, and says nothing about any real app.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Which element a locator names. */
export function matches(element, l) {
    if (l.automation_id !== undefined && element.automation_id !== l.automation_id) return false;
    if (l.name !== undefined && element.name !== l.name) return false;
    if (l.role !== undefined && element.role !== l.role) return false;
    return l.automation_id !== undefined || l.name !== undefined || l.role !== undefined;
}

/** A small app from a JSON file: screens, their elements, and `go` to move to another screen. A value may say `{id}` for another element's value. */
export function stubReader(file) {
    const app = JSON.parse(fs.readFileSync(file, "utf8"));
    let screen = app.start;
    const typed = {};
    const value = (e) => {
        const raw = typed[e.automation_id] ?? e.value;
        return typeof raw === "string" ? raw.replace(/\{(\w+)\}/g, (_, id) => typed[id] ?? "") : raw;
    };
    const elements = () => app.screens[screen].elements;
    const find = (l) => elements().find((e) => matches(e, l));
    return {
        kind: "stub",
        async start() { if (!app.screens?.[screen]) throw new Error(`${file} has no screen ${screen}`); },
        async snapshot() {
            return { title: app.screens[screen].title, elements: elements().map((e) => ({ automation_id: e.automation_id, name: e.name, role: e.role, ...(e.password ? { password: true } : value(e) !== undefined ? { value: String(value(e)) } : {}), ...(e.disabled ? { disabled: true } : {}) })) };
        },
        async invoke(l) { const e = find(l); if (e.go) screen = e.go; },
        async setValue(l, text) { typed[find(l).automation_id] = text; },
        async close() {},
    };
}

/**
 * Windows UI Automation, through a PowerShell script that takes one JSON request per line and answers one JSON line.
 * `host` runs a stand-in for that script, for tests on any system.
 */
export function uiaReader(target, timeoutMs) {
    const program = target.uia_host ? process.execPath : "powershell.exe";
    const args = target.uia_host ? [path.resolve(String(target.uia_host))] : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "uia.ps1")];
    let child, lines;
    const call = async (msg) => {
        child.stdin.write(JSON.stringify(msg) + "\n");
        let timer;
        const late = new Promise((resolve) => { timer = setTimeout(() => resolve("late"), timeoutMs); });
        const next = await Promise.race([lines.next(), late]).finally(() => clearTimeout(timer));
        if (next === "late") throw new Error(`Windows UI Automation gave no answer within ${timeoutMs / 1000}s`);
        if (next.done) throw new Error("the Windows UI Automation reader stopped");
        const reply = JSON.parse(next.value);
        if (reply.error) throw new Error(`Windows UI Automation: ${reply.error}`);
        return reply;
    };
    return {
        kind: "uia",
        standIn: Boolean(target.uia_host),
        async start() {
            child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true });
            child.on("error", () => {});
            child.stdin.on("error", () => {});
            child.stderr.on("data", (d) => process.stderr.write(`uia: ${String(d).split("\n")[0]}\n`));
            lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
            await call({ op: "start", app: target.app, args: target.app_args ?? "" });
        },
        snapshot: () => call({ op: "snapshot" }),
        invoke: (l) => call({ op: "invoke", locator: l }),
        setValue: (l, text) => call({ op: "set_value", locator: l, text }),
        async close() {
            if (!child) return;
            await call({ op: "close" }).catch(() => {});
            child.stdin.end();
            child.kill();
        },
    };
}
