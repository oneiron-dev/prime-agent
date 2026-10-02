//! The launch tool selection at the engine: what the provider request
//! carries (tool definitions and system prompt) for every flag form, what
//! the loop can execute, and that a session without `ipython` never asks
//! for a Python kernel.
use super::tests::echo_definition;
use super::*;
use crate::session_engine::tool_bridge::bridge_tool;
use crate::session_engine::tool_selection::ToolSelection;
use pa_agent::scripted::ScriptedProvider;

fn model() -> pa_agent::types::Model {
    pa_agent::types::Model {
        id: "m".into(),
        name: "m".into(),
        api: "test".into(),
        provider: "test".into(),
        base_url: "http://localhost".into(),
        reasoning: false,
        cost: pa_agent::types::UsageCost::default(),
        context_window: 100_000,
        max_tokens: 100,
    }
}

/// The TS no-tools prompt (`rlm.js` with `ipython` inactive) for a root
/// session in `cwd` whose conversation log is `log`.
fn ts_no_tools_prompt(cwd: &str, log: &str) -> String {
    format!(
        "You are a general purpose agent that uses code to solve tasks.\n\
You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.\n\
When you are done, stop calling tools and state your final answer.\n\
\n\
For slow or independently completing work, use a nonblocking control loop: start the work, record its handle or output location, then end your turn. A `bash()` handle left running beyond its creating cell sends a completion follow-up; when it arrives, inspect the saved handle and continue. Reading a finished handle's result first cancels that follow-up.\n\
When delegation is available and useful, assign independent substantive tasks to separate workers. Start independent workers without waiting for each one sequentially, and let them run in parallel.\n\
Do not keep the turn open by polling with `time.sleep()` or shell `sleep`, and do not replace polling with a long blocking `await`. Await only the short operation needed to start work or inspect a result that is already available; otherwise end the turn.\n\
\n\
As the user-facing root agent, when work follows a plan, uses many subagents, or spans multiple turns, proactively give regular concise progress updates so the user does not have to ask. State the current plan, what has completed, any blockers, the proposed fixes, and the next actions. Lead with user-visible outcomes rather than internal process or gate names. Mention internal details only when they explain a blocker or decision. Send an update at meaningful milestones and before ending a turn while work is still running. Do not repeat unchanged status or interrupt short work with unnecessary updates.\n\
\n\
Use simplified technical English by default for user-facing prose.\n\
Prefer short sentences, common words, and concrete verbs. State one main action or fact per sentence when practical. Use lists for steps or conditions.\n\
Keep necessary technical terms, names, commands, code, paths, and exact quoted text unchanged. State uncertainty directly.\n\
Treat this as clarity guidance, not a claim of formal ASD-STE100 compliance. Preserve a user-requested format, tone, terminology, and necessary precision.\n\
\n\
Working directory: {cwd}\n\
Conversation log: {log}\n\
Recursive agent depth: 0\n\
Pre-installed Python packages: requests, httpx, yaml (PyYAML), tomli, dotenv (python-dotenv), pandas, numpy, scipy, bs4 (Beautiful Soup), lxml, pydantic, tyro.\n\
Install additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module)."
    )
}

/// What one session's first provider request carried.
#[derive(Debug, PartialEq)]
struct Request {
    tools: Vec<String>,
    /// The TS no-tools prompt (`Some(true)`), the layered harness
    /// (`Some(false)`), or neither.
    ts_prompt: Option<bool>,
}

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    agent_dir: PathBuf,
    log: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();
    let log = dir.path().join("sessions").join("fixture-session.jsonl");
    Fixture {
        cwd,
        agent_dir,
        log,
        _dir: dir,
    }
}

