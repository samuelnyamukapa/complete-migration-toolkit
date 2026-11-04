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

/**
 * T-SQL needs no semicolon between statements, so `SELECT 1 RECEIVE ...` is two. Each word here starts a statement there,
 * so it is refused on SQL Server anywhere outside a string, comment or quoted name. A column with one of these names needs brackets.
 */
const FORBIDDEN_MSSQL = new Set([
    "ADD", "BREAK", "CHECKPOINT", "CONTINUE", "DISABLE", "ENABLE", "GET", "GOTO", "IF", "MOVE", "OPEN", "PRINT", "RAISERROR",
    "RECEIVE", "RETURN", "REVERT", "SAVE", "SEND", "SETUSER", "THROW", "WHILE",
]);

/** Never allowed, not even when a person lists one in settings: these change something, or reach outside the database. */
const NEVER_CALL = /^(pg_|lo_|dblink|xp_|sp_|nextval$|setval$|currval$|lastval$|setseed$|set_config$|query_to_xml|query_to_xmlschema|cursor_to_xml|database_to_xml|schema_to_xml|table_to_xml|txid_|fn_varbintohexstr$)/i;

/** Built-in functions that only work out a value. Anything else is refused unless a person lists it in `allow_functions`. */
const SAFE_FUNCTIONS = new Set(`
    count sum avg min max stddev stddev_pop stddev_samp variance var_pop var_samp bool_and bool_or every grouping array_agg string_agg json_agg jsonb_agg json_object_agg jsonb_object_agg xmlagg
    percentile_cont percentile_disc mode row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
    coalesce nullif greatest least abs ceil ceiling floor round trunc sign mod power pow sqrt exp ln log log10 div width_bucket random
    lower upper length char_length character_length octet_length bit_length trim ltrim rtrim btrim left right substring substr position strpos concat concat_ws
    lpad rpad reverse repeat initcap translate split_part overlay regexp_replace regexp_match regexp_matches regexp_split_to_array regexp_split_to_table starts_with ascii chr md5 encode decode to_hex quote_ident quote_literal quote_nullable format
    cast extract date_part date_trunc age now clock_timestamp statement_timestamp transaction_timestamp timeofday current_timestamp current_date current_time localtime localtimestamp make_date make_time make_timestamp make_timestamptz make_interval to_char to_date to_number to_timestamp justify_days justify_hours justify_interval isfinite
    array_length array_to_string string_to_array array_position array_positions array_lower array_upper array_dims array_cat array_append array_prepend cardinality unnest generate_series generate_subscripts
    to_json to_jsonb row_to_json array_to_json json_build_object jsonb_build_object json_build_array jsonb_build_array json_array_length jsonb_array_length json_typeof jsonb_typeof json_extract_path jsonb_extract_path json_extract_path_text jsonb_extract_path_text json_array_elements jsonb_array_elements json_array_elements_text jsonb_array_elements_text json_each jsonb_each json_each_text jsonb_each_text json_object_keys jsonb_object_keys jsonb_pretty
    gen_random_uuid current_database current_schema has_table_privilege has_any_column_privilege has_schema_privilege has_database_privilege
    len charindex patindex replicate stuff str space nchar unicode isnull iif choose convert try_cast try_convert try_parse parse getdate getutcdate sysdatetime sysutcdatetime sysdatetimeoffset dateadd datediff datediff_big datepart datename datefromparts datetimefromparts eomonth year month day isnumeric isdate
    count_big stdev stdevp var varp checksum binary_checksum hashbytes newid square rand cot sin cos tan asin acos atan atn2 degrees radians pi
    json_value json_query isjson openjson string_split quotename db_name is_srvrolemember is_rolemember has_perms_by_name fn_my_permissions
`.trim().split(/\s+/));

/** Words that take a bracket without being a call, wherever they stand. In PostgreSQL none of these can name a function unless it is quoted. */
const ALWAYS_NOT_A_CALL = new Set([
    "ALL", "AND", "ANY", "ARRAY", "AS", "BETWEEN", "CASE", "DISTINCT", "ELSE", "EXCEPT", "EXISTS", "FROM", "HAVING", "IN", "INTERSECT", "LATERAL", "LIMIT", "NOT", "OFFSET", "ON", "OR",
    "ROW", "SELECT", "SOME", "THEN", "TO", "UNION", "USING", "VALUES", "WHEN", "WHERE", "WITH",
    "BIGINT", "BIT", "CHAR", "CHARACTER", "DEC", "DECIMAL", "FLOAT", "INT", "INTEGER", "INTERVAL", "NCHAR", "NUMERIC", "REAL", "SMALLINT", "TIME", "TIMESTAMP", "VARCHAR",
]);
/** More of the same, only on SQL Server: in PostgreSQL these can name a function. */
const ALWAYS_NOT_A_CALL_MSSQL = new Set(["APPLY", "BINARY", "DATETIME2", "DATETIMEOFFSET", "NVARCHAR", "OPTION", "PERCENT", "PIVOT", "TOP", "UNPIVOT", "VARBINARY", "TABLESAMPLE"]);
/** Words that can name a function in PostgreSQL, so each passes only straight after what makes it grammar. */
const NOT_A_CALL_AFTER = {
    OVER: (before) => before?.v === ")",
    FILTER: (before) => before?.v === ")",
    BY: (before) => ["ORDER", "GROUP", "PARTITION"].includes(upper(before)),
    GROUP: (before) => upper(before) === "WITHIN",
    CUBE: (before) => upper(before) === "BY",
    ROLLUP: (before) => upper(before) === "BY",
    SETS: (before) => upper(before) === "GROUPING",
    // Between two values: not at the start of one, where `like('a')` is a call.
    LIKE: (before) => followsValue(before),
    ILIKE: (before) => followsValue(before),
    SIMILAR: (before) => followsValue(before),
    JOIN: (before) => followsValue(before),
};
const upper = (token) => (token?.t === "word" ? token.v.toUpperCase() : undefined);
const followsValue = (before) => {
    if (!before) return false;
    if (before.t === "punct") return before.v === ")";
    if (before.t !== "word") return true;
    const w = before.v.toUpperCase();
    return w === "NOT" || !(ALWAYS_NOT_A_CALL.has(w) || w in NOT_A_CALL_AFTER);
};

