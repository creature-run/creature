import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import type {
  AppConfig,
  ResourceConfig,
  ToolConfig,
  ToolDefinition,
  ToolHandler,
  ToolResult,
  ToolContext,
  InstanceDestroyContext,
  ResourceDefinition,
  TransportSessionInfo,
} from "./types.js";
import { MIME_TYPES } from "./types.js";
import { svgToDataUri, isInitializeRequest, htmlLoader } from "./utils.js";
import { WebSocketManager } from "./websocket.js";
import type { WebSocketConnection } from "./types.js";
import { setCurrentServer } from "./storageRpc.js";


// ============================================================================
// App Class
// ============================================================================

export class App {
  // ==========================================================================
  // Private Properties
  // ==========================================================================

  private config: AppConfig;
  private tools: Map<string, ToolDefinition> = new Map();
  private resources: Map<string, ResourceDefinition> = new Map();
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();
  private websocketManager = new WebSocketManager();
  private instanceWebSockets = new Map<string, WebSocketConnection<unknown, unknown>>();
  private httpServer: Server | null = null;
  private isDev: boolean;
  private callerDir: string;
  private shutdownRegistered = false;
  private isShuttingDown = false;
  
  /** Server-side instance state, keyed by instanceId. */
  private instanceState = new Map<string, unknown>();
  
  /** Callbacks to invoke when an instance is destroyed. */
  private instanceDestroyCallbacks: Array<(ctx: InstanceDestroyContext) => void> = [];

  /** The connected client type for format-specific responses. */
  private clientType: "creature" | "claude" | "chatgpt" | "unknown" = "unknown";


  // ==========================================================================
  // Constructor
  // ==========================================================================

  constructor(config: AppConfig, callerDir?: string) {
    this.callerDir = callerDir || process.cwd();
    this.config = config;
    this.isDev = config.dev ?? process.env.NODE_ENV === "development";
    
  }

  // ==========================================================================
  // Public API: Registration
  // ==========================================================================

  /**
   * Define a UI resource.
   */
  resource(config: ResourceConfig): this {
    if (!config.uri.startsWith("ui://")) {
      throw new Error(`Resource URI must start with "ui://": ${config.uri}`);
    }
    
    const normalizedConfig: ResourceConfig = {
      ...config,
      html: typeof config.html === "string"
        ? htmlLoader(config.html, this.getCallerDir())
        : config.html,
    };
    
    this.resources.set(config.uri, { config: normalizedConfig });
    return this;
  }

  /**
   * Define a tool.
   */
  tool<TInput extends z.ZodType>(
    name: string,
    config: ToolConfig<TInput>,
    handler: ToolHandler<z.infer<TInput>>
  ): this {
    this.tools.set(name, {
      config: config as ToolConfig,
      handler: handler as ToolHandler<unknown>,
    });
    return this;
  }


  // ==========================================================================
  // Public API: Server Lifecycle
  // ==========================================================================

  /**
   * Start the MCP server.
   */
  async start(): Promise<void> {
    const port = this.getPort();
    const expressApp = this.createExpressApp();

    this.httpServer = expressApp.listen(port, () => {
      console.log(`MCP server ready on port ${port}`);
    });

    // Store server reference for lazy WebSocket initialization.
    // WebSocket server is only created when first needed.
    this.websocketManager.setServer(this.httpServer);

    this.registerShutdownHandlers();
  }

