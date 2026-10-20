# Boundaries: eshop-legacy

Written by `cmtk discover` on 2026-10-20. 8 boundaries: 5 covered by an adapter, 3 uncovered.

A boundary is anything the system serves, or calls, stores, sends or reads through. Each one needs cases, and an adapter to run them, before parity can be claimed for it. Run `cmtk discover` again after adding a source or an adapter.

Sources: REA on legacy/bin/eShopLegacyMVC.dll; legacy/Web.config.

| Boundary | Kind | Direction | Where | Covered by | Found in |
|---|---|---|---|---|---|
| CatalogDBContext | database | out | server (localdb)\MSSQLLocalDB, database Microsoft.eShopOnContainers.Services.CatalogDb | **uncovered** | legacy/Web.config: connection string "CatalogDBContext" (System.Data.SqlClient); REA: legacy/bin/eShopLegacyMVC.dll: used by eShopLegacyMVC.Models.CatalogDBContext (DbContext, DbModelBuilder, DecimalPropertyConfiguration, …); eShopLegacyMVC.Models.CatalogItemHiLoGenerator (Database, DbContext); eShopLegacyMVC.Models.Infrastructure.CatalogDBInitializer (CreateDatabaseIfNotExists, Database, DbContext, …); eShopLegacyMVC.MvcApplication (Database); eShopLegacyMVC.Services.CatalogService (DbContext, DbSet, DbEntityEntry, …) |
| eShopLegacyMVC.dll: files | files | out |  | **uncovered** | REA: legacy/bin/eShopLegacyMVC.dll: used by eShopLegacyMVC.Controllers.PicController (File); eShopLegacyMVC.Models.Infrastructure.CatalogDBInitializer (ZipFile, DirectoryInfo, File) |
| eShopLegacyMVC.dll: logs | logs | out |  | **uncovered** | REA: legacy/bin/eShopLegacyMVC.dll: used by eShopLegacyMVC.Controllers.CatalogController (ILog, LogManager); eShopLegacyMVC.Controllers.PicController (ILog, LogManager); eShopLegacyMVC.MvcApplication (ILog, LogManager, LogicalThreadContext, …) |
| eShopLegacyMVC.Controllers.Api.CatalogController2 | http | in | /Catalog2 (by naming convention; check the real route) | http (built in) | REA: legacy/bin/eShopLegacyMVC.dll: eShopLegacyMVC.Controllers.Api.CatalogController2 is an MVC controller |
| eShopLegacyMVC.Controllers.CatalogController | http | in | /Catalog (by naming convention; check the real route) | http (built in) | REA: legacy/bin/eShopLegacyMVC.dll: eShopLegacyMVC.Controllers.CatalogController is an MVC controller |
| eShopLegacyMVC.Controllers.PicController | http | in | /Pic (by naming convention; check the real route) | http (built in) | REA: legacy/bin/eShopLegacyMVC.dll: eShopLegacyMVC.Controllers.PicController is an MVC controller |
| eShopLegacyMVC.Controllers.WebApi.BrandsController | http | in | /api/brands (by naming convention; check the real route) | http (built in) | REA: legacy/bin/eShopLegacyMVC.dll: eShopLegacyMVC.Controllers.WebApi.BrandsController is a Web API controller |
| eShopLegacyMVC.Controllers.WebApi.FilesController | http | in | /api/files (by naming convention; check the real route) | http (built in) | REA: legacy/bin/eShopLegacyMVC.dll: eShopLegacyMVC.Controllers.WebApi.FilesController is a Web API controller |

## Uncovered

No adapter covers these, so no case can check them yet. For each kind, either:
- write an adapter with `cmtk adapter new <name>` and list the kind under its `covers` in `cmtk.yaml`; or
- have a person record why it is out of scope.

- **database**: CatalogDBContext
- **files**: eShopLegacyMVC.dll: files
- **logs**: eShopLegacyMVC.dll: logs

## Limits

- Assemblies are read by REA, never run. Calls made through reflection, dependency injection resolved at run time, or configuration may be missed.
- A controller's route is guessed from its name. Check it against the real routes.
- Discovery lists what its sources show. It never proves that nothing else exists: add sources (configuration, recordings, the map) until the list stops growing.
