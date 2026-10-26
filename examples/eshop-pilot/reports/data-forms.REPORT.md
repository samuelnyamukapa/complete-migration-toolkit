# Test report: eshop-legacy

**Verdict: FAIL** (partial run: only some cases)

16 cases failed.

Next: fix what failed (or correct an expectation with the person who owns the requirement), then `cmtk run` again.

- Date: 2026-10-26
- candidate: `http://localhost:53190`
- Cases: 31 pass, 16 fail, 0 skipped, 0 error

Written by `cmtk run` from the files in this folder. Do not edit the numbers: run it again.

## Settings

What produced this report. Check what is hidden or approved before you sign.

- Settings file: `cmtk-forms.yaml` (sha256 89fd2c5b0a9b6b3e…)

## Requirements

| Requirement | Cases | Passed | Failed | Not run |
| --- | --- | --- | --- | --- |
| RULE-009 | 47 | 31 | 16 | 0 |
| RULE-011 | 47 | 31 | 16 | 0 |
| RULE-013 | 47 | 31 | 16 | 0 |
| RULE-014 | 47 | 31 | 16 | 0 |

## Cases

| Case | Request | Requirement | Result |
| --- | --- | --- | --- |
| CATALOG-ITEM-003 | $.Name one character shorter than 1 | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-008 | $.Name one character longer than 50 | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-009 | $.Name missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-010 | $.Name null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-012 | $.Name: an empty string where text is expected | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-021 | $.Name: 4,096 characters: past most column widths | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-024 | $.Description one character longer than 200 | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-035 | $.Description: 4,096 characters: past most column widths | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-036 | $.Price below its minimum (0) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-041 | $.Price above its maximum (1000000) | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-042 | $.Price missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-043 | $.Price null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-044 | $.Price of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-045 | $.Price not a multiple of 0.01 | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-046 | $.PictureFileName missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-047 | $.PictureFileName null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-049 | $.PictureFileName does not match ^[A-Za-z0-9_-]+\.(png\|jpg\|jpeg\|gif)$ | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-050 | $.CatalogBrandId missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-051 | $.CatalogBrandId null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-052 | $.CatalogBrandId of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-053 | $.CatalogBrandId outside [1,2,3,4,5] | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-054 | $.CatalogBrandId with a fraction though an integer | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-055 | $.CatalogTypeId missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-056 | $.CatalogTypeId null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-057 | $.CatalogTypeId of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-058 | $.CatalogTypeId outside [1,2,3,4] | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-059 | $.CatalogTypeId with a fraction though an integer | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-060 | $.AvailableStock below its minimum (0) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-065 | $.AvailableStock above its maximum (10000000) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-066 | $.AvailableStock missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-067 | $.AvailableStock null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-068 | $.AvailableStock of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-069 | $.AvailableStock with a fraction though an integer | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-070 | $.RestockThreshold below its minimum (0) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-075 | $.RestockThreshold above its maximum (10000000) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-076 | $.RestockThreshold missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-077 | $.RestockThreshold null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-078 | $.RestockThreshold of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-079 | $.RestockThreshold with a fraction though an integer | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-080 | $.MaxStockThreshold below its minimum (0) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-085 | $.MaxStockThreshold above its maximum (10000000) | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-086 | $.MaxStockThreshold missing though required | RULE-009, RULE-011, RULE-013, RULE-014 | FAIL |
| CATALOG-ITEM-087 | $.MaxStockThreshold null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-088 | $.MaxStockThreshold of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-089 | $.MaxStockThreshold with a fraction though an integer | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-090 | $.OnReorder null though not nullable | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |
| CATALOG-ITEM-091 | $.OnReorder of the wrong type | RULE-009, RULE-011, RULE-013, RULE-014 | PASS |

## Input files

The files cases sent, fingerprinted. A different file gives a different SHA-256.

