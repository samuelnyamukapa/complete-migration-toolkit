# Business Rules — eshop

At extraction: 33 confirmed rules (9 P0); later steps may add or correct rules below. Each citation was checked by a second agent that read the cited lines; 0 candidate rules were refuted and left out.

| ID | Name | Category | Priority | Source | Confidence |
|---|---|---|---|---|---|
| RULE-001 | Catalog item Ids come from a Hi/Lo generator in blocks of 10 | Calculation | P0 | `src/eShopLegacyMVC/Models/CatalogItemHiLoGenerator.cs:16-33` | High |
| RULE-002 | Picture URI is built from the item picture route | Calculation | P1 | `src/eShopLegacyMVC/Controllers/CatalogController.cs:160-163` | High |
| RULE-003 | Brand and type seed Ids come from one sequence value incremented per row | Calculation | P1 | `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:51-57` | High |
| RULE-004 | Catalog list is paged and ordered by Id | Calculation | P1 | `src/eShopLegacyMVC/Services/CatalogService.cs:21-35` | High |
| RULE-005 | Total pages is items divided by page size, rounded up | Calculation | P1 | `src/eShopLegacyMVC/ViewModel/PaginatedItemsViewModel.cs:23` | High |
| RULE-006 | Pager shows Previous/Next and a page summary | Calculation | P2 | `src/eShopLegacyMVC/Views/Catalog/Index.cshtml:19-39` | High |
| RULE-007 | Model binding whitelist includes Id and PictureFileName | Validation | P0 | `src/eShopLegacyMVC/Controllers/CatalogController.cs:62` | High |
| RULE-008 | Picture file path is not contained to the Pics folder | Validation | P0 | `src/eShopLegacyMVC/Controllers/PicController.cs:38-46` | High |
| RULE-009 | Create and Edit save only when the model is valid; POSTs need an anti-forgery t… | Validation | P1 | `src/eShopLegacyMVC/Controllers/CatalogController.cs:60-74` | High |
| RULE-010 | Picture endpoint validates the Id and item, then reads the file | Validation | P1 | `src/eShopLegacyMVC/Controllers/PicController.cs:23-50` | High |
| RULE-011 | Item name is required; name length limit exists only in the database | Validation | P1 | `src/eShopLegacyMVC/Models/CatalogDBContext.cs:38-75` | High |
| RULE-012 | Brand and type must reference existing rows | Validation | P1 | `src/eShopLegacyMVC/Models/CatalogDBContext.cs:79-85` | Medium |
| RULE-013 | Item price must be 0 to 1,000,000 with at most two decimals | Validation | P1 | `src/eShopLegacyMVC/Models/CatalogItem.cs:21-25` | High |
| RULE-014 | Stock, restock and max-stock must each be 0 to 10,000,000 | Validation | P1 | `src/eShopLegacyMVC/Models/CatalogItem.cs:44-57` | High |
| RULE-015 | Customization CSV import validation (when UseCustomizationData is true) | Validation | P1 | `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:192-296` | Medium |
| RULE-016 | Details, Edit and Delete pages need an Id: missing gives 400, unknown gives 404 | Validation | P2 | `src/eShopLegacyMVC/Controllers/CatalogController.cs:31-46` | High |
| RULE-017 | Config switches fail startup if missing or not boolean | Validation | P2 | `src/eShopLegacyMVC/Global.asax.cs:68-69` | High |
| RULE-018 | Delete item is a hard delete with no guards | Lifecycle | P0 | `src/eShopLegacyMVC/Controllers/CatalogController.cs:132-140` | High |
| RULE-019 | Database is created and seeded only if it does not exist | Lifecycle | P0 | `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:15-43` | High |
| RULE-020 | Create item assigns a fresh Id and saves | Lifecycle | P0 | `src/eShopLegacyMVC/Services/CatalogService.cs:51-56` | High |
| RULE-021 | Update item overwrites every column with last-write-wins | Lifecycle | P0 | `src/eShopLegacyMVC/Services/CatalogService.cs:58-62` | High |
| RULE-022 | No cross-field stock rules; OnReorder is never derived | Lifecycle | P1 | `src/eShopLegacyMVC/Models/CatalogItem.cs:44-62` | Medium |
| RULE-023 | Customization seed wipes the Pics folder before extracting the zip | Lifecycle | P1 | `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:339-354` | High |
| RULE-024 | Brands API: unknown Id gives 404; Delete is a no-op that returns 200 | Lifecycle | P2 | `src/eShopLegacyMVC/Controllers/WebApi/BrandsController.cs:38-50` | High |
| RULE-025 | Session start stamps machine name and time; each request is logged | Lifecycle | P2 | `src/eShopLegacyMVC/Global.asax.cs:41-54` | High |
| RULE-026 | No authentication or authorization on any action | Policy | P0 | `src/eShopLegacyMVC/App_Start/FilterConfig.cs:8-11` | High |
| RULE-027 | Files API returns BinaryFormatter output; deserializer is unguarded | Policy | P0 | `src/eShopLegacyMVC/Controllers/WebApi/FilesController.cs:21-36` | High |
| RULE-028 | Unhandled errors go to the shared error view | Policy | P1 | `src/eShopLegacyMVC/App_Start/FilterConfig.cs:8-11` | Medium |
| RULE-029 | UseMockData selects the in-memory or SQL catalog service | Policy | P1 | `src/eShopLegacyMVC/Global.asax.cs:68-69` | High |
| RULE-030 | Built-in seed catalog: 12 items, 5 brands, 4 types | Policy | P1 | `src/eShopLegacyMVC/Models/Infrastructure/PreconfiguredData.cs:14-25` | High |
| RULE-031 | Hi/Lo sequences are defined in SQL scripts | Policy | P1 | `src/eShopLegacyMVC/Models/Infrastructure/dbo.catalog_hilo.Sequence.sql:4-10` | Medium |
| RULE-032 | Picture MIME type comes from a fixed, case-sensitive extension map | Policy | P2 | `src/eShopLegacyMVC/Controllers/PicController.cs:52-89` | High |
| RULE-033 | New items default to the picture dummy.png | Policy | P2 | `src/eShopLegacyMVC/Models/CatalogItem.cs:8-13` | High |

