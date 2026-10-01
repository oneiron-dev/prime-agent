//! Connection-scoped delta continuation shared by the Responses WebSocket
//! transports (TS `cachedBody` in `openai-responses-websocket.ts`, Codex
//! `getCachedWebSocketInputDelta`): after a successful response on a
//! connection, the next otherwise-identical request whose input starts with
//! the previous input plus the response's own items sends only the new
//! items, chained by `previous_response_id`.

use serde_json::Value;

/// The anchor one successful response leaves on its connection.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContinuationAnchor {
    /// The full (never delta) request body that produced the response.
    pub(crate) body: Value,
    pub(crate) response_id: String,
    /// The response's assistant items as the next request replays them
    /// (`function_call_output` items excluded).
    pub(crate) response_items: Vec<Value>,
}

/// The serialized JSON (TS `JSON.stringify`): the workspace's
/// `preserve_order` keeps key order, which `Value` equality ignores.
fn serialized(value: &Value) -> String {
    value.to_string()
}

/// The body without the fields a continuation rewrites.
fn without_input(body: &Value) -> Value {
    let mut stripped = body.clone();
    if let Some(map) = stripped.as_object_mut() {
        map.remove("input");
        map.remove("previous_response_id");
    }
    stripped
}

/// The input items `body` adds beyond the baseline (`previous_body`'s
/// input followed by `response_items`), or `None` when the request cannot
/// continue it: a non-array input on either side, any other body field
/// changed (model, reasoning, tools, instructions, ...), or an input that
/// no longer starts with the exact baseline (compaction, history rewrite).
/// An empty delta is a valid continuation. Like TS, the comparisons are on
/// the serialized JSON (`JSON.stringify`, key order included), not on
/// semantic equality.
pub(crate) fn input_delta(
    body: &Value,
    previous_body: &Value,
    response_items: &[Value],
) -> Option<Vec<Value>> {
    let current = body.get("input")?.as_array()?;
    let previous = match previous_body.get("input") {
        Some(Value::Array(items)) => items.as_slice(),
        None => &[],
        Some(_) => return None,
    };
    if serialized(&without_input(body)) != serialized(&without_input(previous_body)) {
        return None;
    }
    let baseline_len = previous.len() + response_items.len();
    if current.len() < baseline_len {
        return None;
    }
    let mut baseline = previous.to_vec();
    baseline.extend_from_slice(response_items);
    if serialized(&Value::Array(current[..baseline_len].to_vec()))
        != serialized(&Value::Array(baseline))
    {
        return None;
    }
    Some(current[baseline_len..].to_vec())
}

