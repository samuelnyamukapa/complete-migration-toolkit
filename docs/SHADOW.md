# Shadow traffic

Recorded cases only prove what was recorded. `cmtk shadow` replays real or production-like read-only requests to both systems, to find the differences nobody thought to test.

It reads a file you already have: an access log, or a file your gateway mirrors requests to. It is not a proxy, and it never sits in the path of live traffic.

## Before you start

- **Test or production-like systems by default.** Replay against production only where the client agrees in writing. cmtk cannot tell a production address from any other, so this check is yours.
- **Recordings stay in the client's environment.** There is no MCP tool for shadow traffic, so an agent cannot start a replay or read a recording through the toolkit. Do not paste a capture or a shadow report into a chat with a model.
- **A GET can still change data on a badly built system,** such as `GET /logout` or `GET /cart/add?id=1`. cmtk cannot see that. Read the capture, and use `--exclude` for those paths.

## Run it

```sh
cmtk shadow --from access.log --capture-only      # write the clean requests, send nothing
cmtk shadow --from access.log --sample 0.1 --rate 5
```

Start with `--capture-only`, and read `capture.jsonl`. Then replay.

| Option | Default | Meaning |
|---|---|---|
| `--from <file>` | (required) | A log or a mirror file. Give it more than once for several files. The file is only read, and only its name is recorded |
| `--format` | `auto` | `clf` (Apache or nginx access log), `w3c` (IIS, from its `#Fields` line), `jsonl` (one JSON object per line) |
| `--sample <share>` | `1` | The share of requests to replay, such as `0.1` |
| `--seed <n>` | `1` | The same seed and the same file choose the same requests |
| `--rate <n>` | `5` | Requests a second to each system. Requests go one at a time, so neither system sees more than this |
| `--max <n>` | `1000` | The most requests in one replay. The report counts the rest |
| `--include`, `--exclude` | | Regular expressions on the cleaned path |
| `--keep-header <name>` | | A header to keep besides `Accept` and `Accept-Language`. A credential header is refused |
| `--redact <regex>` | | A value of your own to redact, such as a customer number. Give it more than once if needed |
| `--keep-values` | off | Store differing values, redacted. For test data only (below) |
| `--capture-only` | off | Write the capture and send nothing |

A `jsonl` line needs a method and a target, under common names: `method` or `request_method`, and `url`, `uri`, `request_uri` or `path`. `{"request":"GET /x HTTP/1.1"}` also works. `headers` and `body` are read if they are there.

## What is sent, and what is not

**Only GET, HEAD and OPTIONS are sent.** Everything else is dropped and counted by method. These are dropped too, because they could change data:

- a GET, HEAD or OPTIONS with a body;
- a request that overrides its method, with a header such as `X-HTTP-Method-Override: DELETE` or a query value such as `_method=DELETE`.

There is no switch to send anything else. `allow_unsafe_methods` and `--allow-unsafe` do nothing here.

A host in the log never decides where a request goes: only the path is kept, and requests go to the `reference` and `candidate` in `cmtk.yaml`. Redirects are compared, not followed.

## What is cleaned, before anything is stored

Each line is cleaned first. The clean request goes into `capture.jsonl`, and only what that file holds is ever sent.

- **Who and when:** client address, user name, time, referrer and user agent are never read.
- **Headers:** only `Accept`, `Accept-Language` and any you keep with `--keep-header`. Cookies, authorization and key headers are stripped and counted. A replay's credentials come only from `headers_from_env`.
- **Credentials in a URL:** query values and path parameters with a credential-like name, such as `token` or `jsessionid`, become `REDACTED`.
- **Personal data in a URL:** query values with a personal name, such as `email` or `surname`, become `REDACTED`. So does anything shaped like an email address, a card number, a phone number, a UK National Insurance number, a US social security number, a bank account, a UK postcode, an IP address or a long token, anywhere in the path or query.

A request with something redacted sends `REDACTED` to both systems. Both should answer it the same way.

A line cmtk cannot read is counted, and never shown, because it can hold anything.

**The limit:** cmtk spots personal data by its name or its shape. A segment after a collection of people, such as `/customers/smith`, is replaced, but a surname anywhere else, such as `/orders/smith/invoice`, has neither. That is why you read the capture first, and use `--redact` for values you know about.

## The answers

Answers are not kept: they can hold personal data. A report says where two answers differ, and how often. It shows the status and the content type. Every other value is withheld, and the report says what it looks like, such as `(withheld: a GUID)` or `(withheld: 24 characters)`.

`--keep-values` stores the values, with anything personal redacted by name or shape. A name in free text has neither, so use it on test data only.

## The report

`cmtk/evidence/shadow/` holds `REPORT.md`, `REPORT.json` and `capture.jsonl`. The report lists:

- what was read, dropped, filtered, sampled, redacted and sent;
- each endpoint, with its unexplained differences. Numbers, GUIDs and redacted values in a path become `{id}`, so `GET /api/orders/7` and `GET /api/orders/8` are one endpoint;
- where each endpoint differs, and the first request that showed it;
- values that look like noise, and drift entries that matched nothing.

Scrubs, match levels, `compare_headers` and the drift ledger all work as they do for `cmtk compare`. A drift entry applies when its `case` is `*`, or an endpoint such as `shadow:GET /api/orders/{id}`.

| Verdict | Means | Exit code |
|---|---|---|
| UNEXPLAINED DIFFERENCES | At least one request answered differently, and no approved drift explains it | 1 |
| INCOMPLETE | A request could not be compared, an answer was over 5 MB, or a system stopped answering and the rest were not sent | 2 |
| NO EVIDENCE | Nothing could be replayed. Also the verdict with `--capture-only`, which exits 0 because you asked for that | 2 |
| NO UNEXPLAINED DIFFERENCES | Every request matched, or differed only by approved drift | 4 |

**A clean replay never reads as parity, and it exits 4.** It covers a sample of read-only traffic, and says nothing about requests that change data. A pipeline that accepts it says so.

There is no sign-off for a shadow report. It is evidence for the pilot's write-up. What a pilot agrees is the period of traffic, and it ends with zero unexplained differences.
