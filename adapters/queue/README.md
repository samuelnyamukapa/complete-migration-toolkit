# Queue adapter

Publishes a case's message to a system's input queue, waits until its output queues are quiet, and reports what arrived. One adapter, with a driver for RabbitMQ and one for Azure Service Bus.

## Setting up

A driver is loaded only when a target asks for it. Install the one you need; if it is missing, the case's error names the command.

```
npm install --no-save amqplib@2.2.1            # RabbitMQ
npm install --no-save @azure/service-bus@7.10.0   # Azure Service Bus
```

Target settings in `cmtk.yaml` can only hold text, numbers and true/false, so lists can go in a JSON file, by target name, with `*` for all targets. See `samples/settings.example.json`.

```yaml
targets:
  legacy:    { driver: rabbitmq, connection_env: CMTK_QUEUE_LEGACY }
  candidate: { driver: rabbitmq, connection_env: CMTK_QUEUE_CANDIDATE }
allow_unsafe_methods: true   # publishing changes state
adapters:
  queue: { command: node, args: [adapters/queue/index.mjs, --settings, queue-settings.json], covers: [queue] }
```

| Setting | What it does |
|---|---|
| `driver` | `rabbitmq` or `servicebus` |
| `connection_env` | The environment variable that holds the connection string. A connection string in settings is refused |
| `input_queue` | Where a case's message goes |
| `output_queues` | What to read: a list, comma-separated text, or a map of report name to queue, so two systems with different queue names report alike |
| `properties` | Message properties to report. Anything else is left out, message ids and times included |
| `quiet_ms` | Output is quiet after this long with no new message. Default 1000. Make it longer than the slowest system takes to start answering, or an empty output will look like the answer |
| `limit_ms` | The longest to wait. Default 30000 |
| `max_messages` | The most to read. Default 1000 |
| `order_matters` | `false` compares messages as a set, keeping duplicates. A case can also say `order_matters: false` |
| `test_namespace` | Names one exact namespace or virtual host as a test one, when its name does not say so |

## A case

```yaml
- id: ORDER-1
  surface: queue
  order_matters: false            # optional
  properties: { tenant: t1 }      # optional, sent with the message
  request: { method: POST, path: /orders, body: { id: ORD-1, total: 10 } }
```

- **POST** publishes. It only runs with `allow_unsafe_methods: true` in `cmtk.yaml` and `--allow-unsafe` on the run. `safe: true` is refused, because publishing is never safe.
- **GET, HEAD and OPTIONS** only read how many messages wait, and take none. On Service Bus this counts by peeking, up to 1000.
- **PUT, PATCH and DELETE** are refused.

The observation is `effects.outputs`, by queue, each message with its body (as JSON when it is JSON), content type and named properties.

## Safety

- **Test namespaces only.** A namespace or virtual host must have a word like `test`, `qa`, `uat`, `sandbox`, `dev`, `ci` or `cmtk` in its name, and hold no `prod`, unless `test_namespace` names it exactly. RabbitMQ's default `/` does not pass. This is checked before a driver is loaded.
- **A production marker is never test.** A word like `prod`, `prod2`, `production`, `prd` or `live` in the name or in the host is refused, and `test_namespace` does not change that. So `amqps://broker.prod.acme.com/test` is refused. Service Bus's `UseDevelopmentEmulator=true` counts only on `localhost`, `127.0.0.1` or `[::1]`. `prod` inside a longer word, as in `products_test`, is not a marker, so a person can name that one.
- **What this can't see.** It reads names only. A production broker with a plain name, such as `broker.acme.com/orders-test`, passes. An address that resolves to production, or a test name on a production host, is not found. Use credentials that reach only test systems.
- **Secrets.** Connection strings come from the environment and are removed from every reply.
- **Emptying queues.** The issue asked `reset` to empty the queues. `cmtk compare` calls `reset` before read-only cases too, and does not say which case comes next, so `reset` only checks the target. The queues are emptied just before a publish instead. `cmtk run`, which never calls `reset`, gets the same clean start.
- **Partial output is an error.** Hitting `limit_ms` or `max_messages` makes the case an error, with what was read kept in the evidence, so it cannot count as a match.
- **The conformance kit has no switches,** so it may not publish unless the `check` target sets `kit_may_publish: true`. The shipped sample only reads. Give the `check` target its settings in the settings file.

## Not covered

Queues only: no topics, subscriptions or exchanges yet. Queues are never created. How it behaves on a real broker is proved only by `test/real-server.test.mjs`, which is skipped unless its environment variables are set. See below. The other tests use an in-memory stand-in behind the same client calls.

## Tests

`npm test` runs `test/queue.test.mjs`, on the local machine only. For a real broker, `npm install --no-save amqplib@2.2.1 @azure/service-bus@7.10.0`, set `CMTK_TEST_RABBITMQ_URL` (image `rabbitmq:3`, with `RABBITMQ_DEFAULT_VHOST=cmtk-test`) or `CMTK_TEST_SERVICEBUS_CONNECTION` and `CMTK_TEST_SERVICEBUS_QUEUE`, and run `test/real-server.test.mjs`.