## Calculation

### RULE-001: Catalog item Ids come from a Hi/Lo generator in blocks of 10
**Category:** Calculation
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Models/CatalogItemHiLoGenerator.cs:16-33`
**Plain English:** Each new item Id is taken from an in-memory block: the app reads NEXT VALUE FOR catalog_hilo once, uses it as the first Id, then hands out the next 9 Ids (+1 each) before asking the database again.
**Specification:**
  Given a fresh generator and the sequence returning 1
  When  11 items are created
  Then  Ids 1-10 come from the first fetch and the 11th triggers a new fetch (returns 11 if the sequence steps by 10 from 1)
**Parameters:** HiLoIncrement=10; sequence name catalog_hilo hardcoded; lock is process-local
**Edge cases handled:** After a restart the unused Ids of the block are skipped, so Ids have gaps; Two instances stay unique only because the shared SQL sequence gives each a distinct block; A rollback does not return Ids
**Suspected defect:** The block size 10 is duplicated in C# and in the SQL INCREMENT BY 10, so they must stay in sync or Ids collide; the bigint is cast to int (overflow past 2.1 billion); field 'remainningLoIds' is misspelled.
**Confidence:** High

### RULE-002: Picture URI is built from the item picture route
**Category:** Calculation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Controllers/CatalogController.cs:160-163`
**Plain English:** PictureUri is an absolute URL to the item's picture route (items/{id}/pic) using the current request's scheme; it is not persisted.
**Specification:**
  Given item Id 7 on https://shop.example/
  When  the item is displayed
  Then  PictureUri = https://shop.example/items/7/pic
**Parameters:** route template items/{catalogItemId:int}/pic; route name GetPicRouteTemplate (Controllers/PicController.cs:24)
**Edge cases handled:** Not persisted (Models/CatalogDBContext.cs:77 ignores it)
**Suspected defect:** Create/Edit POST re-display paths do not set PictureUri; Request.Url.Scheme can be wrong behind a TLS-terminating proxy.
**Confidence:** High

### RULE-003: Brand and type seed Ids come from one sequence value incremented per row
**Category:** Calculation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:51-57`
**Plain English:** The first sequence value is fetched once and each preconfigured type or brand gets that value plus one per row (types 1-4, brands 1-5 on a fresh sequence); the other 9 numbers of the block are not reserved.
**Specification:**
  Given a new sequence and 4 types
  When  seeding runs
  Then  type Ids are 1, 2, 3, 4
**Parameters:** same pattern for brands at lines 68-74
**Edge cases handled:** Seeded items hardcode CatalogTypeId and CatalogBrandId, which only match on a fresh sequence
**Suspected defect:** A non-fresh sequence would break the hardcoded item foreign keys.
**Confidence:** High

### RULE-004: Catalog list is paged and ordered by Id
**Category:** Calculation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Services/CatalogService.cs:21-35`
**Plain English:** The catalog list is sorted by Id ascending; page N skips pageSize x pageIndex items and takes pageSize (pages are 0-based; defaults are page size 10 and page 0).
**Specification:**
  Given 12 items with Ids 1-12, pageSize 10
  When  pageIndex 1 is requested
  Then  Items 11 and 12 are shown; pageIndex 5 returns an empty page with no error
