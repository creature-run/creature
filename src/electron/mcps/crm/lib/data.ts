/**
 * Data Layer
 *
 * Provides a simple DataStore abstraction with two implementations:
 * - KV-backed store for persistence (when running in Creature)
 * - In-memory store as fallback (for other hosts like ChatGPT, Claude, etc.)
 *
 * Data is scoped by localId for instance-based isolation.
 */

import { exp, type KvSearchResult } from "open-mcp-app/server";

// =============================================================================
// DataStore Interface
// =============================================================================

/**
 * Search result with item data and optional snippet.
 */
export interface SearchResult<T> {
  item: T;
  snippet?: string;
  score?: number;
}

export interface ListPageOptions {
  cursor?: string;
  limit?: number;
}

export interface ListPageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Generic data store interface for CRUD operations.
 *
 * This interface allows swapping implementations (e.g., adding persistence)
 * without changing the tool handler code.
 */
export interface DataStore<T> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(): Promise<T[]>;
  listPage(options?: ListPageOptions): Promise<ListPageResult<T>>;
  /**
   * Full-text search across stored items.
   * Returns items that match the query, with optional snippets and relevance scores.
   */
  search(query: string, limit?: number): Promise<SearchResult<T>[]>;
  /**
   * Clear all items in this store.
   */
  clear(): Promise<void>;
}

// =============================================================================
// KV-Backed Implementation (Persistent)
// =============================================================================

/**
 * KV-backed data store using Creature's experimental storage APIs.
 * Data persists across app restarts when running in Creature.
 * Scoped by collection and localId to isolate data.
 */
class KvStore<T> implements DataStore<T> {
  private collection: string;
  private localId: string;

  constructor(collection: string, localId: string) {
    this.collection = collection;
    this.localId = localId;
  }

  /**
   * Build a composite key that includes collection and localId.
   */
  private scopedKey(id: string): string {
    return `${this.collection}:${this.localId}:${id}`;
  }

  /**
   * Get the prefix for listing items in this collection+localId.
   */
  private scopePrefix(): string {
    return `${this.collection}:${this.localId}:`;
  }

  async get(id: string): Promise<T | null> {
    const value = await exp.kvGet(this.scopedKey(id));
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set(id: string, value: T): Promise<void> {
    await exp.kvSet(this.scopedKey(id), JSON.stringify(value));
  }

  async delete(id: string): Promise<boolean> {
    return exp.kvDelete(this.scopedKey(id));
  }

  async listPage(options: ListPageOptions = {}): Promise<ListPageResult<T>> {
    const prefix = this.scopePrefix();
    const page = await exp.kvListWithValues({
      prefix,
      cursor: options.cursor,
      limit: options.limit,
    });
    if (!page) {
      return { items: [], nextCursor: null };
    }

    const items: T[] = [];
    for (const { value } of page.entries) {
      try {
        items.push(JSON.parse(value) as T);
      } catch {
        // Skip invalid entries
      }
    }

    return {
      items,
      nextCursor: page.nextCursor,
    };
  }

  async list(): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.listPage({ cursor, limit: 100 });
      results.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    return results;
  }

  async search(query: string, limit?: number): Promise<SearchResult<T>[]> {
    const prefix = this.scopePrefix();
    const searchResults = await exp.kvSearch(query, { prefix, limit });
    if (!searchResults) return [];

    const results: SearchResult<T>[] = [];
    for (const result of searchResults) {
      const value = await exp.kvGet(result.key);
      if (value) {
        try {
          results.push({
            item: JSON.parse(value) as T,
            snippet: result.snippet,
            score: result.score,
          });
        } catch {
          // Skip invalid entries
        }
      }
    }
    return results;
  }

  async clear(): Promise<void> {
    const prefix = this.scopePrefix();
    let cursor: string | undefined;

    while (true) {
      const page = await exp.kvList({
        prefix,
        cursor,
        limit: 100,
      });
      if (!page) return;

      for (const key of page.keys) {
        await exp.kvDelete(key);
      }

      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
  }
}

// =============================================================================
// In-Memory Implementation (Fallback)
// =============================================================================

/**
 * Shared in-memory storage that persists across store instantiations.
 * Key format: "collection:localId:id"
 *
 * This is module-level so data survives across tool calls.
 * Each tool call creates a new InMemoryStore instance, but they all
 * read/write to this shared Map.
 */
const sharedInMemoryData = new Map<string, unknown>();

/**
 * In-memory data store using a shared Map.
 * Data persists for the lifetime of the process only.
 * Used as fallback when KV storage is not available.
 * Scoped by collection and localId to isolate data.
 */
class InMemoryStore<T> implements DataStore<T> {
  private collection: string;
  private localId: string;

