/**
 * Context Compaction Module
 *
 * Implements structured summarization for long-running agent sessions.
 * Based on Factory.ai research findings:
 * - Anchored iterative summarization (only summarize newly-truncated spans)
 * - Structured format with explicit sections (intent, files, decisions, next steps)
 * - Host-side artifact tracking (more reliable than LLM inference)
 *
 * Optimizes for "tokens per task" not "tokens per request"
 */

import { generateText } from "ai";
import { logAggregator } from "../logging";
import { createProvider } from "./provider";
import type { ProviderCredentials } from "../../shared/credentials";

// --- Types ---

export interface ArtifactRecord {
  path: string;
  action: "read" | "modified" | "created" | "deleted" | "unknown";
  lastMessageIndex: number;
  source: "tool" | "user";
}

export interface SessionContext {
  summary: string | null;
  lastSummarizedMessageIndex: number;
  artifactIndex: Map<string, ArtifactRecord>;
  /** Actual input tokens from the last API response (for accurate tracking) */
  lastActualInputTokens: number | null;
}

export interface ValidMessage {
  role: "user" | "assistant";
  content: string;
}

// --- Configuration ---

// Baseline overhead: system prompt (~1k) + tool definitions (~20-25k for MCP tools)
// This is added to message token estimates to approximate full request size
const BASELINE_OVERHEAD_TOKENS = 25_000;

// Trigger compaction when total estimated context (baseline + messages) exceeds this
const TRIGGER_COMPACTION_AT = 150_000;

// After compaction, aim to have messages use this many tokens (before baseline is added)
const TARGET_MESSAGES_AFTER_COMPACTION = 60_000;

// --- Session Management ---

const sessionContexts = new Map<string, SessionContext>();

export const getSessionContext = (sessionId: string): SessionContext => {
  let ctx = sessionContexts.get(sessionId);
  if (!ctx) {
    ctx = {
      summary: null,
      lastSummarizedMessageIndex: 0,
      artifactIndex: new Map(),
      lastActualInputTokens: null,
    };
    sessionContexts.set(sessionId, ctx);
  }
  return ctx;
};

/**
 * Update session with actual token usage from API response.
 * Call this after each API response to track real token consumption.
 * No logging here - we only log when actual compaction occurs.
 */
export const updateActualTokenUsage = (sessionId: string, inputTokens: number): void => {
  const ctx = getSessionContext(sessionId);
  ctx.lastActualInputTokens = inputTokens;
};

export const clearSessionContext = (sessionId: string): void => {
  sessionContexts.delete(sessionId);
};

// --- Token Estimation ---

/**
 * Rough token estimation: ~4 characters per token
 * Good enough for triggering compaction decisions
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const estimateTokensForMessages = (messages: ValidMessage[]): number =>
  messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

// --- Artifact Tracking ---

const FILE_TOOL_NAMES = new Set([
  "readFile",
  "writeFile",
  "deleteFile",
  "createFile",
  "read_file",
  "write_file",
  "delete_file",
  "create_file",
  "editFile",
  "edit_file",
]);

export interface ToolPart {
  type: string;
  toolName?: string;
  input?: unknown;
  toolInvocation?: {
    toolName: string;
    args: unknown;
  };
}

/**
 * Extract artifact information from tool call parts.
 * Host-side tracking is more reliable than LLM inference for file paths.
 */
export const updateArtifactsFromPart = (
  sessionId: string,
  part: ToolPart,
  messageIndex: number
): void => {
  const ctx = getSessionContext(sessionId);

  let toolName: string | undefined;
  let input: unknown;

  if (part.type === "dynamic-tool") {
    toolName = part.toolName;
    input = part.input;
  } else if (part.type.startsWith("tool-") && part.type !== "tool-invocation") {
    toolName = part.type.substring(5);
    input = part.input;
  } else if (part.type === "tool-invocation" && part.toolInvocation) {
    toolName = part.toolInvocation.toolName;
    input = part.toolInvocation.args;
  }

  if (!toolName || !input || typeof input !== "object") return;
  const inputObj = input as Record<string, unknown>;
  if (!FILE_TOOL_NAMES.has(toolName)) return;

  // Look for path in common field names
  const path = (inputObj.path ?? inputObj.filePath ?? inputObj.file_path) as string | undefined;
  if (typeof path !== "string") return;

  const normalizedToolName = toolName.toLowerCase().replace(/_/g, "");
  const action: ArtifactRecord["action"] =
    normalizedToolName.includes("read")
      ? "read"
      : normalizedToolName.includes("write") || normalizedToolName.includes("edit")
        ? "modified"
        : normalizedToolName.includes("create")
          ? "created"
          : normalizedToolName.includes("delete")
            ? "deleted"
            : "unknown";

  ctx.artifactIndex.set(path, {
    path,
    action,
    lastMessageIndex: messageIndex,
    source: "tool",
  });
};

// --- Structured Summarization Prompt ---

