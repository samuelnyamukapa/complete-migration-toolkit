// A stand-in broker in memory, behind the same client calls amqplib and @azure/service-bus make,
// so the real driver code runs. It is not RabbitMQ or Service Bus: it proves the adapter's logic,
// and the real-server jobs in README.md prove the rest.

/** Queues in one namespace or virtual host, with a worker that answers each message on `in`. */
export function makeBroker(worker = () => []) {
    const queues = new Map(["in", "out", "audit"].map((q) => [q, []]));
    const log = { published: [], purged: [], opened: 0 };
    const need = (q) => {
        if (!queues.has(q)) throw Object.assign(new Error(`NOT_FOUND - no queue '${q}'`), { code: 404 });
        return queues.get(q);
    };
    return {
        queues, log, need,
        put(q, m) { need(q).push(m); },
        publish(q, m) {
            need(q).push(m);
            log.published.push({ queue: q, body: m.body.toString("utf8") });
            if (q === "in") {
                const outs = worker(JSON.parse(m.body.toString("utf8")), m);
                outs.forEach((o, i) => setTimeout(() => need(o.queue).push({ body: Buffer.from(JSON.stringify(o.body)), contentType: o.contentType ?? "application/json", properties: o.properties ?? {} }), 5 * (i + 1)));
            }
        },
    };
}

export function fakeAmqplib(brokerFor, onConnect = () => {}) {
    return {
        async connect(url) {
            onConnect(url);
            const broker = brokerFor(decodeURIComponent(new URL(url).pathname.slice(1)) || "/");
            broker.log.opened++;
            return {
                on() {},
                async close() {},
                async createConfirmChannel() {
                    const handlers = {};
                    const fail = (err) => { handlers.error?.(err); handlers.close?.(); throw err; };
                    return {
                        on(e, f) { handlers[e] = f; },
                        async checkQueue(q) { try { return { messageCount: broker.need(q).length }; } catch (err) { return fail(err); } },
                        async purgeQueue(q) { broker.need(q).length = 0; broker.log.purged.push(q); },
                        sendToQueue(q, body, o) { broker.publish(q, { body, contentType: o.contentType, properties: o.headers }); return true; },
                        async waitForConfirms() {},
                        async get(q) {
                            const m = broker.need(q).shift();
                            return m ? { content: m.body, properties: { contentType: m.contentType, headers: m.properties, messageId: "changes-every-run" } } : false;
                        },
                    };
                },
            };
        },
    };
}

export function fakeServiceBus(brokerFor) {
    return {
        ServiceBusClient: class {
            constructor(connection) {
                this.broker = brokerFor(/UseDevelopmentEmulator=true/i.test(connection) ? "emulator" : /Endpoint=sb:\/\/([^.;/]+)/i.exec(connection)[1]);
                this.broker.log.opened++;
            }
            createReceiver(q, { receiveMode }) {
                const { broker } = this;
                const decode = (m) => { let body = m.body; try { body = JSON.parse(m.body.toString("utf8")); } catch { /* left as bytes, as the real client does */ } return { body, contentType: m.contentType, applicationProperties: m.properties, messageId: "changes-every-run", enqueuedTimeUtc: new Date() }; };
                return {
                    async peekMessages(n) { return broker.need(q).slice(0, n).map(decode); },
                    async receiveMessages(n) {
                        if (receiveMode !== "receiveAndDelete") throw new Error("this stand-in only removes in receiveAndDelete");
                        return broker.need(q).splice(0, n).map(decode);
                    },
                    async close() {},
                };
            }
            createSender(q) {
                const { broker } = this;
                return {
                    async sendMessages(m) { broker.publish(q, { body: m.body, contentType: m.contentType, properties: m.applicationProperties }); },
                    async close() {},
                };
            }
            async close() {}
        },
    };
}
