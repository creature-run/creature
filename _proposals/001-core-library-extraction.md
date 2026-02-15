# Proposal: Core Library Extraction

Extract business logic from `desktop/` into a platform-agnostic `packages/core` library. Desktop becomes a thin Electron shell. Web app and backend consume the same library.

---

## Problem

Everything in `desktop/src/electron/` is tangled with Electron APIs (`app.getPath`, `ipcMain`, `BrowserWindow`, `contextBridge`). The React UI is tangled with `window.electronAPI`. None of it is testable without spinning up Electron. None of it can run on a backend or in a browser.

## Goal

1. `packages/core` — Platform-agnostic library. All business logic, shared types, and provider interfaces. Runs in any Node.js environment. Testable with vitest alone.
2. `desktop/` — Thin Electron shell. Imports core, provides Electron-specific implementations, adds desktop-only features (IDE, Terminal, filesystem MCPs, MCP app dev).
3. Web app + backend — Import the same core library. Provide their own implementations of the provider interfaces.

---

## Package Structure

```
creature/
  packages/
    core/                          ← NEW: extracted library
      src/
        engine/
          agent/                   ← from desktop/src/electron/agent/
          mcp/                     ← from desktop/src/electron/mcp/
          server/                  ← from desktop/src/electron/server/
        interfaces/                ← provider contracts (new)
        types/                     ← from desktop/src/shared/
        index.ts
      package.json
      tsconfig.json
      vitest.config.ts

  desktop/                         ← SLIMMED: thin Electron wrapper
    src/
      electron/
        main.ts                    ← app lifecycle, window management
        preload.ts                 ← implements PlatformAPI via IPC
        providers/                 ← Electron implementations of interfaces
          ElectronSettingsProvider.ts
          ElectronCredentialProvider.ts
          ElectronStorageProvider.ts
          ElectronProcessProvider.ts
          ElectronNotifier.ts
        ipc/                       ← wires providers to IPC handlers
        mcps/                      ← desktop-only: IDE, Terminal, Browser
        window/                    ← Electron window management
      components/                  ← shared React UI (see Section 5)
      contexts/
      App.tsx
      renderer.tsx
```

Only one new package: `packages/core`. Everything else is reorganization within `desktop/`.

---

## Section 1: Provider Interfaces

The core of the extraction. These interfaces define the "clean inputs" that decouple business logic from Electron.

### 1.1 Settings Provider

Replaces the current `settingsStore.ts` which uses `app.getPath("userData")` and local JSON files.

```typescript
// packages/core/src/interfaces/settings.ts

/**
 * Provider interface for settings storage.
 *
 * Desktop implements this with local JSON files.
 * Web implements this with database API calls.
 * The merge logic (defaults → enterprise → user) lives in core,
 * not in the provider — providers just store and retrieve.
 */
interface SettingsProvider {
  loadStorage(): Promise<SettingsStorage>;
  saveStorage(params: { storage: SettingsStorage }): Promise<void>;
}
```

The merge logic (`deepMerge`, `mergePartialSettings`, `getDefaultSettings`, `themeToCssVariables`) moves to core as pure functions. All 887 lines of `settingsStore.ts` currently mix merge logic with file I/O — those separate cleanly.

**Desktop implementation:** Reads/writes `settings.json` at `app.getPath("userData")`. Same behavior as today.

**Web implementation:** GET/PUT to a settings API endpoint. Enterprise settings come from the org's database row. User settings come from the user's database row. The merge happens in core, not in the database.

### 1.2 Credential Provider

Replaces `credentialsStore.ts` which uses `app.getPath("userData")` for encrypted local files.

```typescript
// packages/core/src/interfaces/credentials.ts

/**
 * Provider interface for API credential storage.
 *
 * Desktop implements this with encrypted local files (AES-256-CBC).
 * Web implements this with server-side session/database storage.
 */
interface CredentialProvider {
  getCredentials(): Promise<ProviderCredentials | null>;
  saveCredentials(params: { credentials: ProviderCredentials }): Promise<void>;
  clearCredentials(): Promise<void>;
  getChatModel(): Promise<ChatModelPreference>;
  setChatModel(params: { model: ChatModelPreference }): Promise<void>;
}
```

