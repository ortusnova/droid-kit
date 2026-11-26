//! The database itself, without Tauri: one SQLite connection, migrations,
//! reads, writes and atomic batches. The plugin in `lib.rs` is a thin layer
//! over this, and the tests run on it directly.

use std::path::Path;
use std::time::Duration;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use specta::Type;

use crate::error::StoreError;

/// What a parameter or a column value looks like to TypeScript. SQLite integers
/// come back as JSON numbers: exact up to 2^53, which is far beyond any
/// timestamp in milliseconds.
#[derive(Serialize, Deserialize, Type)]
#[serde(untagged)]
#[allow(dead_code)]
enum Scalar {
    Null(()),
    Bool(bool),
    Number(f64),
    Text(String),
}

/// A parameter: `null`, a boolean (stored as 0 or 1), a number or a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Param(#[specta(type = Scalar)] pub Json);

/// A row: an object from column name to value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct Row(#[specta(type = std::collections::HashMap<String, Scalar>)] pub Json);

/// One statement of a batch: SQL with `?` placeholders and its parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Statement {
    pub sql: String,
    pub params: Vec<Param>,
}

/// What `open` reports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    /// The database file.
    pub path: String,
    /// The schema version: how many migrations have been applied.
    pub version: u32,
    /// The SQLite library built into the app, such as `3.54.1`.
    pub sqlite_version: String,
    /// `wal` for a file database.
    pub journal_mode: String,
}

pub struct Db {
    conn: Connection,
}

/// True for SQL with nothing in it but whitespace, semicolons and comments.
/// rusqlite 0.43 refuses such SQL, and a clear message beats "not an error".
pub fn is_blank(sql: &str) -> bool {
    let mut rest = sql;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == ';');
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.find('\n').map_or("", |i| &after[i + 1..]);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |i| &after[i + 2..]);
        } else {
            return rest.is_empty();
        }
    }
}

fn not_blank(sql: &str) -> Result<(), StoreError> {
    if is_blank(sql) {
        return Err(StoreError::Empty { message: "the SQL is empty or only comments; SQLite takes no statement from it".into() });
    }
    Ok(())
}

fn to_value(param: &Json) -> Result<Value, StoreError> {
    Ok(match param {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().ok_or_else(|| StoreError::invalid(format!("the number {n} does not fit SQLite")))?),
        },
        Json::String(s) => Value::Text(s.clone()),
        other => return Err(StoreError::invalid(format!("a parameter must be null, a boolean, a number or a string, not {}", kind_of(other)))),
    })
}

fn kind_of(v: &Json) -> &'static str {
    match v {
        Json::Array(_) => "an array",
        Json::Object(_) => "an object",
        _ => "this",
    }
}

fn to_values<'a>(params: impl IntoIterator<Item = &'a Json>) -> Result<Vec<Value>, StoreError> {
    params.into_iter().map(to_value).collect()
}

fn from_ref(value: ValueRef<'_>, column: &str) -> Result<Json, StoreError> {
    Ok(match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::from(i),
        // NaN and infinity cannot be JSON.
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number),
        ValueRef::Text(bytes) => Json::String(std::str::from_utf8(bytes).map_err(|_| StoreError::invalid(format!("column {column} is not valid UTF-8")))?.to_string()),
        ValueRef::Blob(_) => return Err(StoreError::invalid(format!("column {column} holds a BLOB; the store returns only null, numbers and text"))),
    })
}

impl Db {
    /// Opens (creating it if needed) the database at `path`, in WAL mode with
    /// foreign keys on, and applies the migrations it has not had.
    pub fn open(path: &Path, migrations: &[String]) -> Result<Db, StoreError> {
        let conn = Connection::open(path).map_err(StoreError::platform)?;
        Self::setup(conn, migrations, true)
    }

    pub fn open_in_memory(migrations: &[String]) -> Result<Db, StoreError> {
        let conn = Connection::open_in_memory().map_err(StoreError::platform)?;
        Self::setup(conn, migrations, false)
    }