/// The request body that continues `anchor`: `previous_response_id` plus
/// only the new input items, or `None` when `body` cannot continue it.
pub(crate) fn delta_request_body(body: &Value, anchor: &ContinuationAnchor) -> Option<Value> {
    if anchor.response_id.is_empty() {
        return None;
    }
    let delta = input_delta(body, &anchor.body, &anchor.response_items)?;
    let mut request = body.clone();
    let map = request.as_object_mut()?;
    map.insert(
        "previous_response_id".to_string(),
        Value::String(anchor.response_id.clone()),
    );
    map.insert("input".to_string(), Value::Array(delta));
    Some(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn anchor(body: Value, items: Vec<Value>) -> ContinuationAnchor {
        ContinuationAnchor {
            body,
            response_id: "resp_1".to_string(),
            response_items: items,
        }
    }

    #[test]
    fn appended_input_continues_with_only_the_new_items() {
        let previous = anchor(
            json!({ "model": "m", "input": [{ "type": "a" }] }),
            vec![json!({ "type": "assistant_item" })],
        );
        let next = json!({
            "model": "m",
            "input": [{ "type": "a" }, { "type": "assistant_item" }, { "type": "new" }],
        });
        assert_eq!(
            delta_request_body(&next, &previous),
            Some(json!({
                "model": "m",
                "input": [{ "type": "new" }],
                "previous_response_id": "resp_1",
            }))
        );
    }

    #[test]
    fn an_unchanged_baseline_sends_an_empty_delta() {
        let previous = anchor(
            json!({ "model": "m", "input": [{ "type": "a" }] }),
            vec![json!({ "type": "b" })],
        );
        let next = json!({ "model": "m", "input": [{ "type": "a" }, { "type": "b" }] });
        assert_eq!(
            input_delta(&next, &previous.body, &previous.response_items),
            Some(Vec::new())
        );
    }

    /// Model, reasoning, tool, and instruction changes all change a body
    /// field outside `input`: no continuation.
    #[test]
    fn any_other_body_change_invalidates_the_anchor() {
        let previous = anchor(
            json!({ "model": "m", "reasoning": { "effort": "low" }, "input": [] }),
            Vec::new(),
        );
        for changed in [
            json!({ "model": "other", "reasoning": { "effort": "low" }, "input": [] }),
            json!({ "model": "m", "reasoning": { "effort": "high" }, "input": [] }),
            json!({ "model": "m", "reasoning": { "effort": "low" }, "tools": [], "input": [] }),
        ] {
            assert_eq!(
                input_delta(&changed, &previous.body, &previous.response_items),
                None,
                "{changed}"
            );
        }
    }

    /// A rewritten history (compaction replaced the prefix) or a dropped
    /// response item breaks the prefix.
    #[test]
    fn a_rewritten_prefix_invalidates_the_anchor() {
        let previous = anchor(
            json!({ "model": "m", "input": [{ "type": "a" }] }),
            vec![json!({ "type": "x" })],
        );
        let rewritten = json!({ "model": "m", "input": [{ "type": "summary" }, { "type": "y" }] });
        assert_eq!(
            input_delta(&rewritten, &previous.body, &previous.response_items),
            None
        );
        let missing_item = json!({ "model": "m", "input": [{ "type": "a" }, { "type": "y" }] });
        assert_eq!(
            input_delta(&missing_item, &previous.body, &previous.response_items),
            None
        );
        let shorter = json!({ "model": "m", "input": [] });
        assert_eq!(
            input_delta(&shorter, &previous.body, &previous.response_items),
            None
        );
    }

    /// The comparisons are on the serialized JSON like TS `JSON.stringify`:
    /// a body or input item whose keys arrive in another order does not
    /// continue the anchor, even though the values are equal (semantic
    /// equality used to continue it).
    #[test]
    fn reordered_keys_do_not_continue_the_anchor() {
        let previous = anchor(
            json!({ "model": "m", "store": false, "input": [{ "type": "a", "id": "1" }] }),
            Vec::new(),
        );
        let reordered_body = json!({ "store": false, "model": "m",
                                     "input": [{ "type": "a", "id": "1" }, { "type": "b" }] });
        assert_eq!(
            input_delta(&reordered_body, &previous.body, &previous.response_items),
            None
        );
        let reordered_item = json!({ "model": "m", "store": false,
                                     "input": [{ "id": "1", "type": "a" }, { "type": "b" }] });
        assert_eq!(
            input_delta(&reordered_item, &previous.body, &previous.response_items),
            None
        );
        let same_order = json!({ "model": "m", "store": false,
                                 "input": [{ "type": "a", "id": "1" }, { "type": "b" }] });
        assert_eq!(
            input_delta(&same_order, &previous.body, &previous.response_items),
            Some(vec![json!({ "type": "b" })])
        );
    }

    /// String inputs never continue (TS `typeof input === "string"`).
    #[test]
    fn string_inputs_never_continue() {
        let previous = anchor(json!({ "model": "m", "input": "hello" }), Vec::new());
        let next = json!({ "model": "m", "input": [{ "type": "a" }] });
        assert_eq!(
            input_delta(&next, &previous.body, &previous.response_items),
            None
        );
        let array_anchor = anchor(json!({ "model": "m", "input": [] }), Vec::new());
        assert_eq!(
            input_delta(
                &json!({ "model": "m", "input": "hi" }),
                &array_anchor.body,
                &array_anchor.response_items
            ),
            None
        );
    }
}
