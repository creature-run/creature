/**
 * Type Definitions
 *
 * All shared types for the Chaos MCP.
 * Defines the test catalog and result shapes for host compliance testing.
 */

// =============================================================================
// Constants
// =============================================================================

export const MCP_NAME = "chaos";
export const CHAOS_UI_URI = `ui://${MCP_NAME}/dashboard`;

// =============================================================================
// Test Definitions
// =============================================================================

/**
 * Categories of chaos tests.
 * - server: The tool handler itself misbehaves (throws, times out, returns bad data)
 * - ui: The tool returns normally but the UI misbehaves after receiving the result
 */
export type TestCategory = "server" | "ui";

/**
 * Static definition for a chaos test.
 * Each test exercises a specific failure mode to verify host resilience.
 */
export interface TestDefinition {
  id: string;
  name: string;
  description: string;
  category: TestCategory;
}

/**
 * Result of running a single chaos test.
 */
export interface TestResult {
  id: string;
  status: "pass" | "fail" | "error" | "skipped";
  timestamp: string;
  durationMs?: number;
  details: string;
  error?: string;
}

/**
 * Master catalog of all chaos tests.
 *
 * Server-side tests: The tool handler deliberately misbehaves to test whether
 * the host proxy, control plane, and SDK handle the failure gracefully.
 *
 * UI-side tests: The tool returns normally, but the UI deliberately misbehaves
 * after receiving the result to test the host's error detection and recovery.
 */
export const TEST_CATALOG: TestDefinition[] = [
  // ── Server-side tests ──────────────────────────────────────────────────────
  {
    id: "happy",
    name: "Happy Path",
    description: "Normal tool result with data and text (control test)",
    category: "server",
  },
  {
    id: "throw",
    name: "Throw Error",
    description: "Tool handler throws an uncaught Error",
    category: "server",
  },
  {
    id: "slow",
    name: "Slow Response",
    description: "Tool takes 15 seconds to respond",
    category: "server",
  },
  {
    id: "huge",
    name: "Huge Payload",
    description: "Returns ~500KB of structured data",
    category: "server",
  },
  {
    id: "error_flag",
    name: "Error Flag",
    description: "Returns a result with isError: true",
    category: "server",
  },
  {
    id: "no_data",
    name: "No Data",
    description: "Returns text-only with no structured data",
    category: "server",
  },

  // ── UI-side tests ──────────────────────────────────────────────────────────
  {
    id: "ui_error",
    name: "UI Runtime Error",
    description: "UI throws an uncaught error during render",
    category: "ui",
  },
  {
    id: "ui_bad_state",
    name: "UI Bad State",
    description: "UI sends malformed widget state to the host",
    category: "ui",
  },
  {
    id: "ui_rapid_state",
    name: "UI Rapid State",
    description: "UI sends 50 rapid widget state updates",
    category: "ui",
  },
];

// Re-export SDK types for tool handlers
export type { ToolContext, ToolResult } from "open-mcp-app/server";
