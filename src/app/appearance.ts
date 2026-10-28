// Text size and reduced motion (PL-10), remembered on this device like the theme.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import type { Motion, TextSize } from "@/ui/types";

/** The webview's zoom for each text size: it scales everything, fixed pixel sizes included. */
export const ZOOM: Record<TextSize, number> = { small: 0.9, normal: 1, large: 1.15 };

const SIZE_KEY = "fuse.text_size";
const MOTION_KEY = "fuse.motion";

/** Sets the webview's zoom (Tauri); tests pass a fake. */
export type ZoomApi = (scale: number) => Promise<void>;
export const tauriZoom: ZoomApi = async (scale) => {
  await getCurrentWebview().setZoom(scale);
};

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.find((a) => a === v) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // the preference just isn't remembered
  }
}

export function useAppearance(zoom: ZoomApi | undefined) {
  const [textSize, setTextSize] = useState<TextSize>(() =>
    read(SIZE_KEY, ["small", "normal", "large"], "normal"),
  );
  const [motion, setMotion] = useState<Motion>(() =>
    read(MOTION_KEY, ["system", "reduce", "full"], "system"),
  );
  useEffect(() => {
    write(SIZE_KEY, textSize);
    zoom?.(ZOOM[textSize]).catch(() => {
      // an older webview without zoom keeps the normal size
    });
  }, [textSize, zoom]);
  useEffect(() => {
    write(MOTION_KEY, motion);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "reduce-motion",
        motion === "reduce" || (motion === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
    };
  }, [motion]);
  return { textSize, setTextSize, motion, setMotion };
}