**Parameters:** default pageSize=10, pageIndex=0 (Controllers/CatalogController.cs:22); sort key Id ascending
**Edge cases handled:** Out-of-range pageIndex returns an empty page; No upper cap on pageSize (a user can request the whole table); Negative skip/take throws, giving an error page
**Suspected defect:** pageSize * pageIndex is int arithmetic and can overflow; negative or zero inputs are not validated; no maximum page size.
**Confidence:** High

### RULE-005: Total pages is items divided by page size, rounded up
**Category:** Calculation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/ViewModel/PaginatedItemsViewModel.cs:23`
**Plain English:** TotalPages = ceiling of total item count divided by page size, using decimal division.
**Specification:**
  Given 12 items and pageSize 10
  When  the paged view model is built
  Then  TotalPages = 2; with 0 items TotalPages = 0
**Parameters:** (int)Math.Ceiling((decimal)count / pageSize)
**Edge cases handled:** Zero items gives 0 pages
**Suspected defect:** pageSize 0 throws DivideByZeroException; a negative pageSize gives a negative TotalPages.
**Confidence:** High

### RULE-006: Pager shows Previous/Next and a page summary
**Category:** Calculation
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Views/Catalog/Index.cshtml:19-39`
**Plain English:** Previous is active only above page 0, Next only below the last page; the text reads 'Showing {ItemsPerPage} of {TotalItems} products - Page {ActualPage+1} - {TotalPages}'.
**Specification:**
  Given 12 items, page size 10, page 0
  When  the list renders
  Then  'Showing 10 of 12 products - Page 1 - 2', Previous hidden, Next active
**Parameters:** hidden class esh-pager-item--hidden; display offset +1
**Edge cases handled:** Hidden links still carry pageIndex -1 or +1 in their URLs
**Suspected defect:** 'Showing N' prints the page size, not the real count on the page (last page with 2 items still says 'Showing 10 of 12'); zero items shows 'Page 1 - 0'.
**Confidence:** High

## Validation

### RULE-007: Model binding whitelist includes Id and PictureFileName
**Category:** Validation
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Controllers/CatalogController.cs:62`
**Plain English:** Create and Edit bind Id, Name, Description, Price, PictureFileName, CatalogTypeId, CatalogBrandId, AvailableStock, RestockThreshold, MaxStockThreshold and OnReorder, so a hand-crafted POST can set the picture file name even though the UI marks it read-only.
**Specification:**
  Given a hand-crafted POST to Edit with PictureFileName=..\..\Web.config and a valid token
  When  it is posted
  Then  the value is saved (the browser-only readonly attribute does not protect it)
**Parameters:** Bind include list (same at line 100); comment at lines 58-59 claims overposting protection
**Edge cases handled:** Id is overwritten on Create but client-supplied on Edit and chooses which row updates
**Suspected defect:** Comment claims overposting protection but Id and PictureFileName are bindable; this feeds the picture path traversal rule.
**Confidence:** High

### RULE-008: Picture file path is not contained to the Pics folder
**Category:** Validation
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Controllers/PicController.cs:38-46`
**Plain English:** The server joins ~/Pics with the stored PictureFileName and returns the file without checking the result stays inside Pics; a name with ..\ or a rooted path escapes the folder.
**Specification:**
  Given an item whose PictureFileName is ..\Web.config
  When  anyone requests /items/{id}/pic
  Then  the server returns the contents of Web.config as application/octet-stream
**Parameters:** root ~/Pics; no extension allow-list
**Edge cases handled:** Path.Combine discards the first argument when the second is rooted
**Suspected defect:** Path traversal / arbitrary file read, reachable anonymously via the bind-whitelist and no-auth rules.
**Confidence:** High

