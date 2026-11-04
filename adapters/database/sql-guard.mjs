// Only SELECT reaches a database. This reads the SQL as tokens, the way the server would, so a
// keyword inside a string or a comment does not count and a statement hidden after one still does.
// It refuses when in doubt: a false refusal costs a rewrite, a false pass could change data.

/** Words that have no place in one read: each is refused anywhere outside a string, comment or quoted name. */
const FORBIDDEN = new Set([
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "REPLACE", "TRUNCATE", "DROP", "ALTER", "CREATE", "RENAME",
    "GRANT", "REVOKE", "DENY", "EXEC", "EXECUTE", "CALL", "DO", "SET", "RESET", "USE", "INTO", "COPY", "BULK", "LOAD", "IMPORT",
    "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "TRANSACTION", "LOCK", "UNLOCK", "FOR", "VACUUM", "ANALYZE", "CLUSTER", "REINDEX", "REFRESH",
    "LISTEN", "NOTIFY", "UNLISTEN", "PREPARE", "DEALLOCATE", "DECLARE", "FETCH", "CLOSE", "WAITFOR", "SHUTDOWN", "KILL", "BACKUP", "RESTORE",
    "DBCC", "RECONFIGURE", "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "OPENXML", "WRITETEXT", "UPDATETEXT", "READTEXT", "GO",
]);

/** Functions a SELECT could call to change something or reach outside the database. Refused when followed by `(`. */
const FORBIDDEN_CALL = /^(pg_|lo_|dblink|xp_|sp_|nextval$|setval$|currval$|lastval$|set_config$|query_to_xml$|database_to_xml|schema_to_xml|table_to_xml|txid_|fn_varbintohexstr$)/i;

function refuse(why) {
    const err = new Error(`only one SELECT may run: ${why}`);
    err.code = "SQL_REFUSED";
    throw err;
}

/** Words, numbers and punctuation, with strings, quoted names and comments consumed. */
export function tokens(sql, dialect) {
    const out = [];
    let i = 0;
    const n = sql.length;
    const isWord = (c) => /[\p{L}\p{N}_$@#]/u.test(c);
    const quoted = (close, what) => {
        i++;
        for (;;) {
            if (i >= n) refuse(`${what} is never closed`);
            if (sql[i] === close) {
                if (sql[i + 1] === close) { i += 2; continue; }
                i++;
                return;
            }
            i++;
        }
    };
    while (i < n) {
        const c = sql[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === "-" && sql[i + 1] === "-") {
            while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
            continue;
        }
        if (c === "/" && sql[i + 1] === "*") {
            let depth = 1; // both servers nest block comments
            i += 2;
            while (depth > 0) {
                if (i >= n) refuse("a comment is never closed");
                if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
                else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
                else i++;
            }
            continue;
        }
        if (c === "'") { quoted("'", "a string"); out.push({ t: "string" }); continue; }
        if (c === '"') { quoted('"', "a quoted name"); out.push({ t: "name" }); continue; }
        if (c === "`") refuse("backtick quoting is not understood");
        if (c === "[" && dialect === "mssql") {
            i++;
            for (;;) {
                if (i >= n) refuse("a [name] is never closed");
                if (sql[i] === "]") {
                    if (sql[i + 1] === "]") { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            out.push({ t: "name" });
            continue;
        }
        if (c === "$" && dialect === "postgres") {
            const m = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(i));
            if (m) {
                const end = sql.indexOf(m[0], i + m[0].length);
                if (end < 0) refuse("a dollar-quoted string is never closed");
                i = end + m[0].length;
                out.push({ t: "string" });
                continue;
            }
            const p = /^\$\d+/.exec(sql.slice(i));
            if (p) { i += p[0].length; out.push({ t: "param" }); continue; }
        }
        if (isWord(c)) {
            const start = i;
            while (i < n && isWord(sql[i])) i++;
            const word = sql.slice(start, i);
            // A prefixed string: N'…' on both, and in PostgreSQL E'…' (with backslash escapes), B'…', X'…', U&'…'.
            if (sql[i] === "'" && /^(n|e|b|x)$/i.test(word)) {
                if (dialect === "postgres" && /^e$/i.test(word)) {
                    i++;
                    for (;;) {
                        if (i >= n) refuse("a string is never closed");
                        if (sql[i] === "\\") { i += 2; continue; }
                        if (sql[i] === "'") {
                            if (sql[i + 1] === "'") { i += 2; continue; }
                            i++;
                            break;
                        }
                        i++;
                    }
                } else quoted("'", "a string");
                out.push({ t: "string" });
                continue;
            }
            if (/^u$/i.test(word) && sql[i] === "&") refuse("U& strings are not understood");
            out.push({ t: "word", v: word });
            continue;
        }
        out.push({ t: "punct", v: c });
        i++;
    }
    return out;
}

/**
 * Throws unless `sql` is exactly one SELECT. WITH is refused too, because a PostgreSQL WITH can hold
 * a DELETE, and parentheses first, because nothing here needs them.
 */
export function assertSelectOnly(sql, dialect) {
    if (typeof sql !== "string" || !sql.trim()) refuse("the statement is empty");
    if (dialect !== "postgres" && dialect !== "mssql") throw new Error(`unknown SQL dialect ${dialect}`);
    const ts = tokens(sql, dialect);
    if (!ts.length) refuse("the statement holds no SQL");
    const first = ts[0];
    if (first.t !== "word" || first.v.toUpperCase() !== "SELECT") refuse(`it starts with ${first.v ?? `a ${first.t}`}, not SELECT`);
    let depth = 0;
    for (let k = 0; k < ts.length; k++) {
        const x = ts[k];
        if (x.t === "punct") {
            if (x.v === "(") depth++;
            else if (x.v === ")") { depth--; if (depth < 0) refuse("a closing parenthesis has no opening one"); }
            else if (x.v === ";") {
                if (k !== ts.length - 1) refuse("it holds more than one statement");
            }
            continue;
        }
        if (x.t !== "word") continue;
        const word = x.v.toUpperCase();
        if (FORBIDDEN.has(word)) refuse(`${word} is not allowed`);
        if (word.startsWith("@@") || (word.startsWith("#") && dialect === "mssql")) refuse(`${x.v} is not allowed`);
        if (ts[k + 1]?.t === "punct" && ts[k + 1].v === "(" && FORBIDDEN_CALL.test(x.v)) refuse(`the function ${x.v} is not allowed`);
        // T-SQL needs no semicolon between statements: `SELECT 1 SELECT 2` is two.
        if (word === "SELECT" && k > 0 && depth === 0) {
            const before = ts[k - 1];
            const joined = before.t === "word" && ["UNION", "ALL", "EXCEPT", "INTERSECT", "DISTINCT"].includes(before.v.toUpperCase());
            if (!joined) refuse("it holds more than one statement");
        }
    }
    if (depth !== 0) refuse("a parenthesis is never closed");
    return sql;
}
