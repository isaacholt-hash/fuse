import { useEffect, useState } from "react";
import type { Theme } from "@/ui/types";

const STORAGE_KEY = "fuse.theme";

function stored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Light / dark / system, remembered on this device. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // preference just isn't remembered
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
    };
  }, [theme]);
  return [theme, setTheme] as const;
}
