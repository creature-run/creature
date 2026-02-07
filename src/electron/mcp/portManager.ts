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
 * - Releases ports when MCPs disconnect or fail
 * - MCPs read their assigned port from MCP_ASSIGNED_PORT env var
 */

import * as net from "net";

/**
 * Check if a port is available by attempting to create a server on it.
 *
 * IMPORTANT: We intentionally do NOT kill processes on busy ports.
 * When a port is busy, we simply skip it and try the next one. Reasons:
 * - We cannot reliably distinguish between orphaned MCP processes and
 *   legitimate user processes (e.g., Vite dev server, other apps)
 * - Killing arbitrary processes is dangerous and could break the user's
 *   development environment or other running applications
 * - Silently skipping busy ports is safe and transparent to the user
 */
const canBindToHost = (port: number, host: string): Promise<"free" | "in-use" | "unsupported"> => {
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

const isPortFree = async (port: number): Promise<boolean> => {
  const hostsToCheck = ["127.0.0.1", "0.0.0.0", "::1", "::"];
  let hadSupportedHost = false;

  for (const host of hostsToCheck) {
    const result = await canBindToHost(port, host);
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
 * Allocates and tracks ports for MCP servers. Used by the Host to
 * assign unique ports to each MCP that needs one (e.g., for WebSocket UI).
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
   * Allocate a port for an MCP server.
   * If the server already has a port assigned, returns that port.
   * Otherwise, finds the next available port in the pool.
   * Checks if ports are actually free on the system (skips busy ports).
   *
   * @param serverName - Unique name of the MCP server
   * @returns The allocated port number
   * @throws Error if no ports are available in the pool
   */
  async allocate({ serverName }: { serverName: string }): Promise<number> {
    // Check existing assignment - but verify the port is still free.
    // An orphan process from a previous session might be occupying it.
    const existing = this.assignments.get(serverName);
    if (existing !== undefined) {
      const stillFree = await isPortFree(existing);
      if (stillFree) {
        return existing;
      }
      // Port is no longer free (orphan process?) - clear assignment and find new port
      console.log(`[PortManager] Port ${existing} for ${serverName} is no longer free, reallocating`);
      this.usedPorts.delete(existing);
      this.assignments.delete(serverName);
    }

    // Find next available port in the range (check if actually free)
    for (let port = this.config.startPort; port <= this.config.endPort; port++) {
      if (!this.usedPorts.has(port)) {
        const free = await isPortFree(port);
        if (free) {
          this.usedPorts.add(port);
          this.assignments.set(serverName, port);
          return port;
        }
      }
    }

    throw new Error(
      `[PortManager] No available ports in range ${this.config.startPort}-${this.config.endPort}`
    );
  }

  /**
   * Release a port back to the pool when an MCP server disconnects.
   *
   * @param serverName - Name of the MCP server releasing its port
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
   *
   * @param serverName - Name of the MCP server
   * @returns The assigned port, or undefined if not assigned
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

