//! The headless fork flags end to end on the real binary (an isolated HOME,
//! the scripted faux provider, no network): the `--json-event-profile`
//! projection of the in-process json stream, the effective
//! `--no-skills`/`--no-context-files`/`--no-prompt-templates` resource
//! policy, and the `agent headless invoked` adoption event.

use std::path::Path;
use std::process::Command;

use serde_json::{json, Value};

fn run_in_home(home: &Path, args: &[&str], script: &Value) -> (String, String, i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .args(args)
        .env("HOME", home)
        .env("PRIME_AGENT_FAUX_SCRIPT", script.to_string())
        // The isolated HOME stays authoritative, and nothing here may
        // reach a telemetry endpoint or flip the telemetry opt-out.
        .env_remove("PRIME_AGENT_CODING_AGENT_DIR")
        .env_remove("PRIME_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
        .env_remove("PRIME_AGENT_TELEMETRY")
        .env_remove("PRIME_AGENT_TELEMETRY_ENDPOINT")
        .env_remove("PRIME_AGENT_TELEMETRY_API_KEY")
        .env_remove("DO_NOT_TRACK")
        .env_remove("PI_OFFLINE")
        .env_remove("RLM_DEPTH")
        .current_dir(home)
        .output()
        .expect("binary present");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

fn json_lines(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .expect("every stdout line is one JSON object")
}

/// Replace the per-run identity (session id, wall-clock stamps) so two
/// runs of the same script compare whole-object.
fn normalized(mut value: Value) -> Value {
    fn walk(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    if key == "timestamp" {
                        *child = json!("<timestamp>");
                    } else {
                        walk(child);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(walk),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }
    walk(&mut value);
    if value["type"] == "session" {
        value["id"] = json!("<session-id>");
    }
    value
}

fn event_type(line: &Value) -> &str {
    line["type"].as_str().unwrap_or_default()
}

/// The reduced profile is exactly the full stream minus the progressive
/// `message_update`/`tool_execution_update` snapshots; only its header
/// carries the profile marker.
#[test]
fn factory_completed_stream_is_the_full_stream_minus_progressive_snapshots() {
    let home = tempfile::TempDir::new().unwrap();
    let script = json!({ "responses": ["a completed answer streamed in several deltas"] });
    let (all_stdout, all_stderr, all_code) = run_in_home(
        home.path(),
        &["--mode", "json", "--json-event-profile", "all", "-p", "hi"],
        &script,
    );
    assert_eq!(all_code, 0, "stderr: {all_stderr}");
    let (reduced_stdout, reduced_stderr, reduced_code) = run_in_home(
        home.path(),
        &[
            "--mode",
            "json",
            "--json-event-profile=factory-completed",
            "-p",
            "hi",
        ],
        &script,
    );
    assert_eq!(reduced_code, 0, "stderr: {reduced_stderr}");
    let all: Vec<Value> = json_lines(&all_stdout)
        .into_iter()
        .map(normalized)
        .collect();
    let reduced: Vec<Value> = json_lines(&reduced_stdout)
        .into_iter()
        .map(normalized)
        .collect();
    assert!(
        all.iter().any(|line| event_type(line) == "message_update"),
        "the full stream carries the progressive snapshots"
    );
    let mut expected_header = all[0].clone();
    expected_header["jsonEventProfile"] = json!("factory-completed");
    assert_eq!(reduced[0], expected_header);
    assert_eq!(all[0].get("jsonEventProfile"), None);
    let expected_events: Vec<Value> = all[1..]
        .iter()
        .filter(|line| !matches!(event_type(line), "message_update" | "tool_execution_update"))
        .cloned()
        .collect();
    assert_eq!(reduced[1..].to_vec(), expected_events);
}

/// `--json-event-profile` outside an explicit json run is a usage error.
#[test]
fn json_event_profile_outside_json_mode_exits_one() {
    let home = tempfile::TempDir::new().unwrap();
    let script = json!({ "responses": ["unused"] });
    let (stdout, stderr, code) = run_in_home(
        home.path(),
        &["--json-event-profile", "all", "-p", "hi"],
        &script,
    );
    assert_eq!(
        (stdout.as_str(), stderr.as_str(), code),
        ("", "Error: --json-event-profile requires --mode json\n", 1)
    );
}

/// The resource policy reaches session assembly: a discovered skill and
/// the project context file are in the assembled system prompt by default
/// and gone under their `--no-*` flag (the faux `systemPrompt` response
/// echoes the prompt the provider received).
#[test]
fn no_skills_and_no_context_files_reach_the_assembled_prompt() {
    let home = tempfile::TempDir::new().unwrap();
    let skill_dir = home.path().join(".prime/agent/skills/lane-probe-skill");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: lane-probe-skill\ndescription: Probe skill for the no-skills verifier\n---\nBody",
    )
    .unwrap();
    std::fs::write(home.path().join("AGENTS.md"), "LANE-PROBE-CONTEXT rule").unwrap();
    let script = json!({ "responses": [{ "systemPrompt": true }] });
    let prompt_of = |flags: &[&str]| {
        let args: Vec<&str> = flags.iter().copied().chain(["-p", "hi"]).collect();
        let (stdout, stderr, code) = run_in_home(home.path(), &args, &script);
        assert_eq!(code, 0, "stderr: {stderr}");
        (
            stdout.contains("lane-probe-skill"),
            stdout.contains("LANE-PROBE-CONTEXT"),
        )
    };
    assert_eq!(prompt_of(&[]), (true, true));
    assert_eq!(prompt_of(&["--no-skills"]), (false, true));
    assert_eq!(prompt_of(&["-ns"]), (false, true));
    assert_eq!(prompt_of(&["--no-context-files"]), (true, false));
}

/// `--no-prompt-templates` stops discovered templates from expanding the
/// prompt (the user row keeps the literal text).
#[test]
fn no_prompt_templates_keeps_the_prompt_literal() {
    let home = tempfile::TempDir::new().unwrap();
    let prompts = home.path().join(".prime/agent/prompts");
    std::fs::create_dir_all(&prompts).unwrap();
    std::fs::write(prompts.join("lane-probe.md"), "EXPANDED-PROBE $1").unwrap();
    let script = json!({ "responses": ["ok", "ok"] });
    let user_text = |flags: &[&str]| {
        let args: Vec<&str> = ["--mode", "json"]
            .into_iter()
            .chain(flags.iter().copied())
            .chain(["-p", "/lane-probe value"])
            .collect();
        let (stdout, stderr, code) = run_in_home(home.path(), &args, &script);
        assert_eq!(code, 0, "stderr: {stderr}");
        json_lines(&stdout)
            .into_iter()
            .find(|line| event_type(line) == "message_start" && line["message"]["role"] == "user")
            .map(|line| line["message"]["content"][0]["text"].clone())
            .expect("the user row streams")
    };
    assert_eq!(user_text(&[]), json!("EXPANDED-PROBE value"));
    assert_eq!(
        user_text(&["--no-prompt-templates"]),
        json!("/lane-probe value")
    );
}

/// Every headless run reports its flags once on the local telemetry mirror
/// (`<agent dir>/telemetry.jsonl`), primitives only.
#[test]
fn headless_run_tracks_its_flags() {
    let home = tempfile::TempDir::new().unwrap();
    let script = json!({ "responses": ["tracked"] });
    let (_, stderr, code) = run_in_home(
        home.path(),
        &[
            "--mode",
            "json",
            "--json-event-profile",
            "factory-completed",
            "-p",
            "hi",
        ],
        &script,
    );
    assert_eq!(code, 0, "stderr: {stderr}");
    let mirror = std::fs::read_to_string(home.path().join(".prime/agent/telemetry.jsonl")).unwrap();
    let tracked: Vec<Value> = mirror
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["name"] == "agent headless invoked")
        .map(|event| {
            let properties = &event["properties"];
            json!({
                "mode": properties["mode"],
                "daemon_hosted": properties["daemon_hosted"],
                "json_event_profile": properties["json_event_profile"],
            })
        })
        .collect();
    assert_eq!(
        tracked,
        vec![json!({
            "mode": "json",
            "daemon_hosted": false,
            "json_event_profile": "factory-completed",
        })]
    );
}
