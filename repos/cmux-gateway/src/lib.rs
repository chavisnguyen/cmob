pub mod cmux;
pub mod domain;
pub mod io;
pub mod protocol;
pub mod providers;
pub mod scanner;
pub mod server;
pub mod services;
pub mod transport;

// Clean crate-root aliases for external binaries and integration tests.
pub use io::{git_view, uploads};
pub use services::{file_read, notifications, pairing_store, push, spend, transcript_image, usage};
pub use transport::loopback;