**Desktop implementation:** Current encryption logic, file-based. No changes.

**Web implementation:** Credentials stored server-side (never sent to browser). The backend's credential provider reads from the database or secrets manager.

### 1.3 Storage Provider

Replaces `kvSqlite.ts`, `vectorSqlite.ts`, and blob storage which use local SQLite and filesystem.

```typescript
// packages/core/src/interfaces/storage.ts

/**
 * Provider interface for MCP app data storage (KV, vector, blob).
 *
 * Desktop implements this with SQLite (node:sqlite) and local filesystem.
 * Backend implements this with Postgres/pgvector and S3/R2.
 */
interface KVStore {
  get(params: { namespace: string; key: string }): Promise<string | null>;
  set(params: { namespace: string; key: string; value: string }): Promise<void>;
  delete(params: { namespace: string; key: string }): Promise<void>;
  list(params: { namespace: string; prefix?: string }): Promise<string[]>;
  search(params: { namespace: string; query: string; limit?: number }): Promise<KVSearchResult[]>;
}

interface VectorStore {
  upsert(params: { namespace: string; id: string; vector: number[]; metadata?: Record<string, string> }): Promise<void>;
  query(params: { namespace: string; vector: number[]; topK?: number }): Promise<VectorResult[]>;
  delete(params: { namespace: string; id: string }): Promise<void>;
}

interface BlobStore {
  read(params: { namespace: string; key: string }): Promise<Buffer | null>;
  write(params: { namespace: string; key: string; data: Buffer }): Promise<void>;
  delete(params: { namespace: string; key: string }): Promise<void>;
  list(params: { namespace: string; prefix?: string }): Promise<string[]>;
}

interface StorageProvider {
  kv: KVStore;
  vector: VectorStore;
  blob: BlobStore;
}
```

### 1.4 Process Provider

Replaces direct `child_process.spawn` calls in `client.ts` for starting MCP servers.

```typescript
// packages/core/src/interfaces/process.ts

/**
 * Provider interface for spawning and managing MCP server processes.
 *
 * Desktop implements this with child_process.spawn.
 * Backend does not use this — all MCPs connect via streamable-http.
 * This interface exists only for desktop-only MCPs (IDE, Terminal)
 * and MCP app development.
 */
interface ProcessProvider {
  spawn(params: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<ManagedProcess>;
}

interface ManagedProcess {
  stdout: ReadableStream<string>;
  stderr: ReadableStream<string>;
  kill(): Promise<void>;
  onExit(handler: (code: number | null) => void): void;
  pid: number;
}
```

**Desktop implementation:** Wraps `child_process.spawn` with process group management and registry.

**Backend:** Does not need this. All MCPs are connected via streamable-http URLs. Process management is handled by K8s.

### 1.5 UI Notifier

Replaces `BrowserWindow.webContents.send()` calls in `controlPlane.ts`.

```typescript
// packages/core/src/interfaces/notifier.ts

/**
 * Provider interface for sending events to the UI layer.
 *
 * Desktop implements this with Electron IPC (webContents.send).
 * Backend implements this with WebSocket messages to the client session.
 */
interface UINotifier {
  send(params: { channel: string; data: unknown }): void;
  sendToPip(params: { instanceId: string; channel: string; data: unknown }): void;
}
```

### 1.6 Path Resolver

Replaces `app.getPath()`, `app.getAppPath()`, `app.isPackaged`, `process.resourcesPath`.

```typescript
// packages/core/src/interfaces/paths.ts

/**
 * Provider interface for resolving filesystem paths.
 *
 * Desktop implements this with Electron app paths.
 * Backend implements this with environment variables or config.
 */
interface PathResolver {
  getUserDataDir(): string;
  getStorageDir(params: { projectId: string; serverName: string }): string;
  getRepoDir(params: { serverName: string }): string;
}
```

---

## Section 2: Engine Extraction

### 2.1 MCP Client (`mcp/client.ts`)

This is the largest file (~4100 lines). It extracts into core with the following changes:

