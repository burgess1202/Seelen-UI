import { invoke, SeelenCommand, SeelenEvent, subscribe } from "@seelen-ui/lib";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Shared source for the "Current Windows wallpaper" resource. The backend pushes a change event
 * when Windows switches wallpaper or overwrites the same file, so there is no polling here.
 */
class NativeWallpaperSource {
  imageSrc = $state("");
  /** True when Windows has no wallpaper image or it cannot be loaded; callers show a fallback. */
  unavailable = $state(false);

  private users = 0;
  private requested = "";
  /** Bumped by every applied snapshot, so a stale initial fetch never overrides an event. */
  private generation = 0;
  private unlisten: Promise<UnlistenFn> | undefined;

  acquire(): () => void {
    this.users += 1;
    if (this.users === 1) this.start();
    return () => {
      this.users -= 1;
      if (this.users === 0) this.stop();
    };
  }

  private start(): void {
    // Listen first: an event may arrive while the initial snapshot is in flight.
    this.unlisten = subscribe(SeelenEvent.NativeShellWallpaperChanged, ({ payload }) => {
      this.apply(payload[0], payload[1]);
    });
    const generation = this.generation;
    invoke(SeelenCommand.GetNativeShellWallpaperSnapshot)
      .then(([path, revision]) => {
        if (this.generation === generation) this.apply(path, revision);
      })
      .catch((error) => console.error("Failed to read the Windows wallpaper", error));
  }

  private stop(): void {
    void this.unlisten?.then((unlisten) => unlisten());
    this.unlisten = undefined;
    this.requested = "";
    this.generation += 1;
  }

  private apply(path: string, revision: number): void {
    if (this.users === 0) return;
    this.generation += 1;

    if (!path) {
      this.requested = "";
      this.imageSrc = "";
      this.unavailable = true;
      return;
    }

    const next = `${convertFileSrc(path)}?revision=${revision}`;
    if (this.requested === next) return;
    this.requested = next;

    // Preload so the current image stays on screen until the next one is decoded.
    const image = new Image();
    image.onload = () => {
      if (this.users > 0 && this.requested === next) {
        this.imageSrc = next;
        this.unavailable = false;
      }
    };
    image.onerror = () => {
      if (this.requested !== next) return;
      console.error(`Failed to load the Windows wallpaper: ${path}`);
      this.requested = "";
      this.imageSrc = "";
      this.unavailable = true;
    };
    image.src = next;
  }
}

export const nativeWallpaperSource = new NativeWallpaperSource();
