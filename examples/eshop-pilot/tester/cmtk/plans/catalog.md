# Test plan: catalog

- **Source:** `inputs/BUSINESS_RULES.md`, which holds rules extracted from the legacy eShop code (RULE-001 to RULE-033).
- **Cases:** `cmtk/cases/catalog.yaml` has 39 drafts. Every one is a read-only `GET`, and nothing counts until a person accepts it with `cmtk review`.
- **Scope in:** the catalog pages: the list, paging, details, the Create, Edit and Delete forms fetched with GET, and item pictures. Also the HTTP API: brands, files and the API root, read-only.
- **Scope out:** the database, SQL, the seeding scripts, POST/PUT/DELETE, and the customization CSV import.

## Before you run

- **Test data.** The cases assume the built-in seed catalog from RULE-030, with nothing created, edited or deleted since seeding:
  - 12 items with Ids 1 to 12, each with picture `{Id}.png`;
  - 5 brands: Azure, .NET, Visual Studio, SQL Server, Other;
  - 4 types: Mug, T-Shirt, Sheet, USB Memory Stick;
  - `UseCustomizationData=false`.

  Q-1 asks you to confirm this.
- **Mode.** RULE-004 (ordered by Id) describes the SQL service. That is `UseMockData=false`, the shipped setting (RULE-029). The input does not say whether the in-memory mock orders items the same way. Which mode the system under test runs is part of Q-1.
- **Intent.** Rules extracted from code describe what the code does today, bugs included. Nothing in the project says behaviour must match exactly, so no case expects a suspected defect. Each defect is a keep-or-fix question instead (Q-2).
- **Credentials.** None are needed: RULE-026 says there is no login. If a login is added, see Q-12.
- **Addresses.** The input names `/Catalog/Details`, `/Catalog/Create`, `/Catalog/Delete/{id}`, `items/{id}/pic`, `api/brands` and `api/files`. The list address `/Catalog/Index` follows the same pattern (the view is `Views/Catalog/Index.cshtml`). The query names `pageSize` and `pageIndex` come from RULE-004 and RULE-006.
- **Finding items on a page.** Cases find items by their picture URLs (`/items/{id}/pic`, RULE-002), because the input does not give item names.

## Criteria

