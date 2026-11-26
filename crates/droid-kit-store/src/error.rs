//! What a store call can fail with, as the app receives it.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StoreError {
    /// SQLite refused the statement.
    #[error("{message}")]
    Sql { message: String },
    /// The SQL was empty or only comments. SQLite (rusqlite 0.43) refuses that, so the store says so instead.
    #[error("{message}")]
    Empty { message: String },
    /// A parameter or an argument the store cannot use.
    #[error("{message}")]
    Invalid { message: String },
    /// A migration failed. It was rolled back: the version and the data are as before.
    #[error("migration {version} failed: {message}")]
    Migration { version: u32, message: String },
    /// The database was made by a newer build of the app than this one.
    #[error("{message}")]
    TooNew { message: String },
    /// `open` has not been called, or the app opened another database.
    #[error("{message}")]
    NotOpen { message: String },
    /// The data directory or the file could not be used.
    #[error("{message}")]
    Platform { message: String },
}

impl StoreError {
    pub fn sql(e: impl std::fmt::Display) -> Self {
        StoreError::Sql { message: e.to_string() }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        StoreError::Invalid { message: message.into() }
    }
    pub fn platform(e: impl std::fmt::Display) -> Self {
        StoreError::Platform { message: e.to_string() }
    }
}
