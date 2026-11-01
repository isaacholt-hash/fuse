// Windows Hello for the app lock (SE-03): asked through Rust (src-tauri/src/hello.rs).
import { invoke } from "@/platform/core";

/** Settings key: "on" offers Windows Hello on the lock screen. */
export const HELLO_SETTING = "lock.hello";

export interface HelloApi {
  /** Whether Windows Hello is set up on this PC (false on other systems). */
  available(): Promise<boolean>;
  /** Asks Windows to check it's you; true when it did. */
  verify(message: string): Promise<boolean>;
}

export const tauriHello: HelloApi = {
  available: () => invoke<boolean>("hello_available"),
  verify: (message) => invoke<boolean>("hello_verify", { message }),
};