**Moves to core as-is (no changes):**
- Connection management (`Map<string, McpConnection>`)
- StreamableHTTP transport handling (already platform-agnostic)
- Tool call execution, resource reading, caching
- Sampling request handling
- Storage method dispatch

**Requires provider injection (currently uses Electron APIs):**

| Current Electron usage | Replaced by |
|---|---|
| `app.getAppPath()`, `app.isPackaged` | `PathResolver` |
| `spawn()` for built-in/dev MCPs | `ProcessProvider` (desktop only) |
| `getMainWindow().webContents.send()` | `UINotifier` |
| `portManager` | Stays in desktop (only needed for local process MCPs) |
| `processRegistry` | Stays in desktop (only needed for local process MCPs) |

**Key architectural change:** The MCP client in core only handles `streamable-http` connections. Desktop wraps it and adds `stdio` + local process spawning for desktop-only MCPs. This is clean because the web/backend will *only* use streamable-http.

```typescript
// packages/core/src/engine/mcp/client.ts

/**
 * Create an MCP client manager.
 * Manages connections to MCP servers via streamable-http transport.
 * Desktop extends this with stdio transport for local MCPs.
 */
const createMcpClient = (params: {
  notifier: UINotifier;
  credentialProvider: CredentialProvider;
  storageProvider: StorageProvider;
  pathResolver: PathResolver;
}) => {
  // ... all current connection logic, minus spawn/process code
};
```

### 2.2 Control Plane (`mcp/controlPlane.ts`)

**Moves to core:**
- Pip instance registry (`Map<string, PipInstance>`)
- `resolveInstanceIdForToolCall()` (delegates to routing.ts, already pure)
- `handleToolCall()` logic (routing, pip creation/destruction)
- Rate limiting (from pip.handlers.ts)
- Widget state management

**Provider injection needed:**

| Current Electron usage | Replaced by |
|---|---|
| `mainWindowRef.webContents.send()` | `UINotifier.send()` |
| `getPopoutWindow()` | `UINotifier.sendToPip()` |
| `app.getAppPath()` for SDK docs | `PathResolver` |

### 2.3 Routing (`mcp/routing.ts`)

**Moves to core unchanged.** Already pure functions. Zero modifications.

### 2.4 Agent (`agent/`)

**Moves to core almost unchanged.** The agent code is already portable:
- `index.ts` — Uses Vercel AI SDK's `streamText`. No Electron deps (the `app` import is unused).
- `provider.ts` — Creates AI SDK providers. Pure function of credentials.
- `tools.ts` — Tool definitions. Portable.
- `contextCompaction.ts` — Token counting, message truncation. Portable.
- `profileInstructions.ts` — System prompt generation. Portable.

**One change:** `handleChatRequest()` currently calls `getCredentials()` which goes through IPC. In core, credentials are passed in:

```typescript
// packages/core/src/engine/agent/index.ts

const handleChatRequest = async (params: {
  messages: UIMessage[];
  folderPath: string | null;
  customInstructions: string | null;
  credentials: ProviderCredentials;
  sessionId: string;
  mcpTools: LanguageModelV3FunctionTool[];
  // ... other dependencies
}) => { ... };
```

### 2.5 Chat Server (`server/chatServer.ts`)

**Moves to core** as a factory function. This is the blueprint for the backend's chat endpoint.

```typescript
// packages/core/src/engine/server/chatHandler.ts

/**
 * Create a chat request handler using the Vercel AI SDK.
 * Returns a function compatible with Node.js http, Express, or Fastify.
 *
 * Desktop uses this in a local HTTP server.
 * Backend uses this in an Express/Fastify route handler.
 */
const createChatHandler = (params: {
  credentialProvider: CredentialProvider;
  mcpClient: McpClient;
  telemetryHandler?: TelemetryHandler;
}) => {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Same logic as current chatServer.ts
    // Uses pipeUIMessageStreamToResponse (Vercel AI SDK)
  };
};
```

The Vercel AI SDK's `streamText` and `pipeUIMessageStreamToResponse` work identically in Electron's Node.js and in a backend server. No changes to the streaming logic.

### 2.6 Settings Logic

**Moves to core:** Type definitions, defaults, `deepMerge`, `mergePartialSettings`, `themeToCssVariables`. These are all pure functions.

