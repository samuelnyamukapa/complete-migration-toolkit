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

The answer holds what happened: the checks, the key values, the pages reached with their status, and the API calls each page made. Query strings are left out, because they can hold keys. A screenshot is kept at each milestone and at the end, as evidence: the `journey` level never looks at one.

## A page visit

A case with no `journey` opens `request.path` and reports the page.

## Safety

- **A case written as GET only reads.** The browser refuses every POST, PUT, PATCH and DELETE, and web sockets, and lists them under `blocked`. A journey that writes is written as `POST`, so it needs `allow_unsafe_methods: true` and `--allow-unsafe`, or `safe: true` if a person has confirmed it changes nothing.
- **The target only.** The browser reaches only the target's own address, or those in the target's `allow_origins`, and uses no proxy. Anything else is blocked and listed.
- **Page text is data.** It goes into values and nowhere else. No step, locator or result ever comes from a page.
- **Secrets.** Header values and `with_env` values are replaced in the answer if a page shows them. A screenshot can't be searched, so use test accounts and test data only.
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
