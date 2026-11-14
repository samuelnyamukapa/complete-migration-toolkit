// The real adapter and real drivers as a process `cmtk` can start, over stand-in databases and a
// small system that changes them when a case asks. STANDIN_CANDIDATE=plant makes the candidate
// store a wrong total. STANDIN_PORT is where the system listens.
import http from "node:http";

import { createAdapter, readSettings, serve } from "../../index.mjs";
import { mssqlDriver, postgresDriver } from "../../drivers.mjs";
import { asSystem, fakeMssql, fakePg, makeDatabase } from "./stand-ins.mjs";

const plant = process.env.STANDIN_CANDIDATE === "plant";
const settings = readSettings(process.argv.slice(2));
const usesPostgres = settings["*"]?.driver === "postgres"; // PGlite takes a moment to start, so only when needed
const databases = usesPostgres ? { legacy: await makeDatabase(), candidate: await makeDatabase() } : {};
const row = (order_no, total, status) => ({ order_no, total, status, updated_at: new Date() });
const server = (name) => ({
    name: "cmtk_test",
    tables: { orders: [row("A-2", "20.50", "new"), row("A-1", "10.00", "new"), row("A-3", "30.00", "new")] },
    logins: { writer: { roles: { db_datawriter: 1 } } },
    label: name,
});
const servers = { legacy: server("legacy"), candidate: server("candidate") };

const system = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
        const [, name, what] = req.url.split("/");
        const finish = (status, body) => { res.writeHead(status, { "content-type": "application/json", "x-trace": "changes-every-run" }); res.end(JSON.stringify(body)); };
        if (req.method !== "POST" || what !== "orders") return finish(200, { read: true });
        const o = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const total = name === "candidate" && plant ? o.total + 1 : o.total;
        if (usesPostgres) await asSystem(databases[name], `INSERT INTO orders (order_no, total, status) VALUES ('${o.order_no}', ${total}, 'new'); UPDATE orders SET status = 'paid', updated_at = now() + interval '1 hour' WHERE order_no = 'A-1'; DELETE FROM orders WHERE order_no = 'A-3'`);
        const t = servers[name].tables.orders;
        t.push(row(o.order_no, total.toFixed(2), "new"));
        t.find((r) => r.order_no === "A-1").status = "paid";
        t.splice(t.findIndex((r) => r.order_no === "A-3"), 1);
        finish(201, { created: o.order_no });
    });
});
await new Promise((r) => system.listen(Number(process.env.STANDIN_PORT ?? 0), "127.0.0.1", r));

const drivers = {
    postgres: postgresDriver(async () => fakePg((host) => databases[host])),
    mssql: mssqlDriver(async () => fakeMssql((host) => servers[host])),
};
await serve(createAdapter({ drivers, settings }));
system.closeAllConnections();
system.close();
process.exit(0);
