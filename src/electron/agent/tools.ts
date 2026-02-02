/**
 * Agent Tools
 *
 * Provides tools that the AI agent can use:
 * - Pip management (close pips and clean up resources)
 *
 * Note: File/code operations are handled by the mcp-ide MCP App.
 */

import { tool } from "ai";
import { z } from "zod";
import { logAggregator } from "../logging";

/**
 * Log a tool call to the Dev Console.
 * Logs both input and output for debugging.
 */
const logToolCall = async <T>(
  toolName: string,
  args: Record<string, unknown>,
  execute: () => Promise<T>
): Promise<T> => {
  // Log input
  logAggregator.log({
    source: "host",
    level: "info",
    message: `[Tool Call] ${toolName} Input: ${JSON.stringify(args)}`,
  });

  const result = await execute();

  // Log output
  logAggregator.log({
    source: "host",
    level: "info",
    message: `[Tool Result] ${toolName} Output: ${JSON.stringify(result)}`,
  });

  return result;
};

/**
 * Create pip management tools.
 *
 * These tools allow the agent to manage Pips:
 * - Close pips and clean up their underlying resources
 *
 * Per MCP Apps spec, the Host (Control Plane) manages pip lifecycle.
 * This tool provides the agent with explicit control over pip closure.
 */
export const createPipTools = ({
  closePipInstance,
}: {
  closePipInstance: (instanceId: string) => Promise<boolean>;
}) => {
  return {
    pip_close: tool({
      description: `Close a pip and clean up its resources. Use this when:
- You're done using a pip
- After stopping a process in a terminal pip
- When the user asks to close a pip
The pip will be removed from the sidebar and its resources cleaned up.`,
      inputSchema: z.object({
        instanceId: z
          .string()
          .describe("The instance ID to close (e.g., pip_123456_abc123)"),
      }),
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' }
        }
      },
      execute: async (args) => {
        return logToolCall("pip_close", args, async () => {
          const { instanceId } = args;
          try {
            const success = await closePipInstance(instanceId);
            if (success) {
              return {
                success: true,
                message: `Closed pip ${instanceId}`,
              };
            } else {
              return {
                success: false,
                error: `Pip not found: ${instanceId}`,
              };
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
            };
          }
        });
      },
    }),
  };
};