| Id | What must be true | Cases | Check |
|---|---|---|---|
| REQ-1/AC-1 | The entry point `GET /` answers 200 | CAT-ENTRY-01 | automated |
| REQ-2/AC-1 | An unknown address answers 404 | CAT-NOTFOUND-01, CAT-PIC-06 | automated |
| REQ-3/AC-1 | The API root answers; what it should return is Q-7 | API-ROOT-01 | automated, no `expect` yet |
| REQ-4/AC-1 | `GET api/brands` lists the brands (Q-8) | API-BRANDS-01 | automated, no `expect` yet |
| REQ-4/AC-2 | `GET api/brands/{id}` returns an existing brand (Q-8) | API-BRANDS-02 | automated, no `expect` yet |
| REQ-4/AC-3 | `GET api/brands/{id}` with an unknown id (Q-8) | API-BRANDS-03 | automated, no `expect` yet |
| RULE-002/AC-1 | A displayed item carries its picture URL on the route `items/{id}/pic` | CAT-LIST-01, CAT-PAGE-01, CAT-PAGE-04, CAT-DETAILS-01 | automated |
| RULE-002/AC-2 | That URL is absolute and uses the current request's scheme | MAN-1 | manual |
| RULE-004/AC-1 | The defaults are page size 10 and page 0, so the list shows items 1 to 10 | CAT-LIST-01 | automated |
| RULE-004/AC-2 | Page N skips pageSize × N items and takes pageSize | CAT-PAGE-01, CAT-PAGE-04, CAT-PAGE-11 | automated |
| RULE-004/AC-3 | An out-of-range pageIndex gives an empty page, not an error | CAT-PAGE-02, CAT-PAGE-03 | automated |
| RULE-004/AC-4 | Items are sorted by Id, ascending | MAN-2 | manual |
| RULE-004/AC-5 | A negative pageIndex: the answer is not decided (Q-3a) | CAT-PAGE-05 | no `expect` yet |
| RULE-004/AC-6 | A very large pageSize, with no cap: not decided (Q-3b) | CAT-PAGE-06 | no `expect` yet |
| RULE-004/AC-7 | pageSize × pageIndex past the int range: not decided (Q-3c) | CAT-PAGE-07 | no `expect` yet |
| RULE-005/AC-1 | TotalPages = items ÷ pageSize, rounded up: 12÷10 gives 2, 12÷11 gives 2, 12÷12 gives 1, 12÷5 gives 3 | CAT-LIST-01, CAT-PAGE-11, CAT-PAGE-10, CAT-PAGE-04 | automated |
| RULE-005/AC-2 | 0 items gives 0 pages | MAN-5 | manual |
| RULE-005/AC-3 | A pageSize of 0: not decided (Q-3d) | CAT-PAGE-08 | no `expect` yet |
| RULE-005/AC-4 | A negative pageSize: not decided (Q-3e) | CAT-PAGE-09 | no `expect` yet |
| RULE-006/AC-1 | The summary reads `Showing {ItemsPerPage} of {TotalItems} products - Page {ActualPage+1} - {TotalPages}` | CAT-LIST-01, CAT-PAGE-04, CAT-PAGE-10, CAT-PAGE-11; CAT-PAGE-01 checks part of it (Q-4) | automated |
| RULE-006/AC-2 | On page 1, Previous is hidden and Next is active | CAT-LIST-01 (partly), MAN-3 | both |
| RULE-006/AC-3 | On the last page, Next is hidden | CAT-PAGE-01 (partly), MAN-3 | both |
| RULE-006/AC-4 | On a middle page, both links are active | CAT-PAGE-04 | automated |
| RULE-007/AC-1 | The Edit form marks the picture file name read-only | CAT-EDIT-04 | automated |
| RULE-009/AC-1 | The Create, Edit and Delete-confirm forms carry an anti-forgery token | CAT-CREATE-01, CAT-EDIT-01, CAT-DELETE-01 | automated |
| RULE-009/AC-2 | The Create and Edit forms offer the brand and type lists | CAT-CREATE-01, CAT-EDIT-01 | automated |
| RULE-009/AC-3 | `GET /Catalog/Delete/{id}` only shows the confirmation page; nothing is deleted | CAT-DELETE-01, MAN-4 | both |
| RULE-010/AC-1 | `items/{id}/pic` returns the item's picture | CAT-PIC-01, CAT-PIC-05, MAN-6 | both |
| RULE-010/AC-2 | An Id of 0 or less gives 400 | CAT-PIC-02, CAT-PIC-03 | automated |
| RULE-010/AC-3 | An unknown item gives 404 | CAT-PIC-04 | automated |
| RULE-010/AC-4 | Only integer ids match the route (`:int`) | CAT-PIC-06 | automated |
| RULE-016/AC-1 | Details, Edit and Delete with no id give 400 | CAT-DETAILS-02, CAT-EDIT-02, CAT-DELETE-02 | automated |
| RULE-016/AC-2 | Details, Edit and Delete with an unknown id give 404 | CAT-DETAILS-03, CAT-DETAILS-05, CAT-EDIT-03, CAT-DELETE-03 | automated |
| RULE-016/AC-3 | A non-numeric id gives 400 | CAT-DETAILS-04 | automated |
| RULE-016/AC-4 | An existing id opens the page (200, implied) | CAT-DETAILS-01, CAT-EDIT-01, CAT-DELETE-01 | automated |
| RULE-027/AC-1 | `GET api/files` returns the brand list (Id, Brand) | API-FILES-01 | automated; the format is Q-9 |
| RULE-028/AC-1 | An unhandled error in a page shows the shared Error view (Q-5) | CAT-PAGE-05, CAT-PAGE-08, CAT-PAGE-09 | no `expect` yet |
| RULE-032/AC-1 | A `.png` picture is served as `image/png` | CAT-PIC-01, CAT-PIC-05 | automated |
| RULE-033/AC-2 | The Create form has no picture field | CAT-CREATE-02 | automated |

That is 39 criteria in scope:
- 26 are checked by cases with `expect` (4 of them also by a manual check);
- 3 are checked only by a manual check;
- 10 wait on a question, and their 9 cases have no `expect` yet.

## Cases

Every case is one GET request against the seed data above. "Contains" means text in the response body.

**Entry point and unknown address**

| Case | Request | Expected |
|---|---|---|
| CAT-ENTRY-01 | `GET /` | 200 |
| CAT-NOTFOUND-01 | `GET /cmtk-no-such-page` | 404 |

