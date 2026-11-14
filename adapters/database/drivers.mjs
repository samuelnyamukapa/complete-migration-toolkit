// SQL Server and PostgreSQL behind one interface. A driver is loaded only when a target asks for it.
//
//   dialect                 for the SELECT check
//   open(connection)        a connection with query(sql, params) giving rows, and close()
//   secretsOf(connection)   the parts that must never be printed
//   hostsOf(connection)     the hosts and databases it names, read without any network call
//   whoCanWrite(query)      what this login could change, by asking the server: a list of
//                           plain descriptions, empty only when the server says nothing can be written
//   databaseName(query)     the name of the database in use
//   selectAll(table, keys, cap)  / selectFrom(sql, keys, cap)  the SQL for one snapshot
//
// Every statement in here goes through the same SELECT check as a person's query (see index.mjs).

export const PACKAGES = { postgres: ["pg", "8.23.1"], mssql: ["mssql", "12.7.13"] };

async function load(importer, driver) {
    const [pkg, version] = PACKAGES[driver];
    try {
        const m = await importer(pkg);
        return m.default ?? m;
    } catch (err) {
        if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(pkg)) {
            throw new Error(`the ${driver} driver needs the ${pkg} package, which is not installed. Run: npm install --no-save ${pkg}@${version}`);
        }
        throw err;
    }
}

const NAME_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;
/** A table or column name split into its parts, refused unless every part is a plain name. */
export function nameParts(name, what = "name") {
    const parts = String(name).split(".");
    if (parts.length > 2 || !parts.every((p) => NAME_PART.test(p))) throw new Error(`${what} ${JSON.stringify(String(name))} must be a plain name or schema.name`);
    return parts;
}
const pgName = (name, what) => nameParts(name, what).map((p) => `"${p}"`).join(".");
const msName = (name, what) => nameParts(name, what).map((p) => `[${p}]`).join(".");

const urlSecrets = (connection) => {
    try {
        const u = new URL(connection);
        return u.password ? [u.password, decodeURIComponent(u.password)] : [];
    } catch {
        return [];
    }
};

