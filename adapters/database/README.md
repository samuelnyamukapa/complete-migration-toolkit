# Database adapter

Takes a read-only snapshot of chosen tables before and after a case, and reports the rows added, removed and changed, sorted by key. SQL Server and PostgreSQL.

## Setting up

A driver is loaded only when a target asks for it. If it is missing, the case's error names the command.

```
npm install --no-save mssql@12.7.13    # SQL Server
npm install --no-save pg@8.23.1        # PostgreSQL
```

Tables need a list, and target settings in `cmtk.yaml` cannot hold one, so settings go in a JSON file, by target name, with `*` for all targets. See `samples/settings.example.json`.

```yaml
targets:
  legacy:    { connection_env: CMTK_DB_LEGACY }
  candidate: { connection_env: CMTK_DB_CANDIDATE }
adapters:
  database: { command: node, args: [adapters/database/index.mjs, --settings, database-settings.json], covers: [database] }
```

| Setting | What it does |
|---|---|
| `driver` | `mssql` or `postgres` |
| `connection_env` | The environment variable that holds the connection string. A connection string in settings is refused |
| `tables` | A list of `{ name, keys, ignore?, as?, query? }`. `keys` identify a row. `ignore` leaves out columns such as timestamps. `as` is the name to report under, so `dbo.Orders` and `public.orders` can line up. `query` reads from one SELECT instead of the whole table |
| `row_cap` | The most rows to read per table. Default 1000 |
| `app_url` | The system that receives the case's request. Without it, a read-only case reports the rows as they are |
| `app_timeout_s` | The longest to wait for the system. Default 30 |
| `settle_ms` | How long to wait after the system answers, for one that writes later |
| `test_database` | Names one exact database as a test one, when its name does not say so |

## A case

```yaml
- id: ORDER-1
  surface: database
  request: { method: POST, path: /api/orders, body: { order_no: N-1, total: 5 } }
```

The adapter reads the tables, sends the request to `app_url`, reads them again, and reports `effects.tables.<name>` as `added`, `removed` and `changed`, plus the system's status and body. The adapter itself only reads. POST, PUT, PATCH and DELETE only run with both unsafe switches, because the system will write.

With no `app_url`, GET reports each table's `rows`. Any other method is then an error, because nothing would happen and the rows would look unchanged.

## Safety

- **A login that can write is refused,** before any row is read, by asking the server what this login can do. PostgreSQL: its role, and `has_table_privilege`, `has_any_column_privilege`, `has_schema_privilege` and `has_database_privilege`. SQL Server: `IS_SRVROLEMEMBER`, `IS_ROLEMEMBER`, `fn_my_permissions` and `HAS_PERMS_BY_NAME`. An answer it cannot read also stops the run. On PostgreSQL 14 and earlier, PUBLIC can create objects in the `public` schema by default, so a login stays refused until you `REVOKE CREATE ON SCHEMA public FROM PUBLIC`.
- **Only SELECT is sent.** Every statement, the adapter's own included, goes through a check that reads the SQL as tokens. It refuses anything but one SELECT: other statements, a second statement with or without a semicolon, `WITH`, `SELECT INTO`, `FOR UPDATE`, and functions that change something or reach outside the database, such as `nextval` or `xp_cmdshell`. Words inside strings, comments and quoted names do not count. It refuses when unsure, so a column called `update` needs quotes.
- **A second lock on PostgreSQL:** the connection asks for read-only transactions. SQL Server has no such setting, so it relies on the two checks above.
- **Test databases only.** The database's name must have a word like `test`, `qa`, `uat`, `sandbox`, `dev`, `ci` or `cmtk`, and none like `prod` or `live`, unless `test_database` names it exactly.
- **The row cap is reported** as `capped: true` and `row_cap` on the table. It also makes the case an error, with the rows read kept in the evidence, so a part of a table can never count as a match. Raise the cap, or narrow the table with `query`.
- **Secrets.** Connection strings come from the environment and are removed from every reply. Response headers are never reported.
- **Personal data.** Rows can hold personal data, and they go into the evidence. Keep the evidence on the client's machines, and use `ignore` for columns you do not need.

## Not covered

The SQL Server statements have only run against a stand-in with canned answers, so `test/real-server.test.mjs` must prove them on a real server. The PostgreSQL statements run on PGlite, which is real PostgreSQL, through a stand-in for the `pg` client.

## Tests

`npm test` runs `test/database.test.mjs`, on the local machine only. For real servers, `npm install --no-save pg@8.23.1 mssql@12.7.13`, set `CMTK_TEST_PG_ADMIN_URL` (image `postgres:17`, database `cmtk_test`) or `CMTK_TEST_MSSQL_ADMIN` (image `mcr.microsoft.com/mssql/server:2022-latest`, for example `Server=localhost,1433;Database=master;User Id=sa;Password=…;Encrypt=false;`), and run `test/real-server.test.mjs`.
