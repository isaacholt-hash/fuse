/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev only: screen to open on start (used by scripts/screenshot.sh). */
  readonly VITE_FUSE_VIEW?: string;
}

/** The React preview runtime as one script (vite.config.ts, AR-05). */
declare module "virtual:react-preview-runtime" {
  const code: string;
  export default code;
}
