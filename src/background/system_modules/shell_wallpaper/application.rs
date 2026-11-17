use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use notify_debouncer_full::{
    DebounceEventResult, Debouncer, FileIdMap, new_debouncer,
    notify::{ReadDirectoryChangesWatcher, RecursiveMode},
};
use windows::Win32::UI::WindowsAndMessaging::WM_SETTINGCHANGE;

use crate::{
    error::Result,
    event_manager,
    platform::shell,
    utils::{lock_free::TracedMutex, spawn_named_thread},
    windows_api::event_window::subscribe_to_background_window,
};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Tracks the static wallpaper currently selected by Windows. Changes are detected through
/// `WM_SETTINGCHANGE` (wallpaper switched) and a watcher on the wallpaper's folder (same file
/// overwritten in place, e.g. slideshows or third-party wallpaper snapshots). No polling.
pub struct ShellWallpaperManager {
    snapshot: TracedMutex<ShellWallpaperSnapshot>,
    watcher: TracedMutex<Option<FolderWatcher>>,
    refresh_tx: crossbeam_channel::Sender<()>,
}

#[derive(Debug, Clone)]
pub enum ShellWallpaperEvent {
    Changed(ShellWallpaperSnapshot),
}

event_manager!(ShellWallpaperManager, ShellWallpaperEvent);

impl ShellWallpaperManager {
    pub fn instance() -> &'static Self {
        static MANAGER: LazyLock<ShellWallpaperManager> = LazyLock::new(ShellWallpaperManager::new);
        &MANAGER
    }

    fn new() -> Self {
        let (refresh_tx, refresh_rx) = crossbeam_channel::unbounded::<()>();
        let manager = Self {
            snapshot: TracedMutex::new(ShellWallpaperSnapshot::default()),
            watcher: TracedMutex::new(None),
            refresh_tx,
        };

        // Initial state is read synchronously so the first command already returns real data.
        manager.refresh();

        // A single worker serializes refreshes (and watcher swaps), coalescing bursts.
        spawn_named_thread("Shell Wallpaper Watcher", move || {
            while refresh_rx.recv().is_ok() {
                while refresh_rx.try_recv().is_ok() {}
                Self::instance().refresh();
            }
        });
        subscribe_to_background_window(Self::on_bg_window_proc);
        manager
    }

    pub fn snapshot(&self) -> ShellWallpaperSnapshot {
        self.snapshot.lock().clone()
    }

    fn request_refresh(&self) {
        let _ = self.refresh_tx.send(());
    }

    fn refresh(&self) {
        let next = ShellWallpaperSnapshot::read();
        self.update_watcher(&next.path);

        let changed = {
            let mut current = self.snapshot.lock();
            if *current == next {
                false
            } else {
                *current = next.clone();
                true
            }
        };

        if changed {
            log::trace!("Windows wallpaper changed: {:?}", next.path);
            Self::send(ShellWallpaperEvent::Changed(next));
        }
    }

    fn update_watcher(&self, wallpaper: &Path) {
        let folder = wallpaper
            .parent()
            .filter(|folder| !folder.as_os_str().is_empty())
            .map(Path::to_path_buf);

        let previous = {
            let mut watcher = self.watcher.lock();
            if watcher.as_ref().map(|w| &w.folder) == folder.as_ref() {
                return;
            }
            watcher.take()
        };
        // Dropped outside the lock; debouncer drop only signals its thread to stop.
        drop(previous);

        let Some(folder) = folder else {
            return;
        };
        match FolderWatcher::create(folder.clone()) {
            Ok(created) => *self.watcher.lock() = Some(created),
            Err(err) => log::warn!("Failed to watch wallpaper folder {folder:?}: {err}"),
        }
    }

    fn on_bg_window_proc(msg: u32, _w_param: usize, _l_param: isize) -> Result<()> {
        // Re-reading is cheap and only emits on a real change, so every setting change is
        // accepted instead of trusting `SPI_SETDESKWALLPAPER` to be the reported parameter.
        if msg == WM_SETTINGCHANGE {
            Self::instance().request_refresh();
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShellWallpaperSnapshot {
    /// Empty when Windows has no wallpaper image (e.g. a solid color background).
    pub path: PathBuf,
    /// File modification time in ms; changes when the same file is overwritten in place.
    pub revision: u64,
}

impl ShellWallpaperSnapshot {
    fn read() -> Self {
        let path = match shell::wallpaper() {
            Ok(path) => path,
            Err(err) => {
                log::warn!("Failed to read the Windows wallpaper path: {err}");
                return Self::default();
            }
        };
        if path.as_os_str().is_empty() {
            return Self::default();
        }
        let revision = file_revision(&path);
        Self { path, revision }
    }
}

struct FolderWatcher {
    folder: PathBuf,
    _debouncer: Debouncer<ReadDirectoryChangesWatcher, FileIdMap>,
}

impl FolderWatcher {
    fn create(folder: PathBuf) -> Result<Self> {
        let mut debouncer =
            new_debouncer(
                WATCH_DEBOUNCE,
                None,
                |result: DebounceEventResult| match result {
                    Ok(_) => ShellWallpaperManager::instance().request_refresh(),
                    Err(errors) => log::warn!("Wallpaper folder watcher errors: {errors:?}"),
                },
            )?;
        debouncer.watch(&folder, RecursiveMode::NonRecursive)?;
        Ok(Self {
            folder,
            _debouncer: debouncer,
        })
    }
}

fn file_revision(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}
