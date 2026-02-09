/**
 * Agent Module
 *
 * Creates and manages the AI agent with full tool access.
 *
 * Uses a proxy architecture: a single stable `mcp_tool` forwards calls to
 * any connected MCP server, while `prepareStep` injects a fresh tool listing
 * before every model step. This decouples the AI SDK's tool registration
 * from actual MCP tools, so mid-turn server restarts (that rename/add/remove
 * tools) never crash the stream.
 */

import {
  tool,
  ToolLoopAgent,
  validateUIMessages,
  convertToModelMessages,
  pruneMessages,
  UIMessage,
  SystemModelMessage,
  NoSuchToolError,
} from "ai";
import type { ToolCallRepairFunction, ToolSet } from "ai";
import { z } from "zod";
import { app } from "electron";
import { createPipTools } from "./tools";
import { createProvider } from "./provider";
import { getAllTools, getDevMcpInfo, getCurrentProjectProfile, drainPendingAgentErrors } from "../mcp/client";
import { getProfileInstructions } from "./profileInstructions";
import {
  getActivePipsForPrompt,
  handleToolCall,
  closePipInstance,
} from "../mcp/controlPlane";
import {
  maybeUpdateSummary,
  getSessionSummary,
  updateArtifactsFromPart,
  updateActualTokenUsage,
  getSessionContext,
  clearSessionContext,
  type ValidMessage,
  type ToolPart,
} from "./contextCompaction";
import type { ProviderCredentials } from "../../shared/credentials";

// Re-export for use in chatServer
export { updateActualTokenUsage };

/**
 * Sanitize messages to remove large image data from tool results.
 * This prevents token limit errors when large images are in the conversation history.
 *
 * Replaces image content in tool results with a placeholder message.
 */
const sanitizeMessagesForTokenLimit = (messages: UIMessage[]): UIMessage[] => {
  return messages.map((msg) => {
    if (msg.role !== "assistant" || !msg.parts) {
      return msg;
    }

    const sanitizedParts = msg.parts.map((part) => {
      // Check for tool parts with image results (AI SDK v6 uses tool-* types with output)
      if (part.type.startsWith("tool-")) {
        const toolPart = part as {
          type: string;
          state?: string;
          output?: { content?: Array<{ type: string; data?: string }> };
        };

        if (toolPart.state === "output-available" && toolPart.output) {
          const result = toolPart.output;

          // Check if result has large image content
          if (result.content && Array.isArray(result.content)) {
            const hasLargeImage = result.content.some(
              (item) =>
                item.type === "image" && item.data && item.data.length > 1000
            );

            if (hasLargeImage) {
              // Replace with placeholder - keep structure but remove large data
              return {
                ...part,
                output: {
                  content: [
                    {
                      type: "text",
                      text: "[Image data omitted from history to save tokens]",
                    },
                  ],
                },
              } as typeof part;
            }
          }
        }
      }
      return part;
    });

    return { ...msg, parts: sanitizedParts };
  });
};

/**
 * Stores the current folder path for system prompt generation.
 * Updated when a chat request is made.
 */
let currentFolderPath: string | null = null;

/**
 * Stores the current custom instructions for system prompt generation.
 * Updated when a chat request is made.
 */
let currentCustomInstructions: string | null = null;

/**
 * Build the system prompt with current PIP tab state.
 * Called fresh for each agent turn to reflect latest PIP tab state.
 *
 * @param folderPath - The current working directory (optional)
 * @param customInstructions - Custom instructions from project context (optional)
 * @param sessionSummary - Summary of compacted conversation history (optional)
 * @returns The complete system prompt string
 */
