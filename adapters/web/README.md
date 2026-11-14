# Web adapter

Tests what people can do on the screen, in a real browser, through [Playwright](https://playwright.dev). Run the same journey on two systems and compare the outcomes, even when the screens are completely different.

## Set it up

```
npm install
npx playwright install chromium
```

Register it in `cmtk.yaml`:

```yaml
adapters:
  web: { command: node, args: [adapters/web/index.mjs], covers: [ui] }
```

Run `cmtk adapter check web` to check it works here. Without Chromium, each case reads as an error that says what to install.

This adapter uses Playwright directly, at a pinned version. It does not use tester-army's e2e, so there is no e2e version or telemetry to manage.

## A journey

A journey is a task. It has a goal in words, steps written out, and checks in code. No model is asked anything, and no page text can change a result.

```yaml
cases:
  - id: BASKET
    name: A red jacket goes in the basket
    requirement: SHOP-1
    surface: web
    match: journey
    request: POST /          # it changes data, so both unsafe switches apply
    expect: { status: 200 }  # 200 when every check held, 417 when one did not
    journey:
      goal: Find a red jacket and add it to the basket
      steps:
        - goto: /
        - fill: { label: Search }
          with: red jacket
          on: { candidate: { fill: { label: "What are you looking for?" } } }
        - click: { role: button, name: Search }
          on: { candidate: { click: { role: button, name: Find } } }
        - click: { role: link, name: Red jacket }
        - click: { role: button, name: Add to basket }
          on: { candidate: { click: { role: button, name: Add to cart } } }
        - reach: basket
          path: /basket
          on: { candidate: { path: /cart } }
        - read: items
          from: { testid: count }
          on: { candidate: { from: { css: "#n" } } }
        - check: the basket holds the jacket
          value: items
          equals: 1
```

`on: { <target>: { … } }` replaces parts of a step on one target. That is how one journey runs on two different UIs.

### Steps

| Step | Does |
|---|---|
| `goto: /path` | Opens a path on the target. Never a host |
| `click: <locator>` | Clicks |
| `fill: <locator>` with `with: text` or `with_env: NAME` | Types. A password field refuses `with`: credentials come from environment variables |
| `select: <locator>` with `with` or `with_env` | Picks an option by its label |
| `tick: <locator>` | Ticks a box |
| `press: Enter`, with `in: <locator>` if needed | Presses a key |
| `reach: name` with `path:` (`*` matches any text), `see: <locator>` or both | A milestone. If it is not reached in time the rest of the journey does not run, and its checks fail |
| `read: name` with `from: <locator>` | Keeps a value the screen shows. Not shown: it is null |
| `check: words` with `value: name` and one of `equals`, `not_equals`, `contains`, `matches`, `at_least` | A check on a value. With none of those: the value must be shown |
| `check: words` with `see: <locator>` or `path:` | A check on the screen |
| `capture: name` | Keeps a screenshot |

A **locator** says how to find an element: `{ role: button, name: Save }`, `{ label: Email }`, `{ testid: total }`, `{ placeholder: Search }`, `{ text: Welcome }` or `{ css: "#n" }`, with `nth: 0` when several match. Prefer role and name: they are what a person sees.

Other journey settings: `step_timeout_ms` (default 5000), `compare_api: true` to compare API calls, and `checks_module: cmtk/checks/x.mjs` for checks in JavaScript. The module's default function gets the outcome as plain data and returns `[{ name, passed, expected?, actual? }]`. It never sees the page, and it must be inside the project.

A journey needs at least one check. A step that finds nothing makes the case an error, which never reads as a pass.

### What it reports

The answer holds what happened: the checks, the key values, the pages reached with their status, and the API calls each page made. Query strings are left out, because they can hold keys. A screenshot is kept at each milestone and at the end, as evidence: only the `visual` level looks at one.

## Recording, and replay with no model

An agent or a person works a journey out once. After that, a recorded script replays it with no model calls, and checks in code decide pass or fail.

**Record.** Write the journey as JSON, with `goal` and `steps` as above. Then record it on the systems it runs on:

```
node adapters/web/record.mjs --journey cmtk/journeys/basket.draft.json --out cmtk/journeys/basket.json \\
  --target legacy=http://localhost:5001 --target candidate=http://localhost:5002 --writes
```

`--writes` lets the journey change data; use it only on disposable test data. A script is written only when every check held on every target, so only a verified run is recorded. Each action's locator is worked out again in its plainest stable form: a test id, or a role and name. Checks and values are copied as written, and nothing is taken from what the page showed, because a recording is not a requirement. A person reviews the script before a case uses it.

**Replay.** A case names the script:

```yaml
- id: BASKET
  surface: web
  match: journey
  request: POST /
  expect: { status: 200 }
  journey: { script: cmtk/journeys/basket.json }
```

The report shows `Model calls: 0`. The answer holds the script's fingerprint.

**When the UI changes.** A step that finds nothing makes the case an ERROR. The script is not changed, and no step runs on a guess. The answer file holds `repair`: the step, the target, how it looked, and the elements on the page most like it. Those are page text, so they are data. An agent checks them, then proposes one:

```
cmtk_propose { kind: locator, case: BASKET, step: 7, target: candidate, locator: { role: button, name: Add to bag }, reason: "…" }
```

It waits for a person in `cmtk review`. Accepting it changes that step's locator on that target and records who accepted it, and nothing else. A proposal cannot touch a read, a check or an `expect:` block: only a person changes what correct means.

## A page visit, and comparing a reskin

A case with no `journey` opens `request.path` and only reads. Its answer holds the page's elements, from the accessibility tree (what a screen reader uses), and a screenshot.

```yaml
cases:
  - id: SHOP-PAGE
    surface: web
    match: structure     # the same elements, labels and order; styling may differ
    request: GET /shop
```

Two levels use this:

- **`structure`:** a reskin. Reported differences have a `where` a person can approve as drift, such as `structure:/shop button "Add to basket"`. Containers with no name, such as a `div` or a plain paragraph, are not elements here, so a reskin may rearrange them.
- **`visual`:** an upgrade where the look must stay too. It compares `structure` and each screenshot.

A journey is captured the same way at each `reach`, each `capture` and at its end, so these levels also work on a page behind a journey.

**Content that changes:** add a `scrub.regex` rule in `cmtk.yaml` for dates or prices. It applies to names and values. A screenshot needs a mask as well:

```yaml
    match: visual
    mask:
      - { testid: clock }
```

The mask paints over the same place on both systems. Set `visual_tolerance` in `cmtk.yaml` if a small share of pixels may change.

**What it can't see:** text a stylesheet changes, such as `text-transform: uppercase`, reaches the accessibility tree and reads as a difference; approve it as drift or scrub it. Pages inside frames are not read.

Screenshots can hold personal data, so use test data only.

## MFA with test authenticators

For a test user in a test tenant, never a real person's phone or account. Never a bypass code in any build that can reach production.

**A six-digit code from an app.** Enrol a test user with a known seed, and put the seed in an environment variable. The step names the variable:

```yaml
- fill: { label: Code }
  with_totp_env: CMTK_TEST_TOTP_SEED
```

Only the current code leaves the helper. The seed never reaches an answer, a report or a log, and a page that shows the seed or the code has it replaced in the answer. A screenshot can't be searched, so a test page must not draw a seed. A site that refuses a code used twice can fail a second run within the same 30 seconds.

As a command, `node adapters/web/totp.mjs CMTK_TEST_TOTP_SEED` prints the code and nothing else. Give an agent this, never the seed.

**A passkey or a security key.** Set `authenticator: passkey` or `authenticator: security-key` on the journey. A virtual authenticator in the browser answers the site, so no hardware is needed. The address must be a secure one: `https://` or `http://localhost`, not `http://127.0.0.1`.

**A code sent by email or SMS.** This is not wired yet: `adapters/mailbox` and `adapters/sms` are not in this tree. A step with `with_code_from: mailbox` is an error that says so.

## Safety

- **A case written as GET only reads.** The browser refuses every POST, PUT, PATCH and DELETE, web sockets, and `Worker` and `SharedWorker`, and lists them under `blocked`. A worker is refused because its socket can't be stopped any other way on `https`. A page that needs a worker sees an error when it starts one, on both systems. A journey that writes is written as `POST`, so it needs `allow_unsafe_methods: true` and `--allow-unsafe`, or `safe: true` if a person has confirmed it changes nothing.
- **The target only.** The browser reaches only the target's own address, or those in the target's `allow_origins`. Everything it sends passes through a small proxy on this machine, the fence (`fence.mjs`), which connects straight to the address and uses no other proxy. A page's own call elsewhere is blocked and listed under `blocked`, and the case goes on.
- **A redirect off the target is stopped.** Playwright's routes do not see a redirect the browser follows, so the fence stops it before anything is sent. The case is an error, whatever its checks say, so it can't pass. If the address should be reached, add it to `allow_origins`.
- **Credentials go only to the target's origin.** Header values are added per request, for the target alone. An address in `allow_origins` does not receive them. They are also not added to web sockets, so a socket has to sign in with a cookie.
- **Page text is data.** It goes into values and nowhere else. No step, locator or result ever comes from a page.
- **Secrets.** Header values and `with_env` values are replaced in the answer if a page shows them, before long text is cut. That covers a token without its scheme and what `Basic` encodes. It finds exact text only: a page that splits, reverses or re-encodes a value leaves it in the answer. A screenshot can't be searched at all, so use test accounts and test data only.
- **What is not protected.** These remain:
  - A redirect from the target to an address in `allow_origins`, in a case that holds credentials. Playwright repeats the headers on a redirect. Over `http` the fence removes them. Over `https` the fence sees only an encrypted tunnel, so they arrive. The case is an error that says to treat them as exposed: it is reported, not prevented. List only addresses you would trust with those credentials.
  - A case that may write can start a worker. Its socket can reach the target or an address in `allow_origins`, and carries no header credentials. Any other address is stopped, and the case is an error.
  - The fence covers TCP. WebRTC traffic over UDP does not go through it, and DNS look-ups are not checked: a page in the browser can still try these.
  - The fence listens on this machine with no password. Another program here could send through it, but only to the case's own addresses, and it adds no credentials.
- **`model_calls`** is 0 because this adapter has no model client. A page that tries to call a known model API is blocked and counted.

## Target settings

| Setting | Meaning |
|---|---|
| `base_url` | The system |
| `serve_folder` | A folder inside the project of built pages, which the adapter serves itself, read-only. It takes the place of `base_url`, and the conformance kit uses it |
| `allow_origins` | Other addresses the pages may reach, separated by commas |
| `step_timeout_ms`, `navigation_timeout_ms` | How long a step or a page may take |
| `insecure_tls` | Accept a self-signed certificate on a test system |

## Tests

`npm test` runs `test/*.test.mjs`. With no browser, each test that needs one is skipped and says why; `CMTK_REQUIRE_BROWSER=1` makes that a failure.