### RULE-009: Create and Edit save only when the model is valid; POSTs need an anti-forgery token
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Controllers/CatalogController.cs:60-74`
**Plain English:** Create, Edit and Delete-confirm are POST-only with a required anti-forgery token; the item is saved only when ModelState is valid, otherwise the form is redisplayed with brand and type lists repopulated.
**Specification:**
  Given an invalid item
  When  it is posted
  Then  the form is shown again with no write; a valid item is saved and redirects to Index
**Parameters:** [ValidateAntiForgeryToken] at lines 61, 99, 133
**Edge cases handled:** GET /Catalog/Delete/{id} only renders the confirmation page; The Web API delete has no equivalent token
**Confidence:** High

### RULE-010: Picture endpoint validates the Id and item, then reads the file
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Controllers/PicController.cs:23-50`
**Plain English:** GET items/{id}/pic returns 400 for Id <= 0, 404 for an unknown item, otherwise the bytes of the item's picture file with a MIME type from the file extension.
**Specification:**
  Given item 1 with PictureFileName 1.png present
  When  GET /items/1/pic
  Then  the PNG bytes are returned as image/png; Id 0 gives 400; an unknown item gives 404
**Parameters:** folder ~/Pics; route constraint :int
**Edge cases handled:** A missing file throws (500), not 404; A null PictureFileName makes Path.Combine throw
**Suspected defect:** A missing picture file is not handled as not found.
**Confidence:** High

### RULE-011: Item name is required; name length limit exists only in the database
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/CatalogDBContext.cs:38-75`
**Plain English:** An item needs a name (max 50 characters at the database level); brand and type names are required with a max of 100; price and picture file name are required.
**Specification:**
  Given a 60-character item name
  When  it is saved
  Then  the form passes [Required] but SaveChanges fails with an entity-validation exception shown as an error page, not a field message
**Parameters:** Name max 50; Brand max 100; Type max 100 (Models/CatalogItem.cs:16-17 holds the [Required])
**Edge cases handled:** The mock service has no length limit
**Suspected defect:** The 50-character limit is not a model attribute, so users get no friendly message.
**Confidence:** High

### RULE-012: Brand and type must reference existing rows
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/CatalogDBContext.cs:79-85`
**Plain English:** Every item needs an existing brand and type, enforced by required relationships and foreign keys; an unselected value binds as 0.
**Specification:**
  Given a POST with CatalogBrandId=99
  When  it is saved
  Then  the database rejects it and the user sees the error page
**Parameters:** seed brands 1-5 and types 1-4
**Edge cases handled:** The mock service does not check this and fails later in ComposeCatalogItems via First()
**Suspected defect:** Failure surfaces as an unhandled error rather than a form error.
**Confidence:** Medium — Should an invalid brand/type produce a validation message? (Behavior inferred from the EF mapping, not run.)

### RULE-013: Item price must be 0 to 1,000,000 with at most two decimals
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/CatalogItem.cs:21-25`
**Plain English:** Price must be a non-negative number, no more than 1,000,000, with at most two decimal places.
**Specification:**
  Given a Create or Edit form with Price 19.999
  When  it is submitted
  Then  it is rejected with 'The field Price must be a positive number with maximum two decimals.'; 19.50 and 0 are accepted; 1000000.01 fails the Range rule
**Parameters:** regex ^\d+(\.\d{0,2})*$; Range 0-1000000; decimal(18,2) is a comment only
**Edge cases handled:** Culture is fixed to en-US so a decimal comma is rejected
**Suspected defect:** The (\.\d{0,2})* group allows '1.' and '1.5.5'; the message says 'positive' but 0 is accepted.
**Confidence:** High

### RULE-014: Stock, restock and max-stock must each be 0 to 10,000,000
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/CatalogItem.cs:44-57`
**Plain English:** AvailableStock, RestockThreshold and MaxStockThreshold must each be between 0 and 10 million.
**Specification:**
  Given AvailableStock = -1
  When  the form is submitted
  Then  it is rejected with 'The field Stock must be between 0 and 10 million.'; 10,000,000 is accepted
**Parameters:** min 0, max 10,000,000 for all three fields
**Edge cases handled:** Non-integer or overflowing input fails model binding with a generic message
**Confidence:** High