/** Where a built-in's name may be qualified: its own schema only, so `my_schema.lower()` is someone's function. */
const BUILT_IN_SCHEMA = { postgres: "pg_catalog", mssql: "sys" };

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
    /** Consumes up to the closing quote, a doubled one standing for itself, and returns what it held. */
    const quoted = (close, what) => {
        i++;
        let held = "";
        for (;;) {
            if (i >= n) refuse(`${what} is never closed`);
            if (sql[i] === close) {
                if (sql[i + 1] === close) { held += close; i += 2; continue; }
                i++;
                return held;
            }
            held += sql[i];
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
        if (c === '"') { out.push({ t: "name", v: quoted('"', "a quoted name") }); continue; }
        if (c === "`") refuse("backtick quoting is not understood");
        if (c === "[" && dialect === "mssql") {
            i++;
            let held = "";
            for (;;) {
                if (i >= n) refuse("a [name] is never closed");
                if (sql[i] === "]") {
                    if (sql[i + 1] === "]") { held += "]"; i += 2; continue; }
                    i++;
                    break;
                }
                held += sql[i];
                i++;
            }
            out.push({ t: "name", v: held });
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

/** A name as the server would find it: a plain word in lower case, and a quoted one exactly as written. */
const foldName = (token) => (token.t === "word" ? token.v.toLowerCase() : token.v);

/** The name in front of a bracket, with what qualifies it: ["pg_catalog", "lower"]. */
function nameBefore(ts, k) {
    const parts = [foldName(ts[k])];
    let j = k;
    while (ts[j - 1]?.t === "punct" && ts[j - 1].v === "." && (ts[j - 2]?.t === "word" || ts[j - 2]?.t === "name")) {
        parts.unshift(foldName(ts[j - 2]));
        j -= 2;
    }
    return parts;
}

/** Is this word, here, grammar rather than a function's name? A quoted name or a qualified one never is. */
function isGrammar(ts, k, dialect) {
    const x = ts[k];
    if (x.t !== "word" || (ts[k - 1]?.t === "punct" && ts[k - 1].v === ".")) return false;
    const word = x.v.toUpperCase();
    if (ALWAYS_NOT_A_CALL.has(word) || (dialect === "mssql" && ALWAYS_NOT_A_CALL_MSSQL.has(word))) return true;
    return word in NOT_A_CALL_AFTER && NOT_A_CALL_AFTER[word](ts[k - 1]);
}

/** A call is allowed only from the list of built-ins, or by the exact name a person put in settings. */
function checkCall(ts, k, dialect, listed) {
    const parts = nameBefore(ts, k);
    const name = parts.join(".");
    const last = parts[parts.length - 1];
    if (NEVER_CALL.test(last)) refuse(`the function ${name} is not allowed`);
    if (listed.has(name)) return;
    const qualifier = parts.slice(0, -1);
    const ownSchema = qualifier.length === 0 || (qualifier.length === 1 && qualifier[0].toLowerCase() === BUILT_IN_SCHEMA[dialect]);
    if (SAFE_FUNCTIONS.has(last) && ownSchema) return;
    refuse(`the function ${name} is not on the list of safe built-ins. If a person has checked that it only reads, list ${name} in this target's allow_functions setting`);
}

/**
 * Throws unless `sql` is exactly one SELECT. WITH is refused too, because a PostgreSQL WITH can hold
 * a DELETE, and parentheses first, because nothing here needs them. `allowFunctions` holds the
 * functions a person has listed in settings, by exact name.
 */
export function assertSelectOnly(sql, dialect, { allowFunctions = [] } = {}) {
    if (typeof sql !== "string" || !sql.trim()) refuse("the statement is empty");
    if (dialect !== "postgres" && dialect !== "mssql") throw new Error(`unknown SQL dialect ${dialect}`);
    const ts = tokens(sql, dialect);
    if (!ts.length) refuse("the statement holds no SQL");
    const listed = new Set(allowFunctions.map((f) => String(f).toLowerCase()));
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
        if (x.t !== "word" && x.t !== "name") continue;
        if (ts[k + 1]?.t === "punct" && ts[k + 1].v === "(" && !isGrammar(ts, k, dialect)) checkCall(ts, k, dialect, listed);
        if (x.t !== "word") continue;
        const word = x.v.toUpperCase();
        if (FORBIDDEN.has(word) || (dialect === "mssql" && FORBIDDEN_MSSQL.has(word))) refuse(`${word} is not allowed`);
        if (word.startsWith("@@") || (word.startsWith("#") && dialect === "mssql")) refuse(`${x.v} is not allowed`);
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
