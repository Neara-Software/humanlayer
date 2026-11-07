use std::path::PathBuf;

const DEFAULT_DIRNAME: &str = "riptide";

/// The local state directory the app shares with riptided (host id, logs, config, window state).
/// A GUI app has no shell environment, so a renamed build bakes its directory name in at compile
/// time (HUMANLAYER_RIPTIDE_DIRNAME, under ~/.humanlayer). HUMANLAYER_RIPTIDE_HOME overrides it at
/// runtime. Neither set keeps ~/.humanlayer/riptide.
pub fn riptide_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("HUMANLAYER_RIPTIDE_HOME").filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    humanlayer_dir().join(option_env!("HUMANLAYER_RIPTIDE_DIRNAME").unwrap_or(DEFAULT_DIRNAME))
}

/// Whether riptide_dir() is the upstream default, so riptided needs no extra environment.
pub fn is_default_riptide_dir() -> bool {
    riptide_dir() == humanlayer_dir().join(DEFAULT_DIRNAME)
}

fn humanlayer_dir() -> PathBuf {
    dirs::home_dir()
        .expect("Failed to get home directory")
        .join(".humanlayer")
}