**List and paging**

| Case | Request | Expected |
|---|---|---|
| CAT-LIST-01 | `GET /Catalog/Index` | 200. Contains "Showing 10 of 12 products - Page 1 - 2", pictures 1 and 10, the hidden-pager class, and a link to `pageIndex=1`. Does not contain pictures 11 and 12. |
| CAT-PAGE-01 | `?pageSize=10&pageIndex=1` | 200. Contains pictures 11 and 12, "of 12 products - Page 2 - 2", and the hidden-pager class. Does not contain pictures 1 and 10. |
| CAT-PAGE-02 | `?pageSize=10&pageIndex=2` | 200, with no item pictures (the page is empty) |
| CAT-PAGE-03 | `?pageSize=10&pageIndex=5` | 200, with no item pictures (the page is empty) |
| CAT-PAGE-04 | `?pageSize=5&pageIndex=1` | 200. Contains "Showing 5 of 12 products - Page 2 - 3" and pictures 6 and 10. Does not contain pictures 5 and 11, or the hidden-pager class. |
| CAT-PAGE-10 | `?pageSize=12&pageIndex=0` | 200. Contains "Showing 12 of 12 products - Page 1 - 1" and pictures 1 and 12. |
| CAT-PAGE-11 | `?pageSize=11&pageIndex=0` | 200. Contains "Showing 11 of 12 products - Page 1 - 2" and picture 11. Does not contain picture 12. |
| CAT-PAGE-05 | `?pageSize=10&pageIndex=-1` | Not set yet (Q-3a, Q-5) |
| CAT-PAGE-06 | `?pageSize=1000&pageIndex=0` | Not set yet (Q-3b) |
| CAT-PAGE-07 | `?pageSize=1000000&pageIndex=10000` | Not set yet (Q-3c) |
| CAT-PAGE-08 | `?pageSize=0&pageIndex=0` | Not set yet (Q-3d, Q-5) |
| CAT-PAGE-09 | `?pageSize=-1&pageIndex=0` | Not set yet (Q-3e, Q-5) |

The paging requests all go to `/Catalog/Index`. A picture here means its URL, `/items/{id}/pic`. The hidden-pager class is `esh-pager-item--hidden` (RULE-006).

**Details, Create, Edit and Delete pages**

| Case | Request | Expected |
|---|---|---|
| CAT-DETAILS-01 | `GET /Catalog/Details/1` | 200, and contains `/items/1/pic` |
| CAT-DETAILS-02 | `GET /Catalog/Details` | 400 |
| CAT-DETAILS-03 | `GET /Catalog/Details/9999` | 404 |
| CAT-DETAILS-04 | `GET /Catalog/Details/abc` | 400 |
| CAT-DETAILS-05 | `GET /Catalog/Details/0` | 404 |
| CAT-CREATE-01 | `GET /Catalog/Create` | 200. Contains `__RequestVerificationToken`, the 5 brand names and the 4 type names. |
| CAT-CREATE-02 | `GET /Catalog/Create` | 200, and does not contain `name="PictureFileName"` |
| CAT-EDIT-01 | `GET /Catalog/Edit/1` | 200. Contains `__RequestVerificationToken`, the 5 brand names and the 4 type names. |
| CAT-EDIT-02 | `GET /Catalog/Edit` | 400 |
| CAT-EDIT-03 | `GET /Catalog/Edit/9999` | 404 |
| CAT-EDIT-04 | `GET /Catalog/Edit/1` | 200, and contains `readonly` |
| CAT-DELETE-01 | `GET /Catalog/Delete/1` | 200, and contains `__RequestVerificationToken` |
| CAT-DELETE-02 | `GET /Catalog/Delete` | 400 |
| CAT-DELETE-03 | `GET /Catalog/Delete/9999` | 404 |

**Item pictures**

| Case | Request | Expected |
|---|---|---|
| CAT-PIC-01 | `GET /items/1/pic` | 200, with `Content-Type: image/png` |
| CAT-PIC-05 | `GET /items/12/pic` | 200, with `Content-Type: image/png` |
| CAT-PIC-02 | `GET /items/0/pic` | 400 |
| CAT-PIC-03 | `GET /items/-1/pic` | 400 |
| CAT-PIC-04 | `GET /items/9999/pic` | 404 |
| CAT-PIC-06 | `GET /items/abc/pic` | 404 (no route matches) |

