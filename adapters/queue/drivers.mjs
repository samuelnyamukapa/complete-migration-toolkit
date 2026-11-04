// The two drivers behind one interface. A driver is loaded only when a target asks for it, so a
// project that uses one broker never needs the other's package.
//
//   namespaceOf(connection)  the namespace or virtual host it names, read without any network call
//   secretsOf(connection)    the parts that must never be printed
//   open(connection)         a connection with:
//     depth(queue)           { count, capped? }: how many wait, without taking or disturbing any
//     purge(queue)           empty it
//     publish(queue, { body: Buffer, contentType?, properties? })
//     take(queue, waitMs)    messages removed from it: [{ body: Buffer | string | object, contentType?, properties? }]
//     close()
// Queues are never created: a queue that does not exist is an error, not a new queue.

/** Pinned for the "not installed" message, and in package.json's optional peers. */
export const PACKAGES = { rabbitmq: ["amqplib", "2.2.1"], servicebus: ["@azure/service-bus", "7.10.0"] };

async function load(importer, driver) {
    const [pkg, version] = PACKAGES[driver];
    try {
        const m = await importer(pkg);
        return m.default ?? m;
    } catch (err) {
        if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(pkg)) {
            throw new Error(`the ${driver} driver needs the ${pkg} package, which is not installed. Run: npm install --no-save ${pkg}@${version}`);
        }
        throw err;
    }
}

export function rabbitmqDriver(importer = (p) => import(p)) {
    return {
        namespaceOf(connection) {
            let u;
            try { u = new URL(connection); } catch { throw new Error("the rabbitmq connection is not an amqp:// or amqps:// URL"); }
            if (u.protocol !== "amqp:" && u.protocol !== "amqps:") throw new Error("the rabbitmq connection is not an amqp:// or amqps:// URL");
            const vhost = decodeURIComponent(u.pathname.replace(/^\//, ""));
            return vhost || "/";
        },
        secretsOf(connection) {
            try { const p = new URL(connection).password; return p ? [p, decodeURIComponent(p)] : []; } catch { return []; }
        },
        async open(connection) {
            const amqp = await load(importer, "rabbitmq");
            const conn = await amqp.connect(connection);
            conn.on("error", () => { /* the next call reports it */ });
            let channel;
            // A failed call closes the channel (RabbitMQ's rule), so each call gets a working one.
            const ch = async () => {
                if (channel) return channel;
                const made = await conn.createConfirmChannel();
                made.on("error", () => { /* the call that caused it reports it */ });
                made.on("close", () => { if (channel === made) channel = undefined; });
                channel = made;
                return made;
            };
            return {
                async depth(queue) {
                    return { count: (await (await ch()).checkQueue(queue)).messageCount };
                },
                async purge(queue) {
                    await (await ch()).purgeQueue(queue);
                },
                async publish(queue, m) {
                    const c = await ch();
                    await c.checkQueue(queue); // RabbitMQ drops a message for a missing queue without a word
                    c.sendToQueue(queue, m.body, { persistent: true, ...(m.contentType ? { contentType: m.contentType } : {}), headers: m.properties ?? {} });
                    await c.waitForConfirms();
                },
                async take(queue) {
                    const c = await ch();
                    const out = [];
                    for (let m = await c.get(queue, { noAck: true }); m; m = await c.get(queue, { noAck: true })) {
                        out.push({ body: m.content, contentType: m.properties?.contentType, properties: m.properties?.headers ?? {} });
                    }
                    return out;
                },
                async close() {
                    await conn.close().catch(() => {});
                },
            };
        },
    };
}

/** The most a read-only depth counts on Service Bus, which has only peek to count with. */
export const PEEK_CAP = 1000;

export function serviceBusDriver(importer = (p) => import(p)) {
    return {
        namespaceOf(connection) {
            if (/(^|;)\s*UseDevelopmentEmulator\s*=\s*true/i.test(connection)) return "emulator";
            const m = /(?:^|;)\s*Endpoint\s*=\s*sb:\/\/([^.;/:]+)/i.exec(connection);
            if (!m) throw new Error("the servicebus connection has no Endpoint=sb://…");
            return m[1];
        },
        secretsOf(connection) {
            const m = /(?:^|;)\s*SharedAccessKey\s*=\s*([^;]+)/i.exec(connection);
            return m ? [m[1].trim()] : [];
        },
        async open(connection) {
            const { ServiceBusClient } = await load(importer, "servicebus");
            const client = new ServiceBusClient(connection);
            const takers = new Map();
            const taker = (queue) => {
                if (!takers.has(queue)) takers.set(queue, client.createReceiver(queue, { receiveMode: "receiveAndDelete" }));
                return takers.get(queue);
            };
            const received = (m) => ({ body: m.body, contentType: m.contentType, properties: m.applicationProperties ?? {} });
            return {
                async depth(queue) {
                    const r = client.createReceiver(queue, { receiveMode: "peekLock" });
                    try {
                        const seen = await r.peekMessages(PEEK_CAP);
                        return { count: seen.length, ...(seen.length >= PEEK_CAP ? { capped: true } : {}) };
                    } finally {
                        await r.close();
                    }
                },
                async purge(queue) {
                    const r = taker(queue);
                    while ((await r.receiveMessages(100, { maxWaitTimeInMs: 200 })).length);
                },
                async publish(queue, m) {
                    const s = client.createSender(queue);
                    try {
                        await s.sendMessages({ body: m.body, ...(m.contentType ? { contentType: m.contentType } : {}), applicationProperties: m.properties ?? {} });
                    } finally {
                        await s.close();
                    }
                },
                async take(queue, waitMs) {
                    return (await taker(queue).receiveMessages(100, { maxWaitTimeInMs: waitMs })).map(received);
                },
                async close() {
                    await client.close();
                },
            };
        },
    };
}

export const DRIVERS = { rabbitmq: rabbitmqDriver(), servicebus: serviceBusDriver() };
