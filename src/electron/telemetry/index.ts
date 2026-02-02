/**
 * Telemetry Module
 *
 * Anonymous product analytics for the desktop app.
 *
 * Usage:
 *   import { telemetry } from './telemetry';
 *
 *   // Initialize on app ready
 *   telemetry.init();
 *
 *   // Track events
 *   telemetry.track('project_open', { profile: 'coding' });
 *
 *   // Shutdown on app quit
 *   await telemetry.shutdown();
 */

export * from "./client";
export * from "./types";