**Stays in providers:** File I/O (`loadStorage`, `saveStorage`). Desktop uses local files. Web uses database.

---

## Section 3: Shared React UI

### 3.1 The Problem

Every React component uses `window.electronAPI` directly:

```typescript
// Current (tightly coupled to Electron)
const configs = await window.electronAPI.mcp.getConfigs();
window.electronAPI.controlPlane.onPipCreated(handler);
```

### 3.2 The Solution: Platform API

Define a `PlatformAPI` interface in core that mirrors the current `window.electronAPI` shape. Provide it via React context. Components use a hook instead of a global.

```typescript
// packages/core/src/types/platformApi.ts

/**
 * Platform API interface.
 *
 * Defines all operations the UI layer can perform.
 * Desktop implements this via Electron IPC (same as current preload.ts).
 * Web implements this via HTTP/WebSocket to the backend.
 */
interface PlatformAPI {
  app: {
    getVersion(): Promise<string>;
    getPlatform(): Promise<string>;
  };

  auth: {
    getState(): Promise<AuthState>;
    saveCredentials(params: { credentials: ProviderCredentials }): Promise<void>;
    setChatModel(params: { model: ChatModelPreference }): Promise<void>;
    clearCredentials(): Promise<void>;
  };

  mcp: {
    getConfigs(): Promise<MCPServerConfig[]>;
    restart(params: { serverName: string }): Promise<void>;
    disable(params: { serverName: string }): Promise<void>;
    closeAll(): Promise<void>;
    getUIResources(): Promise<UIResource[]>;
    launchResourcePip(params: { serverName: string; uri: string }): Promise<void>;
    onRestarted(handler: (serverName: string) => void): () => void;
    onDisabled(handler: (serverName: string) => void): () => void;
    onStatus(handler: (data: McpStatusEvent) => void): () => void;
  };

  controlPlane: {
    closePip(params: { instanceId: string }): Promise<void>;
    pipReady(params: { instanceId: string }): Promise<void>;
    callTool(params: { serverName: string; toolName: string; args: unknown }): Promise<unknown>;
    getResourceHtml(params: { serverName: string; uri: string }): Promise<string>;
    readResource(params: { serverName: string; uri: string }): Promise<unknown>;
    onPipCreated(handler: (pip: McpPip) => void): () => void;
    onPipClosed(handler: (instanceId: string) => void): () => void;
    onToolInput(handler: (data: ToolInputEvent) => void): () => void;
    onToolResult(handler: (data: ToolResultEvent) => void): () => void;
    // ... remaining events
  };

  projects: {
    list(): Promise<Project[]>;
    get(params: { id: string }): Promise<Project>;
    create(params: { name: string; type: string }): Promise<Project>;
    update(params: { id: string; updates: Partial<Project> }): Promise<void>;
    delete(params: { id: string }): Promise<void>;
    open(params: { id: string }): Promise<void>;
  };

  settings: {
    get(): Promise<Settings>;
    update(params: { settings: Partial<SettingsFile> }): Promise<void>;
    getCssVariables(): Promise<Record<string, string>>;
    onChanged(handler: (settings: Settings) => void): () => void;
  };

  window: {
    popout(params: { instanceId: string }): Promise<void>;
    focusPopout(params: { instanceId: string }): Promise<void>;
  };

  /** Desktop-only capabilities. Null on web. */
  desktop: {
    selectFolder(): Promise<string | null>;
    selectFiles(): Promise<string[]>;
    searchFiles(params: { query: string; folderPath: string }): Promise<string[]>;
    shell: { openExternal(params: { url: string }): Promise<void> };
    devConsole: { openWindow(): Promise<void> };
    updater: {
      getPendingInfo(): Promise<UpdateInfo | null>;
      quitAndInstall(): Promise<void>;
    };
  } | null;
}
```

### 3.3 Usage in Components

```typescript
// Before (Electron-coupled)
const configs = await window.electronAPI.mcp.getConfigs();

// After (platform-agnostic)
const api = usePlatformAPI();
const configs = await api.mcp.getConfigs();
```

