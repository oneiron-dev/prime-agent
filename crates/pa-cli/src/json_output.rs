//! The `--mode json` stdout projection (TS `modes/print-mode.ts`
//! `JsonEventProfile`): which session events a headless run writes, and the
//! header marker the reduced profile adds. Output projection only - the
//! session's event generation, persistence and provider streaming never see
//! the profile.

use std::sync::Arc;

use pa_agent::types::AgentEvent;
use serde_json::Value;

/// The JSON event selection for a `--mode json` run (TS `JsonEventProfile`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum JsonEventProfile {
    /// Every session event, unmodified (the default).
    #[default]
    All,
    /// The factory's completed-events stream: the progressive
    /// `message_update` and `tool_execution_update` snapshots are dropped
    /// whole before serialization; every other event is unchanged.
    FactoryCompleted,
}

impl JsonEventProfile {
    /// Parse a `--json-event-profile` value.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "factory-completed" => Some(Self::FactoryCompleted),
            _ => None,
        }
    }

    /// The wire and telemetry name of the profile.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::FactoryCompleted => "factory-completed",
        }
    }

    /// Whether a typed loop event reaches stdout. Decided on the typed
    /// event, so an omitted snapshot is never serialized.
    pub(crate) fn includes_agent_event(self, event: &AgentEvent) -> bool {
        match self {
            Self::All => true,
            Self::FactoryCompleted => match event {
                AgentEvent::MessageUpdate { .. } | AgentEvent::ToolExecutionUpdate { .. } => false,
                AgentEvent::AgentStart
                | AgentEvent::AgentEnd { .. }
                | AgentEvent::TurnStart
                | AgentEvent::TurnEnd { .. }
                | AgentEvent::MessageStart { .. }
                | AgentEvent::MessageEnd { .. }
                | AgentEvent::ToolExecutionStart { .. }
                | AgentEvent::ToolExecutionEnd { .. } => true,
            },
        }
    }

    /// Whether an already-encoded session event (the daemon wire's inner
    /// `session_event.event`) reaches stdout.
    pub(crate) fn includes_wire_event(self, event: &Value) -> bool {
        match self {
            Self::All => true,
            Self::FactoryCompleted => !matches!(
                event.get("type").and_then(Value::as_str),
                Some("message_update" | "tool_execution_update")
            ),
        }
    }

    /// The session header line: unchanged for `all`; the reduced profile
    /// appends its `jsonEventProfile` marker (TS `{ ...header, jsonEventProfile }`).
    pub(crate) fn project_header(self, mut header: Value) -> Value {
        match self {
            Self::All => header,
            Self::FactoryCompleted => {
                if let Some(object) = header.as_object_mut() {
                    object.insert("jsonEventProfile".to_string(), Value::from(self.as_str()));
                }
                header
            }
        }
    }
}

/// Serializes one typed loop event to its wire shape.
type SerializeAgentEvent = Arc<dyn Fn(&AgentEvent) -> Option<Value> + Send + Sync>;
/// Writes one JSON line.
type WriteLine = Arc<dyn Fn(&Value) + Send + Sync>;

/// The json-mode stdout writer for one headless run: the projected header,
/// then the session events the profile keeps, one JSON object per line.
#[derive(Clone)]
pub(crate) struct JsonEventSink {
    profile: JsonEventProfile,
    serialize: SerializeAgentEvent,
    write: WriteLine,
}

impl JsonEventSink {
    /// The product sink: stdout, the shared session-event serializer.
    pub(crate) fn stdout(profile: JsonEventProfile) -> Self {
        Self {
            profile,
            serialize: Arc::new(pa_core::session_engine::session_events::agent_event_json),
            write: Arc::new(|line| {
                println!("{line}");
                // The `--verbose` exit trace starts at the answer's own line.
                if line.get("type").and_then(Value::as_str) == Some("agent_end") {
                    crate::headless_exit::phase("agent_end written");
                }
            }),
        }
    }

    /// Write the session header line.
    pub(crate) fn header(&self, header: Value) {
        (self.write)(&self.profile.project_header(header));
    }

    /// Write one in-process loop event the profile keeps.
    pub(crate) fn agent_event(&self, event: &AgentEvent) {
        if !self.profile.includes_agent_event(event) {
            return;
        }
        if let Some(value) = (self.serialize)(event) {
            (self.write)(&value);
        }
    }

