//! The system prompt of a session whose active tools include no Python REPL
//! (`ipython`): `--no-tools`, `--no-builtin-tools`, or a `--tools` list
//! without `ipython`. The layered harness prompt documents a kernel API the
//! model cannot reach there, so this path builds the shipped TS prompt
//! instead, byte for byte: `core/prompts/rlm.js` `buildRlmPrompt` with
//! `ipython` inactive, assembled by `core/system-prompt.js`
//! `buildSystemPrompt` (default and custom-prompt branches). It carries no
//! harness layers, no image-input line, no root annotation and no
//! unavailable-REPL warning; the harness digest stays a separate user
//! message either way.

use std::fmt::Write as _;

use crate::skills::{format_skills_for_prompt, get_python_skill_runtime_info, Skill};

use super::system_prompt::{BuildSystemPromptOptions, PromptSegment, SystemPromptBreakdown};

const INTRO: [&str; 3] = [
    "You are a general purpose agent that uses code to solve tasks.",
    "You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating one step at a time.",
    "When you are done, stop calling tools and state your final answer.",
];

const LONG_RUNNING_WORK_PROMPT: [&str; 3] = [
    "For slow or independently completing work, use a nonblocking control loop: start the work, record its handle or output location, then end your turn. A `bash()` handle left running beyond its creating cell sends a completion follow-up; when it arrives, inspect the saved handle and continue. Reading a finished handle's result first cancels that follow-up.",
    "When delegation is available and useful, assign independent substantive tasks to separate workers. Start independent workers without waiting for each one sequentially, and let them run in parallel.",
    "Do not keep the turn open by polling with `time.sleep()` or shell `sleep`, and do not replace polling with a long blocking `await`. Await only the short operation needed to start work or inspect a result that is already available; otherwise end the turn.",
];

const USER_PROGRESS_PROMPT: &str = "As the user-facing root agent, when work follows a plan, uses many subagents, or spans multiple turns, proactively give regular concise progress updates so the user does not have to ask. State the current plan, what has completed, any blockers, the proposed fixes, and the next actions. Lead with user-visible outcomes rather than internal process or gate names. Mention internal details only when they explain a blocker or decision. Send an update at meaningful milestones and before ending a turn while work is still running. Do not repeat unchanged status or interrupt short work with unnecessary updates.";

const SIMPLIFIED_TECHNICAL_ENGLISH_PROMPT: [&str; 4] = [
    "Use simplified technical English by default for user-facing prose.",
    "Prefer short sentences, common words, and concrete verbs. State one main action or fact per sentence when practical. Use lists for steps or conditions.",
    "Keep necessary technical terms, names, commands, code, paths, and exact quoted text unchanged. State uncertainty directly.",
    "Treat this as clarity guidance, not a claim of formal ASD-STE100 compliance. Preserve a user-requested format, tone, terminology, and necessary precision.",
];

