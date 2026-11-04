# SMS adapter

Tests text messages without sending any to a real phone. It has no dependencies, and it works in one of two ways for each target.

## A local capture

This is the way to test a system. Point the system's SMS provider address at the capture that ships here. It records what would have been sent.

```
node adapters/sms/capture.mjs --port 8026
```

It accepts a POST to any path, written as Twilio's form (`To`, `From`, `Body`) or as JSON (`to`, `from`, `text` or `body`). It listens only on this machine, holds messages in memory only, and ignores credentials.

```yaml
targets:
  legacy:    { base_url: http://localhost:5001, capture_url: http://localhost:8026, allow_numbers: "+15005550006" }
  candidate: { base_url: http://localhost:5002, capture_url: http://localhost:8027, allow_numbers: "+15005550006" }
adapters:
  sms: { command: node, args: [adapters/sms/index.mjs], covers: [sms] }
```

A POST, PUT, PATCH or DELETE case is sent to the system, the adapter waits until messages stop arriving, and it reports only the new ones. A GET, HEAD or OPTIONS case only observes: it doesn't contact the system. `reset` clears the capture.

## Twilio test credentials

This checks how Twilio answers a message. The adapter sends the case's message itself, and reports what Twilio did with it.

```yaml
targets:
  legacy: { twilio_api: https://api.twilio.com, twilio_sid_env: TWILIO_TEST_SID, twilio_token_env: TWILIO_TEST_TOKEN, allow_numbers: "+15005550006,+15005550009" }
```

```yaml
- id: SMS-REJECTED
  surface: sms
  request: { method: POST, path: /messages, body: { to: "+15005550009", text: "Hello" } }
```

It doesn't observe your system, and it doesn't read messages back. A GET case is an error here, because an empty answer would read as a match. If your system uses its own Twilio test credentials, point it at the capture instead to see what it sends.

## What it reports

```json
{ "status": 202, "effects": { "messages": [{ "to": "+15005550006", "from": "+15005550006", "text": "Your code is <code>" }] } }
```

- Message ids and times are left out, and messages are sorted.
- **One-time codes are masked:** a code after a word such as "code", "OTP" or "PIN"; four to eight digits standing alone; and a code with a short prefix, such as `G-482913`. A price such as `£1000.50` is left alone. A four-digit number that isn't a code, such as a year, is masked too.
- **Twilio mode** adds `accepted`, and either `state` or Twilio's `error_code`. Twilio's error text is left out.

## Safety

- **`allow_numbers` is required.** With no list, everything is refused.
- **Refused before any network call.** A recipient off the list is refused before the system, the capture or Twilio is contacted. The adapter looks in the body (JSON, form or XML), the form, the query string, the path and the headers, at fields with a name such as `to`, `to_number`, `phone`, `mobile` or `bcc`, and at anything written as an international number, including a key.
- **Every form is made one form first.** `whatsapp:` and `tel:`, numbers joined by commas or semicolons, `00` for `+`, full-width digits and invisible characters are all read as the numbers they hold. Each number must be on the list. In a recipient field, anything with three or more digits that isn't a number on the list is refused, so a form this can't read does not pass.
- **What it can't see in advance.** A system might look the number up itself, and a case can hide a number in a field whose name says nothing, written without a `+`, or in the message text. An ordinary text can't be told apart from an instruction. For the capture, this is caught afterwards: a message to someone off the list makes the case an error. The capture only sees what the system sends to it, so a system that talks to a real provider directly is not protected: point its provider address at the capture.
- **The number isn't printed** in a refusal.
- **Only the capture.** An address that doesn't answer as this capture is refused.
- **Twilio mode takes only Twilio's test numbers,** starting `+1500555`, as sender and as recipient. The recipient must be one plain number on the list: a channel or a joined list is refused, and the adapter builds what it sends from that one number. Twilio's test and live credentials look the same, so this adapter can't tell them apart. The numbers are what keep it safe: no real phone has one.
- **Credentials come only from environment variables,** named in the settings. They go only over https or to this machine, and never appear in what the adapter reports.
- Requests go only to the addresses in the settings. Redirects aren't followed and proxies aren't used.

## Test it

`cmtk adapter check sms --target legacy` runs the conformance kit. Change `SMS-002` in `samples/cases.yaml` to something that makes your system send a text.

`npm test` uses the real capture, and a local stand-in for Twilio written from Twilio's documentation. Twilio mode hasn't yet been run against real test credentials.
