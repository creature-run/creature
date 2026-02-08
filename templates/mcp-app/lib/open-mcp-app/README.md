# open-mcp-app

SDK for building MCP Apps that work on any MCP App host (Creature, ChatGPT, Claude Desktop).

## Installation

```bash
npm install open-mcp-app
```

## Quick Start

### Server-side (Express)

```typescript
import { createApp } from "open-mcp-app/server";
import { z } from "zod";

const app = createApp({ name: "My App", version: "1.0.0" })
  .tool("greet", {
    description: "Greet a user",
    parameters: z.object({ name: z.string() }),
    execute: async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}!` }],
    }),
  })
  .build();

app.listen(3000);
```

### Client-side (React)

```tsx
import { HostProvider, useHost } from "open-mcp-app/react";

function App() {
  return (
    <HostProvider name="My App">
      <MyWidget />
    </HostProvider>
  );
}

function MyWidget() {
  const host = useHost();
  
  const handleClick = async () => {
    const result = await host.callTool("greet", { name: "World" });
    console.log(result);
  };
  
  return <button onClick={handleClick}>Greet</button>;
}
```

## Host Compatibility

| Feature | Creature | ChatGPT | Claude Desktop |
|---------|----------|---------|----------------|
| Tool Calls | ✅ | ✅ | ✅ |
| Display Modes | ✅ | ✅ | ❌ |
| Widget State | ✅ | ✅ | ✅ |
| Update Model Context | ✅ | ✅ | ✅ |
| Multi-Instance | ✅ | ❌ | ❌ |
| Theme Sync | ✅ | ❌ | ✅ |

## Core Concepts

### Widget State

Persist UI state across sessions using `widgetState`. Supports two segments:

- **modelContent**: Visible to the AI model in future turns
- **privateContent**: UI-only, hidden from the model

```tsx
const host = useHost();

// Set widget state
host.exp.setWidgetState({
  modelContent: "User is on the settings page",
  privateContent: { theme: "dark", collapsed: false },
});

// Read current state
const state = host.widgetState;
```

### Update Model Context

Explicitly inform the AI model about user actions without triggering an immediate response. Use this when the UI needs the model to know about important interactions (file selections, preferences, etc.) for future turns.

```tsx
const { updateModelContext } = useHost();

// Inform the model about a user action
await updateModelContext([
  { type: "text", text: "User selected file: /src/App.tsx" },
]);
```

**Host Behavior:**
- **Creature**: Sends `ui/update-model-context` notification per MCP Apps spec
- **ChatGPT**: Maps to `setWidgetState` per their MCP Apps compatibility layer
- **Claude Desktop**: Supported via MCP Apps protocol

### Tool Visibility

Control whether tools are available to the model, UI, or both:

```typescript
.tool("search_internal", {
  description: "Search internal data",
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ ... }),
  visibility: "app",  // UI-only tool, hidden from AI
})
```

Visibility options:
- `"model"` (default): AI can call the tool
- `"app"`: UI-only, hidden from AI
- `["model", "app"]`: Available to both

## Entry Points

Import from specific subpaths:

```typescript
import { createApp } from "open-mcp-app/server";  // Server-side
import { createHost } from "open-mcp-app/core";   // Vanilla JS client
import { useHost } from "open-mcp-app/react";     // React hooks
import { mcpAppPlugin } from "open-mcp-app/vite"; // Vite plugin
import "open-mcp-app/styles/tailwind.css";        // Base styles
```

## Development

### With Vite

```typescript
// vite.config.ts
import { mcpAppPlugin } from "open-mcp-app/vite";

export default {
  plugins: [mcpAppPlugin()],
};
```

The Vite plugin provides:
- Hot Module Replacement in the Creature iframe
- Automatic port discovery between UI and server
- Development proxy configuration

## License

MIT
