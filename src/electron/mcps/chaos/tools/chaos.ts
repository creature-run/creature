/**
 * Chaos Tools
 *
 * Test tools that deliberately trigger failure modes to verify host resilience.
 * Each test exercises a specific edge case in the MCP Apps protocol, proxy
 * layer, control plane, or SDK.
 *
 * Tools:
 * - chaos_run { test }:  Run a specific test by ID
 * - chaos_run_all:       Run all server-side tests and return summary
 * - chaos_results:       Open/refresh the test results dashboard
 * - chaos_clear:         Clear all stored test results
 *
 * Tests are split into two categories:
 * - Server-side: The tool handler itself misbehaves (throws, times out, etc.)
 * - UI-side: The tool returns normally but signals the UI to misbehave
 */

import { z } from "zod";
import type { App } from "open-mcp-app/server";
import {
  CHAOS_UI_URI,
  TEST_CATALOG,
  type TestResult,
  type ToolResult,
} from "../lib/types.js";
import {
  setResult,
  getAllResults,
  clearAllResults,
} from "../lib/store.js";

// =============================================================================
// Input Schemas
// =============================================================================

const ChaosRunSchema = z.object({
  test: z
    .enum([
      "happy",
      "throw",
      "slow",
      "huge",
      "error_flag",
      "no_data",
      "ui_error",
      "ui_bad_state",
      "ui_rapid_state",
    ])
    .describe("ID of the chaos test to run"),
});

const ChaosRunAllSchema = z.object({});

const ChaosResultsSchema = z.object({});

const ChaosClearSchema = z.object({});

// =============================================================================
// Test Execution
// =============================================================================

/**
 * Result of executing a single test.
 * Separates the test outcome (TestResult) from the tool behavior
 * (whether to throw, omit data, set error flag, etc.)
 */
interface TestExecution {
  /** The test result to store */
  result: TestResult;
  /** Extra data to include in structuredContent */
  extraData?: Record<string, unknown>;
  /** If set, the tool handler throws this error after storing the result */
  shouldThrow?: Error;
  /** If true, the tool result has isError: true */
  isError?: boolean;
  /** If true, the tool returns text-only (no structured data) */
  noData?: boolean;
}

/**
 * Sleep utility for delay-based tests.
 */
const sleep = ({ ms }: { ms: number }): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute a chaos test and return its outcome.
 *
 * Each test returns a TestExecution that describes:
 * 1. The TestResult to store (pass/fail/error)
 * 2. How the tool handler should behave (throw, return error, etc.)
 *
 * This separation allows chaos_run_all to aggregate results without
 * actually triggering the failure behaviors.
 */
const executeTest = async ({ id }: { id: string }): Promise<TestExecution> => {
  const timestamp = new Date().toISOString();

  switch (id) {
    // ── Server-side tests ──────────────────────────────────────────────────

    case "happy":
      return {
        result: {
          id,
          status: "pass",
          details: "Normal structuredContent and text returned",
          timestamp,
        },
        extraData: {
          message: "Everything works correctly",
          items: [1, 2, 3],
        },
      };

    case "throw":
      return {
        result: {
          id,
          status: "pass",
          details: "Handler threw Error — host should return error to agent without crashing",
          timestamp,
        },
        shouldThrow: new Error(
          "Chaos: deliberate error to test host error handling"
        ),
      };

    case "slow":
      await sleep({ ms: 15000 });
      return {
        result: {
          id,
          status: "pass",
          details: "Responded after 15 second delay",
          timestamp,
        },
        extraData: { delayMs: 15000 },
      };

    case "huge": {
      const payload = "x".repeat(500_000);
      return {
        result: {
          id,
          status: "pass",
          details: `Returned ~${Math.round(payload.length / 1024)}KB payload in structuredContent`,
          timestamp,
        },
        extraData: { payload, sizeBytes: payload.length },
      };
    }

    case "error_flag":
      return {
        result: {
          id,
          status: "pass",
          details: "Returned result with isError: true flag",
          timestamp,
        },
        extraData: { errorMessage: "This is a deliberate error result" },
        isError: true,
      };

    case "no_data":
      return {
        result: {
          id,
          status: "pass",
          details: "Returned text-only with no structured data",
          timestamp,
        },
        noData: true,
      };

    // ── UI-side tests ──────────────────────────────────────────────────────
    // These return normally — the UI reads the trigger field and misbehaves.

    case "ui_error":
      return {
        result: {
          id,
          status: "pass",
          details:
            "UI should throw a runtime error — host should show error overlay",
          timestamp,
        },
        extraData: { trigger: "error" },
      };

    case "ui_bad_state":
      return {
        result: {
          id,
          status: "pass",
          details:
            "UI should send malformed widget state — host should reject gracefully",
          timestamp,
        },
        extraData: { trigger: "bad_state" },
      };

    case "ui_rapid_state":
      return {
        result: {
          id,
          status: "pass",
          details:
            "UI should send 50 rapid widget state updates — host should handle without degradation",
          timestamp,
        },
        extraData: { trigger: "rapid_state" },
      };

    default:
      return {
        result: {
          id,
          status: "error",
          details: `Unknown test ID: "${id}"`,
          timestamp,
        },
      };
  }
};

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * Run a single chaos test.
 *
 * Executes the test, stores the result, and returns the tool response.
 * For tests with shouldThrow, the result is stored BEFORE the throw
 * so the dashboard can display what happened.
 */
