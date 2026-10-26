# Draft defects: eshop-legacy

From `cmtk run` on 2026-10-26 (verdict FAIL). Each draft groups the cases that fail the same way.
A person checks each one and files it. Nothing here has been filed.

## D-01: $.Name: one character longer than 50; 4,096 characters: past most column widths (2 cases)

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-008, CATALOG-ITEM-021
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/Name_maxLength_above_3bva.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row Name_maxLength_above_3bva (BVA-3): $.Name one character longer than 50. The schema says the body is invalid ($.Name maxLength); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-008.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-021.json`

## D-02: $.Description: one character longer than 200; 4,096 characters: past most column widths (2 cases)

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-024, CATALOG-ITEM-035
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/Description_maxLength_above_3bva.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row Description_maxLength_above_3bva (BVA-3): $.Description one character longer than 200. The schema says the body is invalid ($.Description maxLength); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-024.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-035.json`

## D-03: $.Price: above its maximum (1000000); missing though required (2 cases)

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-041, CATALOG-ITEM-042
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/Price_maximum_above_3bva.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row Price_maximum_above_3bva (BVA-3): $.Price above its maximum (1000000). The schema says the body is invalid ($.Price maximum); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-041.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-042.json`

## D-04: $.PictureFileName: missing though required; null though not nullable; does not match ^[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif)$ (3 cases)

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-046, CATALOG-ITEM-047, CATALOG-ITEM-049
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/PictureFileName_missing.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row PictureFileName_missing (EP): $.PictureFileName missing though required. The schema says the body is invalid ($.PictureFileName required); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-046.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-047.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-049.json`

## D-05: $.CatalogBrandId: missing though required; outside [1,2,3,4,5] (2 cases)

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-050, CATALOG-ITEM-053
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/CatalogBrandId_missing.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row CatalogBrandId_missing (EP): $.CatalogBrandId missing though required. The schema says the body is invalid ($.CatalogBrandId required); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-050.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-053.json`

## D-06: $.CatalogTypeId: missing though required; outside [1,2,3,4] (2 cases)

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-055, CATALOG-ITEM-058
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/CatalogTypeId_missing.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row CatalogTypeId_missing (EP): $.CatalogTypeId missing though required. The schema says the body is invalid ($.CatalogTypeId required); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-055.json`
- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-058.json`

## D-07: $.AvailableStock missing though required

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-066
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/AvailableStock_missing.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row AvailableStock_missing (EP): $.AvailableStock missing though required. The schema says the body is invalid ($.AvailableStock required); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-066.json`

## D-08: $.RestockThreshold missing though required

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-076
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/RestockThreshold_missing.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row RestockThreshold_missing (EP): $.RestockThreshold missing though required. The schema says the body is invalid ($.RestockThreshold required); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-076.json`

## D-09: $.MaxStockThreshold missing though required

- Requirements: RULE-009, RULE-011, RULE-013, RULE-014
- Cases: CATALOG-ITEM-086
- Found by: `cmtk run` on 2026-10-26

### Steps to reproduce

1. Send `POST /Catalog/Create` to candidate (http://localhost:53190).
2. As a form (application/x-www-form-urlencoded), the fields from `cmtk/data/catalog-item/rows/MaxStockThreshold_missing.json`.
3. Before it, read `GET /Catalog/Create` on the same target and carry its cookies, with __RequestVerificationToken taken from `input[name=__RequestVerificationToken]` into the form.

### Why it matters

From recipe catalog-item, row MaxStockThreshold_missing (EP): $.MaxStockThreshold missing though required. The schema says the body is invalid ($.MaxStockThreshold required); the oracle is specified. Sent as a browser posts a form (application/x-www-form-urlencoded), from the row's fields. Before it, /Catalog/Create is read for __RequestVerificationToken; the values taken are never written to evidence. The expected status 200 was given on the command line, not read from a document: the reviewer confirms it against the requirement. This request changes data: it runs only with allow_unsafe_methods: true in the settings and --allow-unsafe on the run, against disposable test data.

### Expected

- `status`: 200

### Actual

- `status`: 302

### Evidence

- `cmtk/evidence-forms/run/answers/CATALOG-ITEM-086.json`
