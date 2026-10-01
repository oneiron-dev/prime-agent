//! The `agent provider transport used` adoption seam: the session's stream
//! path observes the provider's WebSocket upgrade (the Responses transport
//! reports a synthetic 101 to the response hook) and reports it once per
//! session through the session telemetry. The session telemetry is
//! installed after the agent that owns the stream path, so it binds late.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use pa_agent::stream::{OnResponseHook, StreamFn};

use super::telemetry::SessionTelemetry;

/// The 101 Switching Protocols status the WebSocket transport reports.
const WEBSOCKET_UPGRADE_STATUS: u16 = 101;

/// One session's transport adoption reporting.
#[derive(Default)]
pub(crate) struct TransportAdoption {
    telemetry: OnceLock<Arc<SessionTelemetry>>,
    reported: AtomicBool,
}

impl TransportAdoption {
    /// Bind the session telemetry the event reports through (depth-0
    /// sessions with telemetry enabled; otherwise nothing reports).
    pub(crate) fn set_telemetry(&self, telemetry: Arc<SessionTelemetry>) {
        let _ = self.telemetry.set(telemetry);
    }

    /// Wrap the session's stream function: until the session has reported,
    /// each request's response hook reports the first WebSocket upgrade,
    /// then delegates to the request's own hook. A session without
    /// telemetry, or one that already reported, streams unwrapped.
    pub(crate) fn instrument(self: &Arc<Self>, stream_fn: StreamFn) -> StreamFn {
        let adoption = Arc::clone(self);
        Arc::new(move |model, context, mut options| {
            if adoption.telemetry.get().is_some() && !adoption.reported.load(Ordering::SeqCst) {
                let inner: Option<OnResponseHook> = options.on_response.take();
                let adoption = Arc::clone(&adoption);
                options.on_response = Some(Arc::new(move |response, model| {
                    if response.status == WEBSOCKET_UPGRADE_STATUS
                        && !adoption.reported.swap(true, Ordering::SeqCst)
                    {
                        if let Some(telemetry) = adoption.telemetry.get() {
                            telemetry.note_provider_transport_used(&model.api);
                        }
                    }
                    if let Some(hook) = inner.as_ref() {
                        hook(response, model);
                    }
                }));
            }
            stream_fn(model, context, options)
        })
    }
}
