<a href="https://creature.run"><img width="3000" height="1000" alt="creautre-github" src="https://github.com/user-attachments/assets/3f81630d-c468-4ad0-a158-01e9bb991f47" /></a>

**Beta:** This software is currently in-development and has not been officially released.

**MCP Apps** — Visual AI tools that agents summon to show content relevant to your task—tools you use collaboratively, with the agent ready to pick up exactly where you leave off. Based on an open specification supported by all major AI companies.

**Creature** — The desktop client that pushes MCP Apps to their full potential, realizing a vision of an AI operating system. Work with multiple apps in persistent tabs alongside your conversation, achieving productivity and clarity that chat alone cannot offer.

**Built for Teams** — For teams and companies creating internal tools on this AI operating system. Build and share MCP Apps across your organization—putting visual AI in everyone's hands, not just developers.

[Website](https://creature.run) | [X](https://x.com/creature_app) | [Discord](https://discord.gg/qXHJygtxNS)

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

## Features

- **Build MCP Apps** — Templates, hot module reloading, a simple SDK, and AI guidance help you and your team rapidly vibe code MCP Apps with ease.
- **Share Apps Across Your Org** — Distribute MCP Apps privately to your team or organization. Build once, deploy to everyone who needs it.
- **Use MCP Apps** — Advanced MCP Apps support with tabbed interfaces, clickable app icons for discovery, and the ability to run multiple instances of the same app simultaneously.
- **On-Premise** — Runs locally on your machine with no cloud connection except to AI providers and any cloud-based MCPs you choose. Local, private, and safe by default.
- **Built-in App Storage** — Secure storage for app data and files that is local by default. Your team can also host the Creature storage extension on-premise.
- **Bring Your Own Model** — No per-token charges. Bring your own AI models via API keys and pay only fixed team-seat pricing for Creature.
- **Open MCP Apps** — Built on the [open-mcp-app SDK](./artifacts). Create apps that work on Creature, ChatGPT Apps, Anthropic's Claude, and more. Build once, run everywhere.
- **Multi-model** — Supports multiple AI models, starting with Anthropic Sonnet and Opus. More models coming soon to give users choice.
- **Extensible** — Extensions available for cloud storage, MCP App hosting, SSO, and more.
- **Brandable** — Customize Creature with your company's styling, making it feel like a purpose-built tool for your organization.
- **Resellable** — Resell Creature with private MCP Apps and support to your customers.
- **SOC 2 Compliant** — Creature meets SOC 2 Type 1 standards for security, availability, and confidentiality — giving your team enterprise-grade assurance.

## Build Your Own MCP Apps

Creature uses the [open-mcp-app](./artifacts) SDK—build your MCP App once, run it anywhere. Create interactive UI apps for AI agents that work across ChatGPT, Claude, Creature, and any host supporting the MCP Apps specification.

```bash
npm install open-mcp-app
```

## Learn More

- [Website](https://creature.run)
- [open-mcp-app SDK](./artifacts)
