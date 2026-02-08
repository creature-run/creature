/**
 * MCP Process Registry
 *
 * Disk-persisted registry of all processes spawned by Creature. Acts as the
 * safety net for orphan cleanup — if the app crashes before graceful shutdown,
 * the next launch reads this registry and kills anything still running.
 *
 * Every spawned MCP process (dev and non-dev) is registered here with full
 * metadata so we can:
 *   1. Verify ownership via command-line signature matching (never kill non-Creature processes)
 *   2. Kill the entire process group (not just the shell) to avoid orphaned grandchildren
 *   3. Cross-reference with portManager to reclaim ports held by orphans
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { exec, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export type McpProcessKind = "dev-mcp" | "local-http";

export interface McpProcessRecord {
  pid: number;
  serverName: string;
  command: string;
  args: string[];
  cwd?: string;
  ports?: {
    mcp?: number;
    hmr?: number;
  };
  createdAt: string;
  runId: string;
  kind: McpProcessKind;
}

const CURRENT_RUN_ID = randomUUID();
const REGISTRY_FILENAME = "mcp-processes.json";

/**
 * Grace period (ms) between SIGTERM and SIGKILL escalation.
 * Gives processes a chance to shut down cleanly before force-killing.
 */
const SIGKILL_GRACE_MS = 500;

const getRegistryPath = (): string => {
  return path.join(app.getPath("userData"), REGISTRY_FILENAME);
};

/**
 * Read all process records from the disk-persisted registry.
 * Returns an empty array if the file doesn't exist or is corrupted.
 */
const readRegistry = (): McpProcessRecord[] => {
  try {
    const registryPath = getRegistryPath();
    if (!fs.existsSync(registryPath)) return [];
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as McpProcessRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[ProcessRegistry] Failed to read registry:", error);
    return [];
  }
};

/**
 * Write process records to disk, replacing the entire registry.
 */
const writeRegistry = (records: McpProcessRecord[]): void => {
  try {
    const registryPath = getRegistryPath();
    fs.writeFileSync(registryPath, JSON.stringify(records, null, 2), "utf8");
  } catch (error) {
    console.error("[ProcessRegistry] Failed to write registry:", error);
  }
};

/**
 * Check whether a process with the given PID is still alive.
 * Uses signal 0 which doesn't actually send a signal but checks for existence.
 */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Retrieve the full command line of a running process by PID.
 * Used for signature matching to verify a PID still belongs to Creature.
 */
const getProcessCommandLine = ({ pid }: { pid: number }): string | null => {
  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8" }
      );
      return result.status === 0 ? result.stdout.trim() : null;
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
};

/**
 * Find all descendant PIDs of a given parent PID on Unix.
 * Walks the process tree recursively via `pgrep -P` so we can kill
 * grandchildren (vite, tsx, esbuild) that may have escaped the process group.
 */
const getDescendantPids = ({ pid }: { pid: number }): number[] => {
  if (process.platform === "win32") return [];

  const descendants: number[] = [];
  const queue = [pid];

  while (queue.length > 0) {
    const parentPid = queue.shift()!;
    try {
      const result = spawnSync("pgrep", ["-P", String(parentPid)], {
        encoding: "utf8",
      });
      if (result.status === 0 && result.stdout.trim()) {
        const childPids = result.stdout.trim().split("\n").map(Number).filter(Boolean);
        descendants.push(...childPids);
        queue.push(...childPids);
      }
    } catch {
      // pgrep not available or failed — skip
    }
  }

  return descendants;
};

/**
 * Verify that a running process still matches the command signature we recorded.
 * Prevents us from killing a process whose PID was recycled by the OS for
 * something unrelated to Creature.
 */
const matchesSignature = ({ record }: { record: McpProcessRecord }): boolean => {
  const cmdline = getProcessCommandLine({ pid: record.pid });
  if (!cmdline) return false;

  const baseCommand = path.basename(record.command);
  const commandMatch =
    (record.command && cmdline.includes(record.command)) ||
    (baseCommand && cmdline.includes(baseCommand));

  const argsMatch = record.args?.length
    ? record.args.some((arg) => arg && cmdline.includes(arg))
    : true;

  return commandMatch && argsMatch;
};

/**
 * Kill a process and its entire tree. Used for orphan cleanup where we
 * don't have a ChildProcess handle — only a PID from the registry.
 *
 * Strategy:
 *   1. Try process group kill via negative PID (works if the group leader is alive)
 *   2. Discover and kill descendants individually via pgrep (catches escapees)
 *   3. Escalate to SIGKILL after a grace period
 *
 * On Windows, uses `taskkill /T /F` which handles tree kill natively.
 */
const terminateProcessTree = ({ pid }: { pid: number }): Promise<void> => {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      exec(`taskkill /pid ${pid} /T /F`, () => resolve());
    });
  }

  return new Promise((resolve) => {
    // Collect descendants before killing the parent, since pgrep won't
    // find children after the parent is gone
    const descendants = getDescendantPids({ pid });

    // Try process group kill first (kills the group leader + all members)
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Group may not exist — fall through to individual kills
    }

    // Also SIGTERM each descendant individually in case they escaped the group
    for (const childPid of descendants) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch {
        // Already gone
      }
    }

    // Escalate to SIGKILL after grace period
    setTimeout(() => {
      // Kill group
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone
      }

      // Kill any remaining descendants
      for (const childPid of descendants) {
        try {
          if (isProcessAlive(childPid)) {
            process.kill(childPid, "SIGKILL");
          }
        } catch {
          // Already gone
        }
      }

      resolve();
    }, SIGKILL_GRACE_MS);
  });
};

