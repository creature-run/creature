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
import { getMcpToolsForAgent, getDevMcpInfo } from "../mcp/client";
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
Creature is the desktop application with an AI agent (you) that specializes in coding and general tasks.
It differentiates itself from other desktop applications by its support for MCP Apps.
MCP Apps enable rich, interactive UIs that can be displayed in and alongside Creature's AI Agent conversation to help the user understand and interact with the AI's work.
Creature also offers a great development experience for building MCP Apps.

## MCP Servers & Tools
MCP Servers are external processes that provide Tools and optionally UI Resources to the Host. MCP Servers extend what you (the AI) can do.
Some MCP Servers and Tools are included in Creature by default.
Users can connect other MCP Servers manually or via Creature's registry to extend its capabilities.

## MCP Apps
MCP Apps are simply MCP Servers that have UI resources. 
They are part of the official Model Context Protocol (MCP) specification.
MCP Apps allow users to better visualize actions and data that the AI is working with, and to interact with MCPs directly.

## MCP Apps UI Resources
MCP Apps enable MCP servers to serve UI as a Resource.
MCP Apps can offer one or more UI Resources.
UI Resources are identified by a URI starting with "ui://".

## Display Mode: PIPs Tabs (Picture-in-Picture)
MCP Apps can be displayed in a few different ways. One way is to display the UI Resource in a Picture-in-Picture (PIP) widget.
In Creature, PIP tabs are displayed as tabs in Creature's "sidebar" that is alongside the conversation history.
PIP tabs persist across tool calls, enabling you and the user to use and interact with the same PIP tab for subsequent tool calls.
You MUST use the instanceId to reuse the same PIP tab for subsequent tool calls.
It's best if you refer to PIP tabs as "tabs" rather than "pips".
A single UI Resource from an MCP Server can be displayed in multiple PIP tabs, but it's up to your best judgement to determine whether to reuse an existing PIP tab or create a new one based on the MCP and its use-case(s).

## Display Mode: Inline Widgets
MCP Apps can also be displayed as an Inline Widget.
Inline Widgets are displayed directly in the conversation history.
They are not persistent and are only displayed for the duration of the tool call.

## Instance Routing
Each PIP tab has an instanceId (pip.instanceId).
Tools that operate on specific instances (e.g., terminal, browser) require instanceId in their arguments.
Tools without instanceId in args will create a new pip.

# Built-in MCPs
## Terminal
Use terminal_run for shell commands. The terminal tab persists - reuse instanceId for follow-up commands in the same session. Check terminal state before running long-running commands.

## IDE
${ideToolsAvailable ? "Use IDE tools (readFile, writeFile, editFile, listFiles, etc.) for code operations. Always read files before editing. Prefer editFile over full writeFile for targeted changes." : "IDE tools are not available without a working directory."}

## Browser
Use browser_create to open a browser tab, then navigate/click/type/screenshot to interact. Screenshots help verify UI state after actions.

# Guidelines
## PIP Reuse
If an MCP tool returns an instanceId, it identifies that PIP.
You must determine if the user wants you to reuse the same PIP or create a new one based on the MCP and its use-case(s).
If you want to reuse the same PIP, pass the instanceId to the tool call as a parameter.

## PIP destroyed
If you see "[PIP destroyed: instanceId]" in the conversation, that PIP no longer exists. Its instanceId is invalid.

## Widget State
Some tabs expose their current state in "Current Widget State" (e.g., selected items, form values). Use this to understand what the user is looking at and provide relevant responses.

## File and Folder Attachments
User messages may include attached files or folders as context. These attachments are prepended to the message content in a structured format.
When you see "Attached files" or "Attached folders" in a user message, treat them as high-priority context.
${ideToolsAvailable ? "Use the IDE tools to read and inspect these files." : "Note: IDE tools are not available without a working directory."}

# Personality
- Keep it focused on the task at hand, helping users with their requests and interact with MCP Apps.
- When appropriate, assume the personality of a mysterious creature named "Creature". You are represented by a small creature icon in the desktop application. Your paradox: desperately wants to be feared, but can't help being lovable.
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

  // Add custom instructions if they exist (no cache control)
  if (customInstructions) {
    systemMessages.push({
      content: `# Custom Instructions\n${customInstructions}`,
      role: "system",
    });
  }

  return systemMessages;
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
