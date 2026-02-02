/**
 * Chat API Server
 *
 * Local HTTP server that handles chat requests from the renderer process.
 * Uses the AI agent to process messages and stream responses.
 *
 * The server is started lazily when a project is opened,
 * not on app startup. A folder is optional - projects can work
 * without a local directory for non-coding use cases.
 */

import http from "node:http";
import { app } from "electron";
import { handleChatRequest, updateActualTokenUsage } from "../agent";
import { getCredentials } from "../ipc/auth.handlers";
import { getMcpServerConfigs } from "../mcp/client";
import * as telemetry from "../telemetry";

const CHAT_SERVER_PORT = 43891;

/** Module-level server instance for lifecycle management */
let chatServerInstance: http.Server | null = null;

/**
 * Create the chat HTTP server.
 */
export const createChatServer = (): http.Server => {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          const { messages, folderPath, customInstructions } = parsed;

          // folderPath is now optional - projects can work without a local directory

          // Get sessionId from header or body, fallback to folderPath-based key
          const sessionId =
            (req.headers["x-session-id"] as string) ||
            parsed.sessionId ||
            `session-${folderPath}`;

          // Get the credentials for API access
          const credentials = getCredentials();
          if (!credentials) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: "No credentials configured" }));
            return;
          }

          // Get MCP count for telemetry
          const mcpConfigs = getMcpServerConfigs();
          const mcpCount = mcpConfigs.length;

          const result = await handleChatRequest({
            messages,
            folderPath: folderPath || null,
            customInstructions: customInstructions || null,
            credentials,
            sessionId,
          });

          // Stream the response using AI SDK's pipeUIMessageStreamToResponse.
          // Include usage metadata for token tracking in the UI.
          result.pipeUIMessageStreamToResponse(res, {
            messageMetadata: ({ part }) => {
              if (part.type === "finish") {
                // Track actual token usage for accurate compaction decisions
                const inputTokens = part.totalUsage?.inputTokens ?? 0;
                if (inputTokens > 0) {
                  updateActualTokenUsage(sessionId, inputTokens);
                }

                // Track successful agent completion
                telemetry.track("agent_completion", {
                  version: app.getVersion(),
                  provider: credentials.type,
                  custom_instructions_set: !!customInstructions,
                  mcp_count: mcpCount,
                  success: true,
                  input_tokens: inputTokens,
                  output_tokens: part.totalUsage?.outputTokens ?? 0,
                });

                return {
                  usage: {
                    promptTokens: inputTokens,
                    completionTokens: part.totalUsage?.outputTokens ?? 0,
                    totalTokens: part.totalUsage?.totalTokens ?? 0,
                  },
                };
              }
              return undefined;
            },
            onError: (error) => {
              console.error("[ChatServer] Stream error:", error);

              // Track failed agent completion (stream error)
              telemetry.track("agent_completion", {
                version: app.getVersion(),
                provider: credentials.type,
                custom_instructions_set: !!customInstructions,
                mcp_count: mcpCount,
                success: false,
                error_name: error instanceof Error ? error.name : "StreamError",
              });

              return error instanceof Error ? error.message : "Stream error";
            },
          });
        } catch (error) {
          console.error("Chat error:", error);

          // Track failed agent completion (server error)
          const mcpConfigs = getMcpServerConfigs();
          telemetry.track("agent_completion", {
            version: app.getVersion(),
            provider: credentials?.type ?? "unknown",
            custom_instructions_set: !!customInstructions,
            mcp_count: mcpConfigs.length,
            success: false,
            error_name: error instanceof Error ? error.name : "ServerError",
          });

          res.writeHead(500);
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return server;
};

/**
 * Start the chat server on the configured port.
 * Handles EADDRINUSE by attempting to kill orphaned processes and retry.
 *
 * This is a no-op if the server is already running, making it safe
 * to call multiple times (e.g., when switching folders).
 */
export const startChatServer = (): http.Server => {
  // Guard: don't start if already running
  if (chatServerInstance) {
    return chatServerInstance;
  }

  const server = createChatServer();

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[ChatServer] Port ${CHAT_SERVER_PORT} is already in use. ` +
          `This usually means a previous instance didn't clean up properly. ` +
          `Kill the process using: lsof -ti :${CHAT_SERVER_PORT} | xargs kill -9`
      );
    } else {
      console.error("[ChatServer] Server error:", err);
    }
  });

  server.listen(CHAT_SERVER_PORT, () => {
    console.log(`[ChatServer] Running on http://localhost:${CHAT_SERVER_PORT}`);
  });

  chatServerInstance = server;
  return server;
};

/**
 * Stop the chat server if it's running.
 * Returns a promise that resolves when the server is fully closed.
 */
export const stopChatServer = (): Promise<void> => {
  return new Promise((resolve) => {
    if (!chatServerInstance) {
      resolve();
      return;
    }

    chatServerInstance.close(() => {
      chatServerInstance = null;
      resolve();
    });
  });
};

/**
 * Get the current chat server instance.
 * Returns null if the server is not running.
 */
export const getChatServer = (): http.Server | null => {
  return chatServerInstance;
};

/**
 * Check if the chat server is currently running.
 */
export const isChatServerRunning = (): boolean => {
  return chatServerInstance !== null;
};

export { CHAT_SERVER_PORT };