    /// Write one daemon-hosted session event the profile keeps.
    pub(crate) fn wire_event(&self, event: &Value) {
        if self.profile.includes_wire_event(event) {
            (self.write)(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::stream::AssistantMessageEvent;
    use pa_agent::types::{
        AgentMessage, AgentToolResult, AssistantContent, AssistantMessage, Message, StopReason,
        TextContent, Usage,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    fn assistant(text: &str) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
            })],
            api: "faux".to_string(),
            provider: "faux".to_string(),
            model: "faux-1".to_string(),
            response_model: None,
            response_model_source: None,
            response_id: Some("resp-1".to_string()),
            diagnostics: None,
            usage: Usage::zero(),
            stop_reason: StopReason::Stop,
            error_message: None,
            stop_reason_raw: None,
            timestamp: 7,
        }
    }

    /// One instance of every loop event, in a plausible run order.
    fn every_event() -> Vec<AgentEvent> {
        let partial = AgentMessage::Standard(Message::Assistant(assistant("par")));
        let done = AgentMessage::Standard(Message::Assistant(assistant("partial answer")));
        vec![
            AgentEvent::AgentStart,
            AgentEvent::TurnStart,
            AgentEvent::MessageStart {
                message: partial.clone(),
            },
            AgentEvent::MessageUpdate {
                message: Arc::new(partial),
                assistant_message_event: Arc::new(AssistantMessageEvent::TextDelta {
                    content_index: 0,
                    delta: "par".to_string(),
                    partial: assistant("par"),
                }),
            },
            AgentEvent::MessageEnd {
                message: done.clone(),
            },
            AgentEvent::ToolExecutionStart {
                tool_call_id: "call-1".to_string(),
                tool_name: "ipython".to_string(),
                args: serde_json::json!({ "code": "1+1" }),
            },
            AgentEvent::ToolExecutionUpdate {
                tool_call_id: "call-1".to_string(),
                tool_name: "ipython".to_string(),
                args: serde_json::json!({ "code": "1+1" }),
                partial_result: AgentToolResult::text("partial output"),
            },
            AgentEvent::ToolExecutionEnd {
                tool_call_id: "call-1".to_string(),
                tool_name: "ipython".to_string(),
                result: AgentToolResult::text("2"),
                is_error: false,
            },
            AgentEvent::TurnEnd {
                message: done.clone(),
                tool_results: Vec::new(),
            },
            AgentEvent::AgentEnd {
                messages: vec![done],
            },
        ]
    }

    /// A sink that records the written lines and counts serializer calls.
    fn recording_sink(
        profile: JsonEventProfile,
    ) -> (JsonEventSink, Arc<Mutex<Vec<Value>>>, Arc<AtomicUsize>) {
        let serialized = Arc::new(AtomicUsize::new(0));
        let lines = Arc::new(Mutex::new(Vec::new()));
        let counter = Arc::clone(&serialized);
        let written = Arc::clone(&lines);
        let sink = JsonEventSink {
            profile,
            serialize: Arc::new(move |event| {
                counter.fetch_add(1, Ordering::SeqCst);
                pa_core::session_engine::session_events::agent_event_json(event)
            }),
            write: Arc::new(move |line| written.lock().unwrap().push(line.clone())),
        };
        (sink, lines, serialized)
    }

    fn event_type(value: &Value) -> String {
        value["type"].as_str().unwrap_or_default().to_string()
    }

    #[test]
    fn profile_values_parse_and_name_round_trip() {
        for profile in [JsonEventProfile::All, JsonEventProfile::FactoryCompleted] {
            assert_eq!(JsonEventProfile::parse(profile.as_str()), Some(profile));
        }
        assert_eq!(JsonEventProfile::parse("factory"), None);
        assert_eq!(JsonEventProfile::parse(""), None);
    }

    /// The reduced stream is the full stream minus exactly the two
    /// progressive event types, every retained event byte-identical; the
    /// omitted snapshots are never serialized (the decision is typed).
    #[test]
    fn factory_completed_drops_exactly_the_progressive_snapshots_before_serializing() {
        let (all_sink, all_lines, all_serialized) = recording_sink(JsonEventProfile::All);
        for event in every_event() {
            all_sink.agent_event(&event);
        }
        assert_eq!(all_serialized.load(Ordering::SeqCst), 10);

        let (reduced_sink, reduced_lines, reduced_serialized) =
            recording_sink(JsonEventProfile::FactoryCompleted);
        for event in every_event() {
            reduced_sink.agent_event(&event);
        }
        assert_eq!(
            reduced_serialized.load(Ordering::SeqCst),
            8,
            "an omitted snapshot must not be serialized first"
        );

        let all = all_lines.lock().unwrap().clone();
        let expected: Vec<Value> = all
            .iter()
            .filter(|line| {
                !matches!(
                    line["type"].as_str(),
                    Some("message_update" | "tool_execution_update")
                )
            })
            .cloned()
            .collect();
        assert_eq!(*reduced_lines.lock().unwrap(), expected);
        assert_eq!(
            all.iter().map(event_type).collect::<Vec<_>>(),
            [
                "agent_start",
                "turn_start",
                "message_start",
                "message_update",
                "message_end",
                "tool_execution_start",
                "tool_execution_update",
                "tool_execution_end",
                "turn_end",
                "agent_end",
            ]
        );
    }

    #[test]
    fn wire_events_follow_the_same_selection() {
        let all = every_event()
            .iter()
            .filter_map(pa_core::session_engine::session_events::agent_event_json)
            .chain([
                serde_json::json!({ "type": "compaction_start", "reason": "threshold" }),
                serde_json::json!({ "type": "goal_update", "goal": null }),
            ])
            .collect::<Vec<_>>();
        let kept: Vec<Value> = all
            .iter()
            .filter(|event| JsonEventProfile::FactoryCompleted.includes_wire_event(event))
            .cloned()
            .collect();
        let expected: Vec<Value> = all
            .iter()
            .filter(|event| {
                !matches!(
                    event["type"].as_str(),
                    Some("message_update" | "tool_execution_update")
                )
            })
            .cloned()
            .collect();
        assert_eq!(kept, expected);
        assert!(all
            .iter()
            .all(|event| JsonEventProfile::All.includes_wire_event(event)));
    }

    /// Only the reduced profile marks the header, as its last field.
    #[test]
    fn header_marker_only_for_the_reduced_profile() {
        let header = serde_json::json!({
            "type": "session",
            "version": 3,
            "id": "abc",
            "timestamp": "2026-10-01T00:00:00.000Z",
            "cwd": "/work",
        });
        assert_eq!(JsonEventProfile::All.project_header(header.clone()), header);
        let projected = JsonEventProfile::FactoryCompleted.project_header(header);
        assert_eq!(
            projected,
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "abc",
                "timestamp": "2026-10-01T00:00:00.000Z",
                "cwd": "/work",
                "jsonEventProfile": "factory-completed",
            })
        );
        assert_eq!(
            projected
                .as_object()
                .unwrap()
                .keys()
                .next_back()
                .map(String::as_str),
            Some("jsonEventProfile")
        );
    }
}
