// Stand-ins for the database clients. `fakePg` puts the `pg` client's calls on PGlite, which is real
// PostgreSQL compiled to WebAssembly, so the SQL, the catalogue and the permissions are real.
// `fakeMssql` is canned answers in memory: it proves the adapter's logic, not the T-SQL. The
// real-server jobs in README.md prove that.
import { PGlite } from "@electric-sql/pglite";

export const SCHEMA = `
    CREATE TABLE orders (order_no text PRIMARY KEY, total numeric(8,2) NOT NULL, status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE audit (id serial PRIMARY KEY, note text);
    INSERT INTO orders (order_no, total, status) VALUES ('A-2', 20.50, 'new'), ('A-1', 10.00, 'new'), ('A-3', 30.00, 'new');
    INSERT INTO audit (note) VALUES ('seeded');
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE ROLE reader LOGIN;
    GRANT USAGE ON SCHEMA public TO reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader;
    CREATE ROLE writer LOGIN;
    GRANT USAGE ON SCHEMA public TO writer;
    GRANT SELECT ON orders, audit TO writer;
    GRANT INSERT ON audit TO writer;
    CREATE ROLE owner_of_schema LOGIN;
    GRANT CREATE, USAGE ON SCHEMA public TO owner_of_schema;
    GRANT SELECT ON orders, audit TO owner_of_schema;
`;

export async function makeDatabase() {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(SCHEMA);
    return db;
}

/** The `pg` module, with the connection's host choosing the database and its user the role. */
export function fakePg(databaseFor, seen = []) {
    return {
        Client: class {
            constructor(config) {
                seen.push(config);
                const u = new URL(config.connectionString);
                this.db = databaseFor(u.hostname);
                this.role = u.username;
            }
            on() {}
            async connect() {
                if (this.role !== "postgres") await this.db.exec(`SET ROLE ${this.role}`);
                else await this.db.exec("RESET ROLE");
                this.db.role = this.role;
            }
            async query(sql, params) {
                seen.push(sql);
                return { rows: (await this.db.query(sql, params)).rows };
            }
            async end() {}
        },
    };
}

/** Something that changes data as the system itself would, whatever role the session is in. */
export async function asSystem(db, sql) {
    await db.exec(`RESET ROLE; ${sql}; ${db.role && db.role !== "postgres" ? `SET ROLE ${db.role}` : ""}`);
}

/**
 * The `mssql` module over rows in memory. `login` says what the permission queries find:
 * { roles: { db_datawriter: 1 }, database: ["INSERT"], objects: [["dbo", "orders"]] }.
 */
export function fakeMssql(serverFor, seen = []) {
    return {
        ConnectionPool: class {
            constructor(connection) {
                const host = /Server=([^;]+)/i.exec(connection)[1];
                this.server = serverFor(host);
                this.user = /User Id=([^;]+)/i.exec(connection)[1];
            }
            on() {}
            async connect() {
                if (this.server.unreachable) throw Object.assign(new Error(this.server.unreachable), { code: "ESOCKET" });
                return this;
            }
            async close() {}
            request() {
                const { server, user } = this;
                return {
                    input() { return this; },
                    async query(sql) {
                        seen.push(sql);
                        const login = server.logins?.[user] ?? {};
                        if (/DB_NAME\(\)/.test(sql)) return { recordset: [{ name: server.name ?? "cmtk_test" }] };
                        if (/IS_SRVROLEMEMBER/.test(sql)) return { recordset: [{ sysadmin: 0, db_owner: 0, db_datawriter: 0, db_ddladmin: 0, ...login.roles }] };
                        if (/fn_my_permissions/.test(sql)) return { recordset: (login.database ?? []).map((permission_name) => ({ permission_name })) };
                        if (/sys\.objects/.test(sql)) return { recordset: (login.objects ?? []).map(([schema_name, table_name]) => ({ schema_name, table_name })) };
                        const m = /^SELECT TOP \((\d+)\) \* FROM \[dbo\]\.\[(\w+)\]/.exec(sql);
                        if (m) return { recordset: [...server.tables[m[2]]].reverse().slice(0, Number(m[1])) };
                        throw new Error(`the stand-in does not understand: ${sql}`);
                    },
                };
            }
        },
    };
}
