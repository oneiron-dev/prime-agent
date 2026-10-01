//! Generic Responses WebSocket connection ownership (TS
//! `openai-responses-websocket.ts` cache, claims, and owned requests).
//!
//! This is provider connection state, not session-engine state: one
//! reusable connection per session id, reused only while idle, open, and
//! under the same connection identity (URL plus normalized handshake
//! headers, credentials included — process-local, never logged or
//! persisted). Concurrent acquisitions take generation claims so a later
//! claim owns the cache slot even when an earlier connection opens later;
//! connection-id guards keep stale releases and idle timers from touching
//! a newer entry. Every request registers as owned by its session, so
//! session disposal cancels in-flight and still-connecting requests too
//! (closing a socket alone cannot stop an upstream that stalls), and closes
//! each request's socket with `session_cleanup`, cached or not.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::connection::{connect, CloseReason, ConnectFailure, EventDialect, WorkerHandle};
use super::continuation::ContinuationAnchor;

/// Idle connections stay cached this long (TS `CACHE_TTL_MS`).
pub(crate) const CONNECTION_IDLE_TTL: Duration = Duration::from_mins(5);

/// The process-local reuse key: URL plus lowercased, sorted handshake
/// headers (a later duplicate replaces an earlier one). It carries the
/// credentials, so `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ConnectionIdentity(String);

impl std::fmt::Debug for ConnectionIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ConnectionIdentity(<redacted>)")
    }
}

pub(crate) fn connection_identity(url: &str, headers: &[(String, String)]) -> ConnectionIdentity {
    let normalized: BTreeMap<String, &str> = headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), value.as_str()))
        .collect();
    ConnectionIdentity(serde_json::json!([url, normalized]).to_string())
}

struct Entry {
    worker: WorkerHandle,
    identity: ConnectionIdentity,
    busy: bool,
    /// Bumped on every acquire and release: a pending idle timer fires
    /// only for the generation it was scheduled under.
    expiry_generation: u64,
    continuation: Option<ContinuationAnchor>,
}

/// An owned request's recorded cancellation cause: set once, by whichever
/// of the caller's abort (observed) or the session's disposal records
/// first, and never changed after (TS keeps the first abort's reason).
const CAUSE_NONE: u8 = 0;
const CAUSE_ABORTED: u8 = 1;
const CAUSE_DISPOSED: u8 = 2;