| Case | File | SHA-256 | Bytes | Sent as |
| --- | --- | --- | --- | --- |
| CATALOG-ITEM-003 | cmtk/data/catalog-item/rows/Name_minLength_below_3bva.json | 3f5c6f8f20aba107… | 288 | the form fields |
| CATALOG-ITEM-008 | cmtk/data/catalog-item/rows/Name_maxLength_above_3bva.json | 4e81d9396869a827… | 344 | the form fields |
| CATALOG-ITEM-009 | cmtk/data/catalog-item/rows/Name_missing.json | 6e47a032351f5bd3… | 306 | the form fields |
| CATALOG-ITEM-010 | cmtk/data/catalog-item/rows/Name_null.json | 8d7d8c02d547eda6… | 275 | the form fields |
| CATALOG-ITEM-012 | cmtk/data/catalog-item/rows/Name_hostile_empty.json | df06fe299ae5a297… | 283 | the form fields |
| CATALOG-ITEM-021 | cmtk/data/catalog-item/rows/Name_hostile_long.json | ebfaed27c3409497… | 4381 | the form fields |
| CATALOG-ITEM-024 | cmtk/data/catalog-item/rows/Description_maxLength_above_3bva.json | 17587f78a9e47b78… | 462 | the form fields |
| CATALOG-ITEM-035 | cmtk/data/catalog-item/rows/Description_hostile_long.json | 4d6b968d35eba050… | 4358 | the form fields |
| CATALOG-ITEM-036 | cmtk/data/catalog-item/rows/Price_minimum_below_3bva.json | 3a7bf6c4cf4ed8e8… | 321 | the form fields |
| CATALOG-ITEM-041 | cmtk/data/catalog-item/rows/Price_maximum_above_3bva.json | 3b554c8311922514… | 354 | the form fields |
| CATALOG-ITEM-042 | cmtk/data/catalog-item/rows/Price_missing.json | 8067ea195f67d556… | 304 | the form fields |
| CATALOG-ITEM-043 | cmtk/data/catalog-item/rows/Price_null.json | 0d4652784b6bf929… | 287 | the form fields |
| CATALOG-ITEM-044 | cmtk/data/catalog-item/rows/Price_wrong_type.json | e3bd07b1f93e5c08… | 324 | the form fields |
| CATALOG-ITEM-045 | cmtk/data/catalog-item/rows/Price_not_a_multiple.json | 8c712e1589891b68… | 339 | the form fields |
| CATALOG-ITEM-046 | cmtk/data/catalog-item/rows/PictureFileName_missing.json | 1a925662af93a86e… | 282 | the form fields |
| CATALOG-ITEM-047 | cmtk/data/catalog-item/rows/PictureFileName_null.json | 878ef08fa7c612e4… | 320 | the form fields |
| CATALOG-ITEM-049 | cmtk/data/catalog-item/rows/PictureFileName_breaks_pattern.json | d902dc2c2b8a9528… | 299 | the form fields |
| CATALOG-ITEM-050 | cmtk/data/catalog-item/rows/CatalogBrandId_missing.json | dbc0bca3bb837f97… | 271 | the form fields |
| CATALOG-ITEM-051 | cmtk/data/catalog-item/rows/CatalogBrandId_null.json | b07f273af20a3c1d… | 300 | the form fields |
| CATALOG-ITEM-052 | cmtk/data/catalog-item/rows/CatalogBrandId_wrong_type.json | 4e86f357b070627a… | 341 | the form fields |
| CATALOG-ITEM-053 | cmtk/data/catalog-item/rows/CatalogBrandId_not_in_enum.json | 485c2d786163e3c4… | 303 | the form fields |
| CATALOG-ITEM-054 | cmtk/data/catalog-item/rows/CatalogBrandId_fraction.json | 93359254a479c8ce… | 312 | the form fields |
| CATALOG-ITEM-055 | cmtk/data/catalog-item/rows/CatalogTypeId_missing.json | 0735cbe26954d404… | 276 | the form fields |
| CATALOG-ITEM-056 | cmtk/data/catalog-item/rows/CatalogTypeId_null.json | 577e9df7ef24e923… | 324 | the form fields |
| CATALOG-ITEM-057 | cmtk/data/catalog-item/rows/CatalogTypeId_wrong_type.json | f9896a8149764fb2… | 298 | the form fields |
| CATALOG-ITEM-058 | cmtk/data/catalog-item/rows/CatalogTypeId_not_in_enum.json | 6941fe1bbd95c8b2… | 297 | the form fields |
| CATALOG-ITEM-059 | cmtk/data/catalog-item/rows/CatalogTypeId_fraction.json | 97ac9f3159c0619b… | 350 | the form fields |
| CATALOG-ITEM-060 | cmtk/data/catalog-item/rows/AvailableStock_minimum_below_3bva.json | e8ce6248252cbfd9… | 308 | the form fields |
| CATALOG-ITEM-065 | cmtk/data/catalog-item/rows/AvailableStock_maximum_above_3bva.json | 895844072d0926e8… | 349 | the form fields |
| CATALOG-ITEM-066 | cmtk/data/catalog-item/rows/AvailableStock_missing.json | f9d05eadc6b841a0… | 278 | the form fields |
| CATALOG-ITEM-067 | cmtk/data/catalog-item/rows/AvailableStock_null.json | 67da74c0f2c4a962… | 314 | the form fields |
| CATALOG-ITEM-068 | cmtk/data/catalog-item/rows/AvailableStock_wrong_type.json | f8a16f4a8e06b7d8… | 297 | the form fields |
| CATALOG-ITEM-069 | cmtk/data/catalog-item/rows/AvailableStock_fraction.json | c72bb664ac66fd65… | 350 | the form fields |
| CATALOG-ITEM-070 | cmtk/data/catalog-item/rows/RestockThreshold_minimum_below_3bva.json | 881d385a621c0115… | 308 | the form fields |
| CATALOG-ITEM-075 | cmtk/data/catalog-item/rows/RestockThreshold_maximum_above_3bva.json | 669b8666c364258b… | 326 | the form fields |
| CATALOG-ITEM-076 | cmtk/data/catalog-item/rows/RestockThreshold_missing.json | e50a54062c148ff8… | 277 | the form fields |
| CATALOG-ITEM-077 | cmtk/data/catalog-item/rows/RestockThreshold_null.json | 3eded043c0f40810… | 287 | the form fields |
| CATALOG-ITEM-078 | cmtk/data/catalog-item/rows/RestockThreshold_wrong_type.json | d5ba38e5292a6f70… | 306 | the form fields |
| CATALOG-ITEM-079 | cmtk/data/catalog-item/rows/RestockThreshold_fraction.json | e9305b6c0b94f3e0… | 315 | the form fields |
| CATALOG-ITEM-080 | cmtk/data/catalog-item/rows/MaxStockThreshold_minimum_below_3bva.json | 39200fbc0fd8c98c… | 303 | the form fields |
| CATALOG-ITEM-085 | cmtk/data/catalog-item/rows/MaxStockThreshold_maximum_above_3bva.json | 14b7901903246922… | 344 | the form fields |
| CATALOG-ITEM-086 | cmtk/data/catalog-item/rows/MaxStockThreshold_missing.json | d327f5f3ca5465f3… | 304 | the form fields |
| CATALOG-ITEM-087 | cmtk/data/catalog-item/rows/MaxStockThreshold_null.json | 27bcd7ad9b57ad71… | 295 | the form fields |
| CATALOG-ITEM-088 | cmtk/data/catalog-item/rows/MaxStockThreshold_wrong_type.json | 56cffe880e8d28bb… | 308 | the form fields |
| CATALOG-ITEM-089 | cmtk/data/catalog-item/rows/MaxStockThreshold_fraction.json | cb585846034a69e9… | 311 | the form fields |
| CATALOG-ITEM-090 | cmtk/data/catalog-item/rows/OnReorder_null.json | a9eb84db59b963e2… | 302 | the form fields |
| CATALOG-ITEM-091 | cmtk/data/catalog-item/rows/OnReorder_wrong_type.json | 4c7dd67dc0152a64… | 300 | the form fields |

