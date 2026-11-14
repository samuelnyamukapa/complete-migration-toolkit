# Comparison report: eshop

**Verdict: PARTIAL COMPARISON** (only part of the system: see Scope)

On what was compared, there are no differences. This comparison covers only catalog, not the whole system. Not compared: 41 cases on http (candidate has no http surface).

Next: a person reads the scope and signs with `cmtk signoff compare` for what was compared. The rest of the system still has to be compared.

- Date: 2026-11-04
- legacy: `http://localhost:53190`
- candidate: `probe=probe/bin/Release/net8.0/CatalogProbe.exe`
- Cases: 24 match, 0 drift, 0 different, 0 skipped, 0 error, 41 not comparable
- Model calls: 0 counted, and 48 answers from an adapter that does not count them

Written by `cmtk compare` from the files in this folder. Do not edit the numbers: run it again.

## Settings

What produced this report. Check what is hidden or approved before you sign.

- Settings file: `cmtk-one-manifest.yaml` (sha256 11abcb2da84ccc29…)
- Match level: exact
- Scrubbed (hidden from every comparison): nothing
- Approved drift: 0 entries in `cmtk/drift-catalogcore.yaml`

## Scope

This comparison covers only catalog, not the whole system. Not compared: 41 cases on http (candidate has no http surface).

- Compared: catalog, 24 cases
- Not compared: http, 41 cases: candidate has no http surface

## Requirements

