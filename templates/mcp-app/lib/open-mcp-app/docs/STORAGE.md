# Storage APIs (Creature Extension)

The Creature SDK provides experimental storage APIs that allow your MCP app to persist data across sessions. This is a Creature-specific extension—when running in other hosts (like ChatGPT or Claude Desktop), these APIs gracefully return `null` or `false`, allowing you to implement fallbacks.

## Overview

Two storage mechanisms are available:

1. **KV Store** - Key-value storage for JSON strings (best for structured data)
2. **Blob Store** - Binary storage for files (best for images, documents, etc.)

Both are:
- **Scoped per project** - Each Creature project has isolated storage
- **Scoped per MCP** - Different MCPs don't share storage
- **Persistent** - Data survives app restarts
- **Sandboxed** - MCPs cannot access storage outside their designated area

## Quick Start

```typescript
import {
  experimental_kvIsAvailable,
  experimental_kvGet,
  experimental_kvSet,
  experimental_kvList,
  experimental_kvDelete,
} from "open-mcp-app/server";

// Check if storage is available
if (experimental_kvIsAvailable()) {
  // Store data
  await experimental_kvSet("user:preferences", JSON.stringify({ theme: "dark" }));
  
  // Retrieve data
  const prefs = await experimental_kvGet("user:preferences");
  if (prefs) {
    const parsed = JSON.parse(prefs);
    console.log(parsed.theme); // "dark"
  }
  
  // List keys with a prefix
  const userKeys = await experimental_kvList("user:");
  
  // Delete data
  await experimental_kvDelete("user:preferences");
}
```

## KV Store API

### `experimental_kvIsAvailable(): boolean`

Check if KV storage is available. Returns `true` when running in Creature with a project open.

```typescript
if (experimental_kvIsAvailable()) {
  // Use persistent storage
} else {
  // Fall back to in-memory storage
}
```

### `experimental_kvGet(key: string): Promise<string | null>`

Retrieve a value by key. Returns `null` if not found or storage unavailable.

```typescript
const value = await experimental_kvGet("settings");
```

### `experimental_kvSet(key: string, value: string): Promise<boolean>`

Store a value. Returns `true` on success, `false` if storage unavailable.

```typescript
await experimental_kvSet("settings", JSON.stringify({ volume: 80 }));
```

### `experimental_kvDelete(key: string): Promise<boolean>`

Delete a key. Returns `true` if the key existed and was deleted.

```typescript
const deleted = await experimental_kvDelete("settings");
```

### `experimental_kvList(prefix?: string): Promise<string[] | null>`

List all keys, optionally filtered by prefix. Returns `null` if storage unavailable.

```typescript
// List all keys
const allKeys = await experimental_kvList();

// List keys starting with "user:"
const userKeys = await experimental_kvList("user:");
```

### Sync Variants

All KV methods have synchronous variants for use cases where async isn't possible:

- `experimental_kvGetSync(key: string): string | null`
- `experimental_kvSetSync(key: string, value: string): boolean`
- `experimental_kvDeleteSync(key: string): boolean`
- `experimental_kvListSync(prefix?: string): string[] | null`

## Blob Store API

### `experimental_blobIsAvailable(): boolean`

Check if blob storage is available.

### `experimental_blobPut(name: string, data: Buffer | Uint8Array, mimeType?: string): Promise<{ success: true; size: number } | null>`

Store a blob. Maximum size is 10MB.

```typescript
import fs from "node:fs";

const imageData = fs.readFileSync("photo.png");
const result = await experimental_blobPut("images/photo.png", imageData, "image/png");

if (result) {
  console.log(`Stored ${result.size} bytes`);
}
```

### `experimental_blobGet(name: string): Promise<{ data: Buffer; mimeType?: string } | null>`

Retrieve a blob by name.

```typescript
const blob = await experimental_blobGet("images/photo.png");
if (blob) {
  // blob.data is a Buffer
  // blob.mimeType is optional string
}
```

### `experimental_blobDelete(name: string): Promise<boolean>`

Delete a blob. Returns `true` if deleted.

### `experimental_blobList(prefix?: string): Promise<string[] | null>`

List blob names, optionally filtered by prefix.

```typescript
const images = await experimental_blobList("images/");
```

