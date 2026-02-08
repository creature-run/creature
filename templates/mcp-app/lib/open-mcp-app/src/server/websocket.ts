/**
 * WebSocket support for real-time bidirectional communication.
 *
 * Provides a type-safe abstraction over WebSockets, allowing MCP Apps
 * to stream data to connected UIs without polling.
 * 
 * Internal module - users interact via `app.createInstance({ websocket: true })`.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { z } from "zod";
import type { WebSocketConnection } from "./types.js";

/**
 * Handler for incoming client messages.
 */
type MessageHandler<T> = (message: T) => void;

/**
 * Internal configuration for WebSocket setup.
 */
interface WebSocketConfig<_TServer = unknown, _TClient = unknown> {
  /** Zod schema for server → client messages (optional, for documentation) */
  server?: z.ZodType;
  /** Zod schema for client → server messages (validated on receive) */
  client?: z.ZodType;
}


/**
 * Internal implementation of a WebSocket connection.
 */
class WebSocketConnectionInternal<TServer = unknown, TClient = unknown> {
  private clients = new Set<WebSocket>();
  private handler: MessageHandler<TClient> | null = null;
  private connectHandler: (() => void) | null = null;
  private clientSchema?: z.ZodType;

  constructor(
    public readonly id: string,
    config: WebSocketConfig<TServer, TClient>
  ) {
    this.clientSchema = config.client;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    this.connectHandler?.();
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  setHandler(handler: MessageHandler<TClient>): void {
    this.handler = handler;
  }

  setConnectHandler(handler: () => void): void {
    this.connectHandler = handler;
  }

  handleMessage(raw: unknown): void {
    if (!this.handler) return;

    try {
      // Validate if schema provided
      const message = this.clientSchema
        ? this.clientSchema.parse(raw)
        : (raw as TClient);

      this.handler(message);
    } catch (error) {
      console.error(`[WebSocket ${this.id}] Invalid message:`, error);
    }
  }

  broadcast(message: TServer): void {
    if (this.clients.size === 0) return;

    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  closeAll(): void {
    for (const client of this.clients) {
      client.close(1000, "WebSocket closed");
    }
    this.clients.clear();
  }
}

/**
 * Manages WebSocket connections and routes messages to instances.
 * Uses lazy initialization - WebSocket server is only created when first needed.
 * Internal class - not exported to users.
 */
export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;
  private isAttached = false;
  private connections = new Map<string, WebSocketConnectionInternal<unknown, unknown>>();

  /**
   * Store the HTTP server reference for lazy WebSocket attachment.
   */
  setServer(server: Server): void {
    this.httpServer = server;
  }

  /**
   * Lazily attach the WebSocket server when first needed.
   */
  private ensureAttached(): void {
    if (this.isAttached || !this.httpServer) return;

    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests - use /ws/* path for WebSocket connections
    this.httpServer.on("upgrade", (request, socket, head) => {
      const url = request.url || "";

      // Handle /ws/{instanceId} paths
      if (!url.startsWith("/ws/")) {
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.wss!.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (ws, req) => {
      // URL: /ws/{instanceId}
      const match = req.url?.match(/^\/ws\/(.+)$/);
      if (!match) {
        ws.close(4000, "Invalid WebSocket URL");
        return;
      }

      const [, instanceId] = match;

      const connection = this.connections.get(instanceId);
      if (!connection) {
        ws.close(4004, "Instance not found");
        return;
      }

      connection.addClient(ws);

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          connection.handleMessage(message);
        } catch (e) {
          console.error(`[WebSocket] Failed to parse message:`, e);
        }
      });

      ws.on("close", () => {
        connection.removeClient(ws);
      });

      ws.on("error", (error) => {
        console.error(`[WebSocket ${instanceId}] Error:`, error);
        connection.removeClient(ws);
      });
    });

    this.isAttached = true;
    console.log(`WebSocket available at ws://localhost:${(this.httpServer.address() as { port: number })?.port || "?"}/ws`);
  }

  /**
   * Create a WebSocket connection for an instance.
   * Lazily initializes the WebSocket server on first call.
   *
   * @param instanceId - The instance ID
   * @param config - WebSocket configuration
   * @param port - Server port for WebSocket URL
   * @returns A WebSocketConnection for bidirectional communication
   */
  createWebSocket<TServer, TClient>(
    instanceId: string,
    config: WebSocketConfig<TServer, TClient>,
    port: number
  ): WebSocketConnection<TServer, TClient> {
    this.ensureAttached();

    // Clean up existing connection if present
    const existing = this.connections.get(instanceId);
    if (existing) {
      existing.closeAll();
    }

    const internal = new WebSocketConnectionInternal<TServer, TClient>(instanceId, config);
    this.connections.set(instanceId, internal as WebSocketConnectionInternal<unknown, unknown>);

    return {
      instanceId,
      websocketUrl: `ws://localhost:${port}/ws/${instanceId}`,
      send: (msg: TServer) => internal.broadcast(msg),
      onMessage: (handler: MessageHandler<TClient>) => internal.setHandler(handler),
      onConnect: (handler: () => void) => internal.setConnectHandler(handler),
      close: () => {
        internal.closeAll();
        this.connections.delete(instanceId);
      },
      get clientCount() {
        return internal.clientCount;
      },
    };
  }

  /**
   * Check if a WebSocket exists for an instance.
   */
  hasWebSocket(instanceId: string): boolean {
    return this.connections.has(instanceId);
  }

  /**
   * Close a specific instance's WebSocket.
   */
  closeWebSocket(instanceId: string): boolean {
    const connection = this.connections.get(instanceId);
    if (connection) {
      connection.closeAll();
      this.connections.delete(instanceId);
      return true;
    }
    return false;
  }

  /**
   * Close all WebSocket connections and shut down the server.
   */
  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.closeAll();
    }
    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.isAttached = false;
  }
}
