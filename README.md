<img width="3000" height="1050" alt="creature-github" src="https://github.com/user-attachments/assets/09956819-322f-4de3-bd45-63f285456d4f" />

# Creature

MCP Apps are visual AI tools that agents can summon to show you content relevant to your current task, and that you can use collaboratively, with the agent ready to pick up exactly where you leave off.

Creature is a desktop client that pushes the MCP Apps specification to its full potential, realizing a vision of an AI operating system. Users work with multiple apps simultaneously in persistent tabs alongside their agent conversation. The result: a collaborative workspace where humans and agents move fluidly across visual tools, achieving a level of productivity and clarity that chat alone cannot offer.

Creature is built for teams and companies seeking to create internal tools on top of this AI operating system. Just as users and agents collaborate seamlessly within the workspace, Creature enables entire organizations to create and share MCP Apps, putting visual AI tools in the hands of everyone, not just developers.

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
