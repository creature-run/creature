<img width="3000" height="1000" alt="creautre-github" src="https://github.com/user-attachments/assets/3f81630d-c468-4ad0-a158-01e9bb991f47" />


**MCP Apps** — Visual AI tools that agents summon to show content relevant to your task—tools you use collaboratively, with the agent ready to pick up exactly where you leave off. Based on an open specification supported by all major AI companies.

**Creature** — The desktop client that pushes MCP Apps to their full potential, realizing a vision of an AI operating system. Work with multiple apps in persistent tabs alongside your conversation, achieving productivity and clarity that chat alone cannot offer.

**Built for Teams** — For teams and companies creating internal tools on this AI operating system. Build and share MCP Apps across your organization—putting visual AI in everyone's hands, not just developers.

## Download

- [Mac (Apple Silicon)](https://releases.creature.run/desktop/latest/Creature-latest-arm64.dmg)
- [Windows](https://releases.creature.run/desktop/latest/Creature-latest-Setup.exe)
- [Linux](https://releases.creature.run/desktop/latest/Creature-latest.AppImage)

## Quickstart (Development)

```bash
# Install dependencies from the monorepo root
npm install

# Run the desktop app in development mode
npm run dev:desktop
```

## Build Your Own MCP Apps

Creature uses the [open-mcp-app](./artifacts) SDK—build your MCP App once, run it anywhere. Create interactive UI apps for AI agents that work across ChatGPT, Claude, Creature, and any host supporting the MCP Apps specification.

```bash
npm install open-mcp-app
```

Check out the included examples in [/artifacts/mcp-apps](./artifacts/mcp-apps):
- **todos** - Simple todo list with CRUD operations
- **notes** - Markdown notes with editor and list views
- **crm** - Customer relationship manager with search

## Learn More

- [Website](https://creature.run)
- [open-mcp-app SDK](./artifacts)
- [License](./LICENSE)
