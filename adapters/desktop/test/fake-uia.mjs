// A stand-in for uia.ps1, speaking the same lines, so the reader's wire protocol is tested on any system.
// The PowerShell itself runs only on Windows: see the test marked for it.
import readline from "node:readline";

const form = { title: "Orders", elements: [{ automation_id: "qty", name: "Quantity", role: "edit", value: "1" }, { automation_id: "secret", name: "Password", role: "edit", password: true }, { automation_id: "place", name: "Place order", role: "button" }] };
let screen = form;
for await (const line of readline.createInterface({ input: process.stdin })) {
    const m = JSON.parse(line);
    let reply = { ok: true };
    if (m.op === "start" && m.app !== "orders.exe") reply = { error: "the app was not found" };
    if (m.op === "snapshot") reply = screen;
    if (m.op === "invoke") screen = { title: "Order placed", elements: [{ automation_id: "total", name: "Total", role: "edit", value: `${form.elements[0].value}0.00` }] };
    if (m.op === "set_value") form.elements.find((e) => e.automation_id === m.locator.automation_id || e.name === m.locator.name).value = m.text;
    process.stdout.write(JSON.stringify(reply) + "\n");
}