### RULE-015: Customization CSV import validation (when UseCustomizationData is true)
**Category:** Validation
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:192-296`
**Plain English:** With UseCustomizationData=true, seed rows come from Setup/*.csv (falling back per file to built-in data if a file is missing) and the whole seed aborts if a header is missing, a column count differs, a type or brand is unknown, or a price or integer is not parseable.
**Specification:**
  Given a CSV row with price '12,5'
  When  seeding runs
  Then  it throws 'price=12,5is not a valid decimal number'
**Parameters:** required headers catalogtypename, catalogbrandname, description, name, price, pictureFileName; optional availablestock, restockthreshold, maxstockthreshold, onreorder; price parsed with AllowDecimalPoint and InvariantCulture (no thousands separator, no minus sign)
**Edge cases handled:** Type and brand lookups are case-sensitive; A blank trailing line fails the column-count check; CSV rows skip the model range rules and the 50-character name limit
**Suspected defect:** Brand-not-found error (line 208) reports the type name; restock and max-stock errors print the unassigned out variable (lines 256, 273).
**Confidence:** Medium — Is the customization CSV import a supported feature or demo-only? (The CSV files were not exercised.)

### RULE-016: Details, Edit and Delete pages need an Id: missing gives 400, unknown gives 404
**Category:** Validation
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Controllers/CatalogController.cs:31-46`
**Plain English:** Single-item screens return Bad Request for a missing Id and Not Found for an Id with no item.
**Specification:**
  Given /Catalog/Details with no id, or id 9999 with no item
  When  requested
  Then  400 for no id; 404 for no item
**Parameters:** HTTP 400 and 404; same pattern at lines 77-93 and 114-129
**Edge cases handled:** A non-numeric id binds to null and returns 400
**Confidence:** High

### RULE-017: Config switches fail startup if missing or not boolean
**Category:** Validation
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Global.asax.cs:68-69`
**Plain English:** UseMockData and UseCustomizationData are read with bool.Parse and have no defaults, so a missing key or a value like 'yes' stops the app at startup.
**Specification:**
  Given UseMockData absent from config
  When  the app starts
  Then  startup fails
**Parameters:** both shipped false (Web.config:19-20); also CatalogDBInitializer.cs:29
**Confidence:** High

## Lifecycle

### RULE-018: Delete item is a hard delete with no guards
**Category:** Lifecycle
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Controllers/CatalogController.cs:132-140`
**Plain English:** Delete is a confirmation page followed by an anti-forgery-protected POST that permanently removes the row; no soft-delete, no stock or reorder check, and the picture file stays on disk.
**Specification:**
  Given item 3 exists
  When  the user confirms Delete
  Then  the row is deleted, the user is redirected to Index, and Pics/3.png remains
**Parameters:** none
**Edge cases handled:** An unknown or already-deleted Id makes FindCatalogItem return null and Remove(null) throws (HTTP 500), unlike the GET handler which returns 404; Items with stock or on reorder can still be deleted
**Suspected defect:** Missing null check; orphan picture files accumulate.
**Confidence:** High

### RULE-019: Database is created and seeded only if it does not exist
**Category:** Lifecycle
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:15-43`
**Plain English:** On first context use, if the database is missing it is created and seeded in order: three sequences, then types, brands and items (a save after each), then pictures if customization is on; an existing database is never changed or migrated.
**Specification:**
  Given no database 'Microsoft.eShopOnContainers.Services.CatalogDb'
  When  the first query runs
  Then  the schema is created and seeded with 4 types, 5 brands and 12 items
**Parameters:** sequences catalog_hilo, catalog_brand_hilo, catalog_type_hilo (START 1 INCREMENT 10); connection (localdb)\MSSQLLocalDB with integrated security (Web.config:12)
**Edge cases handled:** The initializer runs lazily on first context use, not at startup; No transaction around seeding: a failure midway leaves a partial database that is never re-seeded
**Suspected defect:** Partial-seed risk; database name duplicated in config and scripts.
**Confidence:** High

### RULE-020: Create item assigns a fresh Id and saves
**Category:** Lifecycle
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Services/CatalogService.cs:51-56`
**Plain English:** A valid submitted item gets a new Hi/Lo Id (any posted Id is overwritten), is inserted, and the user is redirected to the list.
**Specification:**
  Given a valid form (Name, Price, Brand, Type, Stock)
  When  it is posted with a valid anti-forgery token
  Then  Id is the next Hi/Lo value, the row is inserted, and the user is redirected to Index; an invalid form is redisplayed with nothing saved
**Parameters:** bound fields listed in the bind-whitelist rule; anti-forgery required
**Edge cases handled:** Invalid brand/type fails at database level with an unhandled exception; No uniqueness check on Name; No consistency check on thresholds
**Suspected defect:** Description has no max length; Name length failure surfaces at save time.
**Confidence:** High

