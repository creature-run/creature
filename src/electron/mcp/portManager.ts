/**
 * Port Manager for MCP Servers
 *
 * Centralized port allocation for MCP servers that need UI ports.
 * The Host assigns ports to MCPs via environment variables, avoiding
 * race conditions and port conflicts when running multiple MCPs.
 *
 * Design:
 * - Maintains a pool of available ports (configurable range)
 * - Tracks which ports are assigned to which MCP servers
 * - Checks if ports are actually free before allocating (skips busy ports)
 * - Cross-references the process registry to identify and kill Creature
 *   orphans that are holding ports, while leaving non-Creature processes alone
 * - Releases ports when MCPs disconnect or fail
 * - MCPs read their assigned port from MCP_ASSIGNED_PORT env var
 */

import * as net from "net";
import { findRecordByPort } from "./processRegistry";
import { spawnSync } from "node:child_process";

/**
 * Check if a port is available by attempting to create a server on it.
 *
 * Probes multiple network interfaces to catch ports bound on any address.
 * A port must be free on all supported interfaces to be considered available.
 */
const canBindToHost = ({ port, host }: { port: number; host: string }): Promise<"free" | "in-use" | "unsupported"> => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve("in-use");
        return;
      }
      if (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT") {
        resolve("unsupported");
        return;
      }
      resolve("in-use");
    });
    server.once("listening", () => {
      server.close(() => resolve("free"));
    });
    server.listen(port, host);
  });
};

/**
 * Check if a port is free on all supported network interfaces.
 * Probes 127.0.0.1, 0.0.0.0, ::1, and :: to catch binds on any address.
 */
const isPortFree = async ({ port }: { port: number }): Promise<boolean> => {
  const hostsToCheck = ["127.0.0.1", "0.0.0.0", "::1", "::"];
  let hadSupportedHost = false;

  for (const host of hostsToCheck) {
    const result = await canBindToHost({ port, host });
    if (result === "in-use") {
      return false;
    }
    if (result === "free") {
      hadSupportedHost = true;
    }
  }

  return hadSupportedHost;
};

/**
 * Identify the PID that is currently holding a port.
 * Uses `lsof` on macOS/Linux. Returns null if the port holder can't be determined.
 */