The `usePlatformAPI()` hook reads from a React context:

```typescript
// src/contexts/PlatformContext.tsx

const PlatformContext = createContext<PlatformAPI | null>(null);

const usePlatformAPI = (): PlatformAPI => {
  const api = useContext(PlatformContext);
  if (!api) throw new Error("PlatformAPI not provided");
  return api;
};
```

**Desktop provides:**
```typescript
// desktop/src/renderer.tsx
const electronAPI = createElectronPlatformAPI(); // wraps window.electronAPI
<PlatformProvider api={electronAPI}><App /></PlatformProvider>
```

**Web provides:**
```typescript
// web/src/main.tsx
const webAPI = createWebPlatformAPI({ baseUrl, wsUrl }); // wraps fetch + WebSocket
<PlatformProvider api={webAPI}><App /></PlatformProvider>
```

### 3.4 Desktop-Only Features in Shared Components

Components that use desktop-only features (file picker, terminal, IDE) check for availability:

```typescript
const api = usePlatformAPI();

// Desktop-only features are null on web
if (api.desktop) {
  const folder = await api.desktop.selectFolder();
}
```

This covers:
- File/folder selection dialogs
- Local file search
- Shell operations (open external URLs — web uses `window.open` instead)
- Dev console
- Auto-updater
- MCP app creation (desktop-only for now)

---

## Section 4: Agent on the Backend with Vercel AI SDK

### 4.1 Current Flow (Desktop)

```
Renderer → POST localhost:43891/api/chat
             ↓
         chatServer.ts
             ↓
         handleChatRequest() ← Vercel AI SDK streamText
             ↓
         pipeUIMessageStreamToResponse() → streams back to renderer
```

### 4.2 Backend Flow (Web)

Identical. The backend imports `createChatHandler` from `@creature/core` and mounts it:

```typescript
// Backend (Express example)
import { createChatHandler } from "@creature/core";

const chatHandler = createChatHandler({
  credentialProvider: dbCredentialProvider,
  mcpClient: mcpClient,
  telemetryHandler: serverTelemetry,
});

app.post("/api/chat", (req, res) => chatHandler(req, res));
```

The Vercel AI SDK's `streamText` and `pipeUIMessageStreamToResponse` are Node.js server-side functions. They work identically in Express, Fastify, or raw `http.createServer`. No browser APIs, no Electron APIs.

The web frontend uses `useChat` from `@ai-sdk/react`:

```typescript
const { messages, input, handleSubmit } = useChat({
  api: "https://api.yourdomain.com/api/chat",
  headers: { Authorization: `Bearer ${token}` },
});
```

Or the existing custom fetch-based approach — the AI SDK's streaming protocol is the same regardless of client-side consumption method.

### 4.3 Desktop Can Keep Local Agent

The desktop app continues running the local `chatServer.ts` in the Electron main process. No change needed initially. Optionally, the desktop can later be configured to point to the backend instead (useful for enterprises that want centralized credential management).

---

## Section 5: Settings for Web (Multi-tenant)

### 5.1 Merge Hierarchy

The existing merge hierarchy (defaults → enterprise → user) maps directly to the multi-tenant model:

| Layer | Desktop (current) | Web (new) |
|---|---|---|
| Defaults | Hardcoded in `settingsStore.ts` | Same defaults from `@creature/core` |
| Enterprise | Imported JSON file (optional) | Org row in database (per-subdomain) |
| User | Local JSON file | User row in database |

The `deepMerge` and `mergePartialSettings` functions from core handle the merge identically regardless of where the data comes from.

### 5.2 Web Settings Provider

```typescript
// Web backend settings provider

const createDbSettingsProvider = (params: {
  db: Database;
  orgId: string;
  userId: string;
}): SettingsProvider => ({
  loadStorage: async () => ({
    version: 1,
    enterprise: await params.db.getOrgSettings(params.orgId),
    user: await params.db.getUserSettings(params.userId),
  }),
  saveStorage: async ({ storage }) => {
    if (storage.user) {
      await params.db.setUserSettings(params.userId, storage.user);
    }
    // Enterprise settings are managed by org admins, not individual users
  },
});
```

