# open-mcp-app Knowledge Base

## OVERVIEW
Multi-entry SDK for building Model Context Protocol (MCP) Apps compatible with Creature and ChatGPT. Provides cross-platform abstraction for tools, resources, and UI widgets.

## STRUCTURE
- `src/server`: Express-based server for hosting MCP apps and registering capabilities.
- `src/core`: Vanilla JS host clients and environment detection logic.
- `src/react`: React hooks for UI-host interaction and synchronized state.
- `src/vite`: Vite plugin for HMR and development workflow optimization.

## WHERE TO LOOK
| Entry Point | Core File | Responsibility |
|-------------|-----------|----------------|
| `open-mcp-app/server` | `src/server/app.ts` | `createApp` builder, tool/resource registry. |
| `open-mcp-app/core` | `src/core/index.ts` | `createHost` factory, protocol detection. |
| `open-mcp-app/react` | `src/react/index.ts` | `useHost`, `useToolResult`, `useWebSocket`. |
| `open-mcp-app/vite` | `src/vite/index.ts` | HMR proxy and dev server injection. |

## CONVENTIONS
- Entry-point Imports: Import from specific subpaths (e.g., `/server`), never root.
- Strict Zod Validation: All tool inputs and widget states must use Zod schemas.
- Error Handling: Use SDK error classes for protocol-compliant responses.
- Environment Detection: Automatic switching between SEP-1865 (Creature) and ChatGPT.

## KEY PATTERNS
### Fluent Builder (`createApp`)
Server-side app configuration via chainable API. Handles tool registration, resource mapping, and automatic metadata injection for multi-host compatibility.

### Host Factory (`createHost`)
Client-side factory that auto-detects the execution environment (Creature iframe vs ChatGPT web) and returns the appropriate protocol implementation.

### Widget State Persistence
`useHost().widgetState` and `useHost().setWidgetState` provide synchronized, persistent state leveraging host-provided storage. Widget state supports `modelContent` (visible to AI) and `privateContent` (UI only) segments.

### Metadata Injection
The SDK automatically injects protocol-specific metadata into tool results and resource responses (e.g., `openai/outputTemplate`, `ui.resourceUri`).

### Environment Detection Logic
Core uses `detectEnvironment()` to check for `window.__CREATURE_HOST__` or ChatGPT-specific globals to instantiate the correct `HostClient`.

### HMR Integration
`open-mcp-app/vite` injects a dev-only client script into resources, enabling live UI updates without restarting the MCP server or refreshing the host.

## TECHNICAL NOTES
- Protocol Translation: Maps MCP `structuredContent` to host-specific UI requirements.
- Capability Negotiation: Handles variations in theming, display modes, and icons across hosts.
- State Sync: `useHost().setWidgetState` triggers host-side persistence and state restoration on PIP refresh.
- HMR Architecture: Uses `hmr.json` for port discovery between Vite and the Express server.
- MIME Types: Uses `text/html;profile=mcp-app` (MCP Apps) and `text/html;profile=skybridge` (ChatGPT).
- Session Management: Manages SSE/HTTP transports via `StreamableHTTPServerTransport`.
- Icon Handling: Converts SVG icons to Data URIs for cross-platform rendering.

## SPECIFICATION COMPLIANCE
- MCP Apps (SEP-1865): Protocol version 2025-11-21 - Full support
- ChatGPT Apps SDK: Version 1.x - Cross-platform bridge via `window.openai`
- See `/docs/mcp-apps-spec.md` and `/docs/chatgpt-apps-spec.md` for detailed compliance tracking