impl Fixture {
    fn config(
        &self,
        provider: &Arc<ScriptedProvider>,
        tool_selection: ToolSelection,
    ) -> SessionEngineConfig {
        SessionEngineConfig {
            cwd: self.cwd.clone(),
            agent_dir: self.agent_dir.clone(),
            model: Some(model()),
            stream_fn: Some(provider.stream_fn()),
            tools: vec![bridge_tool(echo_definition())],
            tool_selection,
            conversation_log_path: Some(self.log.clone()),
            // The `sol` wrapper's shape (`--no-skills`, `--bare`): no
            // ambient skills or AGENTS.md above the temp dir may leak in.
            resource_loading: crate::resources::ResourceLoadingPolicy {
                skills: crate::resources::ResourceDiscovery::Disabled,
                prompt_templates: crate::resources::ResourceDiscovery::Disabled,
                context_files: crate::resources::ResourceDiscovery::Disabled,
            },
            ..Default::default()
        }
    }
}

async fn first_request(selection: ToolSelection) -> (Request, String, Fixture) {
    let fixture = fixture();
    let provider = Arc::new(ScriptedProvider::new(model()));
    provider.push_text_turn("ok");
    let engine = create_session(fixture.config(&provider, selection))
        .await
        .unwrap();
    engine.prompt("hi", PromptOptions::default()).await.unwrap();
    engine.session.agent().wait_for_idle().await;
    let calls = provider.calls();
    let context = calls.first().expect("one provider request");
    let system_prompt = context.system_prompt.clone().unwrap_or_default();
    let request = Request {
        tools: context.tools.iter().map(|tool| tool.name.clone()).collect(),
        ts_prompt: if system_prompt.starts_with("You are a general purpose agent") {
            Some(true)
        } else if system_prompt.starts_with("# prime-agent harness") {
            Some(false)
        } else {
            None
        },
    };
    assert_eq!(
        engine.system_prompt, system_prompt,
        "the request carries the session's prompt"
    );
    (request, system_prompt, fixture)
}

/// Every flag form, as the provider sees it: the tool definitions and
/// which prompt the request carries. A request without `ipython` always
/// carries the TS no-tools prompt.
#[tokio::test]
async fn each_selection_reaches_the_provider_request() {
    let allow = |names: &[&str]| {
        ToolSelection::Allowlist(names.iter().map(|name| (*name).to_string()).collect())
    };
    let cases = vec![
        (ToolSelection::Defaults, vec!["echo", "ipython"], true),
        (ToolSelection::NoTools, vec![], false),
        (ToolSelection::SuppliedOnly, vec!["echo"], false),
        (allow(&["ipython"]), vec!["ipython"], true),
        (allow(&[]), vec![], false),
        (allow(&["echo"]), vec!["echo"], false),
        (
            allow(&["nope", "ipython", "echo", "ipython", "read"]),
            vec!["ipython", "echo"],
            true,
        ),
    ];
    for (selection, tools, layered) in cases {
        let (request, system_prompt, fixture) = first_request(selection.clone()).await;
        assert_eq!(
            request,
            Request {
                tools: tools.iter().map(|name| (*name).to_string()).collect(),
                ts_prompt: Some(!layered),
            },
            "selection {selection:?}"
        );
        if !layered {
            // Content and size: exactly the TS no-tools prompt.
            assert_eq!(
                system_prompt,
                ts_no_tools_prompt(
                    &fixture.cwd.display().to_string(),
                    &fixture.log.display().to_string(),
                ),
                "selection {selection:?}"
            );
        }
    }
}

/// `--no-tools`: the request is exactly the TS no-tools prompt (its size
/// is the TS size for the same cwd and log) and carries no tools.
#[tokio::test]
async fn no_tools_sends_the_ts_prompt_and_no_tool_definitions() {
    let (request, system_prompt, fixture) = first_request(ToolSelection::NoTools).await;
    let expected = ts_no_tools_prompt(
        &fixture.cwd.display().to_string(),
        &fixture.log.display().to_string(),
    );
    assert_eq!(
        request,
        Request {
            tools: Vec::new(),
            ts_prompt: Some(true),
        }
    );
    assert_eq!(system_prompt, expected);
    assert_eq!(system_prompt.len(), expected.len());
}