const handleRun = async ({
  test,
}: {
  test: string;
}): Promise<ToolResult> => {
  const start = Date.now();
  const execution = await executeTest({ id: test });
  execution.result.durationMs = Date.now() - start;

  // Store result before any throw so the dashboard can show it
  setResult({ result: execution.result });

  // Tests that should throw — SDK catches this and returns isError to agent
  if (execution.shouldThrow) {
    throw execution.shouldThrow;
  }

  // No-data tests return text-only (no structuredContent)
  if (execution.noData) {
    return {
      text: `Chaos test "${test}": ${execution.result.details}`,
    };
  }

  return {
    data: {
      test,
      result: execution.result,
      ...(execution.extraData || {}),
    },
    text: `Chaos test "${test}": ${execution.result.status} — ${execution.result.details}`,
    ...(execution.isError && { isError: true }),
  };
};

/**
 * Run all server-side tests and return an aggregate summary.
 *
 * Skips slow tests (run individually) and UI tests (require a live iframe).
 * Catches all errors so the suite always completes.
 */
const handleRunAll = async (): Promise<ToolResult> => {
  const results: TestResult[] = [];

  for (const test of TEST_CATALOG) {
    // Skip slow tests in batch mode
    if (test.id === "slow") {
      const skipped: TestResult = {
        id: test.id,
        status: "skipped",
        details: "Skipped in batch mode — run individually to test",
        timestamp: new Date().toISOString(),
      };
      setResult({ result: skipped });
      results.push(skipped);
      continue;
    }

    // Skip UI tests in batch mode (they need a live iframe)
    if (test.category === "ui") {
      const skipped: TestResult = {
        id: test.id,
        status: "skipped",
        details: "UI tests must be run individually",
        timestamp: new Date().toISOString(),
      };
      setResult({ result: skipped });
      results.push(skipped);
      continue;
    }

    // Execute the test
    const start = Date.now();
    try {
      const execution = await executeTest({ id: test.id });
      execution.result.durationMs = Date.now() - start;
      setResult({ result: execution.result });
      results.push(execution.result);
    } catch (e) {
      const durationMs = Date.now() - start;
      // For "throw" test, error is expected — result was stored before throw
      const existing = getAllResults().find((r) => r.id === test.id);
      if (existing) {
        existing.durationMs = durationMs;
        results.push(existing);
      } else {
        const errorResult: TestResult = {
          id: test.id,
          status: "error",
          details: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
          timestamp: new Date().toISOString(),
          durationMs,
          error: e instanceof Error ? e.message : String(e),
        };
        setResult({ result: errorResult });
        results.push(errorResult);
      }
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return {
    data: { results, summary: { passed, failed, errors, skipped, total: results.length } },
    text: `Chaos suite complete: ${passed} passed, ${failed} failed, ${errors} errors, ${skipped} skipped (${results.length} total)`,
    title: `Chaos (${passed}/${results.length - skipped})`,
  };
};

/**
 * Get all stored test results for the dashboard.
 */
const handleResults = async (): Promise<ToolResult> => {
  const results = getAllResults();
  const catalog = TEST_CATALOG;

  return {
    data: { results, catalog },
    text: results.length > 0
      ? `${results.length} test results stored`
      : "No tests run yet. Use chaos_run or chaos_run_all to run tests.",
    title: "Chaos Dashboard",
  };
};

/**
 * Clear all stored test results.
 */
const handleClear = async (): Promise<ToolResult> => {
  clearAllResults();
  return {
    data: { cleared: true, catalog: TEST_CATALOG },
    text: "All test results cleared",
    title: "Chaos Dashboard",
  };
};

// =============================================================================
// Registration
// =============================================================================

/**
 * Register all chaos tools on the app.
 *
 * Tools are designed to be called by the AI agent to exercise
 * failure modes in the host/proxy/SDK stack.
 */
export const registerChaosTools = (app: App) => {
  app.tool(
    "chaos_run",
    {
      description:
        "Run a specific chaos test to exercise a failure mode in the host. Each test targets a specific edge case.",
      ui: CHAOS_UI_URI,
      input: ChaosRunSchema,
    },
    async (input) => handleRun({ test: input.test })
  );

  app.tool(
    "chaos_run_all",
    {
      description:
        "Run all server-side chaos tests and return an aggregate summary. Skips slow and UI-only tests.",
      ui: CHAOS_UI_URI,
      input: ChaosRunAllSchema,
    },
    async () => handleRunAll()
  );

  app.tool(
    "chaos_results",
    {
      description: "Open the chaos test results dashboard and view stored results",
      ui: CHAOS_UI_URI,
      input: ChaosResultsSchema,
    },
    async () => handleResults()
  );

  app.tool(
    "chaos_clear",
    {
      description: "Clear all stored chaos test results",
      ui: CHAOS_UI_URI,
      input: ChaosClearSchema,
    },
    async () => handleClear()
  );
};