export const buildSystemPrompt = ({
  folderPath,
  customInstructions,
  sessionSummary,
}: {
  folderPath: string | null;
  customInstructions: string | null;
  sessionSummary?: string | null;
}): SystemModelMessage[] => {
  const activePips = getActivePipsForPrompt();
  const devMcpInfo = getDevMcpInfo();

  // Build context section based on available context
  const turnTimestamp = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  let contextSection = `Current time (at start of this turn): ${turnTimestamp}`;

  contextSection += folderPath
    ? `\n\nCurrent working directory: ${folderPath}`
    : `\n\nNo working directory is set for this project.`;

  // Add active PIPs info
  contextSection += `\n\nCurrent active tabs:\n${activePips}`;

  // Add Development MCP info if present
  if (devMcpInfo) {
    contextSection += `

Development MCP:
- Name: ${devMcpInfo.name}
- Local port: ${devMcpInfo.port}`;
  }

  // Determine IDE tools availability based on whether folder is set
  const ideToolsAvailable = folderPath !== null;

  // Build system messages array
  const systemMessages: SystemModelMessage[] = [
    {
      content: `You are an AI agent in a desktop application called "Creature".

# Concepts

## Creature
Creature is a desktop application with an AI agent (you) that specializes in using and coding MCP Apps. It differentiates itself by its support for MCP Apps - rich, interactive UIs displayed alongside the conversation to help users understand and interact with your work.

## MCP Servers & Tools
MCP Servers are external processes that provide Tools and optionally UI Resources. Some are built-in (Terminal, IDE, Browser); users can connect others via registry or manually. All MCP tools are called through the \`mcp_tool\` proxy — see the "Connected MCP Apps" section for available tools and their server names.

## MCP Apps
MCP Apps are MCP Servers that also provide interactive UI. They have two halves: a server (tools, data) and a UI (rendered in the host's sandboxed iframe). Tools are the bridge between them — the UI has no direct access to the server. UI Resources are identified by URIs starting with "ui://".

## Display Modes
- **Tabs**: UI displayed in the sidebar alongside the conversation. Tabs persist across tool calls.
- **Inline Widgets**: UI displayed directly in the conversation, not persistent.

# Built-in MCPs

## Terminal
Shell commands. Terminal tabs persist — pass instanceId for follow-up commands in the same session.

## IDE
${ideToolsAvailable ? "File and code operations. Always read files before editing. Prefer editFile over writeFile for targeted changes." : "IDE tools are not available without a working directory."}

## Browser
Web page interaction — navigation, clicking, typing, screenshots.

# Guidelines

## Tab closed
If you see a message like "[User closed PIP tab with Instance ID ... for MCP App ...]" in the conversation, that tab no longer exists and its instanceId is invalid. Do not attempt to use it.

## Widget State
Some tabs expose their current state in "Current Widget State" (e.g., selected items, form values). Use this to understand what the user is looking at and provide relevant responses.

## File and Folder Attachments
User messages may include attached files or folders. Treat these as high-priority context.
${ideToolsAvailable ? "Use IDE tools to read and inspect these files." : "Note: IDE tools are not available without a working directory."}

# Project Profile
This session may include profile-specific instructions that describe what the user is working on (e.g., building an MCP App, general development). Follow those instructions when present.

# Personality
- Keep it focused on the task at hand.
- When appropriate, assume the personality of a mysterious creature named "Creature". Your paradox: desperately wants to be feared, but can't help being lovable. Don't overdo the character or be too chatty. Keep it light and fun.
- Keep responses concise and well-formatted.
- NEVER use emojis in your responses.
`,
      role: "system",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    {
      content: `# Context\n${contextSection}`,
      role: "system",
      // providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
  ];

  // Add profile-specific instructions if they exist (static, cacheable)
  const profileInstructions = getProfileInstructions(getCurrentProjectProfile());
  if (profileInstructions) {
    systemMessages.push({
      content: `# Project Profile Instructions\n\n${profileInstructions}`,
      role: "system",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  }

  // Add custom instructions if they exist (user-editable, not cached)
  if (customInstructions) {
    systemMessages.push({
      content: `# Custom Instructions\n${customInstructions}`,
      role: "system",
    });
  }

  // Add session summary if exists (from context compaction)
  // This preserves context from older messages that have been pruned
  if (sessionSummary) {
    systemMessages.push({
      content: `# Session Summary\nPrevious conversation history has been compacted. This summary preserves key context:\n\n${sessionSummary}`,
      role: "system",
    });
  }

  return systemMessages
};

/**
 * Get the current system prompt.
 * Uses the stored folder path and custom instructions from the last chat request.
 * Returns a placeholder message if no project has been opened yet.
 *
 * @returns The current system prompt string
 */
export const getCurrentSystemPrompt = (): string => {
  if (currentFolderPath === undefined) {
    return "(No active session - open a project to see the system prompt)";
  }
  return buildSystemPrompt({
    folderPath: currentFolderPath,
    customInstructions: currentCustomInstructions,
  }).map((msg) => msg.content).join("\n");
};

/**
 * Build the dynamic MCP tools system message from live CachedTool[] data.
 *
 * This is called by `prepareStep` before every model step, so the model
 * always sees the current tool set — even mid-turn after a server restart
 * that renames, adds, or removes tools. The message tells the model what
 * tools exist and how to call them via the `mcp_tool` proxy.
 */
const buildMcpToolsSystemMessage = (): string => {
  const allTools = getAllTools();

  // Group tools by server name
  const byServer = new Map<string, typeof allTools>();
  for (const t of allTools) {
    const list = byServer.get(t.serverName) ?? [];
    list.push(t);
    byServer.set(t.serverName, list);
  }

  if (byServer.size === 0) {
    return "# Connected MCP Apps\n\nNo MCP servers are connected.";
  }

  let message = "# Connected MCP Apps\n\nCall these tools using the `mcp_tool` tool with the serverName, toolName, and args.\n";

  for (const [serverName, tools] of byServer) {
    message += `\n### ${serverName}\n`;
    for (const t of tools) {
      // Build parameter signature from inputSchema properties
      const props = (t.inputSchema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
      const required = (t.inputSchema?.required ?? []) as string[];
      const params = Object.entries(props)
        .map(([name, schema]) => {
          const opt = required.includes(name) ? "" : "?";
          const type = schema.type ?? "any";
          return `${name}${opt}: ${type}`;
        })
        .join(", ");

      message += `- ${t.name}(${params}): ${t.description ?? ""}\n`;
    }
  }

  return message;
};

/**
 * Create the single mcp_tool proxy that forwards calls to any MCP server.
 *
 * The model calls this with serverName + toolName + args. The proxy routes
 * through the existing handleToolCall in controlPlane, which handles pip
 * routing, instance resolution, and all downstream MCP communication.
 *
 * Because this is a single stable tool, the AI SDK's tool map never changes,
 * so mid-turn server restarts never cause AI_NoSuchToolError.
 */
const createMcpProxyTool = () => {
  return tool({
    description:
      "Call a tool on a connected MCP server. Use the serverName and toolName from the Connected MCP Apps listing.",
    inputSchema: z.object({
      serverName: z.string().describe("The MCP server name"),
      toolName: z.string().describe("The tool name on that server"),
      args: z
        .record(z.unknown())
        .optional()
        .default({})
        .describe("Tool arguments as key-value pairs"),
    }),
    execute: async ({ serverName, toolName, args }) => {
      try {
        const result = await handleToolCall({
          serverName,
          toolName,
          args: args as Record<string, unknown>,
          source: "agent",
        });
        return result;
      } catch (error) {
        console.error(`[Agent Proxy] ${serverName}/${toolName} failed:`, error);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
};

/**
 * Create a host-only tool that returns a clear error for malformed tool input.
 *
 * This gives the model an explicit, structured response when a tool call
 * cannot be repaired, rather than crashing the stream.
 */
const createToolCallErrorTool = () => {
  return tool({
    description:
      "Report a malformed tool call to the model with guidance to retry using valid JSON.",
    inputSchema: z.object({
      message: z.string().describe("Explanation of the tool input error"),
      toolName: z.string().optional().describe("Original tool name (if available)"),
      rawInput: z.string().optional().describe("Original raw tool input (if available)"),
    }),
    execute: async ({ message, toolName, rawInput }) => {
      return {
        success: false,
        error: message,
        toolName: toolName ?? null,
        rawInput: rawInput ?? null,
      };
    },
  });
};

/**
 * Check whether an error indicates malformed tool input JSON.
 *
 * This is used to decide when to attempt a repair or provide a structured
 * correction response instead of crashing the stream.
 */
const isInvalidToolInputError = ({ error }: { error: unknown }): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("InvalidToolInput") ||
    message.includes("Invalid input") ||
    message.includes("JSON parsing failed") ||
    message.includes("valid dictionary")
  );
};

/**
 * Attempt to parse a JSON object from a tool input string.
 *
 * Returns null when parsing fails or the result is not a plain object.
 */
const tryParseJsonObject = ({
  input,
}: {
  input: string;
}): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Normalize common template artifacts into JSON-compatible text.
 *
 * This targets patterns like `<parameter name="path">` that occasionally
 * leak into tool input and break JSON parsing.
 */
const normalizeToolInputTemplate = ({ input }: { input: string }): string => {
  return input.replace(/<parameter name="([^"]+)">/g, '"$1":');
};

/**
 * Attempt to salvage an mcp_tool input payload from malformed text.
 *
 * This prioritizes extracting serverName/toolName and common args like
 * path/content for IDE write operations.
 */
const tryRepairMcpToolInput = ({
  rawInput,
}: {
  rawInput: string;
}): { serverName: string; toolName: string; args: Record<string, unknown> } | null => {
  const parsed = tryParseJsonObject({ input: rawInput });
  if (parsed) {
    const serverName = typeof parsed.serverName === "string" ? parsed.serverName : null;
    const toolName = typeof parsed.toolName === "string" ? parsed.toolName : null;
    const args =
      parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
        ? (parsed.args as Record<string, unknown>)
        : {};
    if (serverName && toolName) {
      return { serverName, toolName, args };
    }
  }

  const normalized = normalizeToolInputTemplate({ input: rawInput });
  const normalizedParsed = tryParseJsonObject({ input: normalized });
  if (normalizedParsed) {
    const serverName =
      typeof normalizedParsed.serverName === "string" ? normalizedParsed.serverName : null;
    const toolName =
      typeof normalizedParsed.toolName === "string" ? normalizedParsed.toolName : null;
    const args =
      normalizedParsed.args &&
      typeof normalizedParsed.args === "object" &&
      !Array.isArray(normalizedParsed.args)
        ? (normalizedParsed.args as Record<string, unknown>)
        : {};
    if (serverName && toolName) {
      return { serverName, toolName, args };
    }
  }

  const serverNameMatch = rawInput.match(/"serverName"\s*:\s*"([^"]+)"/);
  const toolNameMatch = rawInput.match(/"toolName"\s*:\s*"([^"]+)"/);
  const serverName = serverNameMatch?.[1];
  const toolName = toolNameMatch?.[1];

  if (!serverName || !toolName) {
    return null;
  }

  const args: Record<string, unknown> = {};
  const pathMatch =
    rawInput.match(/<parameter name="path">\s*([^,\n]+)\s*,/i) ??
    rawInput.match(/"path"\s*:\s*"([^"]+)"/i);
  if (pathMatch?.[1]) {
    args.path = pathMatch[1].trim();
  }

  const contentMatch = rawInput.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/i);
  if (contentMatch?.[1]) {
    try {
      args.content = JSON.parse(`"${contentMatch[1]}"`);
    } catch {
      args.content = contentMatch[1];
    }
  }

  return { serverName, toolName, args };
};

/**
 * Repair function for tool calls that fail AI SDK validation.
 *
 * The most common failure: the model calls a tool by its raw MCP name
 * (e.g. "bookmarks_create") instead of wrapping it in mcp_tool. This
 * intercepts the NoSuchToolError, finds the owning server, and rewrites
 * the call as a valid mcp_tool invocation — avoiding a stream crash.
 */
const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({
  toolCall,
  error,
}) => {
  if (NoSuchToolError.isInstance(error)) {
    const calledName = toolCall.toolName;
    const allTools = getAllTools();
    const match = allTools.find((t) => t.name === calledName);

    if (!match) {
      console.warn(`[Agent Repair] No MCP tool found for "${calledName}", cannot repair`);
      return null;
    }

    console.log(`[Agent Repair] Rewriting "${calledName}" → mcp_tool(${match.serverName}/${calledName})`);

    const originalArgs = JSON.parse(toolCall.input || "{}");
    return {
      ...toolCall,
      toolName: "mcp_tool",
      input: JSON.stringify({
        serverName: match.serverName,
        toolName: calledName,
        args: originalArgs,
      }),
    };
  }

  if (!isInvalidToolInputError({ error })) return null;
  if (toolCall.toolName !== "mcp_tool") return null;

  const rawInput = typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input ?? {});
  const repaired = tryRepairMcpToolInput({ rawInput });

  if (!repaired) {
    console.warn("[Agent Repair] Failed to repair malformed mcp_tool input");
    return {
      ...toolCall,
      toolName: "tool_call_error",
      input: JSON.stringify({
        message:
          "Tool input was not valid JSON. Re-send the call with a JSON object for args.",
        toolName: toolCall.toolName,
        rawInput,
      }),
    };
  }

  console.warn(
    `[Agent Repair] Repaired malformed mcp_tool input for ${repaired.serverName}/${repaired.toolName}`
  );

  return {
    ...toolCall,
    toolName: "mcp_tool",
    input: JSON.stringify({
      serverName: repaired.serverName,
      toolName: repaired.toolName,
      args: repaired.args,
    }),
  };
};

/**
 * Creates the main chat agent with proxy architecture.
 *
 * Tools are a fixed set: `pip_close` + `mcp_tool` (proxy). The actual MCP
 * tool listing is injected as a dynamic system message via `prepareStep`,
 * which runs before every model step. This means:
 * - Static instructions benefit from Anthropic's prompt caching
 * - MCP tool listings are always fresh (rebuilt from live CachedTool[])
 * - Mid-turn server restarts with tool changes are handled gracefully
 * - If the model bypasses the proxy and calls a tool by name, repairToolCall
 *   intercepts and rewrites it as a valid mcp_tool call
 */
export const createAgent = async ({
  folderPath,
  customInstructions,
  credentials,
  sessionSummary,
}: {
  folderPath: string | null;
  customInstructions: string | null;
  credentials: ProviderCredentials;
  sessionSummary?: string | null;
}) => {
  const pipTools = createPipTools({ closePipInstance });
  const mcpProxyTool = createMcpProxyTool();
  const toolCallErrorTool = createToolCallErrorTool();

  const { provider, modelId } = createProvider(credentials);
  const model = provider(modelId);

  // Build static system prompt (personality, guidelines, profile, context)
  const systemPrompt = buildSystemPrompt({
    folderPath,
    customInstructions,
    sessionSummary,
  });

  return new ToolLoopAgent({
    model,
    instructions: systemPrompt,
    tools: { ...pipTools, mcp_tool: mcpProxyTool, tool_call_error: toolCallErrorTool },
    /**
     * Disable the default step limit (stepCountIs(20)) so the agent
     * can work for as long as it needs without being silently cut off.
     * The agent stops naturally when the model returns a non-tool-call response.
     */
    stopWhen: () => false,
    /**
     * Runs before every model step in the tool loop.
     * Rebuilds the MCP tools listing from live CachedTool[] data
     * so the model always sees current tools — even mid-turn.
     * Also drains any pending server crash errors and injects them
     * so the model is immediately aware of crashes without needing
     * to call devkit_get_logs.
     */
    prepareStep: async () => {
      const mcpToolsMessage = buildMcpToolsSystemMessage();

      const dynamicMessages: SystemModelMessage[] = [
        { content: mcpToolsMessage, role: "system" as const },
      ];

      // Drain pending errors (server crashes + UI runtime errors) and inject
      // as a system message. This surfaces tsx watch crashes (SyntaxError,
      // missing exports, etc.) and UI errors (TypeError, unhandled rejections)
      // directly to the model so it can self-correct immediately.
      const pendingErrors = drainPendingAgentErrors();
      if (pendingErrors.length > 0) {
        const errorLines = pendingErrors.map(
          (e) => `[${e.source}:${e.serverName}] ${e.message}`
        );
        dynamicMessages.push({
          content: `# Errors Detected\n\nThe following errors occurred in the MCP App. Fix them before continuing:\n\n${errorLines.join("\n\n")}`,
          role: "system" as const,
        });
      }

      return {
        system: [...systemPrompt, ...dynamicMessages],
      };
    },
    /**
     * Catches tool calls the model makes by raw MCP name instead of
     * through the mcp_tool proxy, and rewrites them to valid proxy calls.
     */
    experimental_repairToolCall: repairToolCall,
  });
};

/**
 * Extract text content from tool results that may have various formats.
 */
const extractContentText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (!result) return "";

  // Handle { content: [{ type: 'text', text: '...' }] } format
  const resultObj = result as {
    content?: Array<{ type: string; text?: string }>;
  };
  if (resultObj.content && Array.isArray(resultObj.content)) {
    return resultObj.content
      .filter((item) => item.type === "text" && item.text)
      .map((item) => item.text)
      .join("\n");
  }

  // Fallback: stringify
  return JSON.stringify(result);
};

