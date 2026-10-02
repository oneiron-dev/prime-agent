//! Kernel Python environment bootstrap: the public entry point
//! [`ensure_kernel_python`] resolves (and on first run builds) the venv that
//! runs `python -m rlm.repl`, deduplicating concurrent bootstraps;
//! [`prepare_kernel_environment`] does the same setup ahead of the kernel
//! (a one-shot run's foreground preparation). The venv and version-file
//! machinery lives in [`venv`], its owned child processes in
//! `venv::subprocess`, the opt-in setup trace in [`setup_trace`], and the
//! runtime bootstrap code injected into each kernel in [`runtime_code`].
//!
//! Ported from `core/kernel/bootstrap.ts`.

pub(crate) mod dir_lock;
mod disk_memo;
mod runtime_code;
pub mod setup_trace;
pub(crate) mod venv;

use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Context};

use dir_lock::acquire_bootstrap_lock;
pub use runtime_code::{
    build_rlm_bootstrap_code, parse_unavailable_python_skills, UnavailablePythonSkills,
    PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER,
};
use setup_trace::trace;
pub use setup_trace::{set_kernel_setup_trace, KernelSetupTrace};
use venv::subprocess::{ChildCancel, KERNEL_SETUP_CANCELLED};
use venv::{
    bootstrap_venv, ensure_uv, expand_home, has_prime_agent_runtime,
    missing_python_skill_import_labels, missing_rlm_extra_import_labels, normalize_python_skills,
    resolve_writable_kernel_venv_dir, sync_python_skills, BootstrapPythonSkill,
};
pub use venv::{
    invalidate_runtime_probe_cache, kernel_venv_dir, kernel_venv_python, resolve_runtime_identity,
};
use venv::{kernel_base_ready, kernel_ready};

use crate::kernel::cancellation::AbortSignal;

/// One Python skill the kernel should import at bootstrap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelPythonSkill {
    pub name: String,
    pub import_name: String,
    pub package_path: PathBuf,
    pub pyproject_path: PathBuf,
}

/// The default extra packages pre-installed in the kernel venv and promised to
/// the model in the system prompt.
pub const DEFAULT_RLM_EXTRA_PACKAGES: [(&str, &str, &str); 12] = [
    // (uvArg, importName, promptLabel)
    ("requests", "requests", "requests"),
    ("httpx", "httpx", "httpx"),
    ("pyyaml", "yaml", "yaml (PyYAML)"),
    ("tomli", "tomli", "tomli"),
    ("python-dotenv", "dotenv", "dotenv (python-dotenv)"),
    ("pandas", "pandas", "pandas"),
    ("numpy", "numpy", "numpy"),
    ("scipy", "scipy", "scipy"),
    ("beautifulsoup4", "bs4", "bs4 (Beautiful Soup)"),
    ("lxml", "lxml", "lxml"),
    ("pydantic", "pydantic", "pydantic"),
    ("tyro", "tyro", "tyro"),
];

#[must_use]
pub fn default_rlm_extra_uv_args() -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .map(|(uv, _, _)| *uv)
        .collect()
}

#[must_use]
pub fn default_rlm_extra_import_names() -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .map(|(_, import, _)| *import)
        .collect()
}

#[must_use]
pub fn default_rlm_extra_import_labels() -> Vec<&'static str> {
    DEFAULT_RLM_EXTRA_PACKAGES
        .iter()
        .map(|(_, _, label)| *label)
        .collect()
}

/// Progress callback for the bootstrap (`ensure_kernel_python`).
pub type KernelBootstrapProgressHandler = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub struct EnsureKernelPythonOptions {
    pub python_skills: Vec<KernelPythonSkill>,
    pub on_progress: Option<KernelBootstrapProgressHandler>,
    /// Cancels the setup: once the signal fires, the running `uv` step or
    /// interpreter probe is killed and reaped, and the call fails without
    /// acting on the half-finished check (a cancelled readiness probe never
    /// triggers a rebuild). `None` runs to completion; dropping the future
    /// still kills a running step.
    pub cancel: Option<AbortSignal>,
}

impl EnsureKernelPythonOptions {
    pub(crate) fn report(&self, message: &str) {
        match &self.on_progress {
            Some(handler) => handler(message),
            None => eprintln!("{message}"),
        }
    }

    /// What each setup child races (see [`EnsureKernelPythonOptions::cancel`]).
    pub(crate) fn child_cancel(&self) -> ChildCancel<'_> {
        ChildCancel::from_signal(self.cancel.as_ref())
    }

    /// Fail with the cancellation once it fired: checked after every probe
    /// whose `false` a cancellation can fake, before anything acts on it.
    ///
    /// # Errors
    ///
    /// The cancellation, once the setup's signal fired.
    pub(crate) fn check_cancelled(&self) -> anyhow::Result<()> {
        if self.cancel.as_ref().is_some_and(AbortSignal::is_aborted) {
            Err(anyhow!(KERNEL_SETUP_CANCELLED))
        } else {
            Ok(())
        }
    }
}

/// What one setup call found.
struct EnsuredPython {
    python: PathBuf,
    /// This call built the venv or installed missing skills: the readiness
    /// probe has not run on the result yet.
    prepared: bool,
}