const SUMMARIZATION_SYSTEM_PROMPT = `You are a coding-session summarizer for an AI coding agent.

You will be given:
- The existing session summary (may be empty)
- A set of NEW conversation messages that are about to be dropped from the live context
- A machine-generated artifact index (files touched so far)

Your job is to UPDATE the summary IN PLACE, preserving important details and continuity.

Follow this exact structure:

# Session Intent
- Single-sentence description of what the user is trying to achieve overall.
- Update only if the long-term goal clearly changed.

# File & Artifact Activity
- List all important files and artifacts that matter for continuing work.
- For each: path, role, and current status.
- Prefer concise bullet points, e.g.:
  - src/foo.ts (created, implements FooWidget component)
  - api/client.ts (modified, added retry logic to fetchUser)

# Key Decisions & Rationale
- Bulleted list of important design/implementation decisions.
- Include the "why" briefly, including any rejected options only if they could matter later.

# Current Plan / Next Steps
- Short checklist of what remains to be done.
- Keep 3-7 bullets, refresh with latest info from new messages.

# Open Questions / Risks
- Unknowns, blockers, and risky assumptions that might bite later.

# Important Exact Details
- Only include exact strings that must not change (e.g. URL endpoints, API contract shapes, key function names, or tricky regexes).
- Omit generic logging output, errors that are obviously obsolete, etc.

Rules:
- Never remove important files or decisions from the summary unless they are clearly superseded.
- Update or merge entries if later messages changed a file again.
- Optimize for accuracy of file paths, function names, and current state over narrative beauty.
- Keep the summary concise but complete - aim for 500-800 tokens.`;

const buildSummarizationPrompt = ({
  previousSummary,
  newMessages,
  artifactIndex,
}: {
  previousSummary: string | null;
  newMessages: ValidMessage[];
  artifactIndex: Map<string, ArtifactRecord>;
}): string => {
  const previous = previousSummary ?? "(no previous summary; create one)";
  const messagesText = newMessages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const artifactArray = Array.from(artifactIndex.values()).map((a) => ({
    path: a.path,
    action: a.action,
  }));

  return `
Existing summary:
---
${previous}
---

New conversation messages:
---
${messagesText}
---

Current artifact index (machine-readable JSON):
\`\`\`json
${JSON.stringify(artifactArray, null, 2)}
\`\`\`

Now update the summary according to the rules. Output ONLY the updated summary following the exact structure.
`.trim();
};

// --- Summarization Logic ---

/**
 * Get the current session summary for injection into system prompt.
 * Returns null if no summary exists yet.
 */
export const getSessionSummary = (sessionId: string): string | null => {
  const ctx = getSessionContext(sessionId);
  return ctx.summary;
};

/**
 * Maybe update the session summary based on token usage.
 * 
 * This function checks if we're approaching context limits and generates/updates
 * a summary of older messages. The summary is stored in session context and
 * should be injected via system prompt (not by modifying message history).
 * 
 * Uses anchored iterative summarization: only summarizes newly-truncated spans,
 * not the full history, and merges into existing summary.
 */
export const maybeUpdateSummary = async ({
  sessionId,
  credentials,
  messages,
}: {
  sessionId: string;
  credentials: ProviderCredentials;
  messages: ValidMessage[];
}): Promise<{ summarized: boolean }> => {
  const ctx = getSessionContext(sessionId);
  const messageTokens = estimateTokensForMessages(messages);

  // Estimate total context size (messages + baseline overhead for system prompt and tools)
  const totalEstimatedTokens = messageTokens + BASELINE_OVERHEAD_TOKENS;

  // If under threshold, no summarization needed
  if (totalEstimatedTokens < TRIGGER_COMPACTION_AT) {
    return { summarized: false };
  }

  logAggregator.log({
    source: "host",
    level: "info",
    message: `[Context Compaction] Triggered at ~${Math.round(totalEstimatedTokens / 1000)}k tokens (threshold: ${Math.round(TRIGGER_COMPACTION_AT / 1000)}k)`,
  });

  // Determine how many messages to keep in "live window"
  // The rest will be summarized
  let runningTokens = 0;
  let keepFromIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    runningTokens += estimateTokens(messages[i].content);
    if (runningTokens > TARGET_MESSAGES_AFTER_COMPACTION / 2) {
      keepFromIndex = i + 1;
      break;
    }
  }

  // Only summarize the NEW span since last summarization (anchored approach)
  const newSpanStart = ctx.lastSummarizedMessageIndex;
  const newSpanEnd = Math.max(newSpanStart, keepFromIndex);
  const newSpan = messages.slice(newSpanStart, newSpanEnd);

  if (newSpan.length === 0) {
    return { summarized: false };
  }

  logAggregator.log({
    source: "host",
    level: "info",
    message: `[Context Compaction] Summarizing ${newSpan.length} messages (indices ${newSpanStart}-${newSpanEnd})`,
  });

  try {
    const { provider, haikuModelId } = createProvider(credentials);
    const model = provider(haikuModelId);

    const summarizationPrompt = buildSummarizationPrompt({
      previousSummary: ctx.summary,
      newMessages: newSpan,
      artifactIndex: ctx.artifactIndex,
    });

    const { text: updatedSummary } = await generateText({
      model,
      system: SUMMARIZATION_SYSTEM_PROMPT,
      prompt: summarizationPrompt,
      maxOutputTokens: 1500,
    });

    ctx.summary = updatedSummary;
    ctx.lastSummarizedMessageIndex = newSpanEnd;

    logAggregator.log({
      source: "host",
      level: "info",
      message: `[Context Compaction] Summary updated (${estimateTokens(updatedSummary)} tokens)`,
    });

    return { summarized: true };
  } catch (error) {
    logAggregator.log({
      source: "host",
      level: "error",
      message: `[Context Compaction] Summarization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
    return { summarized: false };
  }
};
