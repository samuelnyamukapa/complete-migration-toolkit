// The real adapter and real drivers, over the in-memory broker, as a process `cmtk` can start.
// STANDIN_CANDIDATE says how the candidate differs: same, plant (a wrong total) or reorder.
// STANDIN_LOG names a file that gets one line for every message published.
import fs from "node:fs";

import { createAdapter, readSettings, serve } from "../../index.mjs";
import { rabbitmqDriver, serviceBusDriver } from "../../drivers.mjs";
import { fakeAmqplib, fakeServiceBus, makeBroker } from "./fake-broker.mjs";

const mode = process.env.STANDIN_CANDIDATE ?? "same";
const worker = (name) => (order) => {
    const total = name.includes("candidate") && mode === "plant" ? order.total + 1 : order.total;
    const outs = [
        { queue: "out", body: { order: order.id, line: 1, total }, properties: { tenant: "t1" } },
        { queue: "out", body: { order: order.id, line: 2, total } , properties: { tenant: "t1" } },
        { queue: "audit", body: { event: "order-seen", order: order.id } },
    ];
    return name.includes("candidate") && mode === "reorder" ? [outs[1], outs[0], outs[2]] : outs;
};
const brokers = new Map();
const brokerFor = (name) => {
    if (!brokers.has(name)) {
        const b = makeBroker(worker(name));
        const publish = b.publish;
        b.publish = (q, m) => {
            if (process.env.STANDIN_LOG) fs.appendFileSync(process.env.STANDIN_LOG, `${name} ${q}\n`);
            publish(q, m);
        };
        brokers.set(name, b);
    }
    return brokers.get(name);
};

const drivers = {
    rabbitmq: rabbitmqDriver(async () => fakeAmqplib(brokerFor)),
    servicebus: serviceBusDriver(async () => fakeServiceBus(brokerFor)),
};
await serve(createAdapter({ drivers, settings: readSettings(process.argv.slice(2)) }));
