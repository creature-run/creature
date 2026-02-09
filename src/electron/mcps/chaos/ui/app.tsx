/**
 * Chaos Dashboard UI
 *
 * Test results dashboard for host compliance and failure mode testing.
 * Displays a grid of test cards showing name, description, status, and details.
 *
 * The dashboard receives test results via tool-result notifications from the
 * host. When a UI-side test result arrives, the dashboard triggers the
 * corresponding misbehavior (throw, bad state, etc.) to test host recovery.
 *
 * SDK hooks used:
 * - HostProvider: Provides host client to child components
 * - useHost: Access callTool, isReady, onToolResult, exp_widgetState
 */

import { useEffect, useCallback, useState, useRef } from "react";
import { HostProvider, useHost } from "open-mcp-app/react";
import { TEST_CATALOG, type TestResult, type TestDefinition } from "../lib/types";
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

// =============================================================================
// Types
// =============================================================================

/**
 * Shape of data received from chaos tools in structuredContent.
 */
interface ChaosToolData {
  /** Single test result (from chaos_run) */
  test?: string;
  result?: TestResult;
  /** Trigger for UI-side tests */
  trigger?: "error" | "bad_state" | "rapid_state";
  /** Multiple results (from chaos_run_all or chaos_results) */
  results?: TestResult[];
  /** Test catalog (from chaos_results or chaos_clear) */
  catalog?: TestDefinition[];
  /** Summary stats (from chaos_run_all) */
  summary?: { passed: number; failed: number; errors: number; skipped: number; total: number };
  /** Clear flag (from chaos_clear) */
  cleared?: boolean;
}

// =============================================================================
// Status Badge Component
// =============================================================================

/**
 * Color-coded status badge for test results.
 */
