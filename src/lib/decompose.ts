/**
 * Prompt + parsing for "Split into subtasks" (POST /api/tasks/decompose).
 *
 * Kept pure so it can be unit-tested. The bounds below are the single source of
 * truth for both the prompt text and the server-side clamp: an earlier version
 * told the model "never more than 4" in the system prompt but then asked it to
 * "Break this into 2–6 sequential subtasks" in the user message. Faced with that
 * contradiction the model nearly always settled on the overlap's ceiling, so
 * every split came back as exactly four subtasks.
 *
 * There is deliberately no small cap any more: a common use is pasting a whole
 * to-do list (10–20 items) and splitting it into logical groups, which can
 * legitimately need more than four or six subtasks. The prompt never states a
 * number, so the model has nothing to anchor on; MAX_SUBTASKS is only a sanity
 * ceiling against a runaway reply and is not mentioned to the model.
 */

export const MIN_SUBTASKS = 2;
export const MAX_SUBTASKS = 30;

/** Output budget for a split — large enough for a long to-do list's worth of subtasks. */
export const DECOMPOSE_MAX_TOKENS = 8192;

export interface Subtask {
  title: string;
  description: string;
  context: string;
}

export const DECOMPOSE_SYSTEM_PROMPT = `You are a task planning assistant. Given a complex task for an AI coding or automation agent, your job is to decide whether — and how — to split it into sequential subtasks.

**When to split:** Only split when there are genuinely independent phases, each producing a meaningful standalone deliverable. Good examples: implement feature A then feature B; write a module then integrate it; migrate one system then another.

**When NOT to split:** Do NOT create a subtask just to "find", "locate", "explore", or "understand" code before modifying it. An agent locating the authentication component and modifying it is ONE task — discovery and implementation are inseparable. Do not split setup from execution when they are tightly coupled. Do not create separate subtasks just for testing, verification, documentation or cleanup of work another subtask produces — those belong in that subtask. Each subtask must justify its own existence as a complete unit of work.

**Lists of items:** If the task is a list of separate items (for example a pasted to-do list), group related items into logical subtasks — items touching the same area, feature or files belong together; unrelated items get their own subtask. Every item in the list must end up in exactly one subtask; never drop an item. Mention each item the subtask covers in its description.

**How many:** The number of subtasks must follow from the task itself — count the genuinely distinct deliverables (or logical groups of items) and return exactly that many. There is no target count and no fixed upper limit: a small task may need two, a long to-do list may need many. Do not pad with filler subtasks, and do not cram unrelated work together just to keep the count low. If the task is best handled as a single unit of work, return a JSON array with exactly one element describing it.

Each subtask must:
- Be a complete, meaningful unit of work with a clear deliverable
- Include any discovery or exploration steps needed to complete it (do not outsource exploration to a prior task)
- Be runnable without requiring information to be manually passed from a previous run

Return ONLY a valid JSON array. Each element must have exactly these fields:
{
  "title": "short imperative title (4–10 words)",
  "description": "2–4 sentence description of what the agent should do, including any discovery or exploration it needs to perform",
  "context": "2–3 bullet points of constraints, success criteria, or important notes"
}

Do not include any text outside the JSON array. Do not add markdown fences.`;

export function buildDecomposeUserMessage(title: string, description: string, context?: string): string {
  return `Task to decompose:

Title: ${title}

Description:
${description}${context ? `\n\nContext:\n${context}` : ""}

Decide how many sequential subtasks this task genuinely needs (1 if it should not be split; as many as the work calls for otherwise) and return them:`;
}

export function parseSubtasks(raw: string): Subtask[] {
  // Strip optional markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array");
  return (parsed as Array<Record<string, unknown>>)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      title: String(item.title ?? "").trim(),
      description: String(item.description ?? "").trim(),
      context: String(item.context ?? "").trim(),
    }))
    .filter((s) => s.title && s.description)
    // Sanity ceiling only — not a target, and not mentioned in the prompt.
    .slice(0, MAX_SUBTASKS);
}
