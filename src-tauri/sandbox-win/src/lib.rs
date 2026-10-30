//! WF-07 on Windows (M8 step 9): a command runs in an AppContainer, Windows' own app sandbox.
//! It can write only where the container was granted access (the chat's folders, by an entry
//! added to each folder's permissions), read little beyond the system's own files, and reach the
//! network only when the container is given the network capabilities. A job object holds the
//! command and everything it starts, so ending the job ends them all, and they also end when
//! FUSE does.
//!
//! The folder permissions stay until `revoke` takes them off (Settings → "Reset folder
//! permissions"), and `remove_profile` deletes the container itself.
#![cfg(windows)]

use std::ffi::{OsStr, c_void};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, LocalFree,
    SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, REVOKE_ACCESS,
    SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID,
    TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
    DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
    CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, FreeSid, GetAce, GetAclInformation,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SECURITY_MAX_SID_SIZE,
    SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT, WinCapabilityInternetClientServerSid,
    WinCapabilityInternetClientSid, WinCapabilityPrivateNetworkClientServerSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};

/// The container every sandboxed command runs in.
const PROFILE: &str = "FUSE.Sandbox";
/// What a granted folder allows: read, write, run and delete, but not changing its permissions.
const ACCESS: u32 = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
/// An ACE's flag for "inherited from the parent", not set on the folder itself.
const INHERITED_ACE: u8 = 0x10;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// A capability that's on (winnt.h; windows-sys keeps it in SystemServices).
const SE_GROUP_ENABLED: u32 = 4;

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}

