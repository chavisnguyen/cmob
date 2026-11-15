fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let assets_dir = std::path::Path::new("assets");

    // In release mode: STRICT CHECK - Never allow dummy fallback in production binaries.
    if profile == "release" {
        let has_real_bundle = assets_dir.exists()
            && assets_dir.join("assets").is_dir()
            && assets_dir.join("index.html").is_file();

        if !has_real_bundle {
            panic!(
                "FATAL: Cannot compile release binary without real Vite PWA assets! \
                Run 'make build' or 'vp build' in repos/cmux-client first."
            );
        }
        return;
    }

    // In debug / test mode: ensure assets/ directory and dummy index.html exist
    // solely so backend unit tests (cargo test) can compile without needing a full frontend build.
    if !assets_dir.exists() {
        let _ = std::fs::create_dir_all(assets_dir);
    }
    let index_file = assets_dir.join("index.html");
    if !index_file.exists() {
        let _ = std::fs::write(
            index_file,
            "<!DOCTYPE html><html><body>cmux-mobile test placeholder</body></html>",
        );
    }
}