### 5.3 Theme CSS Variables

`themeToCssVariables()` is already a pure function. It moves to core. Both desktop and web call it to generate CSS variable maps from resolved settings. The web frontend applies these the same way (inline styles on `<html>` or a `<style>` tag).

---

## Section 6: Desktop-Only Features

These stay in `desktop/` and are **not** extracted to core:

| Feature | Why desktop-only |
|---|---|
| IDE MCP (`mcps/ide/`) | Uses local filesystem + `@vscode/ripgrep` |
| Terminal MCP (`mcps/terminal/`) | Uses `node-pty` (native module) |
| Browser MCP (`mcps/browser/`) | Uses Electron `webview` tag |
| MCP App Development | Local `npm run dev`, file watchers, `tsx watch` |
| Local folder support | `selectFolder`, `searchFiles`, project file reads |
| Process registry | Orphan cleanup for locally-spawned MCP processes |
| Port manager | Local port allocation for dev MCP servers |
| Auto-updater | Electron-specific |
| Native menus, tray, dock | Electron-specific |
| Window management | `BrowserWindow`, popout windows |

The desktop app imports core, creates providers, and adds these features on top. The core library has no knowledge of any of them.

---

## Section 7: Testing

### 7.1 Core Library Tests

The primary goal of this extraction: testable without Electron or any server infrastructure.

```typescript
// Example: testing the control plane with mock providers
import { createControlPlane } from "@creature/core";

const mockNotifier = { send: vi.fn(), sendToPip: vi.fn() };
const mockStorage = createMockStorageProvider();

const cp = createControlPlane({
  notifier: mockNotifier,
  storageProvider: mockStorage,
});

// Test pip creation
await cp.handleToolCall({ serverName: "todos", toolName: "create_todo", args: { title: "test" } });
expect(mockNotifier.send).toHaveBeenCalledWith({
  channel: "pip:created",
  data: expect.objectContaining({ serverName: "todos" }),
});
```

```typescript
// Example: testing the agent with mock credentials
import { handleChatRequest } from "@creature/core";

const result = await handleChatRequest({
  messages: [{ role: "user", content: "Hello" }],
  credentials: { type: "anthropic", apiKey: "test-key" },
  // ...
});
// Assert on streamed response
```

```typescript
// Example: testing settings merge logic (pure functions, no mocking needed)
import { mergePartialSettings, getDefaultSettings } from "@creature/core";

const defaults = getDefaultSettings();
const enterprise = { branding: { appName: "Acme Corp" } };
const result = mergePartialSettings(defaults, enterprise);
expect(result.branding.appName).toBe("Acme Corp");
```

### 7.2 What This Unlocks

- **CI without Electron:** Core tests run in Node.js with vitest. No Electron binary, no display server, no native module compilation.
- **Backend team tests independently:** Import core, mock providers, test their integration without desktop infra.
- **Desktop tests are smaller:** Only test Electron-specific wiring (IPC handlers, window management), not business logic.

---

## Section 8: Migration Steps

Ordered by dependency. Each step is independently shippable — the desktop app keeps working after each step.

### Step 1: Create `packages/core` with interfaces and types

- Create `packages/core/` with `package.json`, `tsconfig.json`, `vitest.config.ts`
- Move `src/shared/types.ts`, `src/shared/credentials.ts`, `src/shared/embeddings.ts` to `packages/core/src/types/`
- Define all provider interfaces in `packages/core/src/interfaces/`
- Define `PlatformAPI` type in `packages/core/src/types/platformApi.ts`
- Desktop imports types from `@creature/core` via workspace reference
- **No behavior changes.** Just type definitions.

### Step 2: Extract settings logic

- Move type definitions (`Settings`, `ThemeSettings`, etc.) to core
- Move pure functions (`deepMerge`, `mergePartialSettings`, `getDefaultSettings`, `themeToCssVariables`) to core
- Create `ElectronSettingsProvider` in desktop that implements `SettingsProvider` using the existing file I/O
- Desktop's `settingsStore.ts` becomes a thin wrapper: provider + core logic
- **Write tests** for merge logic and CSS variable generation
- **No behavior changes.** Settings work exactly as before.