  constructor(collection: string, localId: string) {
    this.collection = collection;
    this.localId = localId;
  }

  /**
   * Build a composite key that includes collection and localId.
   */
  private scopedKey(id: string): string {
    return `${this.collection}:${this.localId}:${id}`;
  }

  /**
   * Get the prefix for listing items in this collection+localId.
   */
  private scopePrefix(): string {
    return `${this.collection}:${this.localId}:`;
  }

  async get(id: string) {
    return (sharedInMemoryData.get(this.scopedKey(id)) as T) ?? null;
  }

  async set(id: string, value: T) {
    sharedInMemoryData.set(this.scopedKey(id), value);
  }

  async delete(id: string) {
    return sharedInMemoryData.delete(this.scopedKey(id));
  }

  async listPage(options: ListPageOptions = {}): Promise<ListPageResult<T>> {
    const prefix = this.scopePrefix();
    const limit = options.limit ?? 100;
    const entries = [...sharedInMemoryData.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b));

    let startIndex = 0;
    if (options.cursor) {
      startIndex = entries.findIndex(([key]) => key > options.cursor);
      if (startIndex === -1) {
        return { items: [], nextCursor: null };
      }
    }

    const pageEntries = entries.slice(startIndex, startIndex + limit);
    const items = pageEntries.map(([, value]) => value as T);
    const hasMore = startIndex + pageEntries.length < entries.length;
    const nextCursor = hasMore && pageEntries.length > 0
      ? pageEntries[pageEntries.length - 1]?.[0] ?? null
      : null;

    return {
      items,
      nextCursor,
    };
  }

  async list() {
    const results: T[] = [];

    let cursor: string | undefined;
    while (true) {
      const page = await this.listPage({ cursor, limit: 100 });
      results.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    return results;
  }

  async search(query: string, limit?: number): Promise<SearchResult<T>[]> {
    // Simple in-memory search: match query terms in stringified values
    const prefix = this.scopePrefix();
    const queryLower = query.toLowerCase();
    const results: SearchResult<T>[] = [];

    for (const [key, value] of sharedInMemoryData) {
      if (!key.startsWith(prefix)) continue;

      const valueStr = JSON.stringify(value).toLowerCase();
      if (valueStr.includes(queryLower)) {
        results.push({
          item: value as T,
          // Simple snippet: extract context around the match
          snippet: this.extractSnippet(valueStr, queryLower),
        });

        if (limit && results.length >= limit) break;
      }
    }

    return results;
  }

  async clear(): Promise<void> {
    const prefix = this.scopePrefix();
    const keysToDelete: string[] = [];
    for (const key of sharedInMemoryData.keys()) {
      if (key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      sharedInMemoryData.delete(key);
    }
  }

  /**
   * Extract a snippet around the matched query.
   */
  private extractSnippet(text: string, query: string): string {
    const index = text.indexOf(query);
    if (index === -1) return text.slice(0, 50);
    
    const start = Math.max(0, index - 20);
    const end = Math.min(text.length, index + query.length + 20);
    let snippet = text.slice(start, end);
    
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";
    
    return snippet;
  }
}

// =============================================================================
// Factory
// =============================================================================

/** Track whether we've logged the storage mode */
let storageLoggedOnce = false;

/**
 * Create a data store for the given collection and localId.
 *
 * Automatically selects the best available storage:
 * - KV store (persistent) when running in Creature
 * - In-memory store (volatile) as fallback for other hosts
 *
 * @param collection - The collection/namespace name
 * @param localId - The local ID for data isolation (typically instanceId)
 */
export const createDataStore = <T>({
  collection,
  localId,
}: {
  collection: string;
  localId: string;
}): DataStore<T> => {
  // Check if KV storage is available (Creature host)
  if (exp.kvIsAvailable()) {
    if (!storageLoggedOnce) {
      console.log("[Data] Using persistent KV storage");
      storageLoggedOnce = true;
    }
    return new KvStore<T>(collection, localId);
  }

  // Fall back to in-memory storage
  if (!storageLoggedOnce) {
    console.log("[Data] Using in-memory storage (no persistent storage available)");
    storageLoggedOnce = true;
  }
  return new InMemoryStore<T>(collection, localId);
};