### Sync Variants

- `experimental_blobPutSync(name, data, mimeType?)`
- `experimental_blobGetSync(name)`
- `experimental_blobDeleteSync(name)`
- `experimental_blobListSync(prefix?)`

## Key Naming Conventions

Keys and blob names must follow these rules:

- Maximum length: 256 characters
- Allowed characters: `a-z`, `A-Z`, `0-9`, `_`, `-`, `.`, `/`, `:`
- Cannot contain `..` (path traversal protection)
- Cannot be absolute paths

Recommended patterns:

```typescript
// Namespace by feature
"todos:item:abc123"
"settings:theme"
"cache:api:users"

// Hierarchical blob names
"images/avatars/user123.png"
"exports/report-2024.pdf"
```

## Implementing Fallbacks

For cross-platform compatibility, always implement fallbacks for non-Creature hosts:

```typescript
import {
  experimental_kvIsAvailable,
  experimental_kvGet,
  experimental_kvSet,
} from "open-mcp-app/server";

// In-memory fallback
const memoryStore = new Map<string, string>();

async function getValue(key: string): Promise<string | null> {
  if (experimental_kvIsAvailable()) {
    return experimental_kvGet(key);
  }
  return memoryStore.get(key) ?? null;
}

async function setValue(key: string, value: string): Promise<void> {
  if (experimental_kvIsAvailable()) {
    await experimental_kvSet(key, value);
  } else {
    memoryStore.set(key, value);
  }
}
```

## Example: DataStore Pattern

A common pattern is to create a `DataStore` abstraction that automatically handles the fallback:

```typescript
interface DataStore<T> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<T[]>;
}

// KV-backed implementation
class KvDataStore<T> implements DataStore<T> {
  constructor(private collection: string) {}

  private key(id: string) {
    return `${this.collection}:${id}`;
  }

  async get(id: string): Promise<T | null> {
    const value = await experimental_kvGet(this.key(id));
    return value ? JSON.parse(value) : null;
  }

  async set(id: string, value: T): Promise<void> {
    await experimental_kvSet(this.key(id), JSON.stringify(value));
  }

  async delete(id: string): Promise<boolean> {
    return experimental_kvDelete(this.key(id));
  }

  async list(): Promise<T[]> {
    const keys = await experimental_kvList(`${this.collection}:`);
    if (!keys) return [];
    
    const items: T[] = [];
    for (const key of keys) {
      const value = await experimental_kvGet(key);
      if (value) items.push(JSON.parse(value));
    }
    return items;
  }
}

// In-memory fallback implementation
class MemoryDataStore<T> implements DataStore<T> {
  private data = new Map<string, T>();
  
  async get(id: string) { return this.data.get(id) ?? null; }
  async set(id: string, value: T) { this.data.set(id, value); }
  async delete(id: string) { return this.data.delete(id); }
  async list() { return Array.from(this.data.values()); }
}

// Factory that picks the right implementation
function createDataStore<T>(collection: string): DataStore<T> {
  if (experimental_kvIsAvailable()) {
    return new KvDataStore<T>(collection);
  }
  return new MemoryDataStore<T>();
}
```

## Storage Location

When running in Creature, data is stored at:

```
~/Library/Application Support/Creature/mcp-storage/<projectId>/<mcpKey>/
├── kv.json          # KV store data
└── blobs/           # Blob files
    └── images/
        └── photo.png
```

- `projectId`: UUID of the Creature project
- `mcpKey`: Hashed identifier derived from the MCP server name

## Limitations

- **KV values must be strings** - Use `JSON.stringify()` for objects
- **Maximum blob size: 10MB** - For larger files, consider external storage
- **Maximum key length: 256 characters**
- **Creature-only** - These APIs only work in Creature; other hosts get `null`/`false`

## Environment Variables

When your MCP runs in Creature, these environment variables are set:

| Variable | Description |
|----------|-------------|
| `CREATURE_PROJECT_ID` | UUID of the current project |
| `CREATURE_MCP_SERVER_NAME` | Your MCP's server name |
| `CREATURE_MCP_STORAGE_DIR` | Absolute path to your storage directory |

You typically don't need to use these directly—the SDK APIs handle them for you.
