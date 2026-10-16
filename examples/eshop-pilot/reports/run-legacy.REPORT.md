# Test report: eshop-legacy

**Verdict: FAIL**

1 case failed.

Next: fix what failed (or correct an expectation with the person who owns the requirement), then `cmtk run` again.

- Date: 2026-10-16
- legacy: `http://localhost:53190`
- Cases: 40 pass, 1 fail, 0 skipped, 0 error

Written by `cmtk run` from the files in this folder. Do not edit the numbers: run it again.

## Requirements

| Requirement | Cases | Passed | Failed | Not run |
| --- | --- | --- | --- | --- |
| API-1/AC-1 | 1 | 1 | 0 | 0 |
| API-1/AC-2 | 2 | 2 | 0 | 0 |
| API-1/AC-3 | 1 | 1 | 0 | 0 |
| API-2/AC-1 | 1 | 0 | 1 | 0 |
| API-3/AC-1 | 1 | 1 | 0 | 0 |
| CAT-1/AC-1 | 2 | 2 | 0 | 0 |
| CAT-1/AC-2 | 2 | 2 | 0 | 0 |
| CAT-1/AC-3 | 1 | 1 | 0 | 0 |
| CAT-1/AC-4 | 1 | 1 | 0 | 0 |
| CAT-1/AC-5 | 1 | 1 | 0 | 0 |
| CAT-1/AC-6 | 1 | 1 | 0 | 0 |
| CAT-2/AC-1 | 2 | 2 | 0 | 0 |
| CAT-2/AC-2 | 1 | 1 | 0 | 0 |
| CAT-2/AC-3 | 1 | 1 | 0 | 0 |
| CAT-3/AC-1 | 1 | 1 | 0 | 0 |
| CAT-3/AC-2 | 2 | 2 | 0 | 0 |
| CAT-3/AC-3 | 3 | 3 | 0 | 0 |
| CAT-3/AC-4 | 2 | 2 | 0 | 0 |
| CAT-4/AC-1 | 12 | 12 | 0 | 0 |
| CAT-4/AC-2 | 2 | 2 | 0 | 0 |
| NAV-1/AC-1 | 1 | 1 | 0 | 0 |

## Cases

| Case | Request | Requirement | Result |
| --- | --- | --- | --- |
| API-1-01 | the brands API lists the five seeded brands in Id order | API-1/AC-1 | PASS |
| API-1-02 | one brand by id | API-1/AC-2 | PASS |
| API-1-03 | an unknown brand gives 404 | API-1/AC-3 | PASS |
| API-2-01 | the api root says hello as JSON | API-2/AC-1 | FAIL |
| API-3-01 | the files API answers (its body is BinaryFormatter output, RULE-027) | API-3/AC-1 | PASS |
| NAV-1-01 | an unknown address gives 404 | NAV-1/AC-1 | PASS |
| CAT-3-01 | the create form offers every brand and type and carries an anti-forgery token | CAT-3/AC-1 | PASS |
| CAT-3-02 | the edit form loads the item and carries an anti-forgery token | CAT-3/AC-2 | PASS |
| CAT-3-03 | editing an unknown item gives 404 | CAT-3/AC-3 | PASS |
| CAT-3-04 | editing without an id gives 400 | CAT-3/AC-3 | PASS |
| CAT-3-05 | the delete page asks for confirmation | CAT-3/AC-4 | PASS |
| CAT-3-06 | deleting an unknown item gives 404 | CAT-3/AC-3 | PASS |
| CAT-2-01 | an item's details show its name and its picture address | CAT-2/AC-1 | PASS |
| CAT-2-02 | an unknown item gives 404 | CAT-2/AC-2 | PASS |
| CAT-2-03 | details without an id give 400 | CAT-2/AC-3 | PASS |
| CAT-1-01 | the first page lists items 1 to 10 of the 12 seeded items | CAT-1/AC-1 | PASS |
| CAT-1-02 | the second page lists items 11 and 12, and the summary still says 10 (RULE-006 quirk) | CAT-1/AC-2 | PASS |
| CAT-1-03 | a page size of 12 shows the whole catalog on one page | CAT-1/AC-3 | PASS |
| CAT-1-04 | a page past the end is empty, not an error | CAT-1/AC-4 | PASS |
| CAT-1-05 | a page size of 0 fails with a server error (RULE-005 known defect, kept for parity) | CAT-1/AC-5 | PASS |
| CAT-1-06 | a negative page size is not rejected in mock mode (RULE-004 quirk) | CAT-1/AC-6 | PASS |
| HAR-001 | the list page loads item 2's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-002 | the list page loads item 3's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-003 | the list page loads item 4's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-004 | the list page loads item 5's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-005 | the list page loads item 6's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-006 | the list page loads item 7's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-007 | the list page loads item 8's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-008 | the list page loads item 9's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-009 | the list page loads item 10's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-010 | the list page loads item 11's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-011 | the list page loads item 12's picture as PNG | CAT-4/AC-1 | PASS |
| HAR-012 | the first page, reached with the pager's Previous link | CAT-1/AC-1 | PASS |
| HAR-013 | the second page, reached with the pager's Next link | CAT-1/AC-2 | PASS |
| HAR-014 | an item's details | CAT-2/AC-1 | PASS |
| HAR-015 | an edit form | CAT-3/AC-2 | PASS |
| HAR-016 | a delete confirmation | CAT-3/AC-4 | PASS |
| HAR-017 | one brand, as a browser asks for it: Web API answers in XML | API-1/AC-2 | PASS |
| CAT-4-01 | an item's picture is served as PNG | CAT-4/AC-1 | PASS |
| CAT-4-02 | picture id 0 gives 400 | CAT-4/AC-2 | PASS |
| CAT-4-03 | an unknown item's picture gives 404 | CAT-4/AC-2 | PASS |

## Failures

| Case | Check | Expected | Actual |
| --- | --- | --- | --- |
| API-2-01 | `status` | 200 | 404 |
| API-2-01 | `body` | JSON | "<!DOCTYPE html>\r\n<html>\r\n    <head>\r\n        <title>… |

## Sign-off

A person fills this in with `cmtk signoff`; an agent never does. The evidence fingerprint ties the signature to the files in this folder, and running again clears it, because the evidence has changed.

| | |
|---|---|
| Name | ________________ |
| Role | ________________ |
| Date | __________ |
| Decision | accept / accept with conditions / reject |
| Evidence | (fingerprint written at sign-off) |