const getPortHolderPid = ({ port }: { port: number }): number | null => {
  if (process.platform === "win32") {
    try {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`],
        { encoding: "utf8" }
      );
      if (result.status === 0 && result.stdout.trim()) {
        const pid = parseInt(result.stdout.trim().split("\n")[0], 10);
        return isNaN(pid) ? null : pid;
      }
    } catch {}
    return null;
  }

  try {
    const result = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      const pid = parseInt(result.stdout.trim().split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {}
  return null;
};

/**
 * Configuration for the port manager.
 */
interface PortManagerConfig {
  /** Starting port number for the pool (inclusive) */
  startPort: number;
  /** Ending port number for the pool (inclusive) */
  endPort: number;
}

/**
 * Default port range for MCP UI servers.
 * Range 3100-3200 provides 100 ports, enough for dozens of MCPs.
 */
const DEFAULT_CONFIG: PortManagerConfig = {
  startPort: 3100,
  endPort: 3200,
};

/**
 * PortManager Class
 *
 * Allocates and tracks ports for MCP servers. Integrated with the process
 * registry to identify when a busy port belongs to a Creature orphan vs
 * an unrelated user process. Creature orphans are killed and the port is
 * reclaimed; non-Creature processes are left alone and the port is skipped.
 */
class PortManager {
  private config: PortManagerConfig;
  /** Maps server name to assigned port */
  private assignments: Map<string, number> = new Map();
  /** Set of ports currently in use */
  private usedPorts: Set<number> = new Set();

  constructor(config: PortManagerConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  /**
   * Attempt to reclaim a port that is currently in use.
   *
   * Cross-references the process registry to determine if the port holder
   * is a Creature orphan. If it is, kills the process tree and waits briefly
   * for the port to be released. Returns true if the port was reclaimed.
   *
   * Safety: never kills processes that aren't in the Creature registry.
   */
  private async tryReclaimPort({ port }: { port: number }): Promise<boolean> {
    // Check the registry first — this is the authoritative source for Creature processes
    const registryRecord = findRecordByPort({ port });

    if (registryRecord) {
      console.log(`[PortManager] Port ${port} held by Creature orphan: PID ${registryRecord.pid} (${registryRecord.serverName})`);

      // Kill the orphan's process group
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(registryRecord.pid), "/T", "/F"]);
      } else {
        try { process.kill(-registryRecord.pid, "SIGTERM"); } catch {}
        // Brief wait for SIGTERM, then escalate
        await new Promise((r) => setTimeout(r, 300));
        try { process.kill(-registryRecord.pid, "SIGKILL"); } catch {}
      }

      // Wait for the port to actually be released by the OS
      await new Promise((r) => setTimeout(r, 200));

      const nowFree = await isPortFree({ port });
      if (nowFree) {
        console.log(`[PortManager] Successfully reclaimed port ${port}`);
        return true;
      }

      console.log(`[PortManager] Port ${port} still occupied after killing PID ${registryRecord.pid}`);
      return false;
    }

    // No registry record — check if lsof can identify the holder for diagnostics
    const holderPid = getPortHolderPid({ port });
    if (holderPid) {
      console.debug(`[PortManager] Port ${port} held by non-Creature PID ${holderPid}, skipping`);
    }

    return false;
  }

  /**
   * Allocate a port for an MCP server.
   *
   * If the server already has a port assigned, verifies it's still free.
   * When a port is found occupied, cross-references the process registry
   * to determine if it's a Creature orphan (kill and reclaim) or a user
   * process (skip and try next port).
   */
  async allocate({ serverName }: { serverName: string }): Promise<number> {
    // Check existing assignment — but verify the port is still free.
    // An orphan process from a previous session might be occupying it.
    const existing = this.assignments.get(serverName);
    if (existing !== undefined) {
      const stillFree = await isPortFree({ port: existing });
      if (stillFree) {
        return existing;
      }

      // Port is no longer free — try to reclaim it from a Creature orphan
      console.log(`[PortManager] Port ${existing} for ${serverName} is no longer free, attempting reclaim`);
      const reclaimed = await this.tryReclaimPort({ port: existing });
      if (reclaimed) {
        return existing;
      }

      // Can't reclaim — clear assignment and find a new port
      this.usedPorts.delete(existing);
      this.assignments.delete(serverName);
    }

    // Find next available port in the range
    for (let port = this.config.startPort; port <= this.config.endPort; port++) {
      if (this.usedPorts.has(port)) continue;

      const free = await isPortFree({ port });
      if (free) {
        this.usedPorts.add(port);
        this.assignments.set(serverName, port);
        return port;
      }

      // Port is busy — try to reclaim if it's a Creature orphan
      const reclaimed = await this.tryReclaimPort({ port });
      if (reclaimed) {
        this.usedPorts.add(port);
        this.assignments.set(serverName, port);
        return port;
      }
    }

    throw new Error(
      `[PortManager] No available ports in range ${this.config.startPort}-${this.config.endPort}`
    );
  }

  /**
   * Release a port back to the pool when an MCP server disconnects.
   */
  release({ serverName }: { serverName: string }): void {
    const port = this.assignments.get(serverName);
    if (port !== undefined) {
      this.usedPorts.delete(port);
      this.assignments.delete(serverName);
    }
  }

  /**
   * Get the port assigned to a specific server.
   */
  getAssigned({ serverName }: { serverName: string }): number | undefined {
    return this.assignments.get(serverName);
  }

  /**
   * Release all ports (used during app shutdown).
   */
  releaseAll(): void {
    this.assignments.clear();
    this.usedPorts.clear();
  }

  /**
   * Get current allocation status for debugging.
   */
  getStatus(): { assigned: Record<string, number>; available: number } {
    const assigned: Record<string, number> = {};
    for (const [name, port] of this.assignments) {
      assigned[name] = port;
    }
    const totalPorts = this.config.endPort - this.config.startPort + 1;
    return {
      assigned,
      available: totalPorts - this.usedPorts.size,
    };
  }
}

/**
 * Singleton instance of the PortManager.
 * Used throughout the application for consistent port allocation.
 */
export const portManager = new PortManager();