fn hr(code: i32) -> io::Result<()> {
    if code >= 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

fn win32(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

fn check(ok: i32) -> io::Result<()> {
    if ok != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `\\?\C:\x` (what `canonicalize` gives) as `C:\x`: cmd.exe can't start in the long form.
pub fn plain(path: &Path) -> PathBuf {
    let s = path.as_os_str().to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

struct Handle(HANDLE);

// SAFETY: a kernel handle may be used from any thread.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: this owns the handle and closes it once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// The container's SID, freed when dropped.
struct Sid(PSID);

impl Drop for Sid {
    fn drop(&mut self) {
        // SAFETY: from CreateAppContainerProfile or DeriveAppContainerSidFromAppContainerName,
        // which say to free it with FreeSid.
        unsafe { FreeSid(self.0) };
    }
}

/// The container, made the first time.
fn container() -> io::Result<Sid> {
    let name = wide(PROFILE);
    let mut sid: PSID = null_mut();
    // SAFETY: valid strings, no capabilities, and an out pointer for the SID.
    let made = unsafe {
        CreateAppContainerProfile(
            name.as_ptr(),
            wide("FUSE sandbox").as_ptr(),
            wide("Commands FUSE runs for you").as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if made >= 0 {
        return Ok(Sid(sid));
    }
    // Already made (HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)), or another failure: either way,
    // deriving the SID is what's left to try.
    // SAFETY: a valid string and an out pointer.
    hr(unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) })?;
    Ok(Sid(sid))
}

/// Whether commands can run in the container here (it can be made, or already exists).
pub fn available() -> bool {
    container().is_ok()
}

/// The container's own folder (its TEMP), which only it and you can write.
fn container_folder(sid: &Sid) -> io::Result<PathBuf> {
    let mut text: *mut u16 = null_mut();
    // SAFETY: a valid SID and an out pointer, freed with LocalFree below.
    check(unsafe { ConvertSidToStringSidW(sid.0, &mut text) })?;
    let mut path: *mut u16 = null_mut();
    // SAFETY: the SID string from above and an out pointer, freed with CoTaskMemFree below.
    let res = unsafe { GetAppContainerFolderPath(text, &mut path) };
    // SAFETY: from ConvertSidToStringSidW.
    unsafe { LocalFree(text.cast()) };
    hr(res)?;
    // SAFETY: a NUL-terminated string from GetAppContainerFolderPath.
    let s = unsafe {
        let len = (0..).take_while(|&i| *path.add(i) != 0).count();
        String::from_utf16_lossy(std::slice::from_raw_parts(path, len))
    };
    // SAFETY: from GetAppContainerFolderPath.
    unsafe { CoTaskMemFree(path.cast()) };
    Ok(PathBuf::from(s))
}

/// A path's permissions (its DACL), freed when dropped.
struct Dacl {
    sd: PSECURITY_DESCRIPTOR,
    acl: *mut ACL,
}

impl Drop for Dacl {
    fn drop(&mut self) {
        // SAFETY: from GetNamedSecurityInfoW, which says to free it with LocalFree.
        unsafe { LocalFree(self.sd) };
    }
}

fn dacl(path: &[u16]) -> io::Result<Dacl> {
    let mut sd: PSECURITY_DESCRIPTOR = null_mut();
    let mut acl: *mut ACL = null_mut();
    // SAFETY: a valid path and out pointers; only the DACL is asked for.
    win32(unsafe {
        GetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut sd,
        )
    })?;
    Ok(Dacl { sd, acl })
}

/// Whether `path` itself has the container's write entry (not just one inherited).
fn granted(path: &[u16], sid: &Sid) -> io::Result<bool> {
    let d = dacl(path)?;
    if d.acl.is_null() {
        return Ok(false);
    }
    let mut info = ACL_SIZE_INFORMATION {
        AceCount: 0,
        AclBytesInUse: 0,
        AclBytesFree: 0,
    };
    // SAFETY: a valid ACL and a buffer of the size given.
    check(unsafe {
        GetAclInformation(
            d.acl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    })?;
    for i in 0..info.AceCount {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: i is below the ACL's count; the ACE points into the ACL, which `d` keeps.
        if unsafe { GetAce(d.acl, i, &mut ace) } == 0 {
            continue;
        }
        // SAFETY: every ACE starts with a header; an allowed ACE is read only when its type says.
        unsafe {
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE || header.AceFlags & INHERITED_ACE != 0 {
                continue;
            }
            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
            let ace_sid = (&allowed.SidStart as *const u32)
                .cast_mut()
                .cast::<c_void>();
            if EqualSid(ace_sid, sid.0) != 0 && allowed.Mask & ACCESS == ACCESS {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn set_entry(path: &[u16], sid: &Sid, mode: i32) -> io::Result<()> {
    let d = dacl(path)?;
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: ACCESS,
        grfAccessMode: mode,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_WELL_KNOWN_GROUP,
            ptstrName: sid.0.cast(),
        },
    };
    let mut new: *mut ACL = null_mut();
    // SAFETY: one entry, the path's current DACL, and an out pointer freed below.
    win32(unsafe { SetEntriesInAclW(1, &entry, d.acl, &mut new) })?;
    // SAFETY: the new DACL from above; Windows passes inheritable entries on to what's inside.
    let res = unsafe {
        SetNamedSecurityInfoW(
            path.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new,
            null(),
        )
    };
    // SAFETY: from SetEntriesInAclW.
    unsafe { LocalFree(new.cast()) };
    win32(res)
}

/// Lets the container write in `path` and everything inside it. Returns whether it changed
/// anything (false when the folder already had it). On a large folder the first grant takes a
/// while: Windows writes the entry onto every file inside.
pub fn grant(path: &Path) -> io::Result<bool> {
    let sid = container()?;
    let p = wide(plain(path));
    if granted(&p, &sid)? {
        return Ok(false);
    }
    set_entry(&p, &sid, GRANT_ACCESS)?;
    Ok(true)
}

/// Takes the container's entries off `path` (and so off everything inside it).
pub fn revoke(path: &Path) -> io::Result<()> {
    let sid = container()?;
    set_entry(&wide(plain(path)), &sid, REVOKE_ACCESS)
}

/// Deletes the container and its own folder. Revoke folders first: their entries would stay,
/// naming a container that no longer exists.
pub fn remove_profile() -> io::Result<()> {
    // SAFETY: a valid string.
    hr(unsafe { DeleteAppContainerProfile(wide(PROFILE).as_ptr()) })
}

/// Ends a sandboxed command and everything it started.
#[derive(Clone)]
pub struct Killer(Arc<Handle>);

impl Killer {
    pub fn kill(&self) {
        // SAFETY: a job handle this owns.
        unsafe { TerminateJobObject(self.0.0, 1) };
    }
}

/// A running sandboxed command. Dropping it (and every `Killer`) ends whatever is left of it.
pub struct Child {
    process: Handle,
    job: Arc<Handle>,
    output: Option<File>,
}

impl Child {
    /// Its stdout and stderr together, in the order written; ends when it and everything it
    /// started have exited.
    pub fn take_output(&mut self) -> Option<File> {
        self.output.take()
    }

    pub fn killer(&self) -> Killer {
        Killer(self.job.clone())
    }

    /// Waits for the command itself to exit and returns its exit code (blocking).
    pub fn wait(&self) -> io::Result<u32> {
        // SAFETY: a process handle this owns.
        if unsafe { WaitForSingleObject(self.process.0, INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0u32;
        // SAFETY: as above, with an out pointer.
        check(unsafe { GetExitCodeProcess(self.process.0, &mut code) })?;
        Ok(code)
    }
}

pub struct Spawn<'a> {
    /// Where it starts; must be granted.
    pub cwd: &'a Path,
    /// Run by `cmd.exe /D /S /C`.
    pub command: &'a str,
    pub network: bool,
    /// Variables not passed on (provider keys).
    pub env_remove: &'a [&'a str],
}

/// The environment block: FUSE's own, less `remove`, with TEMP and TMP in the container's folder.
fn environment(remove: &[&str], temp: &Path) -> Vec<u16> {
    let mut vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|(k, _)| {
            !remove.iter().any(|r| r.eq_ignore_ascii_case(k))
                && !k.eq_ignore_ascii_case("TEMP")
                && !k.eq_ignore_ascii_case("TMP")
        })
        .collect();
    let temp = temp.to_string_lossy().into_owned();
    vars.push(("TEMP".into(), temp.clone()));
    vars.push(("TMP".into(), temp));
    vars.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block = Vec::new();
    for (k, v) in vars {
        block.extend(OsStr::new(&format!("{k}={v}")).encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

fn inheritable() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    }
}

/// Starts `cmd.exe /D /S /C <command>` in the container, inside a new job object.
pub fn spawn(s: &Spawn) -> io::Result<Child> {
    let sid = container()?;
    let temp = container_folder(&sid)?;

    // The network capabilities, only when allowed. Without them the container has no network.
    let kinds = [
        WinCapabilityInternetClientSid,
        WinCapabilityInternetClientServerSid,
        WinCapabilityPrivateNetworkClientServerSid,
    ];
    let mut sid_bufs = [[0u8; SECURITY_MAX_SID_SIZE as usize]; 3];
    let mut caps: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    if s.network {
        for (kind, buf) in kinds.iter().zip(sid_bufs.iter_mut()) {
            let mut size = SECURITY_MAX_SID_SIZE;
            // SAFETY: a buffer of SECURITY_MAX_SID_SIZE bytes, which every SID fits.
            check(unsafe {
                CreateWellKnownSid(*kind, null_mut(), buf.as_mut_ptr().cast(), &mut size)
            })?;
            caps.push(SID_AND_ATTRIBUTES {
                Sid: buf.as_mut_ptr().cast(),
                Attributes: SE_GROUP_ENABLED,
            });
        }
    }
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: sid.0,
        Capabilities: if caps.is_empty() {
            null_mut()
        } else {
            caps.as_mut_ptr()
        },
        CapabilityCount: caps.len() as u32,
        Reserved: 0,
    };

    // One pipe for stdout and stderr; FUSE keeps the read end. Input is NUL.
    let sa = inheritable();
    let (mut read, mut write): (HANDLE, HANDLE) = (null_mut(), null_mut());
    // SAFETY: out pointers and inheritable attributes.
    check(unsafe { CreatePipe(&mut read, &mut write, &sa, 0) })?;
    let read = Handle(read);
    let write = Handle(write);
    // SAFETY: a handle this owns; the read end stays with FUSE.
    check(unsafe { SetHandleInformation(read.0, HANDLE_FLAG_INHERIT, 0) })?;
    // SAFETY: a valid path and inheritable attributes.
    let nul = Handle(unsafe {
        CreateFileW(
            wide("NUL").as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &sa,
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    });
    if nul.0 == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    // The attributes: the container, and exactly which handles it inherits.
    let mut size = 0usize;
    // SAFETY: the first call only asks for the size (it fails, as documented).
    unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size) };
    let mut list_buf = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list: LPPROC_THREAD_ATTRIBUTE_LIST = list_buf.as_mut_ptr().cast();
    // SAFETY: a buffer of at least the size asked for, aligned for pointers.
    check(unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut size) })?;
    struct List(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for List {
        fn drop(&mut self) {
            // SAFETY: initialised above, deleted once.
            unsafe { DeleteProcThreadAttributeList(self.0) };
        }
    }
    let _list = List(list);
    let handles = [write.0, nul.0];
    // SAFETY: `security` and `handles` outlive CreateProcessW below.
    check(unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            (&security as *const SECURITY_CAPABILITIES).cast(),
            size_of::<SECURITY_CAPABILITIES>(),
            null_mut(),
            null(),
        )
    })?;
    // SAFETY: as above.
    check(unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(&handles),
            null_mut(),
            null(),
        )
    })?;

    // SAFETY: plain data, zeroed as Windows expects before the fields are set.
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = nul.0;
    si.StartupInfo.hStdOutput = write.0;
    si.StartupInfo.hStdError = write.0;
    si.lpAttributeList = list;

    // SAFETY: no attributes, no name.
    let job = Handle(unsafe { CreateJobObjectW(null(), null()) });
    if job.0.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: plain data, zeroed, then the one flag set.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: the job from above and a struct of the size given.
    check(unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    })?;

    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let cmd = Path::new(&system).join("System32").join("cmd.exe");
    let app = wide(&cmd);
    // /S: what follows /C is run as written, between the outer quotes.
    let mut line = wide(format!("\"{}\" /D /S /C \"{}\"", cmd.display(), s.command));
    let env = environment(s.env_remove, &temp);
    let cwd = wide(plain(s.cwd));
    // SAFETY: zeroed, then filled by CreateProcessW.
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is to a live buffer above; the startup info is extended, as the
    // flags say; the process starts suspended so it's in the job before it runs anything.
    check(unsafe {
        CreateProcessW(
            app.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW,
            env.as_ptr().cast(),
            cwd.as_ptr(),
            (&si as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
            &mut pi,
        )
    })?;
    let process = Handle(pi.hProcess);
    let thread = Handle(pi.hThread);
    // SAFETY: the job and the new, still suspended, process.
    if let Err(e) = check(unsafe { AssignProcessToJobObject(job.0, process.0) }) {
        // SAFETY: the process this just started; it never ran.
        unsafe { TerminateProcess(process.0, 1) };
        return Err(e);
    }
    // SAFETY: the new process's main thread.
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let e = io::Error::last_os_error();
        // SAFETY: a job this owns.
        unsafe { TerminateJobObject(job.0, 1) };
        return Err(e);
    }
    // FUSE's copy of the write end goes, so the output ends when the command's copies do.
    drop(write);
    drop(nul);
    let raw = read.0;
    std::mem::forget(read);
    Ok(Child {
        process,
        job: Arc::new(job),
        // SAFETY: the pipe's read end, owned from here on by the File.
        output: Some(unsafe { File::from_raw_handle(raw) }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn fresh_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fuse-sbx-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        plain(&std::fs::canonicalize(&dir).unwrap())
    }

    /// Runs `command` sandboxed in `dir` and returns its output and exit code.
    fn run(dir: &Path, command: &str, network: bool) -> (String, u32) {
        let mut child = spawn(&Spawn {
            cwd: dir,
            command,
            network,
            env_remove: &[],
        })
        .unwrap();
        let mut out = String::new();
        child
            .take_output()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        let code = child.wait().unwrap();
        (out, code)
    }

    #[test]
    fn writes_only_in_granted_folders() {
        let dir = fresh_dir("write");
        assert!(grant(&dir).unwrap());
        assert!(!grant(&dir).unwrap(), "a second grant changes nothing");
        let profile = std::env::var("USERPROFILE").unwrap();
        let outside = format!("{profile}\\fuse-sandbox-escape-{}.txt", std::process::id());
        let (out, _) = run(
            &dir,
            &format!(
                "echo inside> made.txt & mkdir sub & echo deep> sub\\deep.txt & \
                 echo x> \"{outside}\" & echo x> C:\\Windows\\fuse-escape.txt & type made.txt"
            ),
            false,
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("made.txt"))
                .unwrap()
                .trim(),
            "inside"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("sub").join("deep.txt"))
                .unwrap()
                .trim(),
            "deep"
        );
        assert!(
            !Path::new(&outside).exists(),
            "wrote outside its folder: {out}"
        );
        assert!(!Path::new("C:\\Windows\\fuse-escape.txt").exists(), "{out}");
        assert!(out.contains("denied"), "{out}");
    }

    #[test]
    fn no_network_unless_allowed() {
        let dir = fresh_dir("net");
        grant(&dir).unwrap();
        let probe = |url: &str| {
            format!("curl.exe -sS -m 15 -o NUL {url} && echo connected || echo blocked")
        };
        let (off, _) = run(&dir, &probe("http://example.com"), false);
        assert!(
            off.contains("blocked") && !off.contains("connected"),
            "{off}"
        );
        let (http, _) = run(&dir, &probe("http://example.com"), true);
        let (https, _) = run(&dir, &probe("https://example.com"), true);
        eprintln!("network on, http: {http}\nnetwork on, https: {https}");
        assert!(http.contains("connected"), "{http}");
        assert!(https.contains("connected"), "{https}");
    }

    #[test]
    fn killing_ends_the_whole_tree() {
        let dir = fresh_dir("kill");
        grant(&dir).unwrap();
        let mut child = spawn(&Spawn {
            cwd: &dir,
            command: "start /b ping -n 60 127.0.0.1 >NUL & ping -n 60 127.0.0.1",
            network: false,
            env_remove: &[],
        })
        .unwrap();
        let mut output = child.take_output().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let t = Instant::now();
        child.killer().kill();
        child.wait().unwrap();
        // The output ends only when the background ping, which shares it, has gone too.
        let mut rest = Vec::new();
        let _ = output.read_to_end(&mut rest);
        assert!(t.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn exit_code_and_no_keys() {
        let dir = fresh_dir("env");
        grant(&dir).unwrap();
        // SAFETY: no other test reads this variable.
        unsafe { std::env::set_var("FUSE_TEST_SECRET", "fake-for-test") };
        let mut child = spawn(&Spawn {
            cwd: &dir,
            command: "echo key=%FUSE_TEST_SECRET% & exit 3",
            network: false,
            env_remove: &["FUSE_TEST_SECRET"],
        })
        .unwrap();
        let mut out = String::new();
        child
            .take_output()
            .unwrap()
            .read_to_string(&mut out)
            .unwrap();
        assert_eq!(child.wait().unwrap(), 3);
        assert!(out.contains("key=%FUSE_TEST_SECRET%"), "{out}");
    }

    #[test]
    fn revoke_takes_the_access_away() {
        let dir = fresh_dir("revoke");
        grant(&dir).unwrap();
        revoke(&dir).unwrap();
        // It may not even start there now (the folder is its working directory).
        if let Ok(mut child) = spawn(&Spawn {
            cwd: &dir,
            command: "echo x> after.txt",
            network: false,
            env_remove: &[],
        }) {
            let mut out = String::new();
            let _ = child.take_output().unwrap().read_to_string(&mut out);
            let _ = child.wait();
        }
        assert!(!dir.join("after.txt").exists());
        assert!(grant(&dir).unwrap(), "grantable again after a revoke");
    }
}