fn format_bootstrap_failure(error: &anyhow::Error) -> anyhow::Error {
    let mut message = format!(
        "Failed to set up the Python kernel runtime. {error:#}\n\
         First-time setup needs internet to install uv, Python, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. \
         An interrupted runtime upgrade needs network once more, so re-run this while online. \
         Set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap."
    );
    // The packaged exe-adjacent sidecar is the kernel runtime source; when it
    // is missing everywhere (packaged layout and source checkout), name it:
    // a registry fallback then has no local runtime to fall back from, and
    // the raw install error alone is not actionable.
    if venv::packaged_runtime_dir().is_none() {
        let package = venv::package_dir();
        let _ = write!(message,
            "\nThe packaged prime-agent-runtime directory was not found (looked next to the executable at {} and PI_PACKAGE_DIR); reinstall prime-agent so the kernel runtime ships beside the binary.",
            package.display()
        );
    }
    anyhow!(message)
}

/// One in-flight bootstrap per unique options set, joined by concurrent callers.
type InFlightBootstrap = Option<(
    String,
    Arc<tokio::sync::Mutex<Option<anyhow::Result<EnsuredPython>>>>,
)>;

static IN_FLIGHT: Mutex<InFlightBootstrap> = Mutex::new(None);

/// Resolve the Python interpreter for the kernel: the `PRIME_AGENT_KERNEL_PYTHON`
/// override when valid, else the auto-bootstrapped venv python.
///
/// # Errors
///
/// Returns an error when the `PRIME_AGENT_KERNEL_PYTHON` override points to
/// a Python missing the kernel runtime or default packages, when a writable
/// venv directory cannot be resolved, or when the kernel venv bootstrap or
/// its skill sync fails (the failure is formatted with remediation hints,
/// including a missing packaged runtime directory).
///
/// # Panics
///
/// The in-flight promise stores its outcome under the same lock that takes
/// it, so the internal `expect` on the stored outcome is unreachable.
pub async fn ensure_kernel_python(options: EnsureKernelPythonOptions) -> anyhow::Result<PathBuf> {
    ensure_kernel_python_joined(&options)
        .await
        .map(|ensured| ensured.python)
}

/// Prepare the managed kernel environment ahead of the kernel: build the
/// venv on a fresh home, install missing Python skills, and run the
/// readiness probe a fresh build otherwise leaves to the kernel's own
/// start, so the boot that follows only spawns its process. A warm
/// environment costs one memoized readiness check. A
/// `PRIME_AGENT_KERNEL_PYTHON` override is caller-owned with nothing to
/// build; its probes stay with the boot.
///
/// # Errors
///
/// As [`ensure_kernel_python`]: a failed setup (with its remediation
/// hints), or the cancellation once [`EnsureKernelPythonOptions::cancel`]
/// fired.
pub async fn prepare_kernel_environment(options: EnsureKernelPythonOptions) -> anyhow::Result<()> {
    if std::env::var("PRIME_AGENT_KERNEL_PYTHON").is_ok_and(|python| !python.is_empty()) {
        trace(|| {
            "kernel environment: PRIME_AGENT_KERNEL_PYTHON override, nothing to prepare".to_string()
        });
        return Ok(());
    }
    let started = Instant::now();
    trace(|| "kernel environment preparation start".to_string());
    let ensured = ensure_kernel_python_joined(&options).await?;
    if ensured.prepared {
        let python_skills = normalize_python_skills(&options.python_skills);
        let venv = resolve_writable_kernel_venv_dir()?;
        kernel_ready(
            &ensured.python.to_string_lossy(),
            &venv,
            &resolve_runtime_identity(),
            &python_skills,
            options.child_cancel(),
        )
        .await;
        options.check_cancelled()?;
    }
    trace(|| {
        format!(
            "kernel environment preparation end ({}, {:.1} ms)",
            if ensured.prepared {
                "set up"
            } else {
                "already ready"
            },
            started.elapsed().as_secs_f64() * 1000.0
        )
    });
    Ok(())
}

/// [`ensure_kernel_python`] with the setup outcome, joining a concurrent
/// call with the same options.
async fn ensure_kernel_python_joined(
    options: &EnsureKernelPythonOptions,
) -> anyhow::Result<EnsuredPython> {
    let python_skills = normalize_python_skills(&options.python_skills);
    let key = [
        std::env::var("PRIME_AGENT_KERNEL_PYTHON").unwrap_or_default(),
        std::env::var("PRIME_AGENT_KERNEL_VENV").unwrap_or_default(),
        std::env::var("HOME").unwrap_or_default(),
        std::env::var("XDG_DATA_HOME").unwrap_or_default(),
        serde_json::to_string(&python_skills).unwrap_or_default(),
    ]
    .join("\u{0}");

    let shared = {
        let mut in_flight = IN_FLIGHT
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match in_flight.as_ref() {
            Some((existing_key, promise)) if *existing_key == key => promise.clone(),
            _ => {
                let promise = Arc::new(tokio::sync::Mutex::new(None));
                *in_flight = Some((key, promise.clone()));
                promise
            }
        }
    };
    let mut guard = shared.lock().await;
    if guard.is_none() {
        *guard = Some(ensure_kernel_python_uncached(options, &python_skills).await);
    }
    let outcome = guard.take().expect("outcome was just stored");
    // Drop the registry entry so a later call re-validates instead of reusing
    // a cached rejection forever.
    let mut in_flight = IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if matches!(in_flight.as_ref(), Some((_, promise)) if Arc::ptr_eq(promise, &shared)) {
        *in_flight = None;
    }
    outcome
}

