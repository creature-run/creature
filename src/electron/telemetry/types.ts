/**
 * Telemetry Types
 *
 * Type definitions for anonymous product analytics.
 */

/**
 * A single telemetry event.
 */
export interface TelemetryEvent {
  name: string;
  ts: number; // Unix timestamp in milliseconds
  props?: Record<string, unknown>;
}

/**
 * App information sent with telemetry batches.
 */
export interface TelemetryAppInfo {
  version: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
}

/**
 * Batch of events sent to the telemetry API.
 */
export interface TelemetryBatch {
  installId: string;
  sessionId: string;
  app: TelemetryAppInfo;
  events: TelemetryEvent[];
}

/**
 * Stored event in the local queue (includes row ID for deletion).
 */
export interface QueuedEvent {
  id: number;
  name: string;
  ts: number;
  props: string | null; // JSON string
}
