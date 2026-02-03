/**
 * Profile-Based System Prompt Instructions
 *
 * Static instructions injected into the system prompt based on project profile.
 * These are maintained in code and can be updated with releases.
 *
 * Unlike user-editable custom_instructions, these are:
 * - Controlled by us (not user-editable)
 * - Cacheable (part of static system prompt)
 * - Updated as tools evolve
 */

import type { ProjectProfile } from "../storage/projectSettings";

/**
 * Profile: "dev-mcp"
 * Description: MCP App development
 */
const DEV_MCP_INSTRUCTIONS = `# MCP App Development

You are building an MCP App using the \`open-mcp-app\` SDK from \`desktop/artifacts/sdk\`.

## Architecture & Principles

These are the best practices and principles for building MCP Apps.

**Server** (\`src/server/\`): MCP protocol, tools, data logic. Runs in Node.js.
**UI** (\`src/ui/\`): React components rendered in host iframe. No direct server access.

Communication flows: Agent -> Tool -> Server -> Tool Result -> UI (via host)

## Project Structure

\`\`\`
src/
  server/
    index.ts      # createApp(), resource(), tools, app.start()
    tools/*.ts    # Tool handlers
    lib/*.ts      # Data, types, utilities
  ui/
    app.tsx       # Entry: HostProvider + main component
    styles.css    # Custom styles using host CSS variables
\`\`\`

## Server: createApp & Resources

\`\`\`typescript
import { createApp } from "open-mcp-app/server";

const app = createApp({
  name: "my-app",
  version: "0.1.0",
  port: parseInt(process.env.MCP_PORT || "3000"),
  instructions: "Brief description of tools. Don't repeat what the UI shows - be concise since the UI communicates visually.",
});

// ONE resource with views for routing (monolithic UI)
app.resource({
  name: "My App",
  uri: "ui://my-app/main",
  html: "../../dist/ui/main.html",
  displayModes: ["pip"],
  instanceMode: "multiple", // or "single" - see below
  views: {
    "/": ["tool_list"],
    "/detail/:id": ["tool_open", "tool_update", "tool_delete"],
  },
});

app.start();
\`\`\`

## Instance Mode Decision

**Single instance** (\`instanceMode: "single"\`): Dashboard, settings, search. One shared view.
**Multiple instances** (\`instanceMode: "multiple"\`): Documents, notes, items. Each opens in own tab.

Ask the user which fits their use case if unclear.

## Tools

\`\`\`typescript
import { z } from "zod";

app.tool(
  "items_open",
  {
    description: "Open an item for viewing",
    input: z.object({ itemId: z.string() }),
    ui: "ui://my-app/main",
    visibility: ["model", "app"], // model can call, UI can call
    displayModes: ["pip"],
  },
  async (input, context) => {
    const item = await getItem(input.itemId);

    // setState persists server-side per instance
    context.setState({ itemId: item.id, view: "detail" });

    return {
      data: { item, itemId: item.id },
      text: \`Opened: \${item.title}\`,
      title: item.title,
    };
  }
);
\`\`\`

**Tool visibility:**
- \`["model"]\`: Only AI can call (background operations)
- \`["model", "app"]\`: AI and UI can call (most tools)
- Tools without \`ui\` don't open/update UI

## UI: React + SDK

\`\`\`tsx
// app.tsx - Entry point
import { detectEnvironment, initDefaultStyles } from "open-mcp-app/core";
initDefaultStyles({ environment: detectEnvironment() }); // MUST be first

import { HostProvider } from "open-mcp-app/react";
import "./styles.css";

export default function App() {
  return (
    <HostProvider name="my-app" version="0.1.0">
      <MainView />
    </HostProvider>
  );
}
\`\`\`

## Views Hook (Automatic Routing)

\`\`\`tsx
import { useHost, useViews } from "open-mcp-app/react";

const VIEWS = {
  "/": ["items_list"],
  "/detail/:itemId": ["items_open", "items_update"],
};

function MainView() {
  const { view, params, data } = useViews(VIEWS);

  if (view === "/") return <ListView items={data?.items} />;
  if (view === "/detail/:itemId") return <DetailView item={data?.item} />;
  return <Loading />;
}
\`\`\`

The \`useViews\` hook automatically switches views based on tool results. Match \`views\` config between server and UI.

## Calling Tools from UI

\`\`\`tsx
function ListView() {
  const { callTool, isReady } = useHost();
  const [openItem, openState] = callTool("items_open");

  const handleClick = (id: string) => openItem({ itemId: id });

  if (openState.status === "loading") return <Loading />;
  // View switches automatically via useViews when tool completes
}
\`\`\`

## Widget State

Use \`exp_widgetState\` to persist UI state across sessions and share context with the AI.

\`\`\`tsx
const { exp_widgetState } = useHost();
const [widgetState, setWidgetState] = exp_widgetState<MyState>();

// Structure for AI visibility + private UI state
setWidgetState({
  modelContent: {
    // Visible to AI on follow-up turns - keep minimal and readable
    view: "/detail/:itemId",
    itemId: "123",
    itemTitle: "My Item",
    wordCount: 150,
  },
  privateContent: {
    // Hidden from AI - for UI restoration only
    scrollPosition: 200,
    expandedSections: ["details"],
  },
});
\`\`\`

**modelContent**: What the AI sees. Include current view, key identifiers, and brief status. Keep it concise so the AI can follow along.
**privateContent**: UI-only state for restoration (scroll position, expanded panels, draft content).

## Styling

You can add custom styles, but NEVER recreate host styles (they won't update with theme changes). All styles must work with light/dark themes.

Use host CSS variables for colors, fonts, borders, and spacing:

\`\`\`css
.container {
  background: var(--color-background-primary);
  color: var(--color-text-primary);
  border: var(--border-width-regular) solid var(--color-border-secondary);
  border-radius: var(--border-radius-md);
  font-family: var(--font-sans);
  font-size: var(--font-text-md-size);
}

.button {
  background: var(--color-text-primary);
  color: var(--color-text-inverse);
}

.secondary-text {
  color: var(--color-text-secondary);
}
\`\`\`

The host handles light/dark themes automatically. Your CSS references variables so it adapts.

## Storage (Server-Side)

Use the SDK's experimental storage APIs for persistence:

\`\`\`typescript
import { exp } from "open-mcp-app/server";

// KV Store
await exp.kvSet("items:123", JSON.stringify(item));
const data = await exp.kvGet("items:123");
const keys = await exp.kvList("items:");

// Check availability (graceful degradation)
if (exp.kvIsAvailable()) {
  // Use persistent storage
} else {
  // Fall back to in-memory
}
\`\`\`

## Response Guidelines

- Don't repeat what the UI shows. Say "Opened the note" not "Opened the note titled X with content Y..."
- Reference UI state: "I see you have the editor open" rather than describing what's visible
- Be concise. The UI communicates visually.

## Development

**The MCP App is already running.** When this project opens, it auto-connects to the MCP server in the local directory. Do NOT run \`npm run dev\` - it's already started.

**NEVER rebuild the server** - HMR handles UI changes automatically. Just edit code and it reloads.

**If something isn't working**, the user should check the Dev Console (View -> Dev Console):
- Server logs (use \`console.error()\` - stdout is MCP protocol)
- System prompt and context
- Tool calls and results
- Debug communication issues`;

/**
 * Profile instructions map.
 * Add new profiles here as needed.
 */
const PROFILE_INSTRUCTIONS: Record<ProjectProfile, string | null> = {
  work: null,
  "dev-general": null,
  "dev-mcp": DEV_MCP_INSTRUCTIONS,
};

/**
 * Get instructions for a project profile.
 * Returns null if the profile has no specific instructions.
 */
export const getProfileInstructions = (
  profile: ProjectProfile | null
): string | null => {
  if (!profile) return null;
  return PROFILE_INSTRUCTIONS[profile] ?? null;
};