### RULE-021: Update item overwrites every column with last-write-wins
**Category:** Lifecycle
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Services/CatalogService.cs:58-62`
**Plain English:** Edit marks the posted object as Modified and saves all columns; there is no concurrency token and the item's existence is not checked first.
**Specification:**
  Given two users open item 7
  When  each saves in turn
  Then  the last save silently wins
**Parameters:** no RowVersion/timestamp
**Edge cases handled:** The posted Id is trusted, so a crafted post can update any item; A non-existent Id causes a database concurrency exception; Fields omitted from the form are overwritten with null or default; The mock service silently ignores an update of a missing item
**Suspected defect:** Lost-update risk; no optimistic concurrency.
**Confidence:** High

### RULE-022: No cross-field stock rules; OnReorder is never derived
**Category:** Lifecycle
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/CatalogItem.cs:44-62`
**Plain English:** Nothing enforces AvailableStock <= MaxStockThreshold or RestockThreshold <= MaxStockThreshold, and nothing sets OnReorder from stock versus threshold; all four are plain stored values that users edit by hand.
**Specification:**
  Given AvailableStock 500 and MaxStockThreshold 100
  When  the item is saved
  Then  it is accepted, and OnReorder stays whatever the user posted
**Parameters:** seed stock is 100 per built-in item; seeded thresholds are 0
**Edge cases handled:** The sample CSV has onreorder=true with stock 89; No code decrements stock
**Suspected defect:** Reorder/stock logic that existed in eShopOnContainers is absent: either a missing invariant or an unimplemented feature.
**Confidence:** Medium — Must stock never exceed the max threshold, and should OnReorder be derived (AvailableStock <= RestockThreshold)? Is a reorder process expected in the rewrite or are these just stored values?

### RULE-023: Customization seed wipes the Pics folder before extracting the zip
**Category:** Lifecycle
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/Infrastructure/CatalogDBInitializer.cs:339-354`
**Plain English:** With UseCustomizationData=true, every file in Pics (including dummy.png) is deleted and then Setup/CatalogItems.zip is extracted into it; there is no check the zip exists or is valid.
**Specification:**
  Given UseCustomizationData=true and no CatalogItems.zip
  When  the database is first created
  Then  all existing pictures are deleted and initialization then fails
**Parameters:** folders Pics and Setup; UseCustomizationData=false shipped (Web.config:20)
**Edge cases handled:** GetFiles throws if Pics is missing; Zip entries with .. depend on framework handling; Wipe and extract still run when only CSVs are missing
**Suspected defect:** Destructive step happens before validation.
**Confidence:** High

### RULE-024: Brands API: unknown Id gives 404; Delete is a no-op that returns 200
**Category:** Lifecycle
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Controllers/WebApi/BrandsController.cs:38-50`
**Plain English:** DELETE api/brands/{id} returns 200 if the brand exists and 404 if not, but never deletes anything (comment: 'demo only'); the endpoint is anonymous.
**Specification:**
  Given brand 2 exists
  When  DELETE api/brands/2
  Then  200 is returned and brand 2 still exists
**Parameters:** none
**Edge cases handled:** No anti-forgery or auth
**Suspected defect:** Clients may believe the delete succeeded.
**Confidence:** High

