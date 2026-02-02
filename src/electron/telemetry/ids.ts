/**
 * Telemetry ID Management
 *
 * Manages persistent install ID and per-session session ID.
 */

import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Cached install ID */
let installId: string | null = null;

/** Per-launch session ID */
let sessionId: string | null = null;

/**
 * Get the path to the install ID file.
 */
const getInstallIdPath = (): string => {
  return path.join(app.getPath("userData"), "telemetry-install-id");
};

/**
 * Generate a random UUID v4.
 */
const generateUUID = (): string => {
  return crypto.randomUUID();
};

/**
 * Get or create a persistent anonymous install ID.
 * This ID is stored in userData and persists across app launches.
 */
export const getInstallId = (): string => {
  if (installId) {
    return installId;
  }

  const filePath = getInstallIdPath();

  try {
    if (fs.existsSync(filePath)) {
      const stored = fs.readFileSync(filePath, "utf-8").trim();
      if (stored.length > 0) {
        installId = stored;
        return installId;
      }
    }
  } catch (error) {
    console.error("[Telemetry] Error reading install ID:", error);
  }

  // Generate new install ID
  installId = generateUUID();

  try {
    fs.writeFileSync(filePath, installId, "utf-8");
  } catch (error) {
    console.error("[Telemetry] Error writing install ID:", error);
  }

  return installId;
};

/**
 * Get the current session ID.
 * A new session ID is generated for each app launch.
 */
export const getSessionId = (): string => {
  if (!sessionId) {
    sessionId = generateUUID();
  }
  return sessionId;
};

/**
 * Reset the session ID (for testing purposes).
 */
export const resetSessionId = (): void => {
  sessionId = null;
};
