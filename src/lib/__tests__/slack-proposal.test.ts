import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type SlackProposedTask,
  addRepo,
  applyFieldValue,
  applyFormState,
  applyGitMode,
  applyScheduleMode,
  blockId,
  composeScheduledFor,
  decodeBlockId,
  gitModeOf,
  option,
  removeRepo,
  sanitizeProposal,
  scheduleModeOf,
  scheduledForParts,
  summariseProposal,
  textInputBlock,
  threadTsFromBlockId,
  validateProposal,
} from "../slack-proposal";

function proposal(extra: Partial<SlackProposedTask> = {}): SlackProposedTask {
  return { title: "Fix the thing", description: "Do the work", ...extra };
}

const THREAD = "1712345678.123456";

describe("block ids", () => {
  it("round-trips a kind + thread", () => {
    const id = blockId("context", THREAD);
    assert.deepEqual(decodeBlockId(id), { kind: "context", index: undefined, threadTs: THREAD });
  });

  it("round-trips a kind + index + thread", () => {
    const id = blockId("repobranch", THREAD, 2);
    assert.deepEqual(decodeBlockId(id), { kind: "repobranch", index: 2, threadTs: THREAD });
  });

  it("handles DM thread ids (a channel id, not a timestamp)", () => {
    assert.equal(threadTsFromBlockId(blockId("cfg", "D0123ABC")), "D0123ABC");
  });

  it("still understands legacy cfg_<threadTs> block ids", () => {
    assert.equal(threadTsFromBlockId(`cfg_${THREAD}`), THREAD);
  });
});

describe("schedule mode", () => {
  it("derives the mode from the proposal", () => {
    assert.equal(scheduleModeOf(proposal()), "now");
    assert.equal(scheduleModeOf(proposal({ scheduledFor: "2026-01-02T09:00" })), "scheduled");
    assert.equal(scheduleModeOf(proposal({ isRecurring: true, cronExpression: "0 9 * * *" })), "recurring");
  });

  it("recurring wins over a leftover one-off datetime", () => {
    const p = proposal({ isRecurring: true, scheduledFor: "2026-01-02T09:00" });
    assert.equal(scheduleModeOf(p), "recurring");
  });

  it("clears cron fields when switching to run-now", () => {
    const p = proposal({ isRecurring: true, cronExpression: "0 9 * * *", maxRuns: 3 });
    applyScheduleMode(p, "now");
    assert.equal(p.isRecurring, false);
    assert.equal(p.cronExpression, undefined);
    assert.equal(p.maxRuns, null);
    assert.equal(p.scheduledFor, undefined);
    assert.equal(scheduleModeOf(p), "now");
  });

  it("clears the one-off datetime when switching to recurring", () => {
    const p = proposal({ scheduledFor: "2026-01-02T09:00" });
    applyScheduleMode(p, "recurring");
    assert.equal(p.scheduledFor, undefined);
    assert.equal(scheduleModeOf(p), "recurring");
  });

  it("keeps a proposed datetime when switching to scheduled, else seeds one", () => {
    const kept = proposal({ scheduledFor: "2026-01-02T09:00" });
    applyScheduleMode(kept, "scheduled");
    assert.equal(kept.scheduledFor, "2026-01-02T09:00");

    const seeded = proposal();
    applyScheduleMode(seeded, "scheduled");
    assert.ok(seeded.scheduledFor, "expected a seeded datetime");
    assert.ok(!Number.isNaN(new Date(seeded.scheduledFor as string).getTime()));
    assert.ok(new Date(seeded.scheduledFor as string).getTime() > Date.now());
  });
});