/**
 * Register a spawned process in the disk-persisted registry.
 * Replaces any existing record with the same PID (handles PID reuse).
 */
export const registerMcpProcess = (input: Omit<McpProcessRecord, "createdAt" | "runId">): void => {
  if (!input.pid) return;
  const records = readRegistry().filter((record) => record.pid !== input.pid);
  records.push({
    ...input,
    createdAt: new Date().toISOString(),
    runId: CURRENT_RUN_ID,
  });
  writeRegistry(records);
  console.debug(`[ProcessRegistry] Registered PID ${input.pid} (${input.serverName}, ${input.kind})`);
};

/**
 * Remove a process from the registry when it exits normally.
 * Accepts either PID or serverName to handle both precise and broad cleanup.
 *
 * Idempotent: silently no-ops if the PID/serverName is already gone,
 * which happens because both closeConnection and proc.on("exit")
 * call this for the same process.
 */
export const unregisterMcpProcess = ({
  pid,
  serverName,
}: {
  pid?: number;
  serverName?: string;
}): void => {
  const existing = readRegistry();
  const filtered = existing.filter((record) => {
    if (pid && record.pid === pid) return false;
    if (serverName && record.serverName === serverName) return false;
    return true;
  });

  const removedCount = existing.length - filtered.length;
  if (removedCount === 0) return;

  writeRegistry(filtered);
  if (pid) console.debug(`[ProcessRegistry] Unregistered PID ${pid}`);
};

/**
 * Find an orphan registry record that owns a specific port.
 *
 * Used by portManager to determine if a busy port belongs to a Creature orphan
 * (safe to kill) vs an unrelated user process (must skip).
 *
 * Only returns records from prior runs (different runId). Current-run records
 * are excluded because those processes are actively managed by the connection
 * map and should never be killed by the port reclaim logic.
 */
export const findOrphanRecordByPort = ({ port }: { port: number }): McpProcessRecord | undefined => {
  const records = readRegistry();
  return records.find(
    (r) =>
      r.runId !== CURRENT_RUN_ID &&
      (r.ports?.mcp === port || r.ports?.hmr === port)
  );
};

/**
 * Clean up orphaned processes from previous Creature runs.
 *
 * Called on app startup before allocating ports. Identifies processes from
 * prior runs (different runId), verifies they're still Creature processes
 * via signature matching, and kills the entire process tree.
 *
 * Safety: never kills processes from the current run, and never kills
 * processes whose command line doesn't match the recorded signature
 * (protects against PID reuse by unrelated processes).
 */
export const cleanupOrphanedMcpProcesses = async ({
  reason,
}: {
  reason?: string;
} = {}): Promise<{ cleaned: number; skipped: number }> => {
  const records = readRegistry();
  let cleaned = 0;
  let skipped = 0;
  const remaining: McpProcessRecord[] = [];

  for (const record of records) {
    if (!record.pid) continue;

    // Keep current-run records untouched
    if (record.runId === CURRENT_RUN_ID) {
      remaining.push(record);
      continue;
    }

    // Process already exited — just remove the stale record
    if (!isProcessAlive(record.pid)) {
      cleaned += 1;
      continue;
    }

    // PID is alive but doesn't match our recorded command signature.
    // The OS recycled this PID for an unrelated process — remove the stale record.
    if (!matchesSignature({ record })) {
      console.debug(`[ProcessRegistry] PID ${record.pid} signature mismatch, skipping kill`);
      cleaned += 1;
      continue;
    }

    // Verified Creature orphan — kill the entire process tree
    console.log(`[ProcessRegistry] Killing orphaned process tree: PID ${record.pid} (${record.serverName}, ${record.kind})`, {
      reason,
      ports: record.ports,
    });
    await terminateProcessTree({ pid: record.pid });
    cleaned += 1;
  }

  writeRegistry(remaining);
  skipped = remaining.length;

  if (cleaned > 0) {
    console.log(`[ProcessRegistry] Orphan cleanup complete: ${cleaned} cleaned, ${skipped} kept (reason: ${reason})`);
  }

  return { cleaned, skipped };
};

/**
 * Kill all processes registered in the current run.
 * Called as a last-resort sweep during app shutdown to catch anything
 * that closeAllConnections may have missed.
 */
export const killAllRegisteredProcesses = async (): Promise<void> => {
  const records = readRegistry();
  const currentRunRecords = records.filter((r) => r.runId === CURRENT_RUN_ID);

  for (const record of currentRunRecords) {
    if (!record.pid || !isProcessAlive(record.pid)) continue;

    console.log(`[ProcessRegistry] Shutdown kill: PID ${record.pid} (${record.serverName})`);
    await terminateProcessTree({ pid: record.pid });
  }

  // Clear the registry entirely on clean shutdown
  writeRegistry([]);
};

/**
 * Get the current run ID. Used externally to distinguish current-run
 * processes from orphans of prior runs.
 */
export const getMcpProcessRunId = (): string => {
  return CURRENT_RUN_ID;
};
