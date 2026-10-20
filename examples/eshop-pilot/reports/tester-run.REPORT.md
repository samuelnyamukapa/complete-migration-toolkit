# Test report: eshop-legacy

**Verdict: FAIL**

2 cases failed.

Next: fix what failed (or correct an expectation with the person who owns the requirement), then `cmtk run` again.

- Date: 2026-10-20
- candidate: `http://localhost:53190`
- Cases: 30 pass, 2 fail, 10 skipped, 0 error

Written by `cmtk run` from the files in this folder. Do not edit the numbers: run it again.

## Settings

What produced this report. Check what is hidden or approved before you sign.

- Settings file: `cmtk.yaml` (sha256 5217cac92ce24e82…)

## Requirements

| Requirement | Cases | Passed | Failed | Not run |
| --- | --- | --- | --- | --- |
| EXPLORE/X20261019-213230 | 3 | 0 | 2 | 1 |
| REQ-1/AC-1 | 1 | 1 | 0 | 0 |
| REQ-2/AC-1 | 2 | 2 | 0 | 0 |
| REQ-3/AC-1 | 1 | 0 | 0 | 1 |
| REQ-4/AC-1 | 1 | 0 | 0 | 1 |
| REQ-4/AC-2 | 1 | 0 | 0 | 1 |
| REQ-4/AC-3 | 1 | 0 | 0 | 1 |
| RULE-002/AC-1 | 4 | 4 | 0 | 0 |
| RULE-004/AC-1 | 1 | 1 | 0 | 0 |
| RULE-004/AC-2 | 3 | 3 | 0 | 0 |
| RULE-004/AC-3 | 2 | 2 | 0 | 0 |
| RULE-004/AC-5 | 1 | 0 | 0 | 1 |
| RULE-004/AC-6 | 1 | 0 | 0 | 1 |
| RULE-004/AC-7 | 1 | 0 | 0 | 1 |
| RULE-005/AC-1 | 4 | 4 | 0 | 0 |
| RULE-005/AC-3 | 1 | 0 | 0 | 1 |
| RULE-005/AC-4 | 1 | 0 | 0 | 1 |
| RULE-006/AC-1 | 4 | 4 | 0 | 0 |
| RULE-006/AC-2 | 1 | 1 | 0 | 0 |
| RULE-006/AC-3 | 1 | 1 | 0 | 0 |
| RULE-006/AC-4 | 1 | 1 | 0 | 0 |
| RULE-007/AC-1 | 1 | 1 | 0 | 0 |
| RULE-009/AC-1 | 3 | 3 | 0 | 0 |
| RULE-009/AC-2 | 2 | 2 | 0 | 0 |
| RULE-009/AC-3 | 1 | 1 | 0 | 0 |
| RULE-010/AC-1 | 2 | 2 | 0 | 0 |
| RULE-010/AC-2 | 2 | 2 | 0 | 0 |
| RULE-010/AC-3 | 1 | 1 | 0 | 0 |
| RULE-010/AC-4 | 1 | 1 | 0 | 0 |
| RULE-016/AC-1 | 3 | 3 | 0 | 0 |
| RULE-016/AC-2 | 4 | 4 | 0 | 0 |
| RULE-016/AC-3 | 1 | 1 | 0 | 0 |
| RULE-016/AC-4 | 3 | 3 | 0 | 0 |
| RULE-027/AC-1 | 1 | 1 | 0 | 0 |
| RULE-028/AC-1 | 3 | 0 | 0 | 3 |
| RULE-032/AC-1 | 2 | 2 | 0 | 0 |
| RULE-033/AC-2 | 1 | 1 | 0 | 0 |

## Cases