| Requirement | Cases | Passed | Failed | Not run |
| --- | --- | --- | --- | --- |
| API-1/AC-1 | 2 | 1 | 0 | 1 |
| API-1/AC-2 | 2 | 0 | 0 | 2 |
| API-1/AC-3 | 1 | 0 | 0 | 1 |
| API-2/AC-1 | 1 | 0 | 0 | 1 |
| API-3/AC-1 | 1 | 0 | 0 | 1 |
| CAT-1/AC-1 | 3 | 1 | 0 | 2 |
| CAT-1/AC-2 | 3 | 1 | 0 | 2 |
| CAT-1/AC-3 | 3 | 2 | 0 | 1 |
| CAT-1/AC-4 | 2 | 1 | 0 | 1 |
| CAT-1/AC-5 | 2 | 1 | 0 | 1 |
| CAT-1/AC-6 | 4 | 3 | 0 | 1 |
| CAT-2/AC-1 | 4 | 2 | 0 | 2 |
| CAT-2/AC-2 | 3 | 2 | 0 | 1 |
| CAT-2/AC-3 | 1 | 0 | 0 | 1 |
| CAT-3/AC-1 | 2 | 1 | 0 | 1 |
| CAT-3/AC-2 | 2 | 0 | 0 | 2 |
| CAT-3/AC-3 | 3 | 0 | 0 | 3 |
| CAT-3/AC-4 | 2 | 0 | 0 | 2 |
| CAT-4/AC-1 | 12 | 0 | 0 | 12 |
| CAT-4/AC-2 | 2 | 0 | 0 | 2 |
| NAV-1/AC-1 | 1 | 0 | 0 | 1 |
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
| SVC-1-01 | first page of 10 | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-02 | second page holds items 11 and 12 | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-03 | one page of 12 | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-04 | a page past the end is empty | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-05 | page size 0 throws | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-06 | a negative page size returns nothing and -1 pages | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-07 | a negative page index skips nothing | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-08 | third page of 5 holds 2 items | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-1-09 | page size times index overflows int (RULE-004 suspected defect) | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-2-01 | item 1 | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-2-02 | item 12 | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-2-03 | unknown item is null | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-2-04 | item 0 is null | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-3-01 | the five brands | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| SVC-3-02 | the four types | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-01 | a normal item is valid | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-02 | a name is required | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-03 | a name of spaces is not a name | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-04 | three decimals are rejected | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-05 | a negative price is rejected | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-06 | 1000000.50 passes the range check because it rounds first (DELTA-029) | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-07 | 1000000.51 fails the range check (DELTA-029) | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-08 | a decimal price fails in a comma-decimal culture (DELTA-023) | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| VAL-1-09 | stock levels must be 0 to 10 million | exact | MATCH — read-only, so the systems were not reset first: this compares what each holds now, including anything an earlier case or an earlier run left there |
| API-1-01 | the brands API lists the five seeded brands in Id order | exact | not comparable: candidate has no http surface |
| API-1-02 | one brand by id | exact | not comparable: candidate has no http surface |
| API-1-03 | an unknown brand gives 404 | exact | not comparable: candidate has no http surface |
| API-2-01 | the api root says hello as JSON | exact | not comparable: candidate has no http surface |
| API-3-01 | the files API answers (its body is BinaryFormatter output, RULE-027) | exact | not comparable: candidate has no http surface |
| NAV-1-01 | an unknown address gives 404 | exact | not comparable: candidate has no http surface |
| CAT-3-01 | the create form offers every brand and type and carries an anti-forgery token | exact | not comparable: candidate has no http surface |
| CAT-3-02 | the edit form loads the item and carries an anti-forgery token | exact | not comparable: candidate has no http surface |
| CAT-3-03 | editing an unknown item gives 404 | exact | not comparable: candidate has no http surface |
| CAT-3-04 | editing without an id gives 400 | exact | not comparable: candidate has no http surface |
| CAT-3-05 | the delete page asks for confirmation | exact | not comparable: candidate has no http surface |
| CAT-3-06 | deleting an unknown item gives 404 | exact | not comparable: candidate has no http surface |
| CAT-2-01 | an item's details show its name and its picture address | exact | not comparable: candidate has no http surface |
| CAT-2-02 | an unknown item gives 404 | exact | not comparable: candidate has no http surface |
| CAT-2-03 | details without an id give 400 | exact | not comparable: candidate has no http surface |
| CAT-1-01 | the first page lists items 1 to 10 of the 12 seeded items | exact | not comparable: candidate has no http surface |
| CAT-1-02 | the second page lists items 11 and 12, and the summary still says 10 (RULE-006 quirk) | exact | not comparable: candidate has no http surface |
| CAT-1-03 | a page size of 12 shows the whole catalog on one page | exact | not comparable: candidate has no http surface |
| CAT-1-04 | a page past the end is empty, not an error | exact | not comparable: candidate has no http surface |
| CAT-1-05 | a page size of 0 fails with a server error (RULE-005 known defect, kept for parity) | exact | not comparable: candidate has no http surface |
| CAT-1-06 | a negative page size is not rejected in mock mode (RULE-004 quirk) | exact | not comparable: candidate has no http surface |
| HAR-001 | the list page loads item 2's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-002 | the list page loads item 3's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-003 | the list page loads item 4's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-004 | the list page loads item 5's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-005 | the list page loads item 6's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-006 | the list page loads item 7's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-007 | the list page loads item 8's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-008 | the list page loads item 9's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-009 | the list page loads item 10's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-010 | the list page loads item 11's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-011 | the list page loads item 12's picture as PNG | exact | not comparable: candidate has no http surface |
| HAR-012 | the first page, reached with the pager's Previous link | exact | not comparable: candidate has no http surface |
| HAR-013 | the second page, reached with the pager's Next link | exact | not comparable: candidate has no http surface |
| HAR-014 | an item's details | exact | not comparable: candidate has no http surface |
| HAR-015 | an edit form | exact | not comparable: candidate has no http surface |
| HAR-016 | a delete confirmation | exact | not comparable: candidate has no http surface |
| HAR-017 | one brand, as a browser asks for it: Web API answers in XML | exact | not comparable: candidate has no http surface |
| CAT-4-01 | an item's picture is served as PNG | exact | not comparable: candidate has no http surface |
| CAT-4-02 | picture id 0 gives 400 | exact | not comparable: candidate has no http surface |
| CAT-4-03 | an unknown item's picture gives 404 | exact | not comparable: candidate has no http surface |

## Sign-off

A person fills this in with `cmtk signoff`; an agent never does. The evidence fingerprint ties the signature to the files in this folder, and running again clears it, because the evidence has changed.

| | |
|---|---|
| Name | ________________ |
| Role | ________________ |
| Date | __________ |
| Decision | accept / accept with conditions / reject |
| Evidence | (fingerprint written at sign-off) |