/// Build the no-REPL prompt and its breakdown. `tools` is the session's
/// active tool list (it holds no `ipython`).
pub(super) fn no_repl_breakdown(
    options: &BuildSystemPromptOptions,
    tools: &[&str],
) -> SystemPromptBreakdown {
    let cwd = options.cwd.replace('\\', "/");
    // TS `hasFileAccess`: a shell tool can still read skill files.
    let has_file_access = tools.contains(&"bash");
    let depth = options.rlm_depth.unwrap_or(0);
    let child_doctrine = (depth > 0).then(|| {
        format!(
            "You are a child agent spawned by {}. Task prompts are labeled `[task from parent]`.",
            options.rlm_parent_agent.unwrap_or("your parent agent")
        )
    });
    let context = context_section(&options.context_files);
    let skills_inventory = if has_file_access && !options.skills.is_empty() {
        format_skills_for_prompt(&options.skills)
    } else {
        String::new()
    };
    let append = options.append_system_prompt.clone().unwrap_or_default();

    let mut segments = Vec::new();
    let mut assembled = String::new();
    let cached_prefix_len;
    match options.custom_prompt.as_deref() {
        Some(custom) if !custom.is_empty() => {
            segments.push(PromptSegment::static_segment(
                "custom",
                "--system-prompt",
                custom.to_string(),
            ));
            assembled.push_str(custom);
            cached_prefix_len = assembled.len();
            push_dynamic(
                &mut segments,
                &mut assembled,
                "project-context",
                "AGENTS.md discovery",
                "",
                &context,
            );
            push_dynamic(
                &mut segments,
                &mut assembled,
                "skills-inventory",
                "skill discovery",
                "",
                &skills_inventory,
            );
            push_dynamic(
                &mut segments,
                &mut assembled,
                "environment",
                "session configuration",
                "",
                &format!(
                    "\nCurrent date: {}\nCurrent working directory: {cwd}",
                    super::system_prompt::local_today()
                ),
            );
            if let Some(doctrine) = &child_doctrine {
                push_dynamic(
                    &mut segments,
                    &mut assembled,
                    "session-role",
                    "RLM recursion state",
                    "\n\n",
                    doctrine,
                );
            }
        }
        _ => {
            let mut base: Vec<&str> = INTRO.to_vec();
            base.push("");
            base.extend(LONG_RUNNING_WORK_PROMPT);
            base.push("");
            if depth == 0 {
                base.extend([USER_PROGRESS_PROMPT, ""]);
            }
            base.extend(SIMPLIFIED_TECHNICAL_ENGLISH_PROMPT);
            let base = base.join("\n");
            segments.push(PromptSegment::static_segment(
                "base",
                "TS no-tools prompt (rlm.js)",
                base.clone(),
            ));
            assembled.push_str(&base);
            cached_prefix_len = assembled.len();
            let messages_path = options
                .messages_path
                .clone()
                .unwrap_or_else(|| "not persisted".to_string())
                .replace('\\', "/");
            let environment = [
                format!("Working directory: {cwd}"),
                format!("Conversation log: {messages_path}"),
                format!("Recursive agent depth: {depth}"),
                super::system_prompt::packages_section(),
            ]
            .join("\n");
            push_dynamic(
                &mut segments,
                &mut assembled,
                "environment",
                "session configuration",
                "\n\n",
                &environment,
            );
            if let Some(doctrine) = &child_doctrine {
                push_dynamic(
                    &mut segments,
                    &mut assembled,
                    "session-role",
                    "RLM recursion state",
                    "\n\n",
                    doctrine,
                );
            }
            let skill_lines = installed_skill_lines(&options.skills, has_file_access);
            push_dynamic(
                &mut segments,
                &mut assembled,
                "skills",
                "skill discovery",
                "\n\n",
                &skill_lines,
            );
            let restrictions = family_restrictions(&options.skills);
            push_dynamic(
                &mut segments,
                &mut assembled,
                "family",
                "messaging skills",
                "\n",
                &restrictions,
            );
            let guidelines = options
                .prompt_guidelines
                .as_deref()
                .map(super::system_prompt::format_prompt_guidelines)
                .unwrap_or_default();
            if !guidelines.is_empty() {
                push_dynamic(
                    &mut segments,
                    &mut assembled,
                    "additional-guidance",
                    "prompt guidelines",
                    "\n\n",
                    &format!("# Additional Guidance\n\n{guidelines}"),
                );
            }
            push_dynamic(
                &mut segments,
                &mut assembled,
                "project-context",
                "AGENTS.md discovery",
                "",
                &context,
            );
            push_dynamic(
                &mut segments,
                &mut assembled,
                "skills-inventory",
                "skill discovery",
                "",
                &skills_inventory,
            );
        }
    }
    push_dynamic(
        &mut segments,
        &mut assembled,
        "appended-prompt",
        "--append-system-prompt",
        "\n\n",
        &append,
    );
    SystemPromptBreakdown {
        segments,
        assembled,
        cached_prefix_len,
    }
}

/// Append one non-empty dynamic segment after `separator`.
fn push_dynamic(
    segments: &mut Vec<PromptSegment>,
    assembled: &mut String,
    name: &'static str,
    source: &'static str,
    separator: &str,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    assembled.push_str(separator);
    assembled.push_str(text);
    segments.push(PromptSegment::dynamic_segment(
        name,
        source,
        text.to_string(),
    ));
}

/// TS project context: every file followed by a blank line.
fn context_section(context_files: &[(String, String)]) -> String {
    if context_files.is_empty() {
        return String::new();
    }
    let mut section =
        String::from("\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n");
    for (path, content) in context_files {
        // Writing into a String cannot fail.
        let _ = write!(section, "## {path}\n\n{content}\n\n");
    }
    section
}

/// The model-visible Python skills' import names (TS
/// `visiblePythonSkillImportNames`).
fn visible_python_imports(skills: &[Skill]) -> Vec<String> {
    let visible: Vec<Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .cloned()
        .collect();
    get_python_skill_runtime_info(&visible)
        .into_iter()
        .map(|skill| skill.import_name)
        .collect()
}

