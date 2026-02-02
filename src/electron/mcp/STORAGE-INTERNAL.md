# MCP Storage System - Internal Documentation

This document describes the internal architecture of the MCP storage system, a Creature-specific extension that enables MCPs to persist data on the user's machine.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Creature Desktop                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────┐    ┌──────────────────┐                       │
│  │  Project Handler │───▶│   MCP Manager    │                       │
│  │  (project.ts)    │    │   (client.ts)    │                       │
│  └──────────────────┘    └────────┬─────────┘                       │
│                                   │                                  │
│         projectId                 │ initMcpsForProject(projectId)   │
│                                   ▼                                  │
│                     ┌─────────────────────────┐                     │
│                     │  currentProjectId state │                     │
│                     └─────────────────────────┘                     │
│                                   │                                  │
│              ┌────────────────────┼────────────────────┐            │
│              │                    │                    │            │
│              ▼                    ▼                    ▼            │
│   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│   │  stdio transport │  │  HTTP transport  │  │ Storage Handlers │ │
│   │  (local MCPs)    │  │  (local MCPs)    │  │   (storage.ts)   │ │
│   └────────┬─────────┘  └────────┬─────────┘  └──────────────────┘ │
│            │                     │                                  │
│            │ env vars            │ env vars                         │
│            ▼                     ▼                                  │
│   CREATURE_PROJECT_ID    CREATURE_PROJECT_ID                        │
│   CREATURE_MCP_SERVER_NAME  CREATURE_MCP_SERVER_NAME               │
│   CREATURE_MCP_STORAGE_DIR  CREATURE_MCP_STORAGE_DIR               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          MCP Process                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │                     SDK experimental.ts                       │  │
│   │                                                               │  │
│   │  experimental_kvGet/Set/Delete/List                          │  │
│   │  experimental_blobPut/Get/Delete/List                        │  │
│   │                                                               │  │
│   │  ┌─────────────────────────────────────────────────────────┐ │  │
│   │  │  if (CREATURE_MCP_STORAGE_DIR) {                        │ │  │
│   │  │    // Use local filesystem                              │ │  │
│   │  │    read/write to storageDir/kv.json                     │ │  │
│   │  │    read/write to storageDir/blobs/*                     │ │  │
│   │  │  } else {                                                │ │  │
│   │  │    // Storage unavailable                               │ │  │
│   │  │    return null / false                                  │ │  │
│   │  │  }                                                       │ │  │
│   │  └─────────────────────────────────────────────────────────┘ │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `desktop/src/electron/mcp/client.ts` | MCP lifecycle, env var injection |
| `desktop/src/electron/mcp/storage.ts` | RPC handlers for hosted MCPs (future) |
| `desktop/src/electron/storage/mcpStorageDir.ts` | Storage path computation |
| `desktop/artifacts/sdk/src/server/experimental.ts` | SDK storage APIs |

## How It Works

### 1. Project Opening

When a project is opened (`project:open` IPC handler):

```typescript
// project.handlers.ts
await initMcpsForProject({
  projectId,           // <-- UUID passed here
  workspaceRoots,
  profile,
  mcps,
  isAppManagedProject,
});
```

### 2. Project ID Storage

The MCP manager stores the current project ID in module state:

```typescript
// client.ts
let currentProjectId: string | null = null;

export const initMcpsForProject = async ({ projectId, ... }) => {
  currentProjectId = projectId;
  // ...
};

export const closeMcpsForProject = async () => {
  currentProjectId = null;
  // ...
};

export const getCurrentProjectId = (): string | null => currentProjectId;
```

### 3. Environment Variable Injection

When spawning local MCPs (stdio or HTTP), storage env vars are injected:

```typescript
// client.ts - createStdioTransport() and spawnHttpServerProcess()
if (currentProjectId) {
  const storageDir = getMcpStorageDir({ 
    projectId: currentProjectId, 
    serverName 
  });
  env.CREATURE_PROJECT_ID = currentProjectId;
  env.CREATURE_MCP_SERVER_NAME = serverName;
  env.CREATURE_MCP_STORAGE_DIR = storageDir;
}
```

### 4. Storage Directory Structure

The `getMcpStorageDir()` function computes the storage path:

```typescript
// mcpStorageDir.ts
export const getMcpStorageDir = ({ projectId, serverName }) => {
  const root = getMcpStorageRoot(); // ~/Library/Application Support/Creature/mcp-storage
  const mcpKey = getMcpKey(serverName); // Hash to prevent path issues
  return path.join(root, projectId, mcpKey);
};
```

Resulting structure:
```
~/Library/Application Support/Creature/
└── mcp-storage/
    └── <projectId>/              # UUID
        └── <mcpKey>/             # Hashed server name
            ├── kv.json           # Key-value store
            └── blobs/            # Binary files
                └── ...
```

### 5. SDK Storage APIs

The SDK reads the env var and uses local filesystem:

```typescript
// experimental.ts
const getStorageDir = (): string | null => {
  const dir = process.env.CREATURE_MCP_STORAGE_DIR;
  return dir && dir.length > 0 ? dir : null;
};

export async function experimental_kvGet(key: string): Promise<string | null> {
  const store = await readKvStore();  // Reads storageDir/kv.json
  if (!store) return null;
  return store[sanitizeKey(key)] ?? null;
}
```

## Security Measures

### Key Sanitization

All keys are sanitized to prevent path traversal:

```typescript
const sanitizeKey = (key: string): string => {
  if (key.includes("..")) throw new Error("Key cannot contain '..'");
  if (path.isAbsolute(key)) throw new Error("Key cannot be absolute");
  if (!/^[a-zA-Z0-9_\-./:]+$/.test(key)) throw new Error("Invalid characters");
  return key;
};
```

### Blob Size Limits

Maximum blob size is 10MB:

```typescript
const MAX_BLOB_SIZE = 10 * 1024 * 1024;

if (data.length > MAX_BLOB_SIZE) {
  throw new Error(`Blob exceeds maximum size`);
}
```

### Atomic Writes

KV store writes use atomic temp-file-then-rename:

```typescript
const writeKvStore = async (store: Record<string, string>) => {
  const tempPath = `${kvPath}.tmp.${Date.now()}`;
  await fsPromises.writeFile(tempPath, JSON.stringify(store), "utf-8");
  await fsPromises.rename(tempPath, kvPath); // Atomic on most filesystems
};
```

### Scoping

Storage is strictly scoped by:
1. **Project ID** - Directory level isolation
2. **Server Name** - Subdirectory level isolation (hashed to prevent collisions)

MCPs cannot access storage outside their designated directory.

## Future: Hosted MCP Support (RPC)

The `storage.ts` file contains handlers for RPC-based storage access. This is intended for truly remote MCPs that don't have direct filesystem access.

### Planned Architecture

```
Remote MCP Server ──(JSON-RPC)──▶ Creature Desktop
                                        │
                creature/storage/kv/get │
                creature/storage/kv/set │
                                        ▼
                               Storage Handlers
                                        │
                                        ▼
                              Local Filesystem
```

### Custom Method Names

```typescript
export const STORAGE_METHODS = {
  KV_GET: "creature/storage/kv/get",
  KV_SET: "creature/storage/kv/set",
  KV_DELETE: "creature/storage/kv/delete",
  KV_LIST: "creature/storage/kv/list",
  BLOB_PUT: "creature/storage/blob/put",
  BLOB_GET: "creature/storage/blob/get",
  BLOB_DELETE: "creature/storage/blob/delete",
  BLOB_LIST: "creature/storage/blob/list",
};
```

### Capability Advertisement

The plan is to advertise storage support during MCP initialization:

```typescript
export const CREATURE_STORAGE_CAPABILITIES = {
  creatureStorage: {
    kv: true,
    blobs: true,
    maxBlobBytes: MAX_BLOB_SIZE,
  },
};
```

**Note:** The RPC path is not yet fully implemented. Currently, only locally spawned MCPs with env var injection are supported.

## Debugging

### Check if Storage is Being Used

Add logging to your MCP:

```typescript
console.log("Storage env vars:", {
  projectId: process.env.CREATURE_PROJECT_ID,
  serverName: process.env.CREATURE_MCP_SERVER_NAME,
  storageDir: process.env.CREATURE_MCP_STORAGE_DIR,
});
```

### Inspect Storage Contents

```bash
# List all storage directories
ls -la ~/Library/Application\ Support/Creature/mcp-storage/

# View KV store for a specific project/MCP
cat ~/Library/Application\ Support/Creature/mcp-storage/<projectId>/<mcpKey>/kv.json | jq
```

### Common Issues

1. **Data not persisting across sessions**
   - Check that you're using a stable key prefix, not `instanceId`
   - Verify env vars are set (log them on startup)

2. **Storage unavailable**
   - Ensure a project is open
   - Check that `currentProjectId` is set in client.ts

3. **Key collision between instances**
   - Use `"global"` or stable IDs for project-wide data
   - Use `instanceId` only for per-session data

## Testing

### Manual Testing

1. Open a project in Creature
2. Use an MCP that writes to storage
3. Check the filesystem for created files
4. Restart Creature
5. Verify data persists

### Verifying Env Vars

In the DevConsole, you should see MCP startup logs showing the env vars being injected.

## Related Files

- `desktop/artifacts/sdk/docs/STORAGE.md` - User-facing documentation
- `desktop/artifacts/template-todos/src/server/lib/data.ts` - Example implementation
