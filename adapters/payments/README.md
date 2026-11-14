# Payments adapter

Tests payments with no real money. Each system uses its own Stripe account in test mode. This adapter reports the payments, charges and refunds a case caused, and how the system handled Stripe's webhooks. It has no dependencies.

## Set it up

```yaml
targets:
  legacy:    { base_url: http://localhost:5001, stripe_api: https://api.stripe.com, key_env: LEGACY_STRIPE_KEY, webhook_secret_env: LEGACY_WEBHOOK_SECRET }
  candidate: { base_url: http://localhost:5002, stripe_api: https://api.stripe.com, key_env: CANDIDATE_STRIPE_KEY, webhook_secret_env: CANDIDATE_WEBHOOK_SECRET }
adapters:
  payments: { command: node, args: [adapters/payments/index.mjs], covers: [payments] }
```

| Setting | What it is |
|---|---|
| `stripe_api` | Stripe's address. Required: the adapter reaches only addresses in its settings |
| `key_env` | The name of the environment variable holding this system's test-mode key. Required |
| `base_url` | The system. POST, PUT, PATCH and DELETE cases and webhooks are sent here |
| `webhook_secret_env` | The name of the environment variable holding the secret the system checks webhooks with |
| `window_s` | How far back the account is read, in seconds. Default 3600 |
| `quiet_ms` | The account has settled when nothing changed for this long. Default 1000 |
| `max_wait_ms` | Still changing after this long is an error. Default 15000 |

## What a case does

A POST, PUT, PATCH or DELETE case notes what the account holds, sends the case's request to the system, waits for the account to settle, and reports only the new objects. A GET, HEAD or OPTIONS case only observes: it doesn't contact the system, and it reports everything in the window.

Stripe has no way to empty an account, so `reset` does nothing but check the key.

## Test cards

Write a card by name anywhere in a case's body or form. `test-card:visa` becomes the PaymentMethod to use from a server (`pm_card_visa`). `test-card-number:visa` becomes the number, for a system with a card form.

| Name | Number | What it does |
|---|---|---|
| `visa`, `mastercard`, `amex` | 4242424242424242, 5555555555554444, 378282246310005 | Succeeds |
| `declined` | 4000000000000002 | Declined |
| `insufficient_funds` | 4000000000009995 | Declined for insufficient funds |
| `3ds_required` | 4000000000003220 | 3-D Secure challenge |
| `3ds_always` | 4000002760003184 | 3-D Secure challenge on every payment |
| `3ds_on_setup` | 4000002500003155 | 3-D Secure challenge unless set up for later use |

## Webhooks

A case with `webhook` sends the event to the case's path, signed as Stripe signs them. `deliveries: 2` sends the same event id twice: the duplicate a system must expect.

```yaml
- id: PAY-DUPLICATE
  surface: payments
  webhook: { type: payment_intent.succeeded, object: { amount: 1999, currency: gbp }, deliveries: 2 }
  webhook_observe: /orders/count
  request: { method: POST, path: /stripe/webhook }
```

- `webhook_observe` is a path read from the system after each delivery. A system that answers 200 to both deliveries but fulfils the order twice is only caught this way.
- `webhook` can be a list of events.
- `signature: wrong` on an event sends a bad signature, to compare how each system refuses it.
- These events are made by the adapter, not sent by Stripe.

## What it reports

```json
{ "status": 200, "effects": {
  "payment_intents": [{ "amount": 1999, "amount_received": 1999, "currency": "gbp", "status": "succeeded", "capture_method": "automatic", "error_code": null, "metadata": { "order": "A1" } }],
  "charges": [{ "amount": 1999, "amount_captured": 1999, "amount_refunded": 0, "currency": "gbp", "status": "succeeded", "captured": true, "refunded": false, "failure_code": null, "metadata": { "order": "A1" } }],
  "refunds": [],
  "webhooks": [{ "type": "payment_intent.succeeded", "delivery": 1, "status": 200, "observed": { "status": 200, "body": { "count": 1 } } }]
} }
```

Amounts are minor units (pence or cents); anything else is an error. Ids and times are left out, and objects are sorted. Metadata is reported as it is, so scrub any id your system puts in it.

## Safety

- **Only a test-mode key passes.** Stripe's live and test traffic share one address, so the key decides. Anything but `sk_test_` or `rk_test_` is refused before any network call: live keys and anything else.
- **A live key anywhere stops the case:** in a header or a case, too.
- **Keys come only from environment variables.** A key written in `cmtk.yaml` or a case is refused.
- **No part of a key is ever printed,** even in an error. Stripe's own error text can quote part of one, so only its status and type are reported.
- **An object Stripe marks as live stops the run.**
- A key goes only over https or to this machine. Redirects aren't followed and proxies aren't used. Requests go only to the addresses in the settings.
- More than 10,000 objects in the window is an error rather than a partial answer.

## Test it

`npm test` runs against a local stand-in for Stripe's API, so CI needs no key.

`cmtk adapter check payments --target legacy` runs the conformance kit. Change the paths and bodies in `samples/cases.yaml` to what your system does.

**Still to do by a person:** one run against a real test-mode account. It hasn't been done. Set the variables, run `cmtk adapter check payments --target legacy`, then `cmtk compare --allow-unsafe`, and check in Stripe's dashboard that the test cards behave as the table above says.