const StatusBadge = ({ status }: { status: TestResult["status"] | "pending" }) => {
  const styles: Record<string, string> = {
    pass: "bg-green-500/15 text-green-400 border-green-500/30",
    fail: "bg-red-500/15 text-red-400 border-red-500/30",
    error: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    skipped: "bg-gray-500/15 text-gray-400 border-gray-500/30",
    pending: "bg-gray-500/10 text-gray-500 border-gray-500/20",
  };

  const labels: Record<string, string> = {
    pass: "PASS",
    fail: "FAIL",
    error: "ERROR",
    skipped: "SKIP",
    pending: "—",
  };

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${styles[status] || styles.pending}`}
    >
      {labels[status] || "—"}
    </span>
  );
};

// =============================================================================
// Test Card Component
// =============================================================================

/**
 * Individual test card displaying name, description, status, and details.
 */
const TestCard = ({
  test,
  result,
  onRun,
}: {
  test: TestDefinition;
  result?: TestResult;
  onRun: ({ id }: { id: string }) => void;
}) => {
  return (
    <div className="flex items-start gap-3 p-2.5 bg-bg-secondary border border-bdr-secondary rounded-md">
      {/* Status + Run button */}
      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <StatusBadge status={result?.status || "pending"} />
        <button
          onClick={() => onRun({ id: test.id })}
          className="text-[10px] text-txt-tertiary hover:text-txt-primary transition-colors"
          title={`Run ${test.id}`}
          type="button"
        >
          run
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-txt-primary truncate">
            {test.name}
          </span>
          <span className="text-[10px] text-txt-tertiary px-1 py-0.5 rounded bg-bg-tertiary shrink-0">
            {test.category}
          </span>
        </div>
        <p className="text-xs text-txt-secondary mt-0.5 leading-relaxed">
          {test.description}
        </p>
        {result && (
          <p className="text-[11px] text-txt-tertiary mt-1 leading-relaxed">
            {result.details}
            {result.durationMs !== undefined && (
              <span className="ml-1 opacity-60">({result.durationMs}ms)</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Summary Bar Component
// =============================================================================

/**
 * Aggregate summary bar showing pass/fail/error/skip counts.
 */
const SummaryBar = ({ results }: { results: Map<string, TestResult> }) => {
  const passed = Array.from(results.values()).filter((r) => r.status === "pass").length;
  const failed = Array.from(results.values()).filter((r) => r.status === "fail").length;
  const errors = Array.from(results.values()).filter((r) => r.status === "error").length;
  const skipped = Array.from(results.values()).filter((r) => r.status === "skipped").length;
  const total = TEST_CATALOG.length;
  const ran = results.size - skipped;

  if (results.size === 0) {
    return (
      <div className="text-xs text-txt-tertiary">
        {total} tests available — run chaos_run_all or click "run" on individual tests
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 text-xs">
      {passed > 0 && <span className="text-green-400">{passed} passed</span>}
      {failed > 0 && <span className="text-red-400">{failed} failed</span>}
      {errors > 0 && <span className="text-amber-400">{errors} errors</span>}
      {skipped > 0 && <span className="text-gray-400">{skipped} skipped</span>}
      <span className="text-txt-tertiary">
        ({ran}/{total} ran)
      </span>
    </div>
  );
};

// =============================================================================
// Dashboard Component
// =============================================================================

/**
 * Main chaos dashboard.
 *
 * Tracks test results from tool-result notifications and displays them
 * in a grid. For UI-side tests, triggers deliberate misbehavior after
 * a short delay to test host error detection and recovery.
 */
function ChaosDashboard() {
  const [results, setResults] = useState<Map<string, TestResult>>(new Map());
  const [shouldThrow, setShouldThrow] = useState(false);
  const hasTriggeredUiTest = useRef<Set<string>>(new Set());

  const { callTool, isReady, onToolResult, exp_widgetState } = useHost();
  const [, setWidgetState] = exp_widgetState();

  const [runTest] = callTool("chaos_run");
  const [runAll] = callTool("chaos_run_all");
  const [getResults] = callTool("chaos_results");
  const [clearResults] = callTool("chaos_clear");

  /**
   * Update results map from incoming data.
   * Handles both single results (chaos_run) and batch results (chaos_run_all).
   */
  const updateResults = useCallback((data: ChaosToolData) => {
    setResults((prev) => {
      const next = new Map(prev);

      // Batch results from chaos_run_all or chaos_results
      if (data.results) {
        for (const r of data.results) {
          next.set(r.id, r);
        }
      }

      // Single result from chaos_run
      if (data.test && data.result) {
        next.set(data.test, data.result);
      }

      // Clear
      if (data.cleared) {
        next.clear();
      }

      return next;
    });
  }, []);

  /**
   * Handle UI-side test triggers.
   *
   * When a UI test result arrives, the dashboard triggers the corresponding
   * misbehavior after a short delay. Each trigger only fires once per session
   * to prevent infinite loops on re-render.
   */
  const handleUiTrigger = useCallback(
    ({ trigger, testId }: { trigger: string; testId: string }) => {
      // Only trigger once per test per session
      if (hasTriggeredUiTest.current.has(testId)) return;
      hasTriggeredUiTest.current.add(testId);

      switch (trigger) {
        case "error":
          // Defer to next render cycle so the result is displayed first
          setTimeout(() => setShouldThrow(true), 500);
          break;

        case "bad_state":
          // Send a non-object value as widget state — host should reject
          setTimeout(() => {
            try {
              setWidgetState(42 as never);
            } catch {
              // Ignore — this is the test
            }
          }, 500);
          break;

        case "rapid_state":
          // Flood 50 state updates in rapid succession
          setTimeout(() => {
            for (let i = 0; i < 50; i++) {
              setWidgetState({ modelContent: { chaos_counter: i } });
            }
          }, 500);
          break;
      }
    },
    [setWidgetState]
  );

  /**
   * Listen for tool-result notifications from the host.
   * Updates dashboard state and triggers UI-side test behaviors.
   */
  useEffect(() => {
    return onToolResult((result) => {
      const data = result.structuredContent as unknown as ChaosToolData | undefined;
      if (!data) return;

      updateResults(data);

      // Trigger UI-side misbehavior if flagged
      if (data.trigger && data.test) {
        handleUiTrigger({ trigger: data.trigger, testId: data.test });
      }
    });
  }, [onToolResult, updateResults, handleUiTrigger]);

  /**
   * Fetch stored results on mount.
   * This populates the dashboard if tests were run before the pip was opened.
   */
  useEffect(() => {
    if (!isReady) return;
    getResults({});
  }, [isReady]);

  /**
   * Run a specific test from the dashboard.
   */
  const handleRunTest = useCallback(
    ({ id }: { id: string }) => {
      runTest({ test: id });
    },
    [runTest]
  );

  // ── UI Error Test: Throw during render ──────────────────────────────────
  if (shouldThrow) {
    throw new Error(
      "Chaos: deliberate UI runtime error for testing host error overlay"
    );
  }

  // ── Loading state ───────────────────────────────────────────────────────
  if (!isReady) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-bg-primary text-txt-primary">
        <div className="w-6 h-6 border-2 border-bdr-secondary border-t-txt-primary rounded-full animate-spin" />
      </div>
    );
  }

  // ── Dashboard ───────────────────────────────────────────────────────────
  const serverTests = TEST_CATALOG.filter((t) => t.category === "server");
  const uiTests = TEST_CATALOG.filter((t) => t.category === "ui");

  return (
    <div className="flex flex-col h-full bg-bg-primary text-txt-primary overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-bdr-secondary">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold">Creature Chaos</h1>
            <p className="text-[11px] text-txt-tertiary mt-0.5">
              Host compliance &amp; failure mode testing
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => clearResults({})}
              className="text-[11px] px-2 py-1 rounded border border-bdr-secondary text-txt-secondary hover:text-txt-primary hover:bg-bg-secondary transition-colors"
              type="button"
            >
              Clear
            </button>
            <button
              onClick={() => runAll({})}
              className="text-[11px] px-2 py-1 rounded border border-bdr-secondary bg-bg-secondary text-txt-primary hover:bg-bg-tertiary transition-colors"
              type="button"
            >
              Run All
            </button>
          </div>
        </div>
        <div className="mt-2">
          <SummaryBar results={results} />
        </div>
      </div>

      {/* Test Grid */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Server-side tests */}
        <section>
          <h2 className="text-[11px] font-medium text-txt-tertiary uppercase tracking-wider mb-2">
            Server-Side Tests
          </h2>
          <div className="space-y-1.5">
            {serverTests.map((test) => (
              <TestCard
                key={test.id}
                test={test}
                result={results.get(test.id)}
                onRun={handleRunTest}
              />
            ))}
          </div>
        </section>

        {/* UI-side tests */}
        <section>
          <h2 className="text-[11px] font-medium text-txt-tertiary uppercase tracking-wider mb-2">
            UI-Side Tests
          </h2>
          <p className="text-[10px] text-txt-tertiary mb-2">
            These trigger UI misbehavior. The pip may need to be refreshed after each test.
          </p>
          <div className="space-y-1.5">
            {uiTests.map((test) => (
              <TestCard
                key={test.id}
                test={test}
                result={results.get(test.id)}
                onRun={handleRunTest}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// =============================================================================
// App Entry
// =============================================================================

/**
 * Wraps ChaosDashboard with HostProvider for MCP Apps communication.
 */
export default function App() {
  return (
    <HostProvider name="chaos" version="0.1.0">
      <ChaosDashboard />
    </HostProvider>
  );
}
