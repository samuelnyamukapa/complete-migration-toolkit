// Against real brokers, in CI only: each test is skipped unless its environment variable is set.
// With no worker to answer, the input queue also serves as the output: what was published must come
// back through the real client. The queues must exist first: `orders-in` is created here for
// RabbitMQ; for Service Bus, name an existing one in CMTK_TEST_SERVICEBUS_QUEUE.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAdapter } from "../index.mjs";

const POST = { id: "REAL", request: { method: "POST", path: "/orders", headers: { "Content-Type": "application/json" }, body: '{"id":"ORD-1","total":10}' }, properties: { tenant: "t1" } };
const GET = { id: "REAL", request: { method: "GET", path: "/depth" } };

async function roundTrip(driver, env, queue) {
    const a = createAdapter({
        env: { CONN: env },
        settings: { sys: { driver, connection_env: "CONN", input_queue: queue, output_queues: { echoed: queue }, properties: "tenant", quiet_ms: 1500, limit_ms: 20000 } },
    });
    try {
        const target = { name: "sys" };
        assert.deepEqual(await a.reset(target), { ok: true });
        const o = await a.run(POST, target, {});
        assert.equal(o.error, undefined, o.error);
        assert.deepEqual(o.effects.outputs.echoed, [{ body: { id: "ORD-1", total: 10 }, content_type: "application/json", properties: { tenant: "t1" } }]);
        assert.deepEqual((await a.run(GET, target, {})).effects.queues.echoed, { depth: 0 });
        assert.doesNotMatch(a.clean({ error: `bad ${env}` }), new RegExp(env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
        await a.close();
    }
}

const RABBIT = process.env.CMTK_TEST_RABBITMQ_URL;
test("real RabbitMQ: publish and read back, through amqplib", { skip: RABBIT ? false : "set CMTK_TEST_RABBITMQ_URL" }, async () => {
    const amqp = await import("amqplib");
    const conn = await (amqp.default ?? amqp).connect(RABBIT);
    const ch = await conn.createChannel();
    await ch.assertQueue("orders-in");
    await conn.close();
    await roundTrip("rabbitmq", RABBIT, "orders-in");
});

const BUS = process.env.CMTK_TEST_SERVICEBUS_CONNECTION;
test("real Service Bus or its emulator: publish and read back, through @azure/service-bus", { skip: BUS ? false : "set CMTK_TEST_SERVICEBUS_CONNECTION" }, async () => {
    await roundTrip("servicebus", BUS, process.env.CMTK_TEST_SERVICEBUS_QUEUE ?? "orders-in");
});
