# Adapters: testing what HTTP can't reach

The HTTP adapter (REST, GraphQL, SOAP) is built in. Everything else (queues, Windows services and workers, files and batch jobs, databases, email, SMS, payment sandboxes, desktop apps) is an adapter: a small program in any language that drives one kind of boundary and reports what happened as plain JSON.

## The protocol

The toolkit starts the adapter once per run and writes one JSON request per line to its standard input. The adapter answers each one with one JSON line on standard output. Nothing else may go to standard output; diagnostics go to standard error, which the toolkit passes through to your terminal. An adapter that gives no answer within its `timeout_s` (default 300 seconds) is stopped, and that case is reported as an error.

| Request | Answer |
|---|---|
| `{"op":"describe"}` | `{"name":"mailbox","kinds":["mailbox"],"settings":[]}`. The conformance kit asks for it |
| `{"op":"run","case":{…},"target":{"name":"legacy","base_url":"…"},"headers":{…}}` | An observation (below) |
| `{"op":"reset","target":{…}}` | `{"ok":true}`, once the target is back in its starting state. Called before each case in `cmtk compare`. Any other answer, such as `{"ok":false,"error":"database locked"}`, makes that case an error |

An observation:

```json
{ "status": 200, "headers": {}, "body": "…", "effects": { "emails": [{ "to": "a@example.com", "subject": "Your order" }] } }
```

- **Comparing:** `effects` is compared between systems exactly like a JSON body. It also appears in reports as `effects:$.emails[0].subject`.
- **Errors:** an adapter that cannot run a case answers `{"error":"…"}`.
- **Headers:** the `headers` passed in hold credentials from `headers_from_env`. Use them, but never report them.

## Adding one

1. Run `cmtk adapter new mailbox`. It writes `adapters/mailbox/` with a working Node template, a README and sample cases.
2. Write `run()`, and `reset()` if each case needs a clean start. Some examples:
   - **Mailbox:** read a capture server such as Mailpit, and report each message as sender, sorted recipients, subject, text and links;
   - **Queue:** publish the case's message, then report what reached the output queue;
   - **Worker:** drop the input file, wait until the worker has finished, then report the output folder.
3. Run `cmtk adapter check mailbox`. The conformance kit checks that:
   - it answers `describe` with its name and kinds;
   - each sample case gives an observation;
   - the same case twice gives the same observation;
   - no header value leaks into what the adapter reports.
4. Register it in `cmtk.yaml`, and give its cases `surface: mailbox`:

   ```yaml
   adapters:
     mailbox: { command: node, args: [adapters/mailbox/index.mjs] }
   ```

An adapter can be written in any language, C# included: register its executable as the `command`.

## Rules every adapter keeps

- **Sandboxes only for money and messages.** Refuse live payment keys, such as Stripe's `sk_live_`, and real SMS or email delivery.
- **Report facts, not opinions.** The engine decides what differs and what passes.
- **Leave out what changes on every run,** such as message ids and timestamps, or report it in a field the project can scrub.
- **Never print a secret,** not even in an error.

## Levels

Adapters move through three levels:
- **experimental:** passes the conformance kit;
- **verified:** used on one real project;
- **core:** shipped with the toolkit.
