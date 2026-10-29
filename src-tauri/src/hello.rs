//! Windows Hello for the app lock (SE-03): the lock screen can ask Windows to check it's you
//! (face, fingerprint or PIN). The passcode stays the fallback, and on other systems Hello is
//! reported unavailable. Nothing is stored: Windows only answers "verified" or not.

pub mod commands {
    /// Whether Windows Hello is set up on this PC (always false elsewhere).
    #[tauri::command]
    pub async fn hello_available() -> bool {
        #[cfg(windows)]
        {
            tauri::async_runtime::spawn_blocking(super::windows_hello::available)
                .await
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    /// Asks Windows Hello to confirm it's you, over FUSE's window; true when it did.
    #[tauri::command]
    pub async fn hello_verify(
        window: tauri::WebviewWindow,
        message: String,
    ) -> Result<bool, String> {
        #[cfg(windows)]
        {
            // A raw window handle isn't Send; its address is.
            let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
            tauri::async_runtime::spawn_blocking(move || {
                super::windows_hello::verify(hwnd, &message)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        #[cfg(not(windows))]
        {
            let _ = (window, message);
            Err("Windows Hello is only on Windows.".into())
        }
    }
}

#[cfg(windows)]
mod windows_hello {
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows::core::{HSTRING, factory};
    use windows_future::IAsyncOperation;

    /// WinRT calls need COM on this (blocking-pool) thread; already set up is fine too.
    fn com() {
        // SAFETY: plain COM initialisation for the current thread, with no reserved pointer.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    }

    pub fn available() -> bool {
        com();
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.join())
            .map(|a| a == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    pub fn verify(hwnd: isize, message: &str) -> Result<bool, String> {
        com();
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
            .map_err(|e| e.message())?;
        // SAFETY: `hwnd` is FUSE's own main window, alive while the lock screen waits on this.
        let op: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(
                HWND(hwnd as *mut core::ffi::c_void),
                &HSTRING::from(message),
            )
        }
        .map_err(|e| e.message())?;
        let result = op.join().map_err(|e| e.message())?;
        Ok(result == UserConsentVerificationResult::Verified)
    }
}