**HTTP API**

| Case | Request | Expected |
|---|---|---|
| API-ROOT-01 | `GET /api` | Not set yet (Q-7) |
| API-BRANDS-01 | `GET /api/brands` | Not set yet (Q-8) |
| API-BRANDS-02 | `GET /api/brands/1` | Not set yet (Q-8) |
| API-BRANDS-03 | `GET /api/brands/9999` | Not set yet (Q-8) |
| API-FILES-01 | `GET /api/files` | 200, and contains the 5 brand names. The format is not checked (Q-9). |

## Manual checks

- **MAN-1 (RULE-002/AC-2).** Open `/Catalog/Index` and view the page source.
  - **Pass:** an item's picture address is a full URL with the same scheme and host as the page, ending in `/items/{id}/pic`.
  - **Why manual:** a case may not contain a host.
- **MAN-2 (RULE-004/AC-4).** Open `/Catalog/Index?pageSize=12` and view the source.
  - **Pass:** the picture URLs appear in the order `/items/1/pic`, `/items/2/pic` … `/items/12/pic`.
  - **Why manual:** cases can check which items are on a page, not their order.
- **MAN-3 (RULE-006/AC-2, AC-3).** Open `/Catalog/Index` and look at the pager.
  - **Pass on page 1:** Previous is not visible, and Next is visible and opens page 2.
  - **Pass on page 2:** Next is not visible, and Previous is visible and opens page 1.
  - **Why manual:** cases only see that some pager link is hidden, not which one.
- **MAN-4 (RULE-009/AC-3).** Open `/Catalog/Delete/1` and leave without confirming. Then open `/Catalog/Details/1`.
  - **Pass:** item 1 is still there, and the list still says "of 12 products".
  - **Why manual:** a case cannot depend on an earlier one.
- **MAN-5 (RULE-005/AC-2).** You need a separate, disposable environment with an empty catalog. A person sets it up, because deleting items is out of scope here. Open `/Catalog/Index`.
  - **Pass:** the page answers without an error, and the summary shows 0 products and 0 total pages.
  - **Record:** what the page-number text says. The rule says it reads "Page 1 - 0", and whether that is right is Q-4.
- **MAN-6 (RULE-010/AC-1).** Open `/items/1/pic` in a browser.
  - **Pass:** the item's picture is shown, not a broken image or an empty file.
  - **Why manual:** cases check only the status and the content type, not the bytes.

## Out of scope

| Rules | Why left out |
|---|---|
| RULE-001, RULE-003, RULE-019, RULE-031 | Database, SQL, Hi/Lo sequences and seeding. The scope says out. |
| RULE-030 | Seeding is out, so the seed is used only as the cases' test data. Its suspected defects are not checked: inconsistent prices, near-duplicate names for Ids 3 and 12, and hoodies typed as T-Shirt. |
| RULE-015, RULE-023 | The customization CSV import and the customization seed. The scope says out. |
| RULE-007/AC-2 (overposting Id and PictureFileName), RULE-009 save rules, RULE-011, RULE-012, RULE-013, RULE-014, RULE-018, RULE-020, RULE-021, RULE-022, RULE-033/AC-1 (saved with `dummy.png`) | They need POST, and the scope is read-only. |
| RULE-024 | `DELETE api/brands/{id}`, and the scope is read-only. Reading brands is covered by REQ-4. |
| RULE-026 | Its criterion is creating an item anonymously, which needs POST. Q-12 covers how the decision affects these cases. |
| RULE-008 (P0) | Picture path traversal needs a stored file name such as `..\Web.config`. Only a POST (RULE-007) or the database can set one. **Flagged for a security plan.** |
| RULE-010 (missing file, null file name), RULE-032 (other extensions; `.PNG` in upper case) | They need pictures that differ from the seed, which has only `.png` files that exist. Changing data is out. See Q-10. |
| RULE-017, RULE-029 | Startup config switches, which a read-only request cannot see. RULE-029 decides the mode (Q-1). |
| RULE-025 | Session state and logging happen on the server, so nothing in a response can be checked. |
| RULE-027 deserializer | The input says `DeserializeBinary` has no HTTP caller. |