export function postgresDriver(importer = (p) => import(p)) {
    return {
        dialect: "postgres",
        secretsOf: urlSecrets,
        hostsOf(connection) {
            try {
                const u = new URL(connection);
                // A host in the query takes the place of the one before it.
                return [u.hostname, decodeURIComponent(u.pathname.replace(/^\//, "")), ...u.searchParams.getAll("host"), ...u.searchParams.getAll("dbname")];
            } catch {
                return [...String(connection).matchAll(/(?:^|\s)(?:host|hostaddr|dbname)\s*=\s*'?([^\s']+)/gi)].map((m) => m[1]);
            }
        },
        async open(connection) {
            const pg = await load(importer, "postgres");
            // A second lock behind the permission check and the SELECT check.
            const client = new pg.Client({ connectionString: connection, options: "-c default_transaction_read_only=on" });
            client.on?.("error", () => { /* the next query reports it */ });
            await client.connect();
            return {
                query: async (sql, params = []) => (await client.query(sql, params)).rows,
                close: () => client.end(),
            };
        },
        async whoCanWrite(query) {
            const found = [];
            const [role] = await query("SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user");
            if (!role) throw new Error("the server did not say what this login is");
            for (const [k, what] of [["rolsuper", "it is a superuser"], ["rolcreaterole", "it can create roles"], ["rolcreatedb", "it can create databases"], ["rolreplication", "it is a replication role"], ["rolbypassrls", "it bypasses row security"]]) {
                if (role[k]) found.push(what);
            }
            const [db] = await query("SELECT has_database_privilege(current_database(), 'CREATE') AS can_create");
            if (db?.can_create) found.push("it can create schemas in this database");
            for (const r of await query("SELECT n.nspname AS name FROM pg_namespace n WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' AND has_schema_privilege(n.oid, 'CREATE')")) {
                found.push(`it can create objects in schema ${r.name}`);
            }
            for (const r of await query(
                "SELECT n.nspname AS schema_name, c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                + "WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' "
                + "AND (has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') OR has_any_column_privilege(c.oid, 'INSERT, UPDATE'))",
            )) {
                found.push(`it can write to ${r.schema_name}.${r.table_name}`);
            }
            return found;
        },
        async databaseName(query) {
            const [r] = await query("SELECT current_database() AS name");
            return r?.name;
        },
        selectAll: (table, keys, cap) => `SELECT * FROM ${pgName(table, "table")} ORDER BY ${keys.map((k) => pgName(k, "key column")).join(", ")} LIMIT ${cap}`,
        selectFrom: (sql, keys, cap) => `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS cmtk_rows ORDER BY ${keys.map((k) => pgName(k, "key column")).join(", ")} LIMIT ${cap}`,
    };
}

const OBJECT_WRITE_RIGHTS = ["INSERT", "UPDATE", "DELETE", "ALTER", "CONTROL", "TAKE OWNERSHIP"];
const DB_WRITE_RIGHTS = "('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL', 'TAKE OWNERSHIP', 'EXECUTE', 'CREATE TABLE', 'CREATE PROCEDURE', 'CREATE VIEW', 'CREATE FUNCTION', 'CREATE SCHEMA', 'ALTER ANY SCHEMA', 'ALTER ANY USER', 'ALTER ANY ROLE', 'BACKUP DATABASE')";

export function mssqlDriver(importer = (p) => import(p)) {
    return {
        dialect: "mssql",
        hostsOf(connection) {
            const found = [...String(connection).matchAll(/(?:^|;)\s*(?:server|data source|address|addr|network address|database|initial catalog)\s*=\s*([^;]+)/gi)].map((m) => m[1].trim());
            try {
                const u = new URL(connection);
                found.push(u.hostname, decodeURIComponent(u.pathname.replace(/^\//, "")));
            } catch { /* the usual form, read above */ }
            return found;
        },
        secretsOf(connection) {
            const m = /(?:^|;)\s*(?:password|pwd)\s*=\s*([^;]+)/i.exec(connection);
            return [...(m ? [m[1].trim()] : []), ...urlSecrets(connection)];
        },
        async open(connection) {
            const sql = await load(importer, "mssql");
            const pool = await new sql.ConnectionPool(connection).connect();
            pool.on?.("error", () => { /* the next query reports it */ });
            return {
                async query(text, params = []) {
                    const req = pool.request();
                    params.forEach((v, i) => req.input(`p${i}`, v));
                    return (await req.query(text)).recordset ?? [];
                },
                close: () => pool.close(),
            };
        },
        async whoCanWrite(query) {
            const found = [];
            const [role] = await query("SELECT IS_SRVROLEMEMBER('sysadmin') AS sysadmin, IS_ROLEMEMBER('db_owner') AS db_owner, IS_ROLEMEMBER('db_datawriter') AS db_datawriter, IS_ROLEMEMBER('db_ddladmin') AS db_ddladmin");
            if (!role) throw new Error("the server did not say what this login is");
            for (const k of ["sysadmin", "db_owner", "db_datawriter", "db_ddladmin"]) if (role[k] === 1) found.push(`it is in the ${k} role`);
            for (const r of await query(`SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE') WHERE permission_name IN ${DB_WRITE_RIGHTS}`)) {
                found.push(`it has ${r.permission_name} on this database`);
            }
            const full = "QUOTENAME(s.name) + '.' + QUOTENAME(o.name)";
            for (const r of await query(
                `SELECT s.name AS schema_name, o.name AS table_name FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 AND (`
                + OBJECT_WRITE_RIGHTS.map((w) => `HAS_PERMS_BY_NAME(${full}, 'OBJECT', '${w}') = 1`).join(" OR ") + ")",
            )) {
                found.push(`it can write to ${r.schema_name}.${r.table_name}`);
            }
            return found;
        },
        async databaseName(query) {
            const [r] = await query("SELECT DB_NAME() AS name");
            return r?.name;
        },
        selectAll: (table, keys, cap) => `SELECT TOP (${cap}) * FROM ${msName(table, "table")} ORDER BY ${keys.map((k) => msName(k, "key column")).join(", ")}`,
        selectFrom: (sql, keys, cap) => `SELECT TOP (${cap}) * FROM (${sql.replace(/;\s*$/, "")}) AS cmtk_rows ORDER BY ${keys.map((k) => msName(k, "key column")).join(", ")}`,
    };
}

export const DRIVERS = { postgres: postgresDriver(), mssql: mssqlDriver() };
