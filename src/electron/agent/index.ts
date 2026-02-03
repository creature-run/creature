/**
 * Agent Module
 *
 * Creates and manages the AI agent with full tool access.
 * Tools include pip management and all MCP server tools.
 * File operations are provided by the mcp-ide MCP server.
 */

import {
  ToolLoopAgent,
  wrapLanguageModel,
  validateUIMessages,
  convertToModelMessages,
  UIMessage,
  SystemModelMessage,
} from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { app } from "electron";
import { createPipTools } from "./tools";
import { createProvider, MODEL_IDS } from "./provider";
import { getMcpToolsForAgent, getDevMcpInfo, getCurrentProjectProfile } from "../mcp/client";
import { getProfileInstructions } from "./profileInstructions";
import {
  getActivePipsForPrompt,
  handleToolCall,
  closePipInstance,
} from "../mcp/controlPlane";
import {
  maybeCompactMessages,
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
 * This prevents token limit errors when screenshots are in the conversation history.
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

          // Check if result has image content (like screenshots)
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
                      text: "[Screenshot captured - image data omitted from history to save tokens. The screenshot was displayed in the browser pip.]",
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
 * @returns The complete system prompt string
 */
export const buildSystemPrompt = (
  folderPath: string | null,
  customInstructions: string | null
): SystemModelMessage[] => {
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
  contextSection += `\n\nCurrent active PIP tabs:\n${activePips}`;

  // Add Development MCP info if present
  if (devMcpInfo) {
    contextSection += `

Development MCP:
- Name: ${devMcpInfo.name}
- Local port: ${devMcpInfo.port}
- URL: http://localhost:${devMcpInfo.port}/mcp

Use this port when creating a tunnel for the Development MCP.`;
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
MCP Servers are external processes that provide Tools and optionally UI Resources. Some are built-in; users can connect others via registry or manually.

## MCP Apps
MCP Apps are MCP Servers with UI resources. They allow users to visualize actions/data and interact with MCPs directly. UI Resources are identified by URIs starting with "ui://".

## Display Modes
- **Tabs**: UI displayed in the sidebar alongside the conversation. Tabs persist across tool calls. Refer to them as "tabs" not "pips".
- **Inline Widgets**: UI displayed directly in the conversation, not persistent.

# Built-in MCPs

## Terminal
Use terminal_run for shell commands. Terminal tabs persist - pass instanceId for follow-up commands in the same session.

## IDE
${ideToolsAvailable ? "Use IDE tools (readFile, writeFile, editFile, listFiles, etc.) for code operations. Always read files before editing. Prefer editFile over writeFile for targeted changes." : "IDE tools are not available without a working directory."}

## Browser
Use browser tools (browser_create, browser_navigate, browser_click, browser_type, etc.) to interact with web pages.

# Guidelines

## Tab destroyed
If you see "[PIP destroyed: instanceId]" in the conversation, that tab no longer exists. Its instanceId is invalid.

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
  return buildSystemPrompt(currentFolderPath, currentCustomInstructions).map((msg) => msg.content).join("\n");
};

/**
 * Creates the main chat agent with full tool access.
 * Tools include pip management and all MCP server tools.
 * File operations are provided by the mcp-ide MCP server.
 *
 * Note: The system prompt includes current pip state and is built fresh
 * for each chat request to reflect the latest pip information.
 */
export const createAgent = async ({
  folderPath,
  customInstructions,
  credentials,
}: {
  folderPath: string | null;
  customInstructions: string | null;
  credentials: ProviderCredentials;
}) => {
  const pipTools = createPipTools({ closePipInstance });
  // Pass handleToolCall to route all agent tool calls through Control Plane
  // File tools are now provided by mcp-ide MCP server
  const mcpTools = await getMcpToolsForAgent(handleToolCall);

  const { provider, modelId } = createProvider(credentials);
  const baseModel = provider(modelId);
  // Only use devtools middleware in development (causes /.devtools error in packaged builds)
  const model = app.isPackaged
    ? baseModel
    : wrapLanguageModel({
        model: baseModel,
        middleware: devToolsMiddleware(),
      });

  // Build system prompt with current pip state and custom instructions
  const systemPrompt = buildSystemPrompt(folderPath, customInstructions);

  return new ToolLoopAgent({
    model,
    instructions: systemPrompt,
    // instructions: systemPrompt,
    tools: { ...pipTools, ...mcpTools },
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
 * then convertToModelMessages to convert to ModelMessage[] for ToolLoopAgent.
 *
 * Implements context compaction for long-running sessions using
 * anchored iterative summarization (Factory.ai approach).
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

  const agent = await createAgent({ folderPath, customInstructions, credentials });

  // DefaultChatTransport sends new user messages with parts array
  // containing text and file parts (for images).
  // Log any file parts for debugging purposes.
  const rawMessages = Array.isArray(messages) ? messages : [];
  const messagesWithParts = rawMessages.map((msg: Record<string, unknown>) => {
    // If message has parts, check for file parts (images)
    if (Array.isArray(msg.parts)) {
      const parts = msg.parts as Array<{ type: string; mediaType?: string; url?: string }>;
      const fileParts = parts.filter(p => p.type === "file" && p.mediaType?.startsWith("image/"));
      if (fileParts.length > 0) {
        console.log(`[Agent] Processing message with ${fileParts.length} image file(s)`);
        fileParts.forEach(p => {
          console.log(`[Agent] Image URL: ${p.url?.substring(0, 100)}...`);
        });
      }
      return msg;
    }
    
    // Handle simple string content (legacy format)
    if (typeof msg.content === "string") {
      return { ...msg, parts: [{ type: "text", text: msg.content }] };
    }
    
    return msg;
  });

  // Validate messages into proper UIMessage[] format.
  // Note: Messages with experimental_attachments will be handled after validation
  const validatedMessages = await validateUIMessages({
    messages: messagesWithParts,
  });

  // Sanitize messages to remove large image data (e.g., screenshots) before sending to API.
  // This prevents token limit errors when screenshots are in the conversation history.
  const sanitizedMessages = sanitizeMessagesForTokenLimit(validatedMessages);

  // Track artifacts from message parts for context compaction (host-side tracking)
  let msgIndex = 0;
  for (const msg of sanitizedMessages) {
    if (msg.parts) {
      for (const part of msg.parts) {
        updateArtifactsFromPart(sessionId, part as ToolPart, msgIndex);
      }
    }
    msgIndex++;
  }

  // Build ValidMessage[] for context compaction
  const validMessages: ValidMessage[] = sanitizedMessages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      let textContent = "";
      if (msg.parts) {
        const textParts: string[] = [];
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            textParts.push(part.text);
          }
          // Handle tool-invocation parts with result
          if (part.type === "tool-invocation") {
            const invocation = part as {
              toolInvocation?: {
                state?: string;
                toolName?: string;
                result?: unknown;
              };
            };
            if (
              invocation.toolInvocation?.state === "result" &&
              invocation.toolInvocation.result
            ) {
              const contentText = extractContentText(
                invocation.toolInvocation.result
              );
              textParts.push(
                `[Tool: ${invocation.toolInvocation.toolName}]\nResult: ${contentText}`
              );
            }
          }
          // Handle dynamic-tool parts (UI-initiated tool calls per AI SDK v6)
          if (part.type === "dynamic-tool") {
            const dynamicPart = part as {
              toolName?: string;
              state?: string;
              input?: unknown;
              output?: unknown;
            };
            if (
              dynamicPart.state === "output-available" &&
              dynamicPart.output
            ) {
              const contentText = extractContentText(dynamicPart.output);
              const toolName = dynamicPart.toolName || "unknown";
              textParts.push(
                `[UI Action - ${toolName}]\nArgs: ${JSON.stringify(dynamicPart.input)}\nResult: ${contentText}`
              );
            }
          }
          // Handle tool-* parts (like tool-terminal_run, tool-readFile, etc.)
          if (
            part.type.startsWith("tool-") &&
            part.type !== "tool-invocation"
          ) {
            const toolPart = part as { state?: string; output?: unknown };
            const toolName = part.type.substring(5);
            if (
              (toolPart.state === "output-available" ||
                toolPart.state === "result") &&
              toolPart.output
            ) {
              const contentText = extractContentText(toolPart.output);
              textParts.push(`[Tool: ${toolName}]\nResult: ${contentText}`);
            }
          }
        }
        textContent = textParts.join("\n");
      }
      return { role: msg.role as "user" | "assistant", content: textContent };
    });

  // Apply context compaction if needed (anchored iterative summarization)
  const { compactedMessages, wasCompacted } = await maybeCompactMessages({
    sessionId,
    credentials,
    messages: validMessages,
  });

  if (wasCompacted) {
    // Use compacted messages (simplified format after summarization)
    const result = await agent.stream({ messages: compactedMessages });
    return result;
  } else {
    // Use full model messages (preserves tool call structure)
    const modelMessages = await convertToModelMessages(sanitizedMessages, {
      tools: agent.tools,
      ignoreIncompleteToolCalls: true,
    });
    const result = await agent.stream({ messages: modelMessages });
    return result;
  }
};

/**
 * Clear session context when a session is closed.
 * Call this from the renderer when a tab is closed.
 */
export const clearSession = (sessionId: string): void => {
  clearSessionContext(sessionId);
};
