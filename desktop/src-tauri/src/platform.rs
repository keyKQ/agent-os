//! Platform differences in how the gateway child process is spawned and stopped.

use std::process::{Child, Command};
use std::time::{Duration, Instant};

/// How long a gateway gets to flush state and close its listener after being
/// asked politely, before it is killed outright.
const GRACEFUL_STOP: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

#[cfg(windows)]
pub fn configure_child(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    // Without this the bundled interpreter flashes a console window on every
    // launch and on every supervised restart.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
pub fn configure_child(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // A child inherits its parent's signal mask across fork and exec, and this
    // app blocks SIGTERM/SIGINT/SIGHUP process-wide so it can handle them on a
    // dedicated thread (see `block_terminate_signals`). Without this reset the
    // gateway inherits that mask and ignores the very SIGTERM `stop_child`
    // sends it, turning every graceful stop into an eight-second wait followed
    // by a SIGKILL -- and leaving a gateway that survives `kill` entirely once
    // it has been reparented.
    //
    // SAFETY: `pre_exec` runs in the forked child between fork and exec, where
    // only async-signal-safe functions may be called. `sigemptyset` and
    // `pthread_sigmask` are both on that list.
    unsafe {
        command.pre_exec(|| {
            let mut mask = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
            libc::sigemptyset(mask.as_mut_ptr());
            let mask = mask.assume_init();
            libc::pthread_sigmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
            Ok(())
        });
    }
}

/// Stop a gateway child, escalating only if it does not exit on its own.
///
/// On Unix the gateway gets a SIGTERM first: uvicorn's handler drains in-flight
/// turns and closes the listener, so the next launch finds a free port and an
/// unlocked SQLite database. A hard kill skips both.
///
/// Windows has no SIGTERM equivalent that reaches a non-console child, so the
/// terminate path is all that is available there. A gateway orphaned by a hard
/// app kill is not fatal in either case: the next launch probes the recorded
/// pidfile and attaches to the survivor instead of fighting it for the port.
pub fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // SAFETY: `pid` names a child of this process that has not been reaped
        // yet, so the identifier cannot have been recycled; kill(2) on a live
        // child is defined and errors are non-fatal here.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }

        let deadline = Instant::now() + GRACEFUL_STOP;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(POLL_INTERVAL),
                Err(_) => break,
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

/// True when `pid` names a live process.
///
/// This cannot tell a survivor from a recycled pid — only start-time
/// bookkeeping could — but it removes the common stale-record case: after a
/// reboot every recorded pid is dead, and a dead pid must never be treated as
/// "our earlier gateway" (and later signalled) just because some *other*
/// process now answers on the recorded port.
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: kill(2) with signal 0 performs error checking only and is
        // defined for any pid. Alive-but-not-ours answers EPERM, which still
        // means the pid is in use.
        let outcome = unsafe { libc::kill(pid as i32, 0) };
        outcome == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(windows)]
    {
        // `tasklist` filtered to the exact pid prints a table row containing
        // it on a hit and a "no tasks" message otherwise. Slower than an
        // OpenProcess probe but dependency-free, and this runs once per adopt.
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(false)
    }
}

