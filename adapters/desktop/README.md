# Desktop adapter

Runs a recorded script against a desktop app and reports what the screens showed: window titles, fields and values. On Windows they are read through Windows UI Automation, the description of the screen that assistive tools use. The script's checks decide pass or fail, and the run makes no model calls.

An agent works a journey out once, with `/cmtk:desktop`, and a person reviews the script. After that, no agent is involved.

## Status

**Experimental.** It passes the conformance kit. The script runner and the comparison are tested on any system against a stub app. The PowerShell reader, `uia.ps1`, has a test that runs only on Windows with a desktop session (`CMTK_DESKTOP_TEST=1`). **No real desktop journey has run yet.**

## Set it up

```yaml
targets:
  legacy:    { app: C:/apps/orders-old/orders.exe, isolated_vm: true }
  candidate: { app: C:/apps/orders-new/orders.exe, isolated_vm: true }
adapters:
  desktop: { command: node, args: [adapters/desktop/index.mjs], covers: [ui] }
```

A case:

```yaml
- id: ORDER
  surface: desktop
  match: journey
  request: POST /order       # a path is required; this one only names the journey. POST: it presses and fills
  expect: { status: 200 }    # 200 when every check held, 417 when one did not
  journey: { script: cmtk/journeys/order.json }
```

## A script

A JSON file: `{ "cmtk_script": 1, "goal": "…", "steps": […] }`. [samples/order.json](samples/order.json) is a full one.

| Step | Does |
|---|---|
| `invoke: <locator>` | Presses a button |
| `set_value: <locator>` with `with: text` or `with_env: NAME` | Fills a field. A password field refuses `with`: credentials come from environment variables |
| `reach: name` with `window: "Order*"` | A milestone: the window's title. If it is not reached in time, the rest does not run and its checks fail |
| `read: name` with `from: <locator>` | Keeps a value the window shows. A password field's value is never read |
| `check: words` with `value: name`, and `equals`, `contains` or `matches` | A check. With none of those: the value must be shown |
| `capture: name` | Keeps the window's elements, for the `structure` level |

A **locator** is `{ automation_id: place }`, or `{ name: "Place order", role: button }`. `on: { <target>: { … } }` replaces parts of a step on one target, as in the [web adapter](../web/README.md).

A step that finds nothing makes the case an ERROR, with `repair` in the answer file. An agent proposes a repair with `cmtk_propose` (`kind: locator`), and only a person accepts it in `cmtk review`. It cannot touch a read, a check or an `expect:` block.

## Safety

- **An isolated machine.** The real reader refuses a target without `isolated_vm: true`. Setting it is your statement that this runs inside a virtual machine that can reach only allowed addresses: the adapter can't check that, and it does not build the machine.
- **Leaving the sandbox.** A step marked `leaves_sandbox: true` needs `approved_by` with a person's name, and never an agent's. Marking the step is the author's job; the machine's network rules are what stop one that wasn't marked.
- **A case written as GET only reads.** A script with `invoke` or `set_value` is refused before the app starts, unless the case is written as POST (both unsafe switches apply) or marked `safe: true` by a person.
- **Screen text is data.** It goes into values and nothing else.
- **Secrets.** A credential is filled in from an environment variable by name, and is never in a script, an answer or a prompt.

## The stub

A target with `stub_app: file.json` plays a small app written as JSON instead of starting one, on any system. See [samples/app-v1.json](samples/app-v1.json). The answer says `reader: stub`. A stub proves the script runner and the comparison, and says nothing about a real app, so it is never evidence for a pilot. On a system with no Windows UI Automation and no `stub_app`, a case is an error that says so.

`uia_host` runs a stand-in for `uia.ps1`, for tests.

## Tests

`npm test` runs `test/*.test.mjs`. The conformance kit and the comparison of two versions use the stub. To run the real reader, on Windows with a desktop session: `CMTK_DESKTOP_TEST=1 node --test adapters/desktop/test/desktop.test.mjs`.
