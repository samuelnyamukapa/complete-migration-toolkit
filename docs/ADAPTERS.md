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
- **Errors:** an adapter that cannot run a case answers `{"error":"…"}`. A case arrives as written in its file, with `body_file`, `body_form`, `files` or `before` when it has them; the built-in HTTP adapter handles all four, and an adapter that does not support one should answer an error naming it rather than send the request without it.
- **Headers:** the `headers` passed in hold credentials from `headers_from_env`. Use them, but never report them.
- **Target settings:** `target` holds everything set for that target in `cmtk.yaml`, so a target that has no web address can say what the adapter needs instead, such as `{ queue: orders-in }` or `{ probe: probes/legacy.exe }`.

## Adding one

1. Run `cmtk adapter new mailbox`. It writes `adapters/mailbox/` with a working Node template, a README and sample cases. For C#, see [below](#c).
2. Write `run()`, and `reset()` if each case needs a clean start. Some examples:
   - **Mailbox:** read a capture server such as Mailpit, and report each message as sender, sorted recipients, subject, text and links;
   - **Queue:** publish the case's message, then report what reached the output queue;
   - **Worker:** drop the input file, wait until the worker has finished, then report the output folder.
3. Run `cmtk adapter check mailbox`. The conformance kit checks that:
   - it answers `describe` with its name and kinds;
   - each sample case gives an observation;
   - the same case twice gives the same observation;
   - no header value leaks into what the adapter reports.

   It uses a dummy target. An adapter that needs settings from its target, such as folders, gives them in `samples/cases.yaml` under `check_target:`.
4. Register it in `cmtk.yaml`, and give its cases `surface: mailbox`:

   ```yaml
   adapters:
     mailbox: { command: node, args: [adapters/mailbox/index.mjs], covers: [email] }
   ```

   A target can list the surfaces it offers, such as `surfaces: [http, mailbox]`. See [One manifest or two](MANIFEST.md#one-manifest-or-two).

   `covers` lists the kinds of boundary the adapter checks, so `cmtk discover` stops flagging them as uncovered. The kinds are `http`, `soap`, `outbound-http`, `database`, `files`, `email`, `sms`, `queue`, `payments`, `worker`, `ui` and `logs`.

An adapter can be written in any language: register its executable as the `command`.

## C#

`cmtk adapter new mailbox --lang csharp` writes a small .NET 8 console project with no packages.

1. Write `Run()` in `Adapter.cs`, and `Reset()` if each case needs a clean start. `Program.cs` speaks the protocol, so you should not need to change it.
2. Build it, then run the kit. The kit uses the build, and refuses one older than the code:

   ```
   dotnet build -c Release adapters/mailbox
   cmtk adapter check mailbox
   ```

3. Register the built program:

   ```yaml
   adapters:
     mailbox: { command: dotnet, args: [adapters/mailbox/bin/Release/net8.0/mailbox.dll], covers: [email] }
   ```

   Or use `dotnet run`, with `--no-build`, because a build writes to standard output. The README in the project shows how.

Three things keep it safe. `Console.WriteLine` goes to standard error, so a stray line cannot break the protocol. A reply that holds a header value is not sent: the case gets an error that names the header and not its value. Standard error hides those values too. It can only spot the exact value, so do not encode a header and report it.

[adapters/worker](../adapters/worker/README.md) is a full example, for a Windows service or a .NET worker.

## Rules every adapter keeps

- **Sandboxes only for money and messages.** Refuse live payment keys, such as Stripe's `sk_live_`, and real SMS or email delivery.
- **GET, HEAD and OPTIONS only read.** Exploration sessions send these methods to adapters too, and promise people that nothing changes. An adapter must only observe for them.
- **Report facts, not opinions.** The engine decides what differs and what passes.
- **Leave out what changes on every run,** such as message ids and timestamps, or report it in a field the project can scrub.
- **Never print a secret,** not even in an error.

## Levels

Adapters move through three levels:
- **experimental:** passes the conformance kit;
- **verified:** used on one real project;
- **core:** shipped with the toolkit.
