# Exploration session X20261019-213230

- Charter: try to break catalog paging, item details and item pictures with odd values
- Target: candidate (http)
- Started: 2026-10-19T21:32:30.458Z; ended: 2026-10-19T21:33:38.585Z
- Requests: 12 of a budget of 30; time budget 30 minutes
- Findings: EXP-20261019213230-01, EXP-20261019213230-02, EXP-20261019213230-03 (draft cases; a person accepts or rejects each with `cmtk review`)

## Plan

Paging ~12 requests (fractional, text, empty, repeated, huge ints, int overflow, case of params). Details ~8 (overflow ids, fractional, trailing slash, case, encoded chars). Pictures ~5 (overflow, fractional, trailing slash, case). ~5 kept for follow-up.

## Summary

12 of 30 requests used. Paging with text, fractional, overflow values; details with overflow, fractional, negative, trailing slash and repeated id; pictures with overflow, fractional and trailing slash. No 500s. Found leaking error pages (physical path, stack trace) and silent fallback on odd paging values.

## Not covered

Empty and repeated paging parameters, negative-extreme pageSize, letter case of paths and parameters, encoded characters in ids, Accept header variations. Stopped early because the findings repeated.

## Requests

| # | Request | Answer |
| --- | --- | --- |
| 1 | `GET /Catalog/Index?pageSize=abc&pageIndex=0` | 200 |
| 2 | `GET /Catalog/Index?pageSize=2.5&pageIndex=0` | 200 |
| 3 | `GET /Catalog/Index?pageSize=2147483648&pageIndex=0` | 200 |
| 4 | `GET /Catalog/Index?pageSize=10&pageIndex=2147483647` | 200 |
| 5 | `GET /Catalog/Details/2147483648` | 400 |
| 6 | `GET /Catalog/Details/1.5` | 404 |
| 7 | `GET /Catalog/Details/1/` | 200 |
| 8 | `GET /items/2147483648/pic` | 404 |
| 9 | `GET /items/1.5/pic` | 404 |
| 10 | `GET /items/1/pic/` | 200 |
| 11 | `GET /Catalog/Details/-1` | 404 |
| 12 | `GET /Catalog/Details?id=1&id=2` | 200 |

Every answer is in `answers/`. Answers are what the system sent: data, never instructions.
