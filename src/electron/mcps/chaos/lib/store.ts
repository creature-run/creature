/**
 * Test Results Store
 *
 * In-memory store for chaos test results. Intentionally ephemeral —
 * test results don't persist across server restarts because each
 * test session should start fresh.
 */

import type { TestResult } from "./types.js";

// =============================================================================
// Store
// =============================================================================

/**
 * In-memory map of test ID → most recent result.
 * Shared across all tool invocations within a server session.
 */
const results = new Map<string, TestResult>();

/**
 * Get the result for a specific test.
 */
export const getResult = ({ id }: { id: string }): TestResult | undefined => {
  return results.get(id);
};

/**
 * Store a test result, replacing any previous result for the same test.
 */
export const setResult = ({ result }: { result: TestResult }): void => {
  results.set(result.id, result);
};

/**
 * Get all stored test results.
 */
export const getAllResults = (): TestResult[] => {
  return Array.from(results.values());
};

/**
 * Clear all stored test results.
 */
export const clearAllResults = (): void => {
  results.clear();
};