Besides RULE-008, three P0 suspected defects outside this scope need a later decision:
- RULE-007 together with RULE-008: an anonymous file read through overposting;
- RULE-026: anonymous writes;
- RULE-027: BinaryFormatter.

## Questions

1. **Q-1. Mode and data.**
   - Does the system under test run with `UseMockData=false` (SQL, as shipped) or `true` (the in-memory mock)? RULE-004's order by Id describes the SQL service.
   - Is the catalog reset to the built-in seed before each run (12 items with Ids 1 to 12, 5 brands, 4 types, `UseCustomizationData=false`)? Every list, picture and files case depends on it.
2. **Q-2. Keep the quirks or fix them?** The input describes today's code. Is this plan checking the intended behaviour, or parity with the legacy system, quirks included?
   - **Intended behaviour (the default here):** each suspected defect stays a question below.
   - **Parity:** say so, and those defects can be pinned as "kept for parity".
3. **Q-3. Paging inputs** (RULE-004, RULE-005). For each, keep or fix, and what should the answer be: 400, the first page, or something else?
   - a. A negative pageIndex (CAT-PAGE-05). The rule says it throws and shows an error page. Note that the hidden Previous link on page 1 points to `pageIndex=-1`.
   - b. No cap on pageSize (CAT-PAGE-06). Should there be a maximum, and what value?
   - c. pageSize × pageIndex past the int range (CAT-PAGE-07).
   - d. A pageSize of 0, which throws DivideByZero (CAT-PAGE-08).
   - e. A negative pageSize, which gives negative TotalPages or throws (CAT-PAGE-09).
4. **Q-4. Pager summary** (RULE-006). Keep or fix each of these?
   - On the last page, "Showing 10 of 12" prints the page size, not the 2 items shown. CAT-PAGE-01 checks only the rest of the text.
   - An empty catalog shows "Page 1 - 0" (MAN-5).
5. **Q-5. Error pages** (RULE-028; the input already marks this for SME confirmation).
   - What does `Web.Release.config` set for `customErrors`?
   - Should error pages hide details? Debug compilation is on in the shipped config.

   The answers set the expectations for the Q-3 cases.
6. **Q-6. Entry point** (REQ-1). What should `/` show: the catalog list, or a redirect to it? CAT-ENTRY-01 expects only 200.
7. **Q-7. API root** (REQ-3). The input never mentions one. Which address is it (`/api`?), and what should it answer?
8. **Q-8. Reading brands through the API** (REQ-4). The input describes only `DELETE api/brands/{id}` (RULE-024).
   - Is there a GET for the list and for one brand?
   - What status and format should they answer with?
   - Should an unknown id give 404, as DELETE does?
9. **Q-9. Files API format** (RULE-027). BinaryFormatter output is a suspected defect: it is insecure, and .NET 8 cannot produce it. Keep it, replace it (with JSON, say), or remove the endpoint?
   - API-FILES-01 checks only the status and the brand names. Those hold for BinaryFormatter and for a text format.
   - It also assumes the tool reads a binary body as text.
   - If the endpoint is removed, the case must change.
10. **Q-10. Pictures** (RULE-010, RULE-032). Keep or fix each of these? None is drafted, because each needs test data that differs from the seed.
    - A missing picture file gives 500, not 404.
    - A null file name throws.
    - `.PNG` in upper case is served as `application/octet-stream`.
    - `.tif` is not mapped.
11. **Q-11. Picture URL scheme** (RULE-002). The URL takes the request's scheme, which can be wrong behind a TLS-terminating proxy. Keep or fix? Is the test environment behind such a proxy (MAN-1)?
12. **Q-12. Login** (RULE-026). Any anonymous visitor can create, edit and delete items. Keep that as a demo choice, or fix it?
    - The form cases check the forms, not that they are anonymous.
    - If a login is added, the run supplies credentials through `headers_from_env`, under a variable name to agree (for example `CMTK_AUTH`). A case never holds its value.

## Ids made for this plan

- **AC numbers.** The input numbers only its rules, so every `/AC-n` after a RULE id is mine.
  - Out-of-scope criteria I numbered: RULE-007/AC-2 and RULE-033/AC-1.
- **REQ ids,** for scope areas or skill rules that no rule in the input covers:
  - **REQ-1:** the entry point;
  - **REQ-2:** an unknown address;
  - **REQ-3:** the API root;
  - **REQ-4:** reading brands through the API.
