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
 * - Releases ports when MCPs disconnect or fail
 * - MCPs read their assigned port from MCP_ASSIGNED_PORT env var
 */

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
   *
   * @param serverName - Unique name of the MCP server
   * @returns The allocated port number
   * @throws Error if no ports are available in the pool
   */
  allocate({ serverName }: { serverName: string }): number {
    // Return existing assignment if server already has a port
    const existing = this.assignments.get(serverName);
    if (existing !== undefined) {
      return existing;
    }

    // Find next available port in the range
    for (let port = this.config.startPort; port <= this.config.endPort; port++) {
      if (!this.usedPorts.has(port)) {
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

