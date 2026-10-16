#!/usr/bin/env node
// A Complete Migration Toolkit adapter: one JSON request per line on stdin, one JSON reply per
// line on stdout. Nothing else may be written to stdout; write diagnostics to stderr.
// Replace the body of run() with what this boundary needs: publish a message and read the
// queue, drop a file and read the output folder, query a mailbox, call a payment sandbox.
// Docs: https://github.com/samuelnyamukapa/complete-migration-toolkit/blob/main/docs/ADAPTERS.md
import readline from "node:readline";

const NAME = "__NAME__";

/** What this adapter covers and the settings it needs. */
function describe() {
    return { name: NAME, kinds: [NAME], settings: [] };
}

/**
 * Run one case against one target and return an observation:
 *   { status?, headers?, body?, effects?, error? }
 * `effects` holds side effects as plain JSON (messages, rows, files, emails). The toolkit
 * compares it between systems and checks it against expectations, exactly like a JSON body.
 */
async function run(testCase, target, headers) {
    // Example only: echo what would be sent. Replace with the real interaction.
    return {
        status: 200,
        effects: { target: target.name, method: testCase.request.method, path: testCase.request.path, headerNames: Object.keys(headers ?? {}).sort() },
    };
}

/** Put a target back into the state every case starts from (optional). */
async function reset(_target) {
    return { ok: true };
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
    let reply;
    try {
        const msg = JSON.parse(line);
        if (msg.op === "describe") reply = describe();
        else if (msg.op === "run") reply = await run(msg.case, msg.target, msg.headers);
        else if (msg.op === "reset") reply = await reset(msg.target);
        else reply = { error: `unknown op ${msg.op}` };
    } catch (err) {
        reply = { error: `${err?.name ?? "Error"}: ${err?.message ?? err}` };
    }
    process.stdout.write(JSON.stringify(reply) + "\n");
}
