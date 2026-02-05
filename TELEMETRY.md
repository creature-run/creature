# Creature Desktop Telemetry

Anonymous product analytics collected from the Creature desktop app. All events are sent without user authentication and contain no personally identifiable information (PII).

## Common Properties (All Events)

Every telemetry batch includes these properties automatically:

| Property | Type | Description |
|----------|------|-------------|
| `installId` | string | Persistent anonymous UUID generated on first launch, stored in userData |
| `sessionId` | string | Random UUID generated per app launch |
| `app.version` | string | Creature app version (e.g., "1.0.0") |
| `app.platform` | string | Operating system (`darwin`, `win32`, `linux`) |
| `app.arch` | string | CPU architecture (`arm64`, `x64`) |
| `app.isPackaged` | boolean | Whether running as packaged app (true) or dev mode (false) |

---

## App Lifecycle Events

### `app_start`

Fired immediately when the telemetry client initializes (on app ready).

| Property | Type | Description |
|----------|------|-------------|
| *(none)* | - | No additional properties |

### `app_ready`

Fired after the main window is created and the app is fully initialized.

| Property | Type | Description |
|----------|------|-------------|
| `startup_ms` | number | Time in milliseconds from process start to app ready |

### `app_quit`

Fired when the app begins shutdown (before-quit event).

| Property | Type | Description |
|----------|------|-------------|
| *(none)* | - | No additional properties |

---

## Error Events

### `error_uncaught`

Fired when an uncaught exception or unhandled promise rejection occurs.

| Property | Type | Description |
|----------|------|-------------|
| `type` | string | Either `"exception"` or `"rejection"` |
| `name` | string | Error name (e.g., `"TypeError"`, `"Error"`) |
| `message` | string | Error message (truncated to 500 chars) |

---

## Project Events

### `project_create`

Fired when a new project is created.

| Property | Type | Description |
|----------|------|-------------|
| `profile` | string | Project profile type (`"coding"`, `"dev-mcp"`, `"general"`) |

### `project_open`

Fired when a project is opened.

| Property | Type | Description |
|----------|------|-------------|
| `profile` | string | Project profile type |
| `workspace_roots_count` | number | Number of workspace roots (directories) in the project |
| `has_local_directory` | boolean | Whether the project has a local directory set |

### `project_delete`

Fired when a project is deleted.

| Property | Type | Description |
|----------|------|-------------|
| `is_app_managed` | boolean | Whether the project folder was managed by Creature (in userData) |

---

## MCP Events

### `mcp_create_from_template`

Fired when creating a new MCP app from the example template.

| Property | Type | Description |
|----------|------|-------------|
| `success` | boolean | Whether the creation succeeded |

### `mcp_restart`

Fired when an MCP server is restarted.

| Property | Type | Description |
|----------|------|-------------|
| `server_name` | string | Name of the MCP server |

### `mcp_close_all`

Fired when all MCP connections are closed (e.g., navigating away from a project).

| Property | Type | Description |
|----------|------|-------------|
| *(none)* | - | No additional properties |

### `mcp_launch_resource_pip`

Fired when launching a pip (tab) for an MCP UI resource.

| Property | Type | Description |
|----------|------|-------------|
| `server_name` | string | Name of the MCP server |
| `success` | boolean | Whether the pip launch succeeded |

### `mcp_tool_call`

Fired for every MCP tool call (e.g., terminal_run, readFile, browser_navigate).

| Property | Type | Description |
|----------|------|-------------|
| `server_name` | string | Name of the MCP server |
| `tool_name` | string | Name of the tool called |
| `duration_ms` | number | Time in milliseconds to execute the tool call |
| `success` | boolean | Whether the tool call succeeded |
| `error_type` | string | Error type name if failed (optional) |
| `was_retry` | boolean | Whether this was a retry after session reconnection (optional) |

---

## Agent Events

### `agent_completion`

Fired on every AI agent completion (success or failure).

| Property | Type | Description |
|----------|------|-------------|
| `version` | string | Creature app version |
| `provider` | string | AI provider type (`"anthropic"`, `"bedrock"`, `"vertex"`) |
| `custom_instructions_set` | boolean | Whether custom instructions were provided |
| `mcp_count` | number | Number of configured MCPs |
| `success` | boolean | Whether the completion succeeded |
| `error_name` | string | Error name if failed (optional) |
| `input_tokens` | number | Input token count (only on success) |
| `output_tokens` | number | Output token count (only on success) |

---

## Data Flow

```
Desktop App                          Platform API                    MongoDB
┌─────────────────┐                 ┌─────────────────┐            ┌─────────────┐
│                 │                 │                 │            │             │
│  telemetry/     │   HTTP POST     │  POST /core/v1/ │   insert   │ telemetry_  │
│  client.ts      │ ─────────────▶  │  telemetry/     │ ─────────▶ │ events      │
│                 │   (batched)     │  events         │            │             │
│  SQLite Queue   │                 │                 │            │             │
│  (durable)      │                 │  (no auth)      │            │             │
└─────────────────┘                 └─────────────────┘            └─────────────┘
```

### Batching Behavior

- Events are queued locally in SQLite under `userData/telemetry/queue.sqlite`
- Batches are flushed every 10 seconds or on app quit
- Maximum batch size: 100 events
- Network errors trigger exponential backoff (1s → 60s max)
- Events persist across app restarts until successfully sent

---

## Privacy Notes

- **No PII**: No usernames, emails, or account identifiers are collected
- **No file paths**: Absolute paths are never sent (only counts and booleans)
- **No content**: Message content, code, or file contents are never sent
- **Anonymous IDs**: `installId` is a random UUID with no link to user identity
- **Server-side sanitization**: Props are sanitized to remove any path-like strings

---

## MongoDB Schema

Events are stored with the following document structure:

```javascript
{
  install_id: string,      // From batch envelope
  session_id: string,      // From batch envelope
  name: string,            // Event name (e.g., "app_start")
  ts: Date,                // Client timestamp
  received_at: Date,       // Server timestamp
  app_version: string,     // From batch envelope
  platform: string,        // From batch envelope
  arch: string,            // From batch envelope
  is_packaged: boolean,    // From batch envelope
  props: object | null     // Event-specific properties
}
```

### Indexes

- `{ install_id: 1, ts: -1 }` - Query events by installation
- `{ name: 1, ts: -1 }` - Query events by type
- `{ received_at: -1 }` - Query recent events