| Case | Request | Requirement | Result |
| --- | --- | --- | --- |
| CAT-ENTRY-01 | the site's entry point answers | REQ-1/AC-1 | PASS |
| CAT-NOTFOUND-01 | an unknown address answers 404 | REQ-2/AC-1 | PASS |
| CAT-LIST-01 | the list opens on page 1 with items 1-10 and the pager summary | RULE-004/AC-1, RULE-005/AC-1, RULE-006/AC-1, RULE-006/AC-2, RULE-002/AC-1 | PASS |
| CAT-PAGE-01 | page 2 of 2 shows only items 11 and 12, with Next hidden | RULE-004/AC-2, RULE-006/AC-3, RULE-002/AC-1 | PASS |
| CAT-PAGE-02 | the first page past the end is empty, not an error | RULE-004/AC-3 | PASS |
| CAT-PAGE-03 | a page far past the end is empty, not an error | RULE-004/AC-3 | PASS |
| CAT-PAGE-04 | a middle page skips 5 and shows items 6-10, with both pager links active | RULE-004/AC-2, RULE-005/AC-1, RULE-006/AC-1, RULE-006/AC-4, RULE-002/AC-1 | PASS |
| CAT-PAGE-05 | a negative page index (answer to be decided) | RULE-004/AC-5, RULE-028/AC-1 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| CAT-PAGE-06 | a very large page size (answer to be decided) | RULE-004/AC-6 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| CAT-PAGE-07 | page size times page index past the int range (answer to be decided) | RULE-004/AC-7 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| CAT-PAGE-08 | a page size of 0 (answer to be decided) | RULE-005/AC-3, RULE-028/AC-1 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| CAT-PAGE-09 | a negative page size (answer to be decided) | RULE-005/AC-4, RULE-028/AC-1 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| CAT-PAGE-10 | a page size equal to the item count gives one page | RULE-005/AC-1, RULE-006/AC-1 | PASS |
| CAT-PAGE-11 | a page size one below the item count gives two pages | RULE-004/AC-2, RULE-005/AC-1, RULE-006/AC-1 | PASS |
| CAT-DETAILS-01 | the details page of an existing item opens and shows its picture URL | RULE-016/AC-4, RULE-002/AC-1 | PASS |
| CAT-DETAILS-02 | the details page with no id is a bad request | RULE-016/AC-1 | PASS |
| CAT-DETAILS-03 | the details page of an unknown item is not found | RULE-016/AC-2 | PASS |
| CAT-DETAILS-04 | the details page with a non-numeric id is a bad request | RULE-016/AC-3 | PASS |
| CAT-DETAILS-05 | the details page for id 0 is not found | RULE-016/AC-2 | PASS |
| CAT-CREATE-01 | the create form carries an anti-forgery token and the brand and type lists | RULE-009/AC-1, RULE-009/AC-2 | PASS |
| CAT-CREATE-02 | the create form has no picture field | RULE-033/AC-2 | PASS |
| CAT-EDIT-01 | the edit form of an existing item carries an anti-forgery token and the brand and type lists | RULE-016/AC-4, RULE-009/AC-1, RULE-009/AC-2 | PASS |
| CAT-EDIT-02 | the edit form with no id is a bad request | RULE-016/AC-1 | PASS |
| CAT-EDIT-03 | the edit form of an unknown item is not found | RULE-016/AC-2 | PASS |
| CAT-EDIT-04 | the edit form marks a field read-only | RULE-007/AC-1 | PASS |
| CAT-DELETE-01 | the delete confirmation page of an existing item opens with an anti-forgery token | RULE-016/AC-4, RULE-009/AC-1, RULE-009/AC-3 | PASS |
| CAT-DELETE-02 | the delete page with no id is a bad request | RULE-016/AC-1 | PASS |
| CAT-DELETE-03 | the delete page of an unknown item is not found | RULE-016/AC-2 | PASS |
| CAT-PIC-01 | the first item's picture is served as a PNG | RULE-010/AC-1, RULE-032/AC-1 | PASS |
| CAT-PIC-02 | picture id 0 is a bad request | RULE-010/AC-2 | PASS |
| CAT-PIC-03 | a negative picture id is a bad request | RULE-010/AC-2 | PASS |
| CAT-PIC-04 | the picture of an unknown item is not found | RULE-010/AC-3 | PASS |
| CAT-PIC-05 | the last seed item's picture is served as a PNG | RULE-010/AC-1, RULE-032/AC-1 | PASS |
| CAT-PIC-06 | a non-numeric picture id matches no address | RULE-010/AC-4, REQ-2/AC-1 | PASS |
| API-ROOT-01 | the API root (answer to be decided) | REQ-3/AC-1 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| API-BRANDS-01 | the brand list from the API (answer to be decided) | REQ-4/AC-1 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| API-BRANDS-02 | one existing brand from the API (answer to be decided) | REQ-4/AC-2 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| API-BRANDS-03 | an unknown brand from the API (answer to be decided) | REQ-4/AC-3 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |
| API-FILES-01 | the files API returns the brand list | RULE-027/AC-1 | PASS |
| EXP-20261019213230-01 | Item details error pages reveal the server's physical path | EXPLORE/X20261019-213230 | FAIL |
| EXP-20261019213230-02 | Picture 404 pages contain a stack trace and framework versions | EXPLORE/X20261019-213230 | FAIL |
| EXP-20261019213230-03 | Odd paging values silently show the default page with no error | EXPLORE/X20261019-213230 | SKIPPED — no 'expect:' block, so there is nothing to check on one system |

## Failures

| Case | Check | Expected | Actual |
| --- | --- | --- | --- |
| EXP-20261019213230-01 | `body` | never contains "Physical Path" | found: "></tr> \n    <tr><th>Physical Path</th><td>&nbsp;&nbsp;&nbsp;D:\\githubProj" |
| EXP-20261019213230-02 | `body` | never contains "System.Web.Mvc" | found: "IController.\r\n   at System.Web.Mvc.DefaultControllerFactory.GetControllerI" |
| EXP-20261019213230-02 | `body` | never contains "HttpException" | found: ">\r\n</html>\r\n<!-- \r\n[HttpException]: The controller for path &#39;/items/2" |

## Sign-off

A person fills this in with `cmtk signoff`; an agent never does. The evidence fingerprint ties the signature to the files in this folder, and running again clears it, because the evidence has changed.

| | |
|---|---|
| Name | ________________ |
| Role | ________________ |
| Date | __________ |
| Decision | accept / accept with conditions / reject |
| Evidence | (fingerprint written at sign-off) |
