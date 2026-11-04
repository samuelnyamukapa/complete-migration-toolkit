# Mailbox adapter

Tests the emails a system sends, without sending real email. Each system sends to its own capture server: Mailpit or MailHog, a local mail server that keeps every message. This adapter reports what arrived. It has no dependencies.

## Set it up

```yaml
targets:
  legacy:    { base_url: http://localhost:5001, capture_url: http://localhost:8025 }
  candidate: { base_url: http://localhost:5002, capture_url: http://localhost:8026 }
adapters:
  mailbox: { command: node, args: [adapters/mailbox/index.mjs], covers: [email] }
```

| Setting | What it is |
|---|---|
| `capture_url` | The capture server's API for this target. Required |
| `base_url` | The system. POST, PUT, PATCH and DELETE cases are sent here |
| `quiet_ms` | Mail has stopped when nothing new came for this long. Default 1000. Set it longer than your system's slowest email |
| `max_wait_ms` | Mail still arriving after this long is an error. Default 15000 |

## What a case does

A case with `surface: mailbox` and POST, PUT, PATCH or DELETE:

1. notes what the mailbox already holds;
2. sends the case's request to the system, if `allow_unsafe_methods` and `--allow-unsafe` both allow it;
3. waits until mail stops arriving;
4. reports only the new messages, plus the status the system answered.

A GET, HEAD or OPTIONS case only observes. It doesn't contact the system, and it reports what the mailbox holds now. Reading a message does mark it as read in Mailpit; no report depends on that.

`reset` empties the mailbox. `cmtk compare` calls it before each case that sends mail. A GET compares what each mailbox holds now, and empties nothing.

A case can't use `body_file`, `files`, `before`, or a `body_form` held in a file. The adapter answers an error naming the one it was given.

## What it reports

```json
{ "status": 202, "effects": { "emails": [{
  "from": "Shop <shop@example.test>",
  "to": ["ann@example.test", "zed@example.test"], "cc": [], "bcc": [],
  "subject": "Your order",
  "text": "Track it: https://shop.example.test/track/<masked>?lang=en&token=<masked>",
  "links": ["https://shop.example.test/track/<masked>?lang=en&token=<masked>"],
  "attachments": [{ "name": "receipt.pdf", "type": "application/pdf", "sha256": "…" }]
}] } }
```

- Recipients and messages are sorted, so arrival order doesn't matter.
- Message ids and dates are left out.
- In links, a value is masked if its name looks secret (`token`, `code`, `key`, `sig` and so on) or the value looks generated (a UUID, long hex, or a long mix of letters and digits).
- Links come from the text and from the `href`s in the HTML. The HTML itself isn't reported.
- An address that differs between systems, such as the host in a link, can be scrubbed with `scrub:` in `cmtk.yaml`.

## Safety

At first use of each address, the adapter checks that it answers as a capture server, and refuses to run if not. The case is not sent to the system.

- **Mailpit:** `/api/v1/info` must give its version, database, message count and runtime stats.
- **MailHog:** it has no call that says what it is, so `/api/v2/messages` must have MailHog's shape and its web page must name MailHog.

Requests go only to the addresses in the settings. Redirects aren't followed, proxies aren't used, and a path can't name a host. More than 10,000 messages in the mailbox is an error rather than a partial answer.

## Test it

`cmtk adapter check mailbox --target legacy` runs the conformance kit against that target's capture server. Change the path and body of `MAIL-002` in `samples/cases.yaml` to something that makes your system send an email.

`npm test` runs against local stand-ins written from each server's API documentation. `test/real-server.test.mjs` runs against a real server when `CMTK_TEST_CAPTURE_URL` and `CMTK_TEST_CAPTURE_SMTP` are set, and is skipped otherwise. It empties that server.
