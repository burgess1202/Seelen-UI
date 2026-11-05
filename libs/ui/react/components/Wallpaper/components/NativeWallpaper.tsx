import { invoke, SeelenCommand } from "@seelen-ui/lib";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "preact/hooks";

import type { DefinedWallProps } from "../types";
import { getWallpaperStyles } from "../utils.ts";
import { cx } from "libs/ui/react/utils/styling.ts";
import cs from "../index.module.css";

export function NativeWallpaper({ definition, config, onLoad }: DefinedWallProps) {
  const [imageSrc, setImageSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    let requested = "";

    async function refresh() {
      try {
        const [path, revision] = await invoke(SeelenCommand.GetNativeShellWallpaperSnapshot);
        if (cancelled) return;
        if (!path) {
          requested = "";
          setImageSrc("");
          return;
        }
        const next = `${convertFileSrc(path)}?revision=${revision}`;
        if (requested === next) return;
        requested = next;
        const image = new Image();
        image.onload = () => {
          if (!cancelled && requested === next) setImageSrc(next);
        };
        image.onerror = () => {
          if (requested === next) requested = "";
        };
        image.src = next;
      } catch {
        // Windows may not have a wallpaper image selected yet.
      }
    }

    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return imageSrc
    ? (
      <img
        id={definition.id}
        className={cx(cs.wallpaper, "wallpaper")}
        style={getWallpaperStyles(config)}
        src={imageSrc}
        onLoad={onLoad}
        decoding="async"
        alt=""
      />
    )
    : null;
}
