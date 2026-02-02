/**
 * Telemetry Client
 *
 * Main telemetry module that provides track() for recording events
 * and handles batching/flushing to the platform API.
 */

import { app } from "electron";
import { getInstallId, getSessionId } from "./ids";
import * as store from "./store";
import type { TelemetryEvent, TelemetryBatch, TelemetryAppInfo } from "./types";

/** Batch size for flushing events */
const BATCH_SIZE = 100;

/** Flush interval in milliseconds */
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

/** Maximum retry delay in milliseconds */
const MAX_RETRY_DELAY_MS = 60_000; // 1 minute

/** Current retry delay (increases with backoff) */
let retryDelay = 1000;

/** Flush interval handle */
let flushIntervalId: ReturnType<typeof setInterval> | null = null;

/** Whether the client is initialized */
let initialized = false;

/** Whether we're currently flushing */
let isFlushing = false;

/**
 * Get the API URL from environment or default.
 */
const getApiUrl = (): string => {
  return process.env.API_URL || "https://api.creature.run";
};

/**
 * Get app information for telemetry.
 */
const getAppInfo = (): TelemetryAppInfo => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  isPackaged: app.isPackaged,
});

/**
 * Track a telemetry event.
 * Events are queued locally and flushed periodically.
 *
 * @param name - Event name (e.g., "app_start", "project_open")
 * @param props - Optional event properties (no file paths!)
 */
export const track = (name: string, props?: Record<string, unknown>): void => {
  if (!initialized) {
    console.warn("[Telemetry] Client not initialized, dropping event:", name);
    return;
  }

  const ts = Date.now();

  try {
    store.enqueue(name, ts, props);
  } catch (error) {
    console.error("[Telemetry] Failed to enqueue event:", error);
  }
};

/**
 * Flush queued events to the platform API.
 * Uses batching and handles network errors with backoff.
 */
export const flush = async (): Promise<void> => {
  if (isFlushing) {
    return; // Already flushing
  }

  isFlushing = true;

  try {
    const events = store.peek(BATCH_SIZE);
    if (events.length === 0) {
      return;
    }

    const batch: TelemetryBatch = {
      installId: getInstallId(),
      sessionId: getSessionId(),
      app: getAppInfo(),
      events: events.map((e) => ({
        name: e.name,
        ts: e.ts,
        props: e.props ? JSON.parse(e.props) : undefined,
      })),
    };

    const apiUrl = getApiUrl();
    const endpoint = `${apiUrl}/core/v1/telemetry/events`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batch),
    });

    if (response.ok) {
      // Successfully sent - remove from queue
      const ids = events.map((e) => e.id);
      store.remove(ids);

      // Reset retry delay on success
      retryDelay = 1000;

      // If there are more events, flush again
      const remaining = store.size();
      if (remaining > 0) {
        // Schedule immediate follow-up flush
        setImmediate(() => flush());
      }
    } else {
      console.error(
        "[Telemetry] Failed to send events:",
        response.status,
        response.statusText
      );
      // Increase retry delay with exponential backoff
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  } catch (error) {
    // Network error - events stay in queue for retry
    console.error("[Telemetry] Network error:", error);
    // Increase retry delay with exponential backoff
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
  } finally {
    isFlushing = false;
  }
};

/**
 * Initialize the telemetry client.
 * Starts the periodic flush interval.
 */
export const init = (): void => {
  if (initialized) {
    return;
  }

  initialized = true;

  // Start periodic flush
  flushIntervalId = setInterval(() => {
    flush().catch((error) => {
      console.error("[Telemetry] Periodic flush failed:", error);
    });
  }, FLUSH_INTERVAL_MS);

  console.log("[Telemetry] Client initialized");

  // Track app start
  track("app_start");
};

/**
 * Shutdown the telemetry client.
 * Flushes remaining events and closes the database.
 */
export const shutdown = async (): Promise<void> => {
  if (!initialized) {
    return;
  }

  // Stop periodic flush
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  // Track app quit
  track("app_quit");

  // Final flush attempt (with short timeout)
  try {
    await Promise.race([
      flush(),
      new Promise((resolve) => setTimeout(resolve, 3000)), // 3 second timeout
    ]);
  } catch (error) {
    console.error("[Telemetry] Final flush failed:", error);
  }

  // Close the database
  store.close();

  initialized = false;
  console.log("[Telemetry] Client shutdown complete");
};

/**
 * Check if the telemetry client is initialized.
 */
export const isInitialized = (): boolean => initialized;
