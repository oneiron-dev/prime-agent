//! No-tools prompt parity with the captured TS output.
use pa_core::prompts::system_prompt::{build_system_prompt, BuildSystemPromptOptions};

/// Replace `Current date: YYYY-MM-DD` with a placeholder (no chrono dep for
/// one substitution).
fn regex_lite_replace(text: &str) -> String {
    const MARKER: &str = "Current date: ";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(MARKER) {
        out.push_str(&rest[..at + MARKER.len()]);
        let tail = &rest[at + MARKER.len()..];
        let date_len = tail
            .chars()
            .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
            .count();
        let is_date = date_len == 10;
        if is_date {
            out.push_str("<date>");
            rest = &tail[date_len..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// The TS no-tools prompt as the shipped TS build sent it (captured from
/// `prime-agent -p --no-tools --no-session --no-skills ...` in
/// `/tmp/pb.ysn9o0q3/w`; 2,546 bytes, no trailing newline).
const TS_NO_TOOLS_PROMPT: &str = include_str!("golden/corpus/no-tools-prompt-ts.txt");

/// The fixed fixture of the TS capture: a root session, not persisted, no
/// context, no skills.
fn no_tools_options(selected_tools: Vec<&'static str>) -> BuildSystemPromptOptions<'static> {
    BuildSystemPromptOptions {
        cwd: "/tmp/pb.ysn9o0q3/w".to_string(),
        messages_path: None,
        selected_tools: Some(selected_tools),
        rlm_depth: Some(0),
        ..Default::default()
    }
}

/// Without `ipython` (no tools at all, or a custom tool only) the session
/// prompt is the TS no-tools prompt byte for byte.
#[test]
fn no_tools_prompt_matches_the_ts_capture() {
    assert_eq!(TS_NO_TOOLS_PROMPT.len(), 2_546);
    assert_eq!(
        [
            build_system_prompt(&no_tools_options(Vec::new())),
            build_system_prompt(&no_tools_options(vec!["echo"])),
        ],
        [
            TS_NO_TOOLS_PROMPT.to_string(),
            TS_NO_TOOLS_PROMPT.to_string()
        ]
    );
}

/// TS `buildSystemPrompt` with no tools: project context follows the base
/// (every file ends in a blank line), then the append text.
#[test]
fn no_tools_prompt_appends_context_then_append_text_like_ts() {
    let options = BuildSystemPromptOptions {
        context_files: vec![(
            "/tmp/pb.ysn9o0q3/w/AGENTS.md".to_string(),
            "Rule one.".to_string(),
        )],
        append_system_prompt: Some("Answer in French.".to_string()),
        ..no_tools_options(Vec::new())
    };
    assert_eq!(
        build_system_prompt(&options),
        format!(
            "{TS_NO_TOOLS_PROMPT}\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /tmp/pb.ysn9o0q3/w/AGENTS.md\n\nRule one.\n\n\n\nAnswer in French."
        )
    );
    let append_only = BuildSystemPromptOptions {
        append_system_prompt: Some("Answer in French.".to_string()),
        ..no_tools_options(Vec::new())
    };
    assert_eq!(
        build_system_prompt(&append_only),
        format!("{TS_NO_TOOLS_PROMPT}\n\nAnswer in French.")
    );
}

/// TS's custom-prompt branch with no tools: the custom text, the context,
/// then the date and working-directory lines, then the append text; no
/// harness, packages or environment block.
#[test]
fn no_tools_custom_prompt_gets_the_ts_date_and_cwd_lines() {
    let options = BuildSystemPromptOptions {
        custom_prompt: Some("Be terse.".to_string()),
        context_files: vec![("/w/AGENTS.md".to_string(), "Rule one.".to_string())],
        append_system_prompt: Some("Answer in French.".to_string()),
        ..no_tools_options(Vec::new())
    };
    assert_eq!(
        regex_lite_replace(&build_system_prompt(&options)),
        "Be terse.\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /w/AGENTS.md\n\nRule one.\n\n\nCurrent date: <date>\nCurrent working directory: /tmp/pb.ysn9o0q3/w\n\nAnswer in French."
    );
}

/// A child session without tools: the depth line, then TS's one-line child
/// doctrine (the REPL-only reply and progress lines stay out), and no
/// root progress paragraph.
#[test]
fn no_tools_child_prompt_carries_the_ts_child_doctrine() {
    let options = BuildSystemPromptOptions {
        rlm_depth: Some(2),
        rlm_parent_agent: Some("the lead"),
        ..no_tools_options(Vec::new())
    };
    let prompt = build_system_prompt(&options);
    assert!(!prompt.contains("As the user-facing root agent"));
    assert!(prompt.ends_with(
        "Recursive agent depth: 2\nPre-installed Python packages: requests, httpx, yaml (PyYAML), tomli, dotenv (python-dotenv), pandas, numpy, scipy, bs4 (Beautiful Soup), lxml, pydantic, tyro.\nInstall additional packages with `uv pip install <pkg>` (this is a uv-managed venv with no pip module).\n\nYou are a child agent spawned by the lead. Task prompts are labeled `[task from parent]`."
    ));
}