describe("scheduledForParts", () => {
  it("splits a local datetime into picker values", () => {
    assert.deepEqual(scheduledForParts("2026-01-02T09:05"), { date: "2026-01-02", time: "09:05" });
  });

  it("falls back to a valid future default for junk input", () => {
    const parts = scheduledForParts("not a date");
    assert.match(parts.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(parts.time, /^\d{2}:\d{2}$/);
  });

  it("composes back into something Date can parse", () => {
    const value = composeScheduledFor("2026-01-02", "09:05");
    assert.equal(value, "2026-01-02T09:05");
    assert.equal(new Date(value).getHours(), 9);
  });
});

describe("git mode", () => {
  it("derives the mode from the push flags", () => {
    assert.equal(gitModeOf(proposal()), "branch");
    assert.equal(gitModeOf(proposal({ createPR: true })), "pr");
    assert.equal(gitModeOf(proposal({ pushToMain: true })), "main");
    assert.equal(gitModeOf(proposal({ targetBranch: "develop" })), "target");
  });

  it("switching mode clears the flags that no longer apply", () => {
    const p = proposal({ createPR: true, targetBranch: "develop" });
    applyGitMode(p, "main");
    assert.equal(p.createPR, false);
    assert.equal(p.pushToMain, true);
    assert.equal(p.targetBranch, undefined);
    assert.equal(gitModeOf(p), "main");
  });

  it("keeps the target branch when staying on target mode", () => {
    const p = proposal({ targetBranch: "develop" });
    applyGitMode(p, "target");
    assert.equal(p.targetBranch, "develop");
  });

  it("target mode sticks before a branch name has been typed", () => {
    const p = proposal({ createPR: true });
    applyGitMode(p, "target");
    assert.equal(gitModeOf(p), "target", "menu must not snap back to 'new branch'");
    assert.equal(validateProposal(p)?.includes("target branch"), true);

    applyFieldValue(p, "input_target_branch", { value: "develop" });
    assert.equal(validateProposal(p), null);
  });
});

describe("repos", () => {
  it("normalizes the clone URL and skips blanks and duplicates", () => {
    const p = proposal();
    assert.equal(addRepo(p, "git@github.com:acme/app"), true);
    assert.deepEqual(p.repos, [{ url: "git@github.com:acme/app.git" }]);
    assert.equal(addRepo(p, "git@github.com:acme/app.git"), false);
    assert.equal(addRepo(p, "   "), false);
    assert.equal(p.repos?.length, 1);
  });

  it("removing the last repo resets the git output mode", () => {
    const p = proposal({ repos: [{ url: "git@github.com:acme/app.git" }], createPR: true });
    removeRepo(p, 0);
    assert.deepEqual(p.repos, []);
    assert.equal(gitModeOf(p), "branch");
  });

  it("ignores out-of-range removals", () => {
    const p = proposal({ repos: [{ url: "a.git" }] });
    removeRepo(p, 5);
    assert.equal(p.repos?.length, 1);
  });
});

describe("applyFieldValue", () => {
  it("stores the free-text fields, trimming and blanking empties", () => {
    const p = proposal();
    applyFieldValue(p, "input_context", { value: "  be careful  " });
    applyFieldValue(p, "input_cron", { value: "0 9 * * 1-5" });
    applyFieldValue(p, "input_max_runs", { value: "3" });
    applyFieldValue(p, "input_target_branch", { value: "develop" });
    assert.equal(p.context, "be careful");
    assert.equal(p.cronExpression, "0 9 * * 1-5");
    assert.equal(p.maxRuns, 3);
    assert.equal(p.targetBranch, "develop");

    applyFieldValue(p, "input_context", { value: "   " });
    assert.equal(p.context, undefined);
    applyFieldValue(p, "input_max_runs", { value: "" });
    assert.equal(p.maxRuns, null, "blank max runs means unlimited");
  });

  it("writes a branch onto the repo identified by the block index", () => {
    const p = proposal({ repos: [{ url: "a.git" }, { url: "b.git" }] });
    applyFieldValue(p, "input_repo_branch", { value: "release" }, 1);
    assert.equal(p.repos?.[0].branch, undefined);
    assert.equal(p.repos?.[1].branch, "release");
  });

  it("merges the date and time pickers into one datetime", () => {
    const p = proposal({ scheduledFor: "2026-01-02T09:05" });
    applyFieldValue(p, "pick_schedule_date", { selected_date: "2026-03-04" });
    assert.equal(p.scheduledFor, "2026-03-04T09:05");
    applyFieldValue(p, "pick_schedule_time", { selected_time: "18:30" });
    assert.equal(p.scheduledFor, "2026-03-04T18:30");
  });

  it("ignores unknown widgets", () => {
    const p = proposal();
    applyFieldValue(p, "select_task_provider", { value: "prov_1" });
    assert.deepEqual(p, proposal());
  });
});

describe("applyFormState", () => {
  it("folds every input in the message back onto the proposal", () => {
    const p = proposal({ repos: [{ url: "a.git" }] });
    applyFormState(p, {
      values: {
        [blockId("context", THREAD)]: { input_context: { value: "watch the tests" } },
        [blockId("cron", THREAD)]: { input_cron: { value: "0 9 * * *" } },
        [blockId("repobranch", THREAD, 0)]: { input_repo_branch: { value: "main" } },
        [blockId("newrepo", THREAD)]: { input_new_repo: { value: "git@github.com:acme/other" } },
      },
    });
    assert.equal(p.context, "watch the tests");
    assert.equal(p.cronExpression, "0 9 * * *");
    assert.equal(p.repos?.[0].branch, "main");
    assert.equal(p.newRepoUrl, "git@github.com:acme/other", "typed-but-unsubmitted repo url is kept");
  });

  it("is a no-op when Slack sends no state", () => {
    const p = proposal({ context: "keep me" });
    applyFormState(p, undefined);
    assert.equal(p.context, "keep me");
  });
});

describe("validateProposal", () => {
  it("accepts a plain run-now task", () => {
    assert.equal(validateProposal(proposal()), null);
  });

  it("requires a cron expression for recurring tasks", () => {
    assert.match(validateProposal(proposal({ isRecurring: true })) ?? "", /cron/i);
    assert.equal(validateProposal(proposal({ isRecurring: true, cronExpression: "0 9 * * *" })), null);
  });

  it("rejects an unparseable scheduled datetime", () => {
    assert.match(validateProposal(proposal({ scheduledFor: "whenever" })) ?? "", /date\/time/i);
    assert.equal(validateProposal(proposal({ scheduledFor: "2026-01-02T09:00" })), null);
  });

  it("requires a real branch name in target-branch mode", () => {
    assert.match(validateProposal(proposal({ targetBranch: "   " })) ?? "", /target branch/i);
    assert.equal(validateProposal(proposal({ targetBranch: "develop" })), null);
  });
});

describe("sanitizeProposal", () => {
  it("drops a datetime the model made up", () => {
    assert.equal(sanitizeProposal(proposal({ scheduledFor: "tomorrow morning" })).scheduledFor, undefined);
  });

  it("keeps a real datetime", () => {
    assert.equal(sanitizeProposal(proposal({ scheduledFor: "2026-01-02T09:00" })).scheduledFor, "2026-01-02T09:00");
  });

  it("drops a one-off datetime on a recurring proposal", () => {
    const p = sanitizeProposal(proposal({ isRecurring: true, cronExpression: "0 9 * * *", scheduledFor: "2026-01-02T09:00" }));
    assert.equal(p.scheduledFor, undefined);
    assert.equal(scheduleModeOf(p), "recurring");
  });
});

describe("summariseProposal", () => {
  it("always states the schedule and repos", () => {
    const text = summariseProposal(proposal());
    assert.match(text, /\*Schedule:\* Run now/);
    assert.match(text, /\*Repos:\* none/);
  });

  it("shows cron, run cap, branches, git output, context and provider", () => {
    const text = summariseProposal(
      proposal({
        isRecurring: true,
        cronExpression: "0 9 * * *",
        maxRuns: 5,
        repos: [{ url: "a.git", branch: "dev" }],
        targetBranch: "release",
        context: "be careful",
      }),
      "Personal · Sonnet",
    );
    assert.match(text, /0 9 \* \* \*/);
    assert.match(text, /max 5 runs/);
    assert.match(text, /a\.git \(branch: `dev`\)/);
    assert.match(text, /Push to `release`/);
    assert.match(text, /be careful/);
    assert.match(text, /Personal · Sonnet/);
  });

  it("truncates a very long context", () => {
    const text = summariseProposal(proposal({ context: "x".repeat(900) }));
    assert.ok(text.length < 900, "context should be clipped");
    assert.match(text, /…/);
  });
});

describe("block builders", () => {
  it("builds an input block that dispatches on Enter", () => {
    const block = textInputBlock({
      id: blockId("context", THREAD),
      actionId: "input_context",
      label: "Context",
      placeholder: "…",
      initial: "hello",
      multiline: true,
    });
    assert.equal(block.type, "input");
    assert.equal(block.dispatch_action, true);
    assert.equal(block.optional, true);
    assert.equal(block.element.action_id, "input_context");
    assert.equal(block.element.initial_value, "hello");
    assert.equal(block.element.multiline, true);
    assert.deepEqual(block.element.dispatch_action_config, { trigger_actions_on: ["on_enter_pressed"] });
  });

  it("omits dispatch config for multi-line fields, where Enter is a newline", () => {
    const block = textInputBlock({
      id: blockId("context", THREAD),
      actionId: "input_context",
      label: "Context",
      placeholder: "…",
      multiline: true,
      dispatch: false,
    });
    assert.equal(block.dispatch_action, undefined);
    assert.equal(block.element.dispatch_action_config, undefined);
  });

  it("clamps option labels to Slack's 75 character limit", () => {
    const long = option("y".repeat(200), "v");
    assert.ok(long.text.text.length <= 75);
    assert.equal(long.value, "v");
    assert.equal(option("short", "v").text.text, "short");
  });
});
