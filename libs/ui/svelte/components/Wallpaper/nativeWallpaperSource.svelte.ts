import { invoke, SeelenCommand } from "@seelen-ui/lib";
import { convertFileSrc } from "@tauri-apps/api/core";

class NativeWallpaperSource {
  imageSrc = $state("");

  private users = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private requested = "";
  private refreshing = false;

  acquire(): () => void {
    this.users += 1;
    if (this.users === 1) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), 2500);
    }
    return () => {
      this.users -= 1;
      if (this.users === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.requested = "";
      }
    };
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [path, revision] = await invoke(SeelenCommand.GetNativeShellWallpaperSnapshot);
      if (this.users === 0) return;
      if (!path) {
        this.requested = "";
        this.imageSrc = "";
        return;
      }
      const next = `${convertFileSrc(path)}?revision=${revision}`;
      if (this.requested === next) return;
      this.requested = next;
      const image = new Image();
      image.onload = () => {
        if (this.users > 0 && this.requested === next) this.imageSrc = next;
      };
      image.onerror = () => {
        if (this.requested === next) this.requested = "";
      };
      image.src = next;
    } catch {
      // Windows may not have a wallpaper image selected yet.
    } finally {
      this.refreshing = false;
    }
  }
}

export const nativeWallpaperSource = new NativeWallpaperSource();
