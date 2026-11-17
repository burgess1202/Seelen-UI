use std::{path::PathBuf, sync::Once};

use seelen_core::handlers::SeelenEvent;
use tauri::Manager;

use crate::{
    app::{emit_to_webviews, get_app_handle},
    error::ResultLogExt,
};

use super::application::{ShellWallpaperEvent, ShellWallpaperManager, ShellWallpaperSnapshot};

fn get_shell_wallpaper_manager() -> &'static ShellWallpaperManager {
    static TAURI_EVENT_REGISTRATION: Once = Once::new();
    TAURI_EVENT_REGISTRATION.call_once(|| {
        ShellWallpaperManager::subscribe(|event| {
            let ShellWallpaperEvent::Changed(snapshot) = event;
            emit_to_webviews(
                SeelenEvent::NativeShellWallpaperChanged,
                expose_snapshot(snapshot),
            );
        });
    });
    ShellWallpaperManager::instance()
}

impl crate::tauri_handlers::Handlers {
    /// The revision changes when an application overwrites the same wallpaper file.
    pub fn get_native_shell_wallpaper_snapshot() -> (PathBuf, u64) {
        expose_snapshot(get_shell_wallpaper_manager().snapshot())
    }
}

/// The Windows wallpaper can live anywhere and may have no extension (`TranscodedWallpaper`),
/// so the static asset scope cannot cover it. Allow exactly the current file instead of
/// widening the scope to whole folders or extensions.
fn expose_snapshot(snapshot: ShellWallpaperSnapshot) -> (PathBuf, u64) {
    if !snapshot.path.as_os_str().is_empty() {
        get_app_handle()
            .asset_protocol_scope()
            .allow_file(&snapshot.path)
            .log_error();
    }
    (snapshot.path, snapshot.revision)
}
