/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev only: screen to open on start (used by scripts/screenshot.sh). */
  readonly VITE_FUSE_VIEW?: string;
}