async fn ensure_kernel_python_uncached(
    options: &EnsureKernelPythonOptions,
    python_skills: &[BootstrapPythonSkill],
) -> anyhow::Result<EnsuredPython> {
    if let Ok(override_python) = std::env::var("PRIME_AGENT_KERNEL_PYTHON") {
        if !override_python.is_empty() {
            let python = expand_home(&override_python);
            let python_str = python.to_string_lossy().to_string();
            let cancel = options.child_cancel();
            let mut missing = Vec::new();
            if !has_prime_agent_runtime(&python_str, cancel).await {
                missing.push(
                    "a current prime-agent-runtime with callable rlm.spawn, rlm.create_session, rlm.host_request, rlm.progress_note, explicit harness CRUD methods, and the file-handle snapshot guard".to_string(),
                );
            }
            if missing.is_empty() {
                let missing_extras = missing_rlm_extra_import_labels(&python_str, cancel).await;
                if !missing_extras.is_empty() {
                    missing.push(format!(
                        "default Python packages ({})",
                        missing_extras.join(", ")
                    ));
                }
            }
            if missing.is_empty() && !options.python_skills.is_empty() {
                let missing_skills =
                    missing_python_skill_import_labels(&python_str, &options.python_skills, cancel)
                        .await;
                options.check_cancelled()?;
                if !missing_skills.is_empty() {
                    options.report(&format!(
                        "Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: {}",
                        missing_skills.join(", ")
                    ));
                }
            }
            // A cancelled probe reads as missing: the cancellation is the
            // verdict, not a broken override.
            options.check_cancelled()?;
            if missing.is_empty() {
                return Ok(EnsuredPython {
                    python,
                    prepared: false,
                });
            }
            return Err(anyhow!(
                "PRIME_AGENT_KERNEL_PYTHON points to a Python missing {}: {}",
                missing.join(" and "),
                python.display()
            ));
        }
    }

    let venv = resolve_writable_kernel_venv_dir()?;
    let python = kernel_venv_python(&venv);
    let python_str = python.to_string_lossy().to_string();
    let runtime_identity = resolve_runtime_identity();
    let check_started = Instant::now();
    let ready = kernel_ready(
        &python_str,
        &venv,
        &runtime_identity,
        python_skills,
        options.child_cancel(),
    )
    .await;
    trace(|| {
        format!(
            "kernel environment readiness check: {} ({:.1} ms)",
            if ready { "ready" } else { "not ready" },
            check_started.elapsed().as_secs_f64() * 1000.0
        )
    });
    if ready {
        return Ok(EnsuredPython {
            python,
            prepared: false,
        });
    }
    options.check_cancelled()?;

    let release_lock = tokio::select! {
        lock = acquire_bootstrap_lock(&venv) => lock,
        () = options.child_cancel().fired() => return Err(anyhow!(KERNEL_SETUP_CANCELLED)),
    };
    let result = async {
        if kernel_ready(
            &python_str,
            &venv,
            &runtime_identity,
            python_skills,
            options.child_cancel(),
        )
        .await
        {
            return Ok(EnsuredPython {
                python: python.clone(),
                prepared: false,
            });
        }
        options.check_cancelled()?;
        if kernel_base_ready(
            &python_str,
            &venv,
            &runtime_identity,
            options.child_cancel(),
        )
        .await
        {
            let uv = ensure_uv()?;
            sync_python_skills(
                &uv,
                &venv,
                &python,
                &runtime_identity,
                python_skills,
                options,
            )
            .await?;
            return Ok(EnsuredPython {
                python: python.clone(),
                prepared: true,
            });
        }
        // Never rebuild on a verdict a cancellation faked.
        options.check_cancelled()?;
        let had_venv = venv.exists();
        options.report("› setting up python kernel (one-time, ~30s)…");
        let uv = ensure_uv()?;
        if had_venv {
            options.report("rebuilding kernel venv");
            std::fs::remove_dir_all(&venv)
                .with_context(|| format!("removing {}", venv.display()))?;
        }
        bootstrap_venv(&uv, &venv, python_skills, options).await?;
        Ok(EnsuredPython {
            python: python.clone(),
            prepared: true,
        })
    }
    .await;
    drop(release_lock);
    // A cancelled setup is neither ready nor a setup failure to explain.
    options.check_cancelled()?;
    options.report("✓ ready");
    result.map_err(|error| format_bootstrap_failure(&error))
}

// ---------------------------------------------------------------------------
// Runtime bootstrap code (from core/tools/ipython.ts)
// ---------------------------------------------------------------------------