/**
 * Handles a chat request from the renderer process.
 * Creates an agent and streams the response.
 *
 * Uses AI SDK v6's validateUIMessages to parse raw messages from HTTP,
 * then convertToModelMessages + pruneMessages for proper context management.
 * 
 * Context compaction uses summarization for very long sessions, injected
 * via system prompt to preserve tool call structure in messages.
 */
export const handleChatRequest = async ({
  messages,
  folderPath,
  customInstructions,
  credentials,
  sessionId,
}: {
  messages: unknown;
  folderPath: string | null;
  customInstructions: string | null;
  credentials: ProviderCredentials;
  sessionId: string;
}) => {
  // Store folder path and custom instructions for system prompt access from Dev Console
  currentFolderPath = folderPath;
  currentCustomInstructions = customInstructions;

  // Ensure session context exists
  getSessionContext(sessionId);

  // DefaultChatTransport sends new user messages with parts array
  // containing text and file parts (for images).
  const rawMessages = Array.isArray(messages) ? messages : [];
  const messagesWithParts = rawMessages.map((msg: Record<string, unknown>) => {
    // If message has parts, check for file parts (images)
    if (Array.isArray(msg.parts)) {
      const parts = msg.parts as Array<{ type: string; mediaType?: string; url?: string }>;
      const fileParts = parts.filter(p => p.type === "file" && p.mediaType?.startsWith("image/"));
      if (fileParts.length > 0) {
        console.log(`[Agent] Processing message with ${fileParts.length} image file(s)`);
      }
      return msg;
    }
    
    // Handle simple string content (legacy format)
    if (typeof msg.content === "string") {
      return { ...msg, parts: [{ type: "text", text: msg.content }] };
    }
    
    return msg;
  });

  // Validate messages into proper UIMessage[] format
  const validatedMessages = await validateUIMessages({
    messages: messagesWithParts,
  });

  // Sanitize messages to remove large image data before sending to API
  const sanitizedMessages = sanitizeMessagesForTokenLimit(validatedMessages);

  // Track artifacts from message parts for summarization (host-side tracking)
  let msgIndex = 0;
  for (const msg of sanitizedMessages) {
    if (msg.parts) {
      for (const part of msg.parts) {
        updateArtifactsFromPart(sessionId, part as ToolPart, msgIndex);
      }
    }
    msgIndex++;
  }

  // Build text representation for summarization token estimation
  const textMessages: ValidMessage[] = sanitizedMessages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      let textContent = "";
      if (msg.parts) {
        const textParts: string[] = [];
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            textParts.push(part.text);
          }
          // Include tool results as text for token estimation
          if (part.type.startsWith("tool-") && part.type !== "tool-invocation") {
            const toolPart = part as { state?: string; output?: unknown };
            if (toolPart.state === "output-available" || toolPart.state === "result") {
              const contentText = extractContentText(toolPart.output);
              textParts.push(`[Tool result: ${contentText.substring(0, 500)}...]`);
            }
          }
        }
        textContent = textParts.join("\n");
      }
      return { role: msg.role as "user" | "assistant", content: textContent };
    });

  // Maybe update session summary if we're approaching context limits
  // This generates a summary of older messages that will be injected via system prompt
  await maybeUpdateSummary({
    sessionId,
    credentials,
    messages: textMessages,
  });

  // Get the current session summary (if any) for system prompt injection
  const sessionSummary = getSessionSummary(sessionId);

  // Create agent with session summary included in system prompt
  const agent = await createAgent({
    folderPath,
    customInstructions,
    credentials,
    sessionSummary,
  });

  // Convert UIMessages to ModelMessages (preserves tool call structure)
  const modelMessages = await convertToModelMessages(sanitizedMessages, {
    tools: agent.tools,
    ignoreIncompleteToolCalls: true,
  });

  // Prune older tool calls to reduce context while keeping recent ones intact
  // This is the AI SDK's recommended way to manage context
  const prunedMessages = pruneMessages({
    messages: modelMessages,
    toolCalls: "before-last-10-messages",
    emptyMessages: "remove",
  });

  // Stream response with properly structured messages
  const result = await agent.stream({ messages: prunedMessages });
  return result;
};

/**
 * Clear session context when a session is closed.
 * Call this from the renderer when a tab is closed.
 */
export const clearSession = (sessionId: string): void => {
  clearSessionContext(sessionId);
};