/// TS `skillLines` without a REPL: the shell-command form, only when a
/// shell tool is active.
fn installed_skill_lines(skills: &[Skill], has_shell: bool) -> String {
    let installed = visible_python_imports(skills);
    if installed.is_empty() || !has_shell {
        return String::new();
    }
    let names = installed
        .iter()
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ");
    [
        format!("Installed skills available as shell commands: {names}."),
        "Each skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.".to_string(),
    ]
    .join("\n")
}

/// TS's messaging/observation family restrictions, stated whenever the
/// skill is visible (with or without a REPL).
fn family_restrictions(skills: &[Skill]) -> String {
    let installed = visible_python_imports(skills);
    let mut lines = Vec::new();
    if installed.iter().any(|name| name == "agent_message") {
        lines.push("Agent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.");
    }
    if installed.iter().any(|name| name == "agent_observe") {
        lines.push("Agent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child.");
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompts::system_prompt::build_system_prompt;
    use crate::skills::{
        create_synthetic_source_info, SkillKind, SkillPythonMetadata, SourceScope,
    };
    use std::path::PathBuf;

    fn python_skill(name: &str, import_name: &str) -> Skill {
        Skill {
            name: name.to_string(),
            description: format!("Skill {name}"),
            file_path: PathBuf::from("/skills/SKILL.md"),
            base_dir: PathBuf::from("/skills"),
            source_info: create_synthetic_source_info("/skills", "user", SourceScope::User, None),
            disable_model_invocation: false,
            kind: SkillKind::Python,
            python: Some(SkillPythonMetadata {
                import_name: import_name.to_string(),
                package_path: PathBuf::from("/skills"),
                pyproject_path: PathBuf::from("/skills/pyproject.toml"),
            }),
        }
    }

    fn prompt(tools: Vec<&'static str>) -> String {
        build_system_prompt(&BuildSystemPromptOptions {
            cwd: "/w".to_string(),
            selected_tools: Some(tools),
            skills: vec![
                python_skill("agent-message", "agent_message"),
                python_skill("agent-observe", "agent_observe"),
            ],
            ..Default::default()
        })
    }

    /// The custom-prompt date line is TS's LOCAL calendar day: the day of
    /// an instant moves with the zone offset across midnight.
    #[test]
    fn the_date_line_follows_the_local_offset() {
        use crate::prompts::system_prompt::date_at;
        // 2026-10-02T00:30:00Z.
        let instant = 1_790_901_000;
        assert_eq!(
            [
                date_at(instant, 0),
                date_at(instant, -3_600),
                date_at(instant, 14 * 3_600),
                date_at(0, -1),
            ],
            ["2026-10-02", "2026-10-01", "2026-10-02", "1969-12-31"]
        );
        let custom = build_system_prompt(&BuildSystemPromptOptions {
            cwd: "/w".to_string(),
            custom_prompt: Some("Be terse.".to_string()),
            selected_tools: Some(Vec::new()),
            ..Default::default()
        });
        assert!(custom.contains(&format!(
            "\nCurrent date: {}\n",
            crate::prompts::system_prompt::local_today()
        )));
    }

    /// TS without a REPL: the family restrictions follow the environment
    /// block on their own lines; no skill inventory without a shell tool.
    #[test]
    fn visible_messaging_skills_add_only_their_restrictions() {
        let text = prompt(Vec::new());
        assert!(text.ends_with(
            "(this is a uv-managed venv with no pip module).\nAgent messaging is restricted to your parent, siblings, and direct children; roots are siblings, and deeper communication relays through the intermediate child.\nAgent observation is restricted to your parent, siblings, and direct children; roots are siblings, and deeper inspection relays through the intermediate child."
        ));
        assert!(!text.contains("<available_skills>"));
    }

    /// A shell tool without a REPL: TS lists the skills as shell commands
    /// and appends the skill inventory last.
    #[test]
    fn a_shell_tool_lists_skills_as_commands_and_appends_the_inventory() {
        let text = prompt(vec!["bash"]);
        assert!(text.contains(
            "pip module).\n\nInstalled skills available as shell commands: `agent_message`, `agent_observe`.\nEach skill is also available as a shell command by the same name: `<skill> ...`. Discover its CLI usage with `<skill> --help`.\nAgent messaging is restricted"
        ));
        assert!(text.ends_with(&format!(
            "relays through the intermediate child.{}",
            format_skills_for_prompt(&[
                python_skill("agent-message", "agent_message"),
                python_skill("agent-observe", "agent_observe"),
            ])
        )));
    }
}