## Pages read first

A page read before the request, for the values it carries and the cookies it sets. The evidence holds their names, never their values.

| Case | Page | Status | Values taken | Cookies |
| --- | --- | --- | --- | --- |
| CATALOG-ITEM-003 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-008 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-009 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-010 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-012 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-021 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-024 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-035 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-036 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-041 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-042 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-043 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-044 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-045 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-046 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-047 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-049 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-050 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-051 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-052 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-053 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-054 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-055 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-056 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-057 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-058 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-059 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-060 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-065 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-066 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-067 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-068 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-069 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-070 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-075 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-076 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-077 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-078 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-079 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-080 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-085 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-086 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-087 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-088 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-089 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-090 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |
| CATALOG-ITEM-091 | GET /Catalog/Create | 200 | __RequestVerificationToken | ASP.NET_SessionId, __RequestVerificationToken |

## Failures

| Case | Check | Expected | Actual |
| --- | --- | --- | --- |
| CATALOG-ITEM-008 | `status` | 200 | 302 |
| CATALOG-ITEM-021 | `status` | 200 | 302 |
| CATALOG-ITEM-024 | `status` | 200 | 302 |
| CATALOG-ITEM-035 | `status` | 200 | 302 |
| CATALOG-ITEM-041 | `status` | 200 | 302 |
| CATALOG-ITEM-042 | `status` | 200 | 302 |
| CATALOG-ITEM-046 | `status` | 200 | 302 |
| CATALOG-ITEM-047 | `status` | 200 | 302 |
| CATALOG-ITEM-049 | `status` | 200 | 302 |
| CATALOG-ITEM-050 | `status` | 200 | 302 |
| CATALOG-ITEM-053 | `status` | 200 | 302 |
| CATALOG-ITEM-055 | `status` | 200 | 302 |
| CATALOG-ITEM-058 | `status` | 200 | 302 |
| CATALOG-ITEM-066 | `status` | 200 | 302 |
| CATALOG-ITEM-076 | `status` | 200 | 302 |
| CATALOG-ITEM-086 | `status` | 200 | 302 |

## Sign-off

A person fills this in with `cmtk signoff`; an agent never does. The evidence fingerprint ties the signature to the files in this folder, and running again clears it, because the evidence has changed.

| | |
|---|---|
| Name | ________________ |
| Role | ________________ |
| Date | __________ |
| Decision | accept / accept with conditions / reject |
| Evidence | (fingerprint written at sign-off) |
