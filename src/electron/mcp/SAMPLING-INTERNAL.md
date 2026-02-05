# MCP Sampling (Creature Internal)

This document describes how MCP sampling is implemented inside Creature.

## Overview

Sampling allows an MCP server to ask the Host to generate a model response. The Host mediates approval and returns the final response back to the MCP server.

Creature implements sampling via the MCP `sampling/createMessage` request and a user approval UI embedded in the chat input.

## Request Flow

1. MCP server calls `experimental.sampleMessage` (SDK) which sends `sampling/createMessage`.
2. `desktop/src/electron/mcp/client.ts` receives the request and builds a prompt from:
   - `messages`
   - `systemPrompt` (optional)
   - `includeContext` (optional)
3. The Host requests user approval via `desktop/src/electron/mcp/sampling.ts`.
4. UI shows the approval state in the chat input (`desktop/src/components/ChatInput.tsx`).
5. On approval, the Host calls the model and returns a `sampling/createMessage` result.
6. The MCP server receives the final content blocks in its tool handler.

## UI/Approval

- The approval UI replaces the chat input while a sampling request is pending.
- The user can edit the message before approving.
- The approval state is managed in `desktop/src/App.tsx` and `desktop/src/components/ViewChat.tsx`.

## Result Normalization

- The Host normalizes the response content to MCP content blocks in `desktop/src/electron/mcp/client.ts`.
- If no tool blocks are present, the response collapses to a single text content block.

## Key Files

- Host request handling: `desktop/src/electron/mcp/client.ts`
- Approval state + IPC: `desktop/src/electron/mcp/sampling.ts`
- IPC handlers: `desktop/src/electron/ipc/sampling.handlers.ts`
- UI approval view: `desktop/src/components/ChatInput.tsx`
- Chat wiring: `desktop/src/components/ViewChat.tsx`, `desktop/src/App.tsx`

## SDK Mapping

- SDK entrypoint: `desktop/artifacts/sdk/src/server/experimental.ts`
- API: `exp.sampleMessage(...)` → MCP `sampling/createMessage`

## Testing

- Sampling tester MCP app: `desktop/artifacts/mcp-apps/sampling-tester`
- Use `sampling_test` tool and verify:
  - Approval UI appears in chat input
  - Result is returned to the MCP server
  - Pip instance opens and renders (if configured)