### RULE-025: Session start stamps machine name and time; each request is logged
**Category:** Lifecycle
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Global.asax.cs:41-54`
**Plain English:** A new session stores the server machine name and start time in in-process session state, and each request sets an activity id and logs a debug line; controller actions log user-supplied values.
**Specification:**
  Given a new visitor
  When  the first request arrives
  Then  Session MachineName and SessionStartTime are set
**Parameters:** sessionState mode=InProc; log4net config log4net.xml
**Edge cases handled:** The stored values are not read by first-party code; Raw request values are written to logs (CatalogController.cs:24, 64)
**Suspected defect:** In-proc session blocks scaling out; unsanitized values in logs allow log forging.
**Confidence:** High

## Policy

### RULE-026: No authentication or authorization on any action
**Category:** Policy
**Priority:** P0
**Source:** `src/eShopLegacyMVC/App_Start/FilterConfig.cs:8-11`
**Plain English:** No [Authorize] attribute, login or role exists; the only global filter is HandleErrorAttribute, so any anonymous visitor can create, edit and delete catalog items and call the Web API.
**Specification:**
  Given an anonymous user
  When  they open /Catalog/Create and submit a valid item with a valid anti-forgery token
  Then  the item is created
**Parameters:** none
**Edge cases handled:** Session state only records machine name and start time; it is not an access check
**Suspected defect:** Missing authorization on write actions (may be a demo choice).
**Confidence:** High

### RULE-027: Files API returns BinaryFormatter output; deserializer is unguarded
**Category:** Policy
**Priority:** P0
**Source:** `src/eShopLegacyMVC/Controllers/WebApi/FilesController.cs:21-36`
**Plain English:** api/files returns the brand list serialized with BinaryFormatter to any anonymous caller; the shared utility also exposes DeserializeBinary with no type allow-list or size limit (eShopLegacy.Utilities/Serializing.cs:8-22).
**Specification:**
  Given an anonymous GET api/files
  When  it is called
  Then  a binary-serialized list of brand objects (Id int, Brand string) is returned
**Parameters:** BinaryFormatter; BrandDTO {Id, Brand}
**Edge cases handled:** No first-party caller of DeserializeBinary was found; BinaryFormatter is removed or disabled in modern .NET
**Suspected defect:** Insecure serialization (deserialization of untrusted data allows remote code execution) and a wire format .NET 8 cannot reproduce.
**Confidence:** High

### RULE-028: Unhandled errors go to the shared error view
**Category:** Policy
**Priority:** P1
**Source:** `src/eShopLegacyMVC/App_Start/FilterConfig.cs:8-11`
**Plain English:** HandleErrorAttribute is the only global filter, so unhandled MVC errors (null delete, missing picture, negative paging, foreign-key failures) show the shared Error view when custom errors are enabled; Web API controllers do not use it.
**Specification:**
  Given an unhandled exception in an MVC action
  When  it propagates
  Then  the Error view is shown, subject to customErrors settings
**Parameters:** <compilation debug="true"> in Web.config:31; no customErrors element found in the main Web.config
**Edge cases handled:** Web.Release.config was not opened
**Suspected defect:** Debug compilation is enabled in the shipped config.
**Confidence:** Medium — What does Web.Release.config set for customErrors?

### RULE-029: UseMockData selects the in-memory or SQL catalog service
**Category:** Policy
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Global.asax.cs:68-69`
**Plain English:** App setting UseMockData (shipped false) picks the catalog service at startup: true registers a shared in-memory mock seeded with the 12 preconfigured items and no database initializer; false registers the SQL service per request and sets the EF initializer.
**Specification:**
  Given UseMockData=true
  When  an item is created
  Then  it gets Id = max + 1, lives only in memory and is shared by all users
**Parameters:** UseMockData=false (Web.config:19); wiring also at Global.asax.cs:85-90 and Modules/ApplicationModule.cs:18-38
**Edge cases handled:** Mock Max() throws on an empty list; Mock does not enforce length limits or foreign keys and mutates stored items when composing lists; Mock list is not thread-safe; Pictures are still read from disk
**Suspected defect:** The mock diverges from the real service in validation, Id assignment and concurrency.
**Confidence:** High

### RULE-030: Built-in seed catalog: 12 items, 5 brands, 4 types
**Category:** Policy
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/Infrastructure/PreconfiguredData.cs:14-25`
**Plain English:** The built-in seed has 12 items (stock 100, thresholds 0, OnReorder false, prices 8.50, 12 or 19.50, pictures {Id}.png), 5 brands (Azure, .NET, Visual Studio, SQL Server, Other) and 4 types (Mug, T-Shirt, Sheet, USB Memory Stick).
**Specification:**
  Given a fresh database with UseCustomizationData=false
  When  seeding runs
  Then  these rows are inserted; the mock service uses the same constants directly
**Parameters:** 12 items, 5 brands, 4 types; AvailableStock 100; picture {Id}.png
**Edge cases handled:** The real database overwrites Ids (Hi/Lo), matching the seed only by accident
**Suspected defect:** Inconsistent seed prices, near-duplicate names for Ids 3 and 12, hoodies typed as T-Shirt, thresholds 0 so nothing would trigger reorder.
**Confidence:** High

### RULE-031: Hi/Lo sequences are defined in SQL scripts
**Category:** Policy
**Priority:** P1
**Source:** `src/eShopLegacyMVC/Models/Infrastructure/dbo.catalog_hilo.Sequence.sql:4-10`
**Plain English:** Three bigint sequences (catalog_hilo, catalog_brand_hilo, catalog_type_hilo) start at 1 and step by 10.
**Specification:**
  Given a new database
  When  the initializer runs the sequence scripts
  Then  the three sequences exist with START 1 and INCREMENT 10
**Parameters:** START 1, INCREMENT 10
**Edge cases handled:** The scripts hardcode USE [Microsoft.eShopOnContainers.Services.CatalogDb]
**Suspected defect:** Database name is duplicated in the scripts and in Web.config; the type sequence script was not opened by the extractor.
**Confidence:** Medium — Is the app database always named Microsoft.eShopOnContainers.Services.CatalogDb, and does catalog_type_hilo also step by 10?

### RULE-032: Picture MIME type comes from a fixed, case-sensitive extension map
**Category:** Policy
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Controllers/PicController.cs:52-89`
**Plain English:** The content type is chosen from the file extension: .png, .gif, .jpg/.jpeg, .bmp, .tiff, .wmf, .jp2, .svg map to image types; anything else is application/octet-stream.
**Specification:**
  Given a picture named A.PNG
  When  it is served
  Then  the type is application/octet-stream because .PNG does not match .png