/// Stop a gateway by pid — one this app started in an earlier run and adopted.
///
/// Not a `Child`, so there is nothing to reap and no exit status to collect;
/// the process is reparented to init and disappears on its own. The pid comes
/// from the app's own record, adopted only after `pid_alive` said the process
/// still exists *and* the recorded endpoint answered `/ready`; a recycled pid
/// behind a real gateway port remains theoretically reachable, which is why
/// the record is cleared on every clean shutdown.
pub fn stop_pid(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: kill(2) with a valid signal is defined for any pid; a pid
        // that has already exited yields ESRCH, which is ignored here.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }

    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

/// The signals that mean "stop": `kill`, Ctrl+C, and a closing session.
#[cfg(unix)]
const TERMINATE_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

#[cfg(unix)]
fn terminate_signal_set() -> libc::sigset_t {
    use std::mem::MaybeUninit;

    let mut mask = MaybeUninit::<libc::sigset_t>::uninit();
    // SAFETY: `sigemptyset` initializes the set through the pointer before any
    // `sigaddset` reads it, and the value is fully initialized before it is
    // assumed to be.
    unsafe {
        libc::sigemptyset(mask.as_mut_ptr());
        for signal in TERMINATE_SIGNALS {
            libc::sigaddset(mask.as_mut_ptr(), signal);
        }
        mask.assume_init()
    }
}

/// Block the terminate signals process-wide. Must run before any thread is
/// spawned, and therefore before Tauri is built.
///
/// `pthread_sigmask` only changes the calling thread's mask, but a new thread
/// inherits the mask of the thread that created it. Blocking on the main thread
/// first is what makes the mask universal — do it later and the threads Tauri
/// has already started keep the default disposition, so a SIGTERM delivered to
/// one of them terminates the process outright and the `sigwait` below never
/// runs.
#[cfg(unix)]
pub fn block_terminate_signals() {
    let mask = terminate_signal_set();
    // SAFETY: `mask` is an initialized sigset and the output parameter is
    // explicitly null because the previous mask is not needed.
    unsafe {
        libc::pthread_sigmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut());
    }
}

#[cfg(not(unix))]
pub fn block_terminate_signals() {}

/// Run `on_terminate` when the OS asks this process to stop.
///
/// Without this, a SIGTERM — `kill`, a logout, a process manager stopping the
/// app — tears the process down without Tauri's event loop ever reaching its
/// exit handler, orphaning the gateway.
///
/// The callback runs on a dedicated thread woken by `sigwait`, not in a signal
/// handler, so it is free to take locks and terminate a child process; neither
/// is async-signal-safe and neither would be legal in a real handler.
#[cfg(unix)]
pub fn on_terminate<F>(on_terminate: F)
where
    F: Fn() + Send + 'static,
{
    std::thread::Builder::new()
        .name("agentos-signal-watch".to_string())
        .spawn(move || {
            // Inherited from the main thread's mask, which block_terminate_signals
            // set before any thread existed.
            let mask = terminate_signal_set();
            let mut signal: libc::c_int = 0;
            // SAFETY: `mask` is an initialized sigset whose signals are blocked
            // in this thread, which is exactly sigwait's precondition.
            let waited = unsafe { libc::sigwait(&mask, &mut signal) };
            if waited == 0 {
                on_terminate();
            }
        })
        .expect("signal watch thread should spawn");
}

#[cfg(not(unix))]
pub fn on_terminate<F>(_on_terminate: F)
where
    F: Fn() + Send + 'static,
{
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    /// Regression test for a silent, easily-reintroduced bug.
    ///
    /// `block_terminate_signals` blocks SIGTERM so the app can handle it on a
    /// dedicated thread, and a child inherits that mask across fork and exec.
    /// A gateway spawned without `configure_child`'s reset therefore ignores
    /// every SIGTERM the supervisor sends it: each stop degrades into an
    /// eight-second wait and a SIGKILL, and a gateway orphaned by a hard app
    /// kill cannot be stopped with `kill` at all.
    #[test]
    fn a_child_does_not_inherit_the_blocked_terminate_mask() {
        block_terminate_signals();

        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_child(&mut command);

        let mut child = command.spawn().expect("/bin/sh should spawn");
        // Let the fork reach exec before signalling it.
        std::thread::sleep(Duration::from_millis(300));

        // SAFETY: `child` has not been reaped, so its pid cannot have been
        // recycled onto an unrelated process.
        unsafe {
            libc::kill(child.id() as i32, libc::SIGTERM);
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(Some(_status)) = child.try_wait() {
                return;
            }
            std::thread::sleep(POLL_INTERVAL);
        }

        let _ = child.kill();
        let _ = child.wait();
        panic!("child ignored SIGTERM: it inherited the parent's blocked signal mask");
    }
}
