import { createHash } from "node:crypto";

export const DECISION_QUESTIONS_V8_VERSION = "v8-structured-plus-rule";
export const DECISION_QUESTIONS_V8 = `{
 "gate_verdict": {
  "jev_type": "noul",
  "yes_option": "accept",
  "no_option": "reject",
  "instructions": {
   "decision": "Accept or reject this ONE terminal result as proof that the gate it belongs to passed on the exact candidate.",
   "scope_of_judgment": "Only the gate this result is for. Other gates, reviews or writers still pending are separate decisions.",
   "answer_yes_means": "accept and advance",
   "answer_no_means": "reject, preserve evidence, repair or rerun",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "The result proves this gate on the exact candidate.",
    "yes_if_all": [
     "the result is bound to the candidate being judged (fingerprint, hash or replica id matches, or the state gives no sign of a different revision)",
     "exit code and pass/fail counts are consistent with a pass for this gate, or, for a writer terminal, the run ended normally (exit 0, agent_end) with changes inside the permitted paths",
     "the run completed rather than being interrupted"
    ],
    "not_a_reason_to_say_no": [
     "a different gate is still red or not yet run",
     "tests were skipped by the filter while a nonzero number ran and passed",
     "a criterion forbids replaying an earlier attempt and this attempt is a different one"
    ]
   },
   "false": {
    "definition": "The result does not prove this gate.",
    "no_if_any": [
     "non-zero exit or any failed test in this run",
     "the run was interrupted, killed or has no normal end marker",
     "zero tests matched when the criteria require a nonzero number",
     "the result is for a different revision than the candidate",
     "the phase produced work that leaves the named invariant broken or is explicitly incomplete",
     "the state carries no exit code, counts or receipt for this result at all"
    ]
   }
  },
  "policy": "Accept only what the evidence proves. An exit code alone, a historical PASS, or a review request is not candidate acceptance. A terminal result must be for the exact candidate fingerprint. A rejected predecessor is not a satisfied dependency. Preserve failed evidence; never replay unchanged work."
 },
 "baseline_adoption": {
  "jev_type": "noul",
  "yes_option": "adopt_dirty",
  "no_option": "restart_clean",
  "instructions": {
   "decision": "Adopt the retained dirty worktree or candidate as the working baseline, or restart from a clean checkout.",
   "answer_yes_means": "adopt the retained bytes and continue only the remaining gaps",
   "answer_no_means": "restart from a clean checkout of the authoritative base",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "The retained bytes are the right baseline.",
    "yes_if_all": [
     "the retained revision or candidate is identifiable (hash, fingerprint, diff or adoption record)",
     "delegated authority for source-baseline choice exists",
     "the retained work is usable, even with a known bounded defect to repair"
    ],
    "not_a_reason_to_say_no": [
     "historical authorship or ACK is unknown",
     "a compile or test defect exists that a writer can repair in place",
     "an older green candidate also exists but sits behind the current baseline"
    ]
   },
   "false": {
    "definition": "The retained bytes should not be the baseline.",
    "no_if_any": [
     "the retained bytes cannot be identified",
     "the retained bytes are known wrong, contaminated or built on a superseded base with no path forward",
     "no authority covers adoption"
    ]
   }
  },
  "policy": "Under the Root delegated source-baseline authority, retained dirty bytes are adopted as the baseline when the exact retained revision is known and evidence is preserved; missing historical authorship proof is not by itself a reason to restart. Restart clean only when the retained bytes cannot be identified or are known wrong. No semantic restart of usable work."
 },
 "attempt_requeue": {
  "jev_type": "noul",
  "yes_option": "requeue",
  "no_option": "settle_no_retry",
  "instructions": {
   "decision": "Requeue this attempt (launch it again) or settle it as no-retry.",
   "answer_yes_means": "launch the same attempt again through the supported path",
   "answer_no_means": "do not launch it again; preserve evidence; withdraw or consume as appropriate",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "A relaunch is warranted.",
    "yes_if_all": [
     "the attempt is proven dead or failed for a transient cause",
     "its claim or slot is released",
     "no equivalent job is queued, running or already consumed",
     "the work is still needed"
    ]
   },
   "false": {
    "definition": "A relaunch is not warranted.",
    "no_if_any": [
     "death cannot be proven (a missing PID, an absent supervisor or unreadable processes are not death)",
     "the same result has already been consumed, including a duplicate delivery of a consumed event",
     "an equivalent job is queued or running, or a successor already covers the work",
     "the attempt's dependency was rejected, so the attempt as imported can never be satisfied",
     "the failure is a real assertion or compile error that needs a fix, not a replay"
    ]
   }
  },
  "policy": "A missing PID is not death. Do not add a duplicate action or job to create apparent progress. Requeue only with proof the attempt is dead and its claim released. If an equivalent job is queued or running, do not add another. Preserve failed receipts."
 },
 "writer_stop": {
  "jev_type": "noul",
  "yes_option": "stop_writer",
  "no_option": "let_finish",
  "instructions": {
   "decision": "Stop the running writer now, preserving partial bytes, or let it finish.",
   "answer_yes_means": "stop only this writer, keep bytes, obtain a bounded ruling, relaunch corrected",
   "answer_no_means": "let it finish and judge the result at the gate",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "Finishing would produce work that must be reverted or cannot be published.",
    "yes_if_any": [
     "the writer's task is known to contradict the governing blueprint or an owner ruling",
     "the writer targets a repository or path outside the allowlist with no amendment",
     "the run is about to mutate state on a known topology or invariant failure"
    ]
   },
   "false": {
    "definition": "Finishing is safe.",
    "no_if_any": [
     "the concern is style, slowness or an unverified bot assertion",
     "the writer is read-only or cannot mutate anything",
     "an owner hold forbids new admissions or successors but says nothing about live work"
    ]
   }
  },
  "policy": "Managers decide and dispatch; they do not invent semantic fixes. A writer whose task is known to conflict with the governing blueprint should be stopped in scope with partial bytes preserved and a fresh corrected writer launched after a bounded ruling; no source reset, no unchanged replay. Do not stop healthy work on unverified claims."
 },
 "executability": {
  "jev_type": "noul",
  "yes_option": "executable_now",
  "no_option": "blocked",
  "instructions": {
   "decision": "Is the next action for this ticket executable now by the manager within its existing authority, or blocked?",
   "answer_yes_means": "take the next action now",
   "answer_no_means": "a named real dependency, resource or authority reason blocks every action the manager owns",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "Something the manager owns can be done now.",
    "yes_if_any": [
     "the inputs exist and no named dependency stands in the way",
     "another party has confirmed it does not own the work, so no dependency on it exists",
     "the work is file-only or a local rewrite and needs no contended resource",
     "a result is waiting to be consumed",
     "independent work the manager owns is available even if one action waits"
    ],
    "not_a_reason_to_say_no": [
     "a packet is ambiguous but can be rewritten locally into an executable action",
     "an optional external review is unavailable on quota while a code fix within authority remains",
     "monitoring reports no active repair, which is knowledge, not a block"
    ]
   },
   "false": {
    "definition": "Every action the manager owns is blocked right now.",
    "no_if_any": [
     "the target is banned by the allowlist and no amendment exists",
     "an owner hold or a pending ruling on authority applies to the action",
     "a required upstream release has not landed and nothing independent remains",
     "no compatible capacity exists and existing admission will advance it"
    ]
   }
  },
  "policy": "Blocked means a named real dependency, resource or authority reason exists right now. An owner supervision HOLD is a real block. A rejected predecessor is not a satisfied dependency. If one action is blocked, advance any independent work you own. Do not wait for approval you already have."
 },
 "scope": {
  "jev_type": "noul",
  "yes_option": "in_scope",
  "no_option": "out_of_scope",
  "instructions": {
   "decision": "Is this diff, PR or target in scope of the owner allowlist and the ticket's blueprint?",
   "answer_yes_means": "the work may proceed under this ticket",
   "answer_no_means": "the work must not be done or published under this ticket",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "The target and paths are covered.",
    "yes_if_any": [
     "the target repository is on the allowlist and the paths fall inside the blueprint's scope",
     "the owner has stated directly that this repository or work may be done, which is an explicit amendment",
     "a path outside the originally granted set is needed to repair a gate and a Root delegation covers necessary gate repair",
     "the changes are inside the engine tree even if they mention a banned external repository by name"
    ]
   },
   "false": {
    "definition": "The target or paths are not covered.",
    "no_if_any": [
     "the target repository is banned by the allowlist and no owner amendment names it",
     "the owner has ruled this work out of the wave",
     "the blueprint explicitly forbids this class of change",
     "the work is a ruled deferral or a schema expansion beyond the blueprint"
    ]
   }
  },
  "policy": "Work is in scope only when the target repository and paths are within the owner allowlist for the ticket and the blueprint's scope. Publishing outside the allowlist is out of scope regardless of correctness; owner amendments to the allowlist are explicit files, not inferred."
 },
 "merge_readiness": {
  "jev_type": "noul",
  "yes_option": "merge_ready",
  "no_option": "not_ready",
  "instructions": {
   "decision": "Is this candidate merge-ready right now, or has its merge or closeout already been completed and needs only consumption?",
   "answer_yes_means": "merge under the guarded path, or consume the completed merge",
   "answer_no_means": "hold; something required is red, unproven, unresolved or on a superseded head",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "Nothing required is outstanding.",
    "yes_if_any": [
     "required gates are green on the exact candidate, review completed with zero open findings or with each finding answered by the ticket's own tests, provenance bound, no owner hold",
     "the owner has explicitly waived the remaining review for this candidate and ordered the merge",
     "the merge or closeout has already completed (merge result present, issue Done with the PR attached) and nothing is pending"
    ],
    "not_a_reason_to_say_no": [
     "an optional reviewer is unavailable on quota and is recorded as not required",
     "older inline threads bound to a previous commit that are not new findings",
     "other tickets have their own obligations against this merge"
    ]
   },
   "false": {
    "definition": "Something required is outstanding.",
    "no_if_any": [
     "a required gate is red or unproven on this head",
     "review reports an open bug or rule finding that the ticket's own tests do not answer",
     "the reviewed head is no longer the branch tip",
     "an owner hold applies",
     "review is only requested, pending or terminal-skipped with no explicit waiver"
    ]
   }
  },
  "policy": "Merge-ready means gates green on the exact candidate, bot threads settled by remote proof rather than by claim, provenance bound, and no owner hold. A review request, a pending check, or a terminal-skipped review is not review completion. An explicit owner waiver replaces review only for the pair it names."
 },
 "build_host": {
  "jev_type": "choice",
  "instructions": {
   "decision": "Where should the manager run the next build or test action?",
   "rule_of_thumb": "Mac first for portable Rust when Mac capacity is free or staged; a free Linux slot when the Linux worktree is ready or the Mac is busy; wait only when the proof is platform-bound to a busy host or an equivalent run is already queued there.",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "wait_current_slot": {
    "definition": "Keep the action on its current host or slot and wait.",
    "pick_if_any": [
     "the proof is platform-specific to that host",
     "an equivalent run is already queued or running there",
     "no other eligible capacity is mentioned as free or staged"
    ],
    "do_not_pick_if": [
     "a free Linux slot or a free or staged Mac slot is named in the state"
    ]
   },
   "move_to_free_linux_slot": {
    "definition": "Rebind the unstarted action to a free Linux physical slot on the same box.",
    "pick_if_any": [
     "a free Linux slot is named and the Linux worktree at the candidate fingerprint is ready",
     "the Mac is busy or not mentioned and a Linux slot is free"
    ],
    "do_not_pick_if": [
     "the action has already started elsewhere",
     "a Mac slot is free or staged for this exact replica and the proof is portable"
    ]
   },
   "move_to_mac_portable": {
    "definition": "Rebind the portable Rust build, test, check or clippy to MacBook Pro capacity.",
    "pick_if_any": [
     "a Mac slot is free, fresh or has a staged workspace for this replica",
     "Mac slots are reported idle and portable jobs are queued"
    ],
    "do_not_pick_if": [
     "the proof is Linux-specific",
     "the state says the Mac is busy"
    ]
   }
  },
  "policy": "The owner prefers the MacBook Pro for portable Rust build/test/check/clippy when fresh Mac capacity is available. Keep genuinely platform-specific proof on its platform. Use an eligible free Linux slot when the Mac is busy. Do not wait just for a warm cache. Do not duplicate or restart live or accepted work."
 },
 "review_posting": {
  "jev_type": "noul",
  "yes_option": "posted",
  "no_option": "not_posted",
  "instructions": {
   "decision": "Has this review or comment actually been posted or completed, so the manager may truthfully report it as requested, underway or done?",
   "answer_yes_means": "a real POST or a completed review exists",
   "answer_no_means": "nothing real is in flight; do not report it as requested or underway",
   "general_rule": "Judge only this decision from what the state says. Other gates, reviews, tickets or work that remain pending are separate decisions and do not by themselves make the answer no; a missing fact is not evidence of failure unless the criteria name it as required."
  },
  "criteria": {
   "true": {
    "definition": "A real receipt exists.",
    "yes_if_any": [
     "a request command returned a comment or action ID or URL with a timestamp",
     "a completed review body for this head exists with findings or an exact-head marker"
    ],
    "not_a_reason_to_say_no": [
     "no review body has come back yet after a request that returned an ID",
     "a different reviewer is unavailable on quota"
    ]
   },
   "false": {
    "definition": "No real receipt exists.",
    "no_if_any": [
     "the review is only planned, delegated or described as requested with no returned ID",
     "a status check reads PENDING while the same PR shows auto-review disabled or SKIPPED and no manual request exists",
     "the only bodies are quota, limit or could-not-complete notices",
     "the returned run is terminal SKIPPED, disabled or failed",
     "the state gives no returned ID, URL or comment, only a request number and an estimate"
    ]
   }
  },
  "policy": "A review request is not a completed review, and a planned or delegated request is not a POST. A submitted READY action is not execution. Report a review as requested or running only against a returned ID and timestamp; a terminal SKIP, disabled or quota failure is not productive waiting."
 }
}`;
export const DECISION_QUESTIONS_V8_SHA256 = createHash("sha256").update(DECISION_QUESTIONS_V8).digest("hex");