  /**
   * Stop the MCP server gracefully.
   */
  async stop(): Promise<void> {
    const gracefulTimeout = this.config.gracefulShutdownTimeout ?? 5000;
    const keepAliveTimeout = this.config.keepAliveTimeout ?? 5000;

    // Call user shutdown hook
    try {
      await this.config.onShutdown?.();
    } catch (error) {
      console.error("[MCP] Error in onShutdown callback:", error);
    }

    // Destroy all instances
    for (const instanceId of this.instanceState.keys()) {
      this.destroyInstance(instanceId);
    }
    this.websocketManager.closeAll();

    // Close all MCP transports with timeout
    const transportClosePromises = [...this.transports.values()].map((transport) =>
      transport.close().catch(() => {})
    );

    await Promise.race([
      Promise.all(transportClosePromises),
      new Promise((resolve) => setTimeout(resolve, gracefulTimeout)),
    ]);

    this.transports.clear();

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.keepAliveTimeout = keepAliveTimeout;

      await new Promise<void>((resolve) => {
        const forceClose = setTimeout(resolve, gracefulTimeout);
        this.httpServer?.close(() => {
          clearTimeout(forceClose);
          resolve();
        });
      });

      this.httpServer = null;
    }

    console.log("[MCP] Shutdown complete");
  }

  // ==========================================================================
  // Public API: Instance Lifecycle
  // ==========================================================================

  /**
   * Create an instance with optional WebSocket support.
   * 
   * Most tools don't need this — the SDK creates instances automatically.
   * Only call createInstance() when you need a WebSocket URL for real-time updates.
   */
  createInstance<TServer = unknown, TClient = unknown>(
    options: { websocket?: boolean } = {}
  ): {
    instanceId: string;
    websocketUrl?: string;
    send?: (msg: TServer) => void;
    onMessage?: (handler: (msg: TClient) => void) => void;
    onConnect?: (handler: () => void) => void;
  } {
    const instanceId = this.generateInstanceId();
    
    if (options.websocket) {
      const ws = this.websocketManager.createWebSocket<TServer, TClient>(
        instanceId,
        {},
        this.getPort()
      );
      this.instanceWebSockets.set(instanceId, ws as WebSocketConnection<unknown, unknown>);
      
      return {
        instanceId,
        websocketUrl: ws.websocketUrl,
        send: ws.send,
        onMessage: ws.onMessage,
        onConnect: ws.onConnect,
      };
    }
    
    return { instanceId };
  }

  /**
   * Register a callback to be invoked when an instance is destroyed.
   */
  onInstanceDestroy(callback: (ctx: InstanceDestroyContext) => void): void {
    this.instanceDestroyCallbacks.push(callback);
  }

  /**
   * Destroy an instance and clean up its resources.
   */
  destroyInstance(instanceId: string): boolean {
    const state = this.instanceState.get(instanceId);
    const hasState = state !== undefined || this.instanceState.has(instanceId);
    const hasWebSocket = this.instanceWebSockets.has(instanceId);
    
    if (hasState || hasWebSocket) {
      // Invoke destroy callbacks
      for (const callback of this.instanceDestroyCallbacks) {
        try {
          callback({ instanceId, state });
        } catch (error) {
          console.error(`[MCP] onInstanceDestroy callback error for ${instanceId}:`, error);
        }
      }
      
      // Close WebSocket
      const ws = this.instanceWebSockets.get(instanceId);
      if (ws) {
        ws.close();
        this.instanceWebSockets.delete(instanceId);
      }
      
      // Clear state
      this.instanceState.delete(instanceId);
      console.log(`[MCP] Instance destroyed: ${instanceId}`);
      return true;
    }
    
    return false;
  }

  /**
   * Check if an instance exists.
   */
  hasInstance(instanceId: string): boolean {
    return this.instanceState.has(instanceId);
  }

  /**
   * Get instance state.
   */
  getInstanceState<T>(instanceId: string): T | undefined {
    return this.instanceState.get(instanceId) as T | undefined;
  }

  /**
   * Set instance state directly.
   */
  setInstanceState<T>(instanceId: string, state: T): void {
    this.instanceState.set(instanceId, state);
  }

  /**
   * Create a WebSocket for an existing instance.
   * 
   * Use this when you need real-time communication for an instance
   * that was created by a tool handler (which provides instanceId via context).
   */
  createWebSocketForInstance<TServer = unknown, TClient = unknown>(
    instanceId: string
  ): WebSocketConnection<TServer, TClient> | null {
    // Check if WebSocket already exists for this instance
    if (this.instanceWebSockets.has(instanceId)) {
      return this.instanceWebSockets.get(instanceId) as WebSocketConnection<TServer, TClient>;
    }
    
    const ws = this.websocketManager.createWebSocket<TServer, TClient>(
      instanceId,
      {},
      this.getPort()
    );
    this.instanceWebSockets.set(instanceId, ws as WebSocketConnection<unknown, unknown>);
    
    return ws;
  }

  // ==========================================================================
  // Public API: Transport Sessions
  // ==========================================================================

  /**
   * Get list of active transport sessions.
   */
  getTransportSessions(): TransportSessionInfo[] {
    return [...this.transports.keys()].map((id) => ({
      id,
      transport: "streamable-http" as const,
    }));
  }

  /**
   * Get the count of active transport sessions.
   */
  getTransportSessionCount(): number {
    return this.transports.size;
  }

  // ==========================================================================
  // Public API: Serverless Adapters
  // ==========================================================================

  /**
   * Get the app configuration.
   */
  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * Get all tool definitions.
   */
  getToolDefinitions(): Map<string, ToolDefinition> {
    return this.tools;
  }

  /**
   * Get all resource definitions.
   */
  getResourceDefinitions(): Map<string, ResourceDefinition> {
    return this.resources;
  }

  /**
   * Close a specific transport session.
   */
  closeTransportSession(sessionId: string): boolean {
    const transport = this.transports.get(sessionId);
    if (transport) {
      transport.close().catch(() => {});
      this.transports.delete(sessionId);
      return true;
    }
    return false;
  }

  // ==========================================================================
  // Public API: Resource Cache
  // ==========================================================================
  // Private: Configuration Helpers
  // ==========================================================================

  private getPort(): number {
    return this.config.port || parseInt(process.env.MCP_PORT || process.env.PORT || "3000", 10);
  }

  private getCallerDir(): string {
    return this.callerDir;
  }

  // ==========================================================================
  // Public API: MCP Request Handling (for testing)
  // ==========================================================================

  /**
   * Handle an MCP JSON-RPC request directly.
   * Used for testing without starting a server.
   */
  async handleMcpRequest(body: {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
  }): Promise<{
    jsonrpc: string;
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string };
  }> {
    const method = body.method;
    const params = body.params;
    const id = body.id ?? null;

    // Initialize
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: this.config.name, version: this.config.version },
          capabilities: { tools: {}, resources: {} },
          ...(this.config.instructions && { instructions: this.config.instructions }),
        },
        id,
      };
    }

    // List tools
    if (method === "tools/list") {
      const tools = [];
      for (const [name, definition] of this.tools) {
        const { config } = definition;
        const toolMeta = this.buildToolMeta(config);
        tools.push({
          name,
          description: this.buildToolDescription(config, config.input || z.object({})),
          inputSchema: config.input ? this.zodToJsonSchema(config.input) : { type: "object" },
          ...(Object.keys(toolMeta).length > 0 && { _meta: toolMeta }),
        });
      }
      return { jsonrpc: "2.0", result: { tools }, id };
    }

    // Call tool
    if (method === "tools/call") {
      const toolName = params?.name as string | undefined;
      const args = (params?.arguments || {}) as Record<string, unknown>;
      const definition = this.tools.get(toolName || "");

      if (!definition) {
        return { jsonrpc: "2.0", error: { code: -32601, message: `Tool not found: ${toolName}` }, id };
      }

      const { config: toolConfig, handler } = definition;
      const input = toolConfig.input ? toolConfig.input.parse(args) : args;
      const instanceId = (args.instanceId as string) || this.generateInstanceId();

      // Create a simple context for direct request handling
      const context: ToolContext = {
        instanceId,
        getState: <T>() => this.instanceState.get(instanceId) as T | undefined,
        setState: <T>(state: T) => { this.instanceState.set(instanceId, state); },
        send: () => {},
        onMessage: () => {},
        onConnect: () => {},
        websocketUrl: undefined,
      };

      const result = await handler(input, context);
      return { jsonrpc: "2.0", result: this.formatToolResult(result, instanceId), id };
    }

    // List resources
    if (method === "resources/list") {
      const resources = [];
      for (const [uri, { config }] of this.resources) {
        resources.push({
          uri,
          name: config.name,
          description: config.description,
          mimeType: MIME_TYPES.MCP_APPS,
          _meta: {
            ui: {
              ...(config.views && { views: config.views }),
              ...(config.instanceMode && { instanceMode: config.instanceMode }),
              ...(config.icon && {
                icon: {
                  data: svgToDataUri(config.icon.svg),
                  alt: config.icon.alt,
                },
              }),
            },
          },
        });
      }
      return { jsonrpc: "2.0", result: { resources }, id };
    }

    // Read resource
    if (method === "resources/read") {
      const uri = params?.uri as string | undefined;
      const resourceDef = this.resources.get(uri || "");

      if (!resourceDef) {
        return { jsonrpc: "2.0", error: { code: -32601, message: `Resource not found: ${uri}` }, id };
      }

      const { config } = resourceDef;
      const html = typeof config.html === "function" ? await config.html() : config.html;

      const mcpAppsMeta: Record<string, unknown> = {
        ui: {
          displayModes: config.displayModes,
          ...(config.icon && {
            icon: {
              data: svgToDataUri(config.icon.svg),
              alt: config.icon.alt,
            },
          }),
          ...(config.csp && { csp: config.csp }),
        },
        "openai/widgetPrefersBorder": true,
      };

      return {
        jsonrpc: "2.0",
        result: {
          contents: [
            {
              uri,
              mimeType: MIME_TYPES.MCP_APPS,
              text: html,
              _meta: mcpAppsMeta,
            },
          ],
        },
        id,
      };
    }

    return { jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${method}` }, id };
  }

  /**
   * Convert Zod schema to JSON Schema for tool definitions.
   */
  private zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
    // Simple conversion - in production you'd use zod-to-json-schema
    if ("_def" in schema) {
      const def = (schema as any)._def;
      if (def.typeName === "ZodObject") {
        const shape = def.shape?.() || {};
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        
        for (const [key, value] of Object.entries(shape)) {
          const fieldDef = (value as any)._def;
          if (fieldDef?.typeName === "ZodString") {
            properties[key] = { type: "string", description: fieldDef.description };
          } else if (fieldDef?.typeName === "ZodNumber") {
            properties[key] = { type: "number", description: fieldDef.description };
          } else if (fieldDef?.typeName === "ZodBoolean") {
            properties[key] = { type: "boolean", description: fieldDef.description };
          } else if (fieldDef?.typeName === "ZodOptional") {
            const inner = fieldDef.innerType?._def;
            if (inner?.typeName === "ZodString") {
              properties[key] = { type: "string", description: inner.description };
            } else {
              properties[key] = { type: "string" };
            }
          } else {
            properties[key] = { type: "string" };
          }
          
          if (fieldDef?.typeName !== "ZodOptional") {
            required.push(key);
          }
        }
        
        return {
          type: "object",
          properties,
          ...(required.length > 0 && { required }),
          additionalProperties: true, // Allow _creatureToken and other injected args
        };
      }
    }
    return { type: "object", additionalProperties: true };
  }

  // ==========================================================================
  // Private: Instance Helpers
  // ==========================================================================

  private generateInstanceId(): string {
    return `inst_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Resolve instanceId for a tool call.
   * 
   * The host (control plane) owns routing decisions and passes instanceId.
   * SDK uses the provided instanceId for state management, or generates
   * a new one if not provided (fallback for hosts that don't manage routing).
   * 
   * @param inputInstanceId - instanceId from tool call input args (provided by host)
   */
  private resolveInstanceId(inputInstanceId: unknown): string {
    if (typeof inputInstanceId === "string") {
      return inputInstanceId;
    }
    return this.generateInstanceId();
  }

  // ==========================================================================
  // Private: Schema Introspection
  // ==========================================================================

  /**
   * Extract the shape (properties) from a Zod schema.
   */
  private getSchemaShape(schema: z.ZodType): Record<string, unknown> | undefined {
    if ("_def" in schema && typeof (schema as any)._def?.shape === "function") {
      return (schema as any)._def.shape();
    }
    return undefined;
  }

  /**
   * Check if a field is required in a Zod schema.
   */
  private isFieldRequired(schema: z.ZodType, fieldName: string): boolean {
    const shape = this.getSchemaShape(schema);
    if (!shape || !(fieldName in shape)) return false;
    
    const field = shape[fieldName] as z.ZodType;
    if ("_def" in field && (field as any)._def?.typeName === "ZodOptional") {
      return false;
    }
    return true;
  }

  // ==========================================================================
  // Private: Express Server
  // ==========================================================================

  private createExpressApp(): express.Express {
    const app = express();
    app.use(express.json());

    // CORS middleware
    app.use((req: Request, res: Response, next: () => void) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });

    // Health check
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        server: this.config.name,
        version: this.config.version,
        activeSessions: this.transports.size,
        websockets: this.instanceWebSockets.size,
      });
    });

    // MCP endpoints
    app.post("/mcp", (req, res) => this.handleMcpPost(req, res));
    app.get("/mcp", (req, res) => this.handleMcpGet(req, res));
    app.delete("/mcp", (req, res) => this.handleMcpDelete(req, res));

    return app;
  }

  private async handleMcpPost(req: Request, res: Response): Promise<void> {
    const transportSessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      /**
       * Ensure tools/list is always available, even when no tools are registered.
       * This prevents clients from receiving -32601 and keeps empty-tool apps valid.
       */
      if (req.body?.method === "tools/list" && this.tools.size === 0) {
        res.json({
          jsonrpc: "2.0",
          id: req.body?.id ?? null,
          result: { tools: [] },
        });
        return;
      }

      let transport: StreamableHTTPServerTransport;

      if (transportSessionId && this.transports.has(transportSessionId)) {
        transport = this.transports.get(transportSessionId)!;
      } else if (!transportSessionId && isInitializeRequest(req.body)) {
        // Detect client type for format-specific responses
        const clientName = req.body?.params?.clientInfo?.name?.toLowerCase() || "";
        if (clientName === "creature") {
          this.clientType = "creature";
        } else if (clientName.includes("claude")) {
          this.clientType = "claude";
        } else if (clientName.includes("chatgpt") || clientName.includes("openai")) {
          this.clientType = "chatgpt";
        } else {
          this.clientType = "unknown";
        }
        console.log(`[MCP] Client: ${clientName}, type: ${this.clientType}`);

        transport = this.createTransport();
        const server = this.createMcpServer();
        await server.connect(transport);
        
        // Set the current server for storage RPC access
        setCurrentServer(server);
        
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid transport session ID" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  }

  private async handleMcpGet(req: Request, res: Response): Promise<void> {
    const transportSessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!transportSessionId || !this.transports.has(transportSessionId)) {
      res.status(400).send("Invalid or missing transport session ID");
      return;
    }

    const transport = this.transports.get(transportSessionId)!;
    await transport.handleRequest(req, res);
  }

  private async handleMcpDelete(req: Request, res: Response): Promise<void> {
    const transportSessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!transportSessionId || !this.transports.has(transportSessionId)) {
      res.status(400).send("Invalid or missing transport session ID");
      return;
    }

    const transport = this.transports.get(transportSessionId)!;
    await transport.handleRequest(req, res);
  }

  // ==========================================================================
  // Private: MCP Server & Transport
  // ==========================================================================

  private createTransport(): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId: string) => {
        this.transports.set(newSessionId, transport);
        console.log(`[MCP] Transport session created: ${newSessionId}`);
        this.config.onTransportSessionCreated?.({
          id: newSessionId,
          transport: "streamable-http",
        });
      },
    });

    transport.onerror = (error: Error) => {
      const sid = transport.sessionId || "unknown";
      console.error(`[MCP] Transport session error for ${sid}:`, error.message);
      this.config.onTransportSessionError?.(
        { id: sid, transport: "streamable-http" },
        error
      );
    };

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        console.log(`[MCP] Transport session closed: ${sid}. Client should re-initialize to continue.`);
        this.transports.delete(sid);
        this.config.onTransportSessionClosed?.({
          id: sid,
          transport: "streamable-http",
        });
      }
    };

    return transport;
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      {
        name: this.config.name,
        version: this.config.version,
        ...(this.config.instructions && { instructions: this.config.instructions }),
      },
      { capabilities: { logging: {}, tools: {}, resources: {} } }
    );

    this.registerResources(server);
    this.registerTools(server);

    return server;
  }

  private registerResources(server: McpServer): void {
    for (const [uri, { config }] of this.resources) {
      server.registerResource(
        config.name,
        uri,
        {
          mimeType: MIME_TYPES.MCP_APPS,
          description: config.description,
          _meta: {
            ui: {
              ...(config.views && { views: config.views }),
              ...(config.instanceMode && { instanceMode: config.instanceMode }),
              ...(config.icon && {
                icon: {
                  data: svgToDataUri(config.icon.svg),
                  alt: config.icon.alt,
                },
              }),
            },
          },
        },
        async () => {
          let html = typeof config.html === "function" ? await config.html() : config.html;

          const mcpAppsMeta: Record<string, unknown> = {
            ui: {
              displayModes: config.displayModes,
              ...(config.icon && {
                icon: {
                  data: svgToDataUri(config.icon.svg),
                  alt: config.icon.alt,
                },
              }),
              ...(config.csp && { csp: config.csp }),
            },
            "openai/widgetPrefersBorder": true,
          };

          const chatgptMeta: Record<string, unknown> = {
            "openai/widgetPrefersBorder": true,
          };

          // Claude Desktop/Claude.ai only supports 1 content item in resource responses
          // Return format-specific content based on detected client type
          if (this.clientType === "claude" || this.clientType === "creature") {
            return {
              contents: [
                {
                  uri,
                  mimeType: MIME_TYPES.MCP_APPS,
                  text: html,
                  _meta: mcpAppsMeta,
                },
              ],
            };
          }

          if (this.clientType === "chatgpt") {
            return {
              contents: [
                {
                  uri,
                  mimeType: MIME_TYPES.CHATGPT,
                  text: html,
                  _meta: chatgptMeta,
                },
              ],
            };
          }

          // Unknown clients: return both formats for compatibility
          return {
            contents: [
              {
                uri,
                mimeType: MIME_TYPES.MCP_APPS,
                text: html,
                _meta: mcpAppsMeta,
              },
              {
                uri,
                mimeType: MIME_TYPES.CHATGPT,
                text: html,
                _meta: chatgptMeta,
              },
            ],
          };
        }
      );
    }
  }

  private registerTools(server: McpServer): void {
    for (const [name, { config, handler }] of this.tools) {
      const toolMeta = this.buildToolMeta(config);
      const baseSchema = config.input || z.object({});
      // Use passthrough to allow host-injected fields (instanceId, _source, _creatureToken)
      // to pass through MCP SDK validation without being stripped
      const inputSchema = "passthrough" in baseSchema && typeof (baseSchema as z.AnyZodObject).passthrough === "function"
        ? (baseSchema as z.AnyZodObject).passthrough()
        : baseSchema;
      const description = this.buildToolDescription(config, baseSchema);
      const hasUi = !!config.ui;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server.registerTool as any)(
        name,
        {
          description,
          inputSchema,
          ...(Object.keys(toolMeta).length > 0 && { _meta: toolMeta }),
        },
        async (args: Record<string, unknown>) => {
          try {
            const input = config.input ? config.input.parse(args) : args;

            // Determine instanceId for tools with UI
            // Host (control plane) passes _instanceId for routing; SDK uses it for state
            // Note: Uses underscore prefix to avoid collision with tool-defined arguments
            let instanceId: string | undefined;
            if (hasUi && config.ui) {
              instanceId = this.resolveInstanceId(args._instanceId);
            }

            // Get resource config for WebSocket setup
            const resource = config.ui ? this.resources.get(config.ui) : undefined;
            const hasWebSocket = resource?.config.experimental?.websocket === true;

            // Get or create WebSocket if resource has websocket: true
            let ws: WebSocketConnection<unknown, unknown> | undefined;
            let websocketUrl: string | undefined;
            if (hasWebSocket && instanceId) {
              ws = this.getOrCreateWebSocket(instanceId);
              websocketUrl = ws?.websocketUrl;
            }

            // Build handler context
            const context: ToolContext = {
              instanceId: instanceId || "",
              getState: <T>() => instanceId ? this.instanceState.get(instanceId) as T : undefined,
              setState: <T>(state: T) => {
                if (instanceId) {
                  this.instanceState.set(instanceId, state);
                }
              },
              send: <T>(message: T) => {
                if (ws) {
                  ws.send(message);
                }
              },
              onMessage: <T>(messageHandler: (msg: T) => void) => {
                if (ws) {
                  ws.onMessage(messageHandler as (msg: unknown) => void);
                }
              },
              onConnect: (connectHandler: () => void) => {
                if (ws) {
                  ws.onConnect(connectHandler);
                }
              },
              websocketUrl,
            };
            
            const result = await handler(input, context);
            return this.formatToolResult(result, instanceId, websocketUrl);
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[MCP] Tool "${name}" failed:`, err.message);
            this.config.onToolError?.(name, err, args);

            return {
              content: [{ type: "text" as const, text: err.message }],
              isError: true,
            };
          }
        }
      );
    }
  }

  /**
   * Get or create a WebSocket for an instance.
   * Used internally by registerTools when resource has websocket: true.
   */
  private getOrCreateWebSocket(instanceId: string): WebSocketConnection<unknown, unknown> {
    // Check if WebSocket already exists for this instance
    const existing = this.instanceWebSockets.get(instanceId);
    if (existing) {
      return existing;
    }
    
    // Create new WebSocket
    const ws = this.websocketManager.createWebSocket(instanceId, {}, this.getPort());
    this.instanceWebSockets.set(instanceId, ws as WebSocketConnection<unknown, unknown>);
    console.log(`[MCP] WebSocket created for instance ${instanceId}`);
    return ws as WebSocketConnection<unknown, unknown>;
  }

  private buildToolMeta(config: ToolConfig): Record<string, unknown> {
    const toolMeta: Record<string, unknown> = {};
    
    if (config.ui) {
      const visibility = config.visibility || ["model", "app"];
      
      // Build experimental metadata (non-standard extensions)
      const experimental: Record<string, unknown> = {};
      if (config.experimental?.defaultDisplayMode) {
        experimental.defaultDisplayMode = config.experimental.defaultDisplayMode;
      }
      if (config.experimental?.openInBackground !== undefined) {
        experimental.openInBackground = config.experimental.openInBackground;
      }
      
      toolMeta.ui = {
        resourceUri: config.ui,
        visibility,
        ...(config.displayModes && { displayModes: config.displayModes }),
        ...(Object.keys(experimental).length > 0 && { experimental }),
      };
      toolMeta["openai/outputTemplate"] = config.ui;
      // ChatGPT requires this to allow widget/UI to call the tool
      toolMeta["openai/widgetAccessible"] = visibility.includes("app");

      // TODO: Remove this once Claude.ai follows the spec correctly.
      toolMeta["ui/resourceUri"] = config.ui;
    }
    
    if (config.loadingMessage) {
      toolMeta["openai/toolInvocation/invoking"] = config.loadingMessage;
    }
    if (config.completedMessage) {
      toolMeta["openai/toolInvocation/invoked"] = config.completedMessage;
    }

    return toolMeta;
  }

  private buildToolDescription(config: ToolConfig, inputSchema: z.ZodType): string {
    let description = config.description;
    
    if (config.ui) {
      const schemaShape = this.getSchemaShape(inputSchema);
      const hasInstanceIdInSchema = schemaShape && "instanceId" in schemaShape;
      const isInstanceIdRequired = this.isFieldRequired(inputSchema, "instanceId");
      
      if (isInstanceIdRequired) {
        description += " Requires instanceId from a previous tool response.";
      } else if (hasInstanceIdInSchema) {
        description += " Returns instanceId. Pass it in subsequent calls to target the same widget.";
      } else {
        description += " Returns instanceId for the new widget.";
      }
    }

    return description;
  }

  /**
   * Format tool result for MCP protocol response.
   * 
   * SDK manages instanceId and websocketUrl automatically.
   */
  private formatToolResult(result: ToolResult, instanceId?: string, websocketUrl?: string) {
    const text = result.text || JSON.stringify(result.data || {});

    const structuredContent: Record<string, unknown> = {
      ...result.data,
      ...(result.title && { title: result.title }),
      ...(result.inlineHeight && { inlineHeight: result.inlineHeight }),
      ...(instanceId && { instanceId }),
      ...(websocketUrl && { websocketUrl }),
    };

    const meta: Record<string, unknown> = {};
    if (instanceId) {
      meta["openai/widgetSessionId"] = instanceId;
    }

    return {
      content: [{ type: "text" as const, text }],
      ...(Object.keys(structuredContent).length > 0 && { structuredContent }),
      ...(Object.keys(meta).length > 0 && { _meta: meta }),
      ...(result.isError && { isError: true }),
    };
  }

  // ==========================================================================
  // Private: Shutdown
  // ==========================================================================

  private registerShutdownHandlers(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;

    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`[MCP] ${signal} received, shutting down gracefully...`);
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Checks if a filename belongs to the SDK itself.
 * Matches various SDK installation patterns:
 * - Published: node_modules/open-mcp-app/
 * - Local development: desktop/artifacts/sdk/
 * - Public SDK: public/sdk/
 */
function isSDKPath(filename: string): boolean {
  return (
    filename.includes("/public/sdk/") ||
    filename.includes("\\public\\sdk\\") ||
    filename.includes("/open-mcp-app/") ||
    filename.includes("\\open-mcp-app\\") ||
    // Local SDK development paths
    filename.includes("/artifacts/sdk/") ||
    filename.includes("\\artifacts\\sdk\\")
  );
}

/**
 * Get the directory of the file that called createApp().
 */
function getCallerDirectory(): string {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const err = new Error();
  const stack = err.stack as unknown as NodeJS.CallSite[];
  Error.prepareStackTrace = originalPrepareStackTrace;

  for (const frame of stack) {
    const filename = frame.getFileName();
    if (filename && !isSDKPath(filename)) {
      return filename.startsWith("file://") 
        ? path.dirname(fileURLToPath(filename))
        : path.dirname(filename);
    }
  }
  return process.cwd();
}

/**
 * Create a new MCP App.
 */
export function createApp(config: AppConfig): App {
  const callerDir = getCallerDirectory();
  return new App(config, callerDir);
}