### Step 3: Extract agent

- Move `agent/index.ts`, `agent/provider.ts`, `agent/tools.ts`, `agent/contextCompaction.ts`, `agent/profileInstructions.ts` to core
- Remove unused `app` import
- Change `handleChatRequest` to accept credentials as a parameter instead of calling `getCredentials()` internally
- Extract `chatServer.ts` handler logic into `createChatHandler` factory
- Desktop's `chatServer.ts` calls `createChatHandler` with `ElectronCredentialProvider`
- **Write tests** for agent with mock credentials
- **No behavior changes.** Chat works exactly as before.

### Step 4: Extract MCP routing and storage

- Move `mcp/routing.ts` to core (zero changes, pure functions)
- Move `mcp/storage.ts` dispatch logic to core
- Move `storage/kvSqlite.ts` and `storage/vectorSqlite.ts` to core (they're already portable, use `node:sqlite`)
- Create `StorageProvider` implementations in desktop
- **Write tests** for routing logic and storage dispatch
- **No behavior changes.**

### Step 5: Extract control plane

- Move `mcp/controlPlane.ts` to core
- Replace `BrowserWindow.webContents.send()` with `UINotifier.send()`
- Replace `getPopoutWindow()` with `UINotifier.sendToPip()`
- Replace `app.getAppPath()` with `PathResolver`
- Create `ElectronNotifier` in desktop that implements `UINotifier` via IPC
- Move rate limiting logic from `pip.handlers.ts` into core control plane
- **Write tests** for pip lifecycle, routing, rate limiting
- **No behavior changes.**

### Step 6: Extract MCP client (streamable-http only)

- Extract the streamable-http connection logic from `client.ts` into core
- Leave stdio/spawn logic in desktop as a desktop-specific extension
- Core's MCP client handles: connection management, tool calls, resource reads, caching, sampling
- Desktop extends it with: process spawning, port management, process registry, dev MCP detection, stdout watching
- **Write tests** for connection management with mock transports
- **No behavior changes.**

### Step 7: Introduce PlatformAPI in React UI

- Create `PlatformContext` with `usePlatformAPI()` hook
- Create `ElectronPlatformAPI` that wraps `window.electronAPI` (trivial mapping)
- Wrap the app with `<PlatformProvider api={electronAPI}>`
- Migrate components from `window.electronAPI.X` to `usePlatformAPI().X`
  - This is a mechanical find-and-replace across ~15 component files
  - Each component's behavior is identical
- Guard desktop-only features with `api.desktop` null checks
- **Write tests** for components with mock PlatformAPI
- **No behavior changes.**

### Step 8: Web app consumes core

- Backend team imports `@creature/core`
- Implements `CredentialProvider`, `StorageProvider`, `SettingsProvider` backed by their database
- Mounts `createChatHandler` on their Express/Fastify server
- Creates MCP client pointing to hosted MCP servers (streamable-http)
- Web frontend creates `WebPlatformAPI` (HTTP/WebSocket implementation)
- Wraps shared React components with `<PlatformProvider api={webAPI}>`
- Desktop-only features are hidden (null desktop property)

---

## What This Does NOT Cover

- **MCP app development on web** — Deferred. Desktop-only for now.
- **MCP app deployment (GitHub Actions)** — Separate initiative. Uses the Deploy API, not this library.
- **Backend infrastructure** — Auth, database, K8s hosting are handled by the other team. This proposal defines the interfaces they implement.
- **Cloud terminal/browser/IDE** — Not planned. These MCPs are desktop-only.

---

## Risks

1. **MCP client is large (~4100 lines).** Extracting the streamable-http subset cleanly requires careful refactoring. The stdio/spawn code is deeply interleaved. Recommend extracting connection-by-connection, not all at once.

2. **`window.electronAPI` is used in ~15 component files.** The migration to `usePlatformAPI()` is mechanical but touches many files. Do it in one PR to avoid a long period of mixed usage.

3. **Implicit dependencies in `client.ts`.** The MCP client imports from 15+ modules across the codebase. Some of these (like `logAggregator`, `telemetry`) need their own lightweight interfaces or become optional injections.
