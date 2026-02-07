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

const getRegistryPath = (): string => {
  return path.join(app.getPath("userData"), REGISTRY_FILENAME);
};

const readRegistry = (): McpProcessRecord[] => {
  try {
    const registryPath = getRegistryPath();
    if (!fs.existsSync(registryPath)) return [];
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as McpProcessRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[MCP] Failed to read process registry:", error);
    return [];
  }
};

const writeRegistry = (records: McpProcessRecord[]): void => {
  try {
    const registryPath = getRegistryPath();
    fs.writeFileSync(registryPath, JSON.stringify(records, null, 2), "utf8");
  } catch (error) {
    console.error("[MCP] Failed to write process registry:", error);
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const getProcessCommandLine = (pid: number): string | null => {
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

const matchesSignature = (record: McpProcessRecord): boolean => {
  const cmdline = getProcessCommandLine(record.pid);
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

const terminateProcess = (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      exec(`taskkill /pid ${pid} /T /F`, () => resolve());
    });
  }

  return new Promise((resolve) => {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      resolve();
      return;
    }

    setTimeout(() => {
      try {
        if (isProcessAlive(pid)) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        // Ignore final kill errors
      }
      resolve();
    }, 500);
  });
};

export const registerMcpProcess = (input: Omit<McpProcessRecord, "createdAt" | "runId">): void => {
  if (!input.pid) return;
  const records = readRegistry().filter((record) => record.pid !== input.pid);
  records.push({
    ...input,
    createdAt: new Date().toISOString(),
    runId: CURRENT_RUN_ID,
  });
  writeRegistry(records);
};

export const unregisterMcpProcess = ({
  pid,
  serverName,
}: {
  pid?: number;
  serverName?: string;
}): void => {
  const records = readRegistry().filter((record) => {
    if (pid && record.pid === pid) return false;
    if (serverName && record.serverName === serverName) return false;
    return true;
  });
  writeRegistry(records);
};

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
    if (record.runId === CURRENT_RUN_ID) {
      remaining.push(record);
      continue;
    }

    if (!isProcessAlive(record.pid)) {
      cleaned += 1;
      continue;
    }

    if (!matchesSignature(record)) {
      cleaned += 1;
      continue;
    }

    console.log(`[MCP] Cleaning orphaned process ${record.pid} (${record.serverName})`, {
      reason,
      kind: record.kind,
    });
    await terminateProcess(record.pid);
    cleaned += 1;
  }

  writeRegistry(remaining);
  skipped = remaining.length;
  return { cleaned, skipped };
};

export const getMcpProcessRunId = (): string => {
  return CURRENT_RUN_ID;
};
