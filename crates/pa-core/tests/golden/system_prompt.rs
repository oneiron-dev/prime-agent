//! Golden snapshot of the assembled layered system prompt. The prompt no
//! longer pins the TS text (the layered redesign supersedes TS-prompt
//! parity); the golden pins the Rust prompt itself so any layer edit is a
//! visible, reviewed change. Regenerate with `PA_UPDATE_GOLDEN=1 cargo test`.

use pa_core::prompts::system_prompt::{build_system_prompt, BuildSystemPromptOptions};
use pa_core::skills::load_skills_from_dir;
use std::path::Path;

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/golden/corpus/system-prompt.json"
);

#[derive(serde::Serialize, serde::Deserialize)]
struct GoldenCorpus {
    fixture: serde_json::Value,
    skill_count: usize,
    #[serde(rename = "systemPrompt")]
    system_prompt: String,
}

/// The workspace bundled skills directory (source-checkout layout):
/// pa-core lives at `<root>/crates/pa-core`.
fn bundled_skills_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .join("skills")
}

/// Fixture-state prompt with the per-run values normalized: the skills
/// directory path, raw readdir skill order (both sides sort), and the date.
fn fixture_prompt() -> (String, usize) {
    let skills_dir = bundled_skills_dir();
    let mut loaded = load_skills_from_dir(&skills_dir, "package");
    // Skill enumeration is directory-order; pin content, not order.
    loaded
        .skills
        .sort_by(|left, right| left.name.cmp(&right.name));
    let count = loaded.skills.len();
    let prompt = build_system_prompt(&BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        messages_path: Some("/w/sessions/fixture-session.jsonl".to_string()),
        skills: loaded.skills,
        selected_tools: Some(vec!["ipython"]),
        allow_recursion: Some(true),
        rlm_depth: Some(0),
        ..Default::default()
    })
    .replace(skills_dir.to_string_lossy().as_ref(), "<skills-dir>");
    let normalized = regex_lite_replace(&prompt);
    (normalized, count)
}

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

#[test]
fn system_prompt_matches_golden_snapshot() {
    let (prompt, skill_count) = fixture_prompt();
    if std::env::var("PA_UPDATE_GOLDEN").as_deref() == Ok("1") {
        let corpus = GoldenCorpus {
            fixture: serde_json::json!({
                "cwd": "/w",
                "messagesPath": "/w/sessions/fixture-session.jsonl",
                "selectedTools": ["ipython"],
                "skillsSource": "bundled skills directory (<skills-dir>)",
            }),
            skill_count,
            system_prompt: prompt,
        };
        std::fs::write(
            GOLDEN,
            serde_json::to_string_pretty(&corpus).expect("serialize golden") + "\n",
        )
        .expect("write golden");
        return;
    }
    let raw = std::fs::read_to_string(GOLDEN).expect("golden corpus");
    let golden: GoldenCorpus = serde_json::from_str(&raw).expect("golden corpus json");
    assert_eq!(
        skill_count, golden.skill_count,
        "bundled skill count changed; re-run with PA_UPDATE_GOLDEN=1 after updating the prompt layers"
    );
    assert_eq!(
        prompt, golden.system_prompt,
        "assembled prompt changed; if intended, re-run with PA_UPDATE_GOLDEN=1 and review the diff"
    );
}

/// The TS no-tools prompt as the shipped TS build sent it (captured from
/// `prime-agent -p --no-tools --no-session --no-skills ...` in
/// `/tmp/pb.ysn9o0q3/w`; 2,546 bytes, no trailing newline).
const TS_NO_TOOLS_PROMPT: &str = include_str!("corpus/no-tools-prompt-ts.txt");

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