**Parameters:** png=image/png, gif=image/gif, jpg and jpeg=image/jpeg, bmp=image/bmp, tiff=image/tiff, wmf=image/wmf, jp2=image/jp2, svg=image/svg+xml, other=application/octet-stream
**Edge cases handled:** .tif is not mapped, only .tiff; Unknown types are still served; SVG is served as image/svg+xml
**Suspected defect:** Case-sensitive match; no extension allow-list.
**Confidence:** High

### RULE-033: New items default to the picture dummy.png
**Category:** Policy
**Priority:** P2
**Source:** `src/eShopLegacyMVC/Models/CatalogItem.cs:8-13`
**Plain English:** A new CatalogItem starts with PictureFileName 'dummy.png'; the Create form has no picture field, so this is the only picture a user can normally give an item.
**Specification:**
  Given the Create form is opened and saved without a picture field
  When  the item is saved
  Then  PictureFileName = dummy.png
**Parameters:** DefaultPictureName = dummy.png
**Edge cases handled:** Items loaded from the database or CSV overwrite the default; A bound null overwrites the default and fails the required constraint
**Confidence:** High

## Rules requiring SME confirmation

- **RULE-012** (Medium): Should an invalid brand/type produce a validation message? (Behavior inferred from the EF mapping, not run.)
- **RULE-015** (Medium): Is the customization CSV import a supported feature or demo-only? (The CSV files were not exercised.)
- **RULE-022** (Medium): Must stock never exceed the max threshold, and should OnReorder be derived (AvailableStock <= RestockThreshold)? Is a reorder process expected in the rewrite or are these just stored values?
- **RULE-028** (Medium): What does Web.Release.config set for customErrors?
- **RULE-031** (Medium): Is the app database always named Microsoft.eShopOnContainers.Services.CatalogDb, and does catalog_type_hilo also step by 10?

## Rules folded into another

These rules described the same behavior as another rule in a different place, so they were merged into it (the kept rule lists their locations under "Also cited"):

- Default paging parameters (Controllers/CatalogController.cs:22) into Catalog list is paged and ordered by Id
- Paging parameters are not validated (Controllers/CatalogController.cs:22-28) into Catalog list is paged and ordered by Id
- Mock-service ID generation (Services/CatalogServiceMock.cs:50-52) into UseMockData selects the in-memory or SQL catalog service
- Item name is required (Models/CatalogItem.cs:16-17) into Item name is required; name length limit exists only in the database
- Field length limits (Models/CatalogDBContext.cs:38-75) into Item name is required; name length limit exists only in the database
- Seed CSV validation (Models/Infrastructure/CatalogDBInitializer.cs:192-215) into Customization CSV import validation (when UseCustomizationData is true)
- Stock fields and OnReorder have no lifecycle (Models/CatalogItem.cs:44-62) into No cross-field stock rules; OnReorder is never derived
- Item field validations and defaults (Models/CatalogItem.cs:16-57) into Item price must be 0 to 1,000,000 with at most two decimals
- Picture serving and file naming (Controllers/PicController.cs:24-89) into Picture endpoint validates the Id and item, then reads the file
- Hi/Lo catalog ID generation (second report) (Models/CatalogItemHiLoGenerator.cs:11-34) into Catalog item Ids come from a Hi/Lo generator in blocks of 10
- Config switches (calculation lens) (Web.config:19-20) into UseMockData selects the in-memory or SQL catalog service
- Pagination and ordering (lifecycle lens) (Services/CatalogService.cs:21-35) into Catalog list is paged and ordered by Id

## Coverage gaps

These parts were NOT fully mined:

- **3 phases cut short:** referee, p0-panel, consolidation-agent