    fn setup(conn: Connection, migrations: &[String], file: bool) -> Result<Db, StoreError> {
        conn.busy_timeout(Duration::from_secs(5)).map_err(StoreError::sql)?;
        if file {
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0)).map_err(StoreError::sql)?;
        }
        conn.pragma_update(None, "foreign_keys", true).map_err(StoreError::sql)?;
        let mut db = Db { conn };
        db.migrate(migrations)?;
        Ok(db)
    }

    /// Applies, in order and once each, the migrations the database has not had.
    /// Script *n* and `PRAGMA user_version = n` are one transaction. A script
    /// must not contain `BEGIN` or `COMMIT`.
    pub fn migrate(&mut self, migrations: &[String]) -> Result<u32, StoreError> {
        let current = self.version()?;
        if current as usize > migrations.len() {
            return Err(StoreError::TooNew {
                message: format!("the database is at version {current}, but this build of the app only knows {} migration(s)", migrations.len()),
            });
        }
        let pending = &migrations[current as usize..];
        // Check them all first: a script that cannot run should stop everything before anything changes.
        for (i, script) in pending.iter().enumerate() {
            if is_blank(script) {
                return Err(StoreError::Migration { version: current + i as u32 + 1, message: "the script is empty or only comments".into() });
            }
        }
        for (i, script) in pending.iter().enumerate() {
            let version = current + i as u32 + 1;
            let failed = |e: rusqlite::Error| StoreError::Migration { version, message: e.to_string() };
            let tx = self.conn.transaction().map_err(failed)?;
            tx.execute_batch(script).map_err(failed)?;
            tx.pragma_update(None, "user_version", version).map_err(failed)?;
            tx.commit().map_err(failed)?;
        }
        self.version()
    }

    pub fn version(&self) -> Result<u32, StoreError> {
        self.conn.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(StoreError::sql)
    }

    pub fn journal_mode(&self) -> Result<String, StoreError> {
        self.conn.pragma_query_value(None, "journal_mode", |row| row.get(0)).map_err(StoreError::sql)
    }

    /// Reads rows as JSON objects, in the order the statement returns them.
    pub fn select(&self, sql: &str, params: &[Json]) -> Result<Vec<Json>, StoreError> {
        not_blank(sql)?;
        let values = to_values(params)?;
        let mut stmt = self.conn.prepare(sql).map_err(StoreError::sql)?;
        let names: Vec<String> = stmt.column_names().map(|n| n.to_string()).collect();
        let mut rows = stmt.query(params_from_iter(values)).map_err(StoreError::sql)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(StoreError::sql)? {
            let mut object = serde_json::Map::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                object.insert(name.clone(), from_ref(row.get_ref(i).map_err(StoreError::sql)?, name)?);
            }
            out.push(Json::Object(object));
        }
        Ok(out)
    }

    /// Runs one statement and returns how many rows it changed.
    pub fn execute(&self, sql: &str, params: &[Json]) -> Result<u32, StoreError> {
        not_blank(sql)?;
        let values = to_values(params)?;
        let changed = self.conn.execute(sql, params_from_iter(values)).map_err(StoreError::sql)?;
        Ok(changed as u32)
    }

    /// Runs the statements in one transaction: all of them, or none.
    pub fn batch(&mut self, statements: &[Statement]) -> Result<(), StoreError> {
        // Check what can be checked before opening the transaction.
        let mut prepared = Vec::with_capacity(statements.len());
        for (i, st) in statements.iter().enumerate() {
            not_blank(&st.sql).map_err(|e| StoreError::Empty { message: format!("statement {}: {e}", i + 1) })?;
            prepared.push(to_values(st.params.iter().map(|p| &p.0)).map_err(|e| StoreError::Invalid { message: format!("statement {}: {e}", i + 1) })?);
        }
        let tx = self.conn.transaction().map_err(StoreError::sql)?;
        for (i, (st, values)) in statements.iter().zip(prepared).enumerate() {
            tx.execute(&st.sql, params_from_iter(values)).map_err(|e| StoreError::Sql { message: format!("statement {}: {e}", i + 1) })?;
        }
        tx.commit().map_err(StoreError::sql)
    }

    pub fn info(&self, path: &Path) -> Result<StoreInfo, StoreError> {
        Ok(StoreInfo { path: path.display().to_string(), version: self.version()?, sqlite_version: rusqlite::version().to_string(), journal_mode: self.journal_mode()? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scripts(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    fn st(sql: &str, params: Vec<Json>) -> Statement {
        Statement { sql: sql.into(), params: params.into_iter().map(Param).collect() }
    }
    fn tables(db: &Db) -> Vec<String> {
        db.select("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", &[]).unwrap().iter().map(|r| r["name"].as_str().unwrap().to_string()).collect()
    }
    fn count(db: &Db, table: &str) -> i64 {
        db.select(&format!("SELECT COUNT(*) AS n FROM {table}"), &[]).unwrap()[0]["n"].as_i64().unwrap()
    }
    struct TempFile(std::path::PathBuf);
    impl TempFile {
        fn new(name: &str) -> TempFile {
            let dir = std::env::temp_dir().join(format!("dk-store-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempFile(dir)
        }
        fn db(&self) -> std::path::PathBuf {
            self.0.join("app.db")
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn migrations_apply_once_and_in_order() {
        let t = TempFile::new("order");
        let m = scripts(&["CREATE TABLE a (n INTEGER)", "ALTER TABLE a ADD COLUMN s TEXT", "CREATE TABLE b (x TEXT)"]);
        let db = Db::open(&t.db(), &m[..2]).unwrap();
        assert_eq!(db.version().unwrap(), 2);
        db.execute("INSERT INTO a (n, s) VALUES (?, ?)", &[json!(1), json!("kept")]).unwrap();
        drop(db);
        // Opening the same two again applies nothing (a second `ALTER` would fail), and the data is kept.
        let mut db = Db::open(&t.db(), &m[..2]).unwrap();
        assert_eq!(db.version().unwrap(), 2);
        assert_eq!(count(&db, "a"), 1);
        // A build that declares three applies only the third.
        assert_eq!(db.migrate(&m).unwrap(), 3);
        assert_eq!(tables(&db), ["a", "b"]);
        assert_eq!(db.migrate(&m).unwrap(), 3);
        assert_eq!(db.select("SELECT s FROM a", &[]).unwrap(), [json!({ "s": "kept" })]);
    }

    #[test]
    fn a_failed_migration_leaves_the_version_and_the_data_unchanged() {
        let t = TempFile::new("failed");
        let good = scripts(&["CREATE TABLE a (n INTEGER); INSERT INTO a VALUES (1)"]);
        drop(Db::open(&t.db(), &good).unwrap());
        // Migration 2 creates a table and then fails: the table must not stay.
        let bad = scripts(&["CREATE TABLE a (n INTEGER); INSERT INTO a VALUES (1)", "CREATE TABLE half (x); INSERT INTO nope VALUES (1)"]);
        let err = Db::open(&t.db(), &bad).err().unwrap();
        assert!(matches!(&err, StoreError::Migration { version: 2, message } if message.contains("nope")), "{err:?}");
        let db = Db::open(&t.db(), &good).unwrap();
        assert_eq!(db.version().unwrap(), 1);
        assert_eq!(tables(&db), ["a"]);
        assert_eq!(count(&db, "a"), 1);
    }

    #[test]
    fn a_failure_in_the_first_migration_creates_nothing() {
        let t = TempFile::new("first");
        let err = Db::open(&t.db(), &scripts(&["CREATE TABLE a (n); SELECT * FROM missing; CREATE TABLE b (n)"])).err().unwrap();
        assert!(matches!(err, StoreError::Migration { version: 1, .. }), "{err:?}");
        let mut db = Db::open(&t.db(), &[]).unwrap();
        assert_eq!(db.version().unwrap(), 0);
        assert!(tables(&db).is_empty());
        assert_eq!(db.migrate(&scripts(&["CREATE TABLE a (n)"])).unwrap(), 1);
    }

    #[test]
    fn an_empty_or_comment_only_script_is_refused_with_a_clear_error_and_nothing_applies() {
        for blank in ["", "   \n", "-- nothing here", "/* nothing */ ;", "; ;"] {
            assert!(is_blank(blank), "{blank:?}");
            let err = Db::open_in_memory(&scripts(&["CREATE TABLE a (n)", blank])).err().unwrap();
            assert!(matches!(&err, StoreError::Migration { version: 2, message } if message.contains("empty")), "{blank:?}: {err:?}");
        }
        // Checked before anything runs: the first, valid script was not applied either.
        let t = TempFile::new("blank");
        assert!(Db::open(&t.db(), &scripts(&["CREATE TABLE a (n)", "-- later"])).is_err());
        assert_eq!(Db::open(&t.db(), &[]).unwrap().version().unwrap(), 0);
        assert!(!is_blank("-- c\nSELECT 1"));
        assert!(!is_blank("/* c */ CREATE TABLE a (n)"));
    }

    #[test]
    fn empty_statements_are_refused_by_every_call() {
        let mut db = Db::open_in_memory(&scripts(&["CREATE TABLE a (n)"])).unwrap();
        assert!(matches!(db.select("", &[]), Err(StoreError::Empty { .. })));
        assert!(matches!(db.execute("-- x", &[]), Err(StoreError::Empty { .. })));
        let err = db.batch(&[st("INSERT INTO a VALUES (1)", vec![]), st("  ", vec![])]).unwrap_err();
        assert!(matches!(&err, StoreError::Empty { message } if message.starts_with("statement 2:")), "{err:?}");
        assert_eq!(count(&db, "a"), 0, "nothing ran");
    }

    #[test]
    fn a_database_from_a_newer_build_is_not_touched() {
        let t = TempFile::new("newer");
        drop(Db::open(&t.db(), &scripts(&["CREATE TABLE a (n)", "CREATE TABLE b (n)"])).unwrap());
        let err = Db::open(&t.db(), &scripts(&["CREATE TABLE a (n)"])).err().unwrap();
        assert!(matches!(err, StoreError::TooNew { .. }), "{err:?}");
    }

    #[test]
    fn a_failing_batch_stores_nothing() {
        let mut db = Db::open_in_memory(&scripts(&["CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)"])).unwrap();
        db.batch(&[st("INSERT INTO a (id, n) VALUES (1, 1)", vec![])]).unwrap();
        // The second statement violates NOT NULL, the third would be fine.
        let err = db.batch(&[st("INSERT INTO a (id, n) VALUES (?, ?)", vec![json!(2), json!(2)]), st("INSERT INTO a (id, n) VALUES (3, NULL)", vec![]), st("INSERT INTO a (id, n) VALUES (4, 4)", vec![])]).unwrap_err();
        assert!(matches!(&err, StoreError::Sql { message } if message.starts_with("statement 2:")), "{err:?}");
        assert_eq!(db.select("SELECT id FROM a ORDER BY id", &[]).unwrap(), [json!({ "id": 1 })]);
        // 20 times in a row, as the spike asked, and the connection is still usable.
        for i in 0..20 {
            assert!(db.batch(&[st("INSERT INTO a (id, n) VALUES (?, 1)", vec![json!(100 + i)]), st("INSERT INTO nope VALUES (1)", vec![])]).is_err());
            db.batch(&[st("INSERT INTO a (id, n) VALUES (?, 1)", vec![json!(200 + i)])]).unwrap();
        }
        assert_eq!(count(&db, "a"), 21);
        assert!(db.select("SELECT id FROM a WHERE id >= 100 AND id < 200", &[]).unwrap().is_empty());
    }

    #[test]
    fn a_batch_survives_a_new_connection_and_a_killed_one_leaves_nothing() {
        let t = TempFile::new("kill");
        let m = scripts(&["CREATE TABLE a (n INTEGER)"]);
        let mut db = Db::open(&t.db(), &m).unwrap();
        db.batch(&[st("INSERT INTO a VALUES (1)", vec![]), st("INSERT INTO a VALUES (2)", vec![])]).unwrap();
        // An open transaction that is never committed, dropped as if the process died.
        {
            let tx = db.conn.transaction().unwrap();
            tx.execute("INSERT INTO a VALUES (99)", []).unwrap();
        }
        drop(db);
        let db = Db::open(&t.db(), &m).unwrap();
        assert_eq!(db.select("SELECT n FROM a ORDER BY n", &[]).unwrap(), [json!({ "n": 1 }), json!({ "n": 2 })]);
    }

    #[test]
    fn params_and_rows_are_json() {
        let db = Db::open_in_memory(&scripts(&["CREATE TABLE t (i INTEGER, r REAL, s TEXT, b INTEGER, n TEXT)"])).unwrap();
        let changed = db.execute("INSERT INTO t (i, r, s, b, n) VALUES (?, ?, ?, ?, ?)", &[json!(1_795_000_000_000_i64), json!(1.5), json!("héllo \"q\""), json!(true), Json::Null]).unwrap();
        assert_eq!(changed, 1);
        assert_eq!(db.select("SELECT * FROM t", &[]).unwrap(), [json!({ "i": 1_795_000_000_000_i64, "r": 1.5, "s": "héllo \"q\"", "b": 1, "n": null })]);
        // A parameter that is neither a scalar nor null is refused.
        assert!(matches!(db.execute("INSERT INTO t (s) VALUES (?)", &[json!(["x"])]), Err(StoreError::Invalid { .. })));
        assert!(matches!(db.select("SELECT ?", &[json!({ "a": 1 })]), Err(StoreError::Invalid { .. })));
        // A BLOB is not returned, with a message naming the column.
        let err = db.select("SELECT x'00ff' AS raw", &[]).unwrap_err();
        assert!(matches!(&err, StoreError::Invalid { message } if message.contains("raw")), "{err:?}");
        // Several statements in one call, and a statement that returns rows from execute, are errors.
        assert!(db.select("SELECT 1; SELECT 2", &[]).is_err());
        assert!(db.execute("SELECT 1", &[]).is_err());
    }

    #[test]
    fn wal_and_foreign_keys_are_on() {
        let t = TempFile::new("wal");
        let m = scripts(&["CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id))"]);
        let db = Db::open(&t.db(), &m).unwrap();
        assert_eq!(db.journal_mode().unwrap(), "wal");
        assert!(db.execute("INSERT INTO c (pid) VALUES (7)", &[]).is_err(), "no parent row");
        let info = db.info(&t.db()).unwrap();
        assert_eq!((info.version, info.journal_mode.as_str()), (1, "wal"));
        assert_eq!(info.sqlite_version, "3.54.1");
    }
}