/// Record a session disposal as a request's cause; `false` when a cause
/// (the caller's observed abort) is already recorded, which then stands.
fn record_disposal(cause: &AtomicU8) -> bool {
    cause
        .compare_exchange(
            CAUSE_NONE,
            CAUSE_DISPOSED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

struct Owned {
    session_id: Option<String>,
    cancel: CancellationToken,
    cause: Arc<AtomicU8>,
    /// The request's connection once acquired (TS `owner.socket`), so
    /// disposal reaches a socket that never entered the session cache.
    worker: Option<WorkerHandle>,
}

#[derive(Default)]
struct State {
    cache: HashMap<String, Entry>,
    claims: HashMap<String, u64>,
    owned: HashMap<u64, Owned>,
    next_generation: u64,
    next_request: u64,
}

fn lock_state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE
        .get_or_init(|| Mutex::new(State::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Why an owned request stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cancellation {
    /// The caller aborted the request.
    Aborted,
    /// The owning session was disposed (a cancellation, never a transport
    /// failure to replay).
    SessionDisposed,
}

/// One request registered as owned by its session (TS `beginOwnedRequest`).
/// Its token fires on the caller's abort and on the session's disposal;
/// dropping the registration releases ownership.
pub(crate) struct OwnedRequest {
    id: u64,
    cancel: CancellationToken,
    cause: Arc<AtomicU8>,
}

impl OwnedRequest {
    pub(crate) fn begin(session_id: Option<&str>, caller: Option<&CancellationToken>) -> Self {
        let cancel = caller.map_or_else(CancellationToken::new, CancellationToken::child_token);
        let cause = Arc::new(AtomicU8::new(CAUSE_NONE));
        let mut state = lock_state();
        state.next_request += 1;
        let id = state.next_request;
        state.owned.insert(
            id,
            Owned {
                session_id: session_id.map(str::to_string),
                cancel: cancel.clone(),
                cause: Arc::clone(&cause),
                worker: None,
            },
        );
        Self { id, cancel, cause }
    }

    /// The token every stage of the request races.
    pub(crate) fn token(&self) -> &CancellationToken {
        &self.cancel
    }

    /// Record the request's acquired connection (TS `owner.socket =
    /// acquired.socket`): disposal closes it with `session_cleanup`. A
    /// disposal that landed while the connection was being acquired closes
    /// it now.
    pub(crate) fn attach(&self, worker: &WorkerHandle) {
        let mut state = lock_state();
        if self.cause.load(Ordering::SeqCst) == CAUSE_DISPOSED {
            worker.close(CloseReason::SessionCleanup);
        }
        if let Some(owned) = state.owned.get_mut(&self.id) {
            owned.worker = Some(worker.clone());
        }
    }

    /// Why the request stopped, if it did; once answered, the answer never
    /// changes. A disposal counts from the moment it records its cause,
    /// before its token fires (the socket's `session_cleanup` close can
    /// reach the request first). A fired token with no recorded cause is
    /// the caller's abort, recorded here unless a disposal recorded first.
    pub(crate) fn cancellation(&self) -> Option<Cancellation> {
        let recorded = match self.cause.load(Ordering::SeqCst) {
            CAUSE_NONE if self.cancel.is_cancelled() => {
                match self.cause.compare_exchange(
                    CAUSE_NONE,
                    CAUSE_ABORTED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => CAUSE_ABORTED,
                    Err(first) => first,
                }
            }
            cause => cause,
        };
        match recorded {
            CAUSE_DISPOSED => Some(Cancellation::SessionDisposed),
            CAUSE_ABORTED => Some(Cancellation::Aborted),
            _ => None,
        }
    }
}

impl Drop for OwnedRequest {
    fn drop(&mut self) {
        lock_state().owned.remove(&self.id);
    }
}

/// A connection one request holds (TS `acquire`'s result).
pub(crate) struct Acquired {
    pub(crate) worker: WorkerHandle,
    /// The session whose cache entry backs this connection; `None` for an
    /// ephemeral connection (no session id, or a newer claim owns the
    /// slot), which never carries a continuation.
    slot: Option<String>,
    /// The entry's continuation anchor at acquisition.
    pub(crate) continuation: Option<ContinuationAnchor>,
}

/// Whether a released connection returns to the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReleaseDisposition {
    /// Keep an open connection cached for reuse (idle expiry starts).
    Keep,
    /// Close it (failures, aborts, ephemeral connections).
    Discard,
}

/// Acquire a connection for one request (TS `acquire`): reuse the
/// session's idle same-identity connection, otherwise open a new one
/// under a generation claim.
pub(crate) async fn acquire(
    url: &str,
    headers: &[(String, String)],
    session_id: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Acquired, ConnectFailure> {
    if cancel.is_cancelled() {
        return Err(ConnectFailure::Cancelled);
    }
    let Some(session_id) = session_id else {
        let worker = connect(url, headers, Some(cancel), EventDialect::Responses).await?;
        return Ok(Acquired {
            worker,
            slot: None,
            continuation: None,
        });
    };
    let identity = connection_identity(url, headers);
    let claim = {
        let mut state = lock_state();
        // Every session acquire claims its logical order, a fast reuse
        // included.
        state.next_generation += 1;
        let claim = state.next_generation;
        state.claims.insert(session_id.to_string(), claim);
        let mut reused = None;
        let mut retire_old = false;
        if let Some(old) = state.cache.get_mut(session_id) {
            old.expiry_generation += 1;
            if old.identity != identity {
                // A route, credential, or handshake change invalidates the
                // old authenticated connection, a busy one included: its
                // request ends with the close.
                old.worker.close(CloseReason::IdentityChanged);
                retire_old = true;
            } else if !old.busy && old.worker.is_open() {
                old.busy = true;
                reused = Some((old.worker.clone(), old.continuation.clone()));
            } else if !old.busy {
                old.worker.close(CloseReason::Done);
                retire_old = true;
            }
        }
        if retire_old {
            state.cache.remove(session_id);
        }
        if let Some((worker, continuation)) = reused {
            if state.claims.get(session_id) == Some(&claim) {
                state.claims.remove(session_id);
            }
            return Ok(Acquired {
                worker,
                slot: Some(session_id.to_string()),
                continuation,
            });
        }
        claim
    };
    // The claim stays live while the new connection opens.
    let worker = match connect(url, headers, Some(cancel), EventDialect::Responses).await {
        Ok(worker) => worker,
        Err(failure) => {
            let mut state = lock_state();
            if state.claims.get(session_id) == Some(&claim) {
                state.claims.remove(session_id);
            }
            return Err(failure);
        }
    };
    let mut state = lock_state();
    if state.claims.get(session_id) != Some(&claim) {
        // A newer claim owns the slot even while it is still connecting:
        // this connection serves one request and closes.
        return Ok(Acquired {
            worker,
            slot: None,
            continuation: None,
        });
    }
    if let Some(occupant) = state.cache.get(session_id) {
        if !occupant.busy {
            occupant.worker.close(if occupant.identity == identity {
                CloseReason::Replaced
            } else {
                CloseReason::IdentityChanged
            });
            state.cache.remove(session_id);
        } else if occupant.identity != identity {
            occupant.worker.close(CloseReason::IdentityChanged);
        }
        // A busy same-identity occupant finishes its request; the
        // connection-id guards keep its release and timer off this entry.
    }
    state.cache.insert(
        session_id.to_string(),
        Entry {
            worker: worker.clone(),
            identity,
            busy: true,
            expiry_generation: 0,
            continuation: None,
        },
    );
    state.claims.remove(session_id);
    Ok(Acquired {
        worker,
        slot: Some(session_id.to_string()),
        continuation: None,
    })
}

/// Replace (or clear) the continuation anchor of the entry backing
/// `acquired`, when that entry still owns the session's slot.
pub(crate) fn set_continuation(acquired: &Acquired, anchor: Option<ContinuationAnchor>) {
    let Some(session_id) = &acquired.slot else {
        return;
    };
    let mut state = lock_state();
    if let Some(entry) = state.cache.get_mut(session_id) {
        if entry.worker.connection_id() == acquired.worker.connection_id() {
            entry.continuation = anchor;
        }
    }
}

/// Whether `acquired` is backed by the session's cache entry (a
/// continuation can be recorded for it).
pub(crate) fn is_cached(acquired: &Acquired) -> bool {
    acquired.slot.is_some()
}

/// Return a connection after its request (TS `release`).
pub(crate) fn release(acquired: &Acquired, disposition: ReleaseDisposition) {
    let Some(session_id) = &acquired.slot else {
        acquired.worker.close(CloseReason::Done);
        return;
    };
    let connection_id = acquired.worker.connection_id();
    let mut state = lock_state();
    let current = state
        .cache
        .get(session_id)
        .is_some_and(|entry| entry.worker.connection_id() == connection_id);
    if disposition == ReleaseDisposition::Discard || !acquired.worker.is_open() {
        acquired.worker.close(CloseReason::Done);
        if current {
            state.cache.remove(session_id);
        }
        return;
    }
    if !current {
        // The slot moved on (identity change, newer claim): this
        // connection is no longer reusable.
        acquired.worker.close(CloseReason::IdentityChanged);
        return;
    }
    let Some(entry) = state.cache.get_mut(session_id) else {
        return;
    };
    entry.busy = false;
    entry.expiry_generation += 1;
    let generation = entry.expiry_generation;
    let session_id = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(CONNECTION_IDLE_TTL).await;
        let mut state = lock_state();
        let expired = state.cache.get(&session_id).is_some_and(|entry| {
            entry.worker.connection_id() == connection_id
                && entry.expiry_generation == generation
                && !entry.busy
        });
        if expired {
            if let Some(entry) = state.cache.remove(&session_id) {
                entry.worker.close(CloseReason::IdleTimeout);
            }
        }
    });
}

/// Dispose one session's (or every session's) Responses WebSocket
/// resources (TS `closeOpenAIResponsesWebSocketSessions`): ownership
/// first — every owned request, cached or not, connecting or streaming, is
/// cancelled as disposed and its socket closed with `session_cleanup` —
/// then the claims and cached connections.
pub(crate) fn close_sessions(session_id: Option<&str>) {
    let mut state = lock_state();
    for owned in state.owned.values() {
        let owns =
            session_id.is_none_or(|session_id| owned.session_id.as_deref() == Some(session_id));
        if !owns {
            continue;
        }
        // A request the caller already aborted keeps that verdict (its
        // token fired before the disposal could record); the others record
        // the disposal first, at once and for good: whichever signal the
        // socket's worker sees, the request reads as disposed.
        let disposing = !owned.cancel.is_cancelled() && record_disposal(&owned.cause);
        // Every owned socket closes with `session_cleanup` (TS closes
        // `request.socket` unconditionally), an aborted one included, and
        // the reason is set before the token fires.
        if let Some(worker) = &owned.worker {
            worker.close(CloseReason::SessionCleanup);
        }
        if disposing {
            owned.cancel.cancel();
        }
    }
    if let Some(session_id) = session_id {
        state.claims.remove(session_id);
        if let Some(entry) = state.cache.remove(session_id) {
            entry.worker.close(CloseReason::SessionCleanup);
        }
    } else {
        state.claims.clear();
        for (_, entry) in state.cache.drain() {
            entry.worker.close(CloseReason::SessionCleanup);
        }
    }
}

/// Test probe: the cached connection id for `session_id`, if any.
#[cfg(test)]
pub(crate) fn cached_connection_id(session_id: &str) -> Option<u64> {
    lock_state()
        .cache
        .get(session_id)
        .map(|entry| entry.worker.connection_id())
}

/// Test probe: how many requests `session_id` currently owns.
#[cfg(test)]
pub(crate) fn owned_request_count(session_id: &str) -> usize {
    lock_state()
        .owned
        .values()
        .filter(|owned| owned.session_id.as_deref() == Some(session_id))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A request's cancellation cause is recorded once: a caller abort the
    /// request already observed stands even when a racing disposal (past
    /// its token check) records next, and a disposal recorded before the
    /// caller's abort stands too. The disposal mark used to be a plain
    /// store, flipping an observed abort to a disposal.
    #[test]
    fn the_first_recorded_cancellation_cause_stands() {
        let caller = CancellationToken::new();
        let aborted = OwnedRequest::begin(Some("cause-abort-first"), Some(&caller));
        caller.cancel();
        assert_eq!(aborted.cancellation(), Some(Cancellation::Aborted));
        // The racing disposal's record step, after its token check passed.
        assert!(!record_disposal(&aborted.cause));
        assert_eq!(aborted.cancellation(), Some(Cancellation::Aborted));

        let caller = CancellationToken::new();
        let disposed = OwnedRequest::begin(Some("cause-dispose-first"), Some(&caller));
        assert_eq!(disposed.cancellation(), None);
        assert!(record_disposal(&disposed.cause));
        caller.cancel();
        assert_eq!(disposed.cancellation(), Some(Cancellation::SessionDisposed));
    }

    #[test]
    fn identity_normalizes_header_case_order_and_duplicates() {
        let headers = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
                .collect()
        };
        let base = connection_identity(
            "ws://h/v1/responses",
            &headers(&[("Authorization", "Bearer a"), ("X-Team", "t")]),
        );
        assert_eq!(
            base,
            connection_identity(
                "ws://h/v1/responses",
                &headers(&[("x-team", "t"), ("authorization", "Bearer a")]),
            )
        );
        // A later duplicate replaces the earlier value (handshake insert).
        assert_eq!(
            base,
            connection_identity(
                "ws://h/v1/responses",
                &headers(&[
                    ("X-Team", "old"),
                    ("Authorization", "Bearer a"),
                    ("x-team", "t")
                ]),
            )
        );
        // A credential or route change is a different identity.
        assert_ne!(
            base,
            connection_identity(
                "ws://h/v1/responses",
                &headers(&[("Authorization", "Bearer b"), ("X-Team", "t")]),
            )
        );
        assert_ne!(
            base,
            connection_identity(
                "ws://other/v1/responses",
                &headers(&[("Authorization", "Bearer a"), ("X-Team", "t")]),
            )
        );
        // The credential-bearing identity never prints.
        assert_eq!(format!("{base:?}"), "ConnectionIdentity(<redacted>)");
    }

    #[test]
    fn disposal_marks_only_the_owning_sessions_requests() {
        let mine = OwnedRequest::begin(Some("dispose-owner-a"), None);
        let other = OwnedRequest::begin(Some("dispose-owner-b"), None);
        let caller = CancellationToken::new();
        let aborted_first = OwnedRequest::begin(Some("dispose-owner-a"), Some(&caller));
        caller.cancel();
        assert_eq!(aborted_first.cancellation(), Some(Cancellation::Aborted));
        close_sessions(Some("dispose-owner-a"));
        assert_eq!(mine.cancellation(), Some(Cancellation::SessionDisposed));
        // A request the caller aborted first stays an abort.
        assert_eq!(aborted_first.cancellation(), Some(Cancellation::Aborted));
        assert_eq!(other.cancellation(), None);
        assert_eq!(owned_request_count("dispose-owner-a"), 2);
        drop(mine);
        drop(aborted_first);
        assert_eq!(owned_request_count("dispose-owner-a"), 0);
    }
}
