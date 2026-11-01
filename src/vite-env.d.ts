/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev only: screen to open on start (used by scripts/screenshot.sh). */
  readonly VITE_FUSE_VIEW?: string;
  /** M10 step 12: "code" opens the Code area (screenshots). */
  readonly VITE_FUSE_AREA?: string;
  /** The click-through test build only (M8 step 14): the folder "Add a folder" links. */
  readonly VITE_E2E_FOLDER?: string;
}

/** The React preview runtime as one script (vite.config.ts, AR-05). */
declare module "virtual:react-preview-runtime" {
  const code: string;
  export default code;
}
