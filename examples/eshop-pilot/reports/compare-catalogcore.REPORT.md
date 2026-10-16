# Comparison report: eshop-catalogcore

**Verdict: PARITY**

No differences at all.

Next: a person reviews the report and signs it with `cmtk signoff compare`.

- Date: 2026-10-16
- legacy: `probe=probe/bin/Release/net472/CatalogProbe.exe`
- candidate: `probe=probe/bin/Release/net8.0/CatalogProbe.exe`
- Cases: 24 match, 0 drift, 0 different, 0 skipped, 0 error

Written by `cmtk compare` from the files in this folder. Do not edit the numbers: run it again.

## Requirements

| Requirement | Cases | Passed | Failed | Not run |
| --- | --- | --- | --- | --- |
| API-1/AC-1 | 1 | 1 | 0 | 0 |
| CAT-1/AC-1 | 1 | 1 | 0 | 0 |
| CAT-1/AC-2 | 1 | 1 | 0 | 0 |
| CAT-1/AC-3 | 2 | 2 | 0 | 0 |
| CAT-1/AC-4 | 1 | 1 | 0 | 0 |
| CAT-1/AC-5 | 1 | 1 | 0 | 0 |
| CAT-1/AC-6 | 3 | 3 | 0 | 0 |
| CAT-2/AC-1 | 2 | 2 | 0 | 0 |
| CAT-2/AC-2 | 2 | 2 | 0 | 0 |
| CAT-3/AC-1 | 1 | 1 | 0 | 0 |
| VAL-1/AC-1 | 1 | 1 | 0 | 0 |
| VAL-1/AC-2 | 2 | 2 | 0 | 0 |
| VAL-1/AC-3 | 2 | 2 | 0 | 0 |
| VAL-1/AC-4 | 2 | 2 | 0 | 0 |
| VAL-1/AC-5 | 1 | 1 | 0 | 0 |
| VAL-1/AC-6 | 1 | 1 | 0 | 0 |

## Contracts

No contracts are listed in cmtk.yaml, so none were checked.

## Cases

| Case | Request | Level | Result |
| --- | --- | --- | --- |
| SVC-1-01 | first page of 10 | exact | MATCH |
| SVC-1-02 | second page holds items 11 and 12 | exact | MATCH |
| SVC-1-03 | one page of 12 | exact | MATCH |
| SVC-1-04 | a page past the end is empty | exact | MATCH |
| SVC-1-05 | page size 0 throws | exact | MATCH |
| SVC-1-06 | a negative page size returns nothing and -1 pages | exact | MATCH |
| SVC-1-07 | a negative page index skips nothing | exact | MATCH |
| SVC-1-08 | third page of 5 holds 2 items | exact | MATCH |
| SVC-1-09 | page size times index overflows int (RULE-004 suspected defect) | exact | MATCH |
| SVC-2-01 | item 1 | exact | MATCH |
| SVC-2-02 | item 12 | exact | MATCH |
| SVC-2-03 | unknown item is null | exact | MATCH |
| SVC-2-04 | item 0 is null | exact | MATCH |
| SVC-3-01 | the five brands | exact | MATCH |
| SVC-3-02 | the four types | exact | MATCH |
| VAL-1-01 | a normal item is valid | exact | MATCH |
| VAL-1-02 | a name is required | exact | MATCH |
| VAL-1-03 | a name of spaces is not a name | exact | MATCH |
| VAL-1-04 | three decimals are rejected | exact | MATCH |
| VAL-1-05 | a negative price is rejected | exact | MATCH |
| VAL-1-06 | 1000000.50 passes the range check because it rounds first (DELTA-029) | exact | MATCH |
| VAL-1-07 | 1000000.51 fails the range check (DELTA-029) | exact | MATCH |
| VAL-1-08 | a decimal price fails in a comma-decimal culture (DELTA-023) | exact | MATCH |
| VAL-1-09 | stock levels must be 0 to 10 million | exact | MATCH |

## Sign-off

A person fills this in with `cmtk signoff`; an agent never does. The evidence fingerprint ties the signature to the files in this folder, and running again clears it, because the evidence has changed.

| | |
|---|---|
| Name | ________________ |
| Role | ________________ |
| Date | __________ |
| Decision | accept / accept with conditions / reject |
| Evidence | (fingerprint written at sign-off) |