/// A model that calls `ipython` anyway in a no-tools session gets the
/// loop's unknown-tool error, and nothing asks for a kernel.
#[tokio::test]
async fn an_unsolicited_ipython_call_cannot_reach_the_kernel() {
    let fixture = fixture();
    let provider = Arc::new(ScriptedProvider::new(model()));
    provider.push_tool_call_turn(
        None,
        vec![(
            "call-1",
            "ipython",
            serde_json::json!({ "code": "print(1)" }),
        )],
    );
    provider.push_text_turn("done");
    let engine = create_session(fixture.config(&provider, ToolSelection::NoTools))
        .await
        .unwrap();
    engine.prompt("hi", PromptOptions::default()).await.unwrap();
    engine.session.agent().wait_for_idle().await;
    let state = engine.session.agent().state().await;
    let results: Vec<(String, bool)> = state
        .messages
        .iter()
        .filter_map(|message| match message {
            pa_agent::types::AgentMessage::Standard(pa_agent::types::Message::ToolResult(
                result,
            )) => Some((result.tool_name.clone(), result.is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(results, vec![("ipython".to_string(), true)]);
    assert_eq!(engine.provisioner.start_requests(), 0);
}

/// `--no-tools` with the prewarm requested (the print and daemon builds
/// ask for it) and a resume snapshot on disk: neither arm asks for the
/// kernel, so no Python process starts and nothing revives.
#[tokio::test]
async fn no_tools_never_asks_for_a_kernel_even_with_prewarm_and_a_snapshot() {
    let fixture = fixture();
    let artifact_dir =
        crate::session_engine::harness_digest::session_artifact_dir_for_log(&fixture.log).unwrap();
    std::fs::create_dir_all(&artifact_dir).unwrap();
    std::fs::write(
        crate::kernel::state_snapshot::snapshot_path_in(&artifact_dir),
        b"snapshot",
    )
    .unwrap();
    for selection in [
        ToolSelection::NoTools,
        ToolSelection::SuppliedOnly,
        ToolSelection::Allowlist(vec!["echo".to_string()]),
    ] {
        let provider = Arc::new(ScriptedProvider::new(model()));
        let engine = create_session(SessionEngineConfig {
            prewarm_ipython_kernel: Some(true),
            ..fixture.config(&provider, selection.clone())
        })
        .await
        .unwrap();
        assert_eq!(
            engine.provisioner.start_requests(),
            0,
            "selection {selection:?}"
        );
    }
}

/// The append sources: the no-REPL prompt appends the resolved text (an
/// explicit source, or the discovered `APPEND_SYSTEM.md` when none is
/// given); the layered prompt keeps its shipped guideline bullet.
#[tokio::test]
async fn append_text_follows_the_prompt_kind() {
    let fixture = fixture();
    std::fs::write(fixture.agent_dir.join("APPEND_SYSTEM.md"), "From the file.").unwrap();
    let build = |selection: ToolSelection, append: Vec<String>| {
        let provider = Arc::new(ScriptedProvider::new(model()));
        let config = SessionEngineConfig {
            append_system_prompt: append,
            ..fixture.config(&provider, selection)
        };
        async move { create_session(config).await.unwrap().system_prompt }
    };
    let base = ts_no_tools_prompt(
        &fixture.cwd.display().to_string(),
        &fixture.log.display().to_string(),
    );
    assert_eq!(
        build(ToolSelection::NoTools, vec!["Be brief.".to_string()]).await,
        format!("{base}\n\nBe brief.")
    );
    assert_eq!(
        build(ToolSelection::NoTools, Vec::new()).await,
        format!("{base}\n\nFrom the file.")
    );
    let layered = build(ToolSelection::Defaults, vec!["Be brief.".to_string()]).await;
    assert!(layered.contains("# Additional Guidance\n\n- Be brief."));
    assert!(!layered.contains("From the file."));
}
