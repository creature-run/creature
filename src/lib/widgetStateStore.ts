/**
 * Widget State Store (In-Memory)
 *
 * Manages widget state for the current conversation session.
 * This is the renderer-side store that handles widget state until
 * database persistence is implemented.
 *
 * State is keyed by widgetId format: `{conversationId}:{messageId}`
 * For PIP mode without a message context: `{conversationId}:pip:{instanceId}`
 *
 * State structure follows ChatGPT Apps format:
 * - modelContent: Data visible to AI model on follow-up turns
 * - privateContent: UI-only state hidden from model
 * - imageIds: File IDs for images the model can see
 *
 * Lifecycle:
 * - Widget state is stored when Guest UI calls setWidgetState()
 * - Widget state is restored via hostContext.widgetState on render
 * - All state is cleared when conversation closes
 *
 * @see WIDGET_STATE_SPEC.md
 */

/**
 * Widget state structure following ChatGPT Apps format.
 * This is the standard interface for widget state across both
 * Creature MCP Apps and ChatGPT Apps.
 */
export interface WidgetState {
  /**
   * Content visible to the AI model on follow-up turns.
   * This is injected into the model's context when processing
   * the next user message, allowing continuity of widget data.
   */
  modelContent?: string | Record<string, unknown> | null;

  /**
   * UI-only state hidden from the model.
   * Used for view preferences, scroll position, expanded/collapsed
   * state, and other UI concerns the model doesn't need to see.
   */
  privateContent?: Record<string, unknown> | null;

  /**
   * File IDs for images the model can see.
   * Allows widgets to surface images in the AI context.
   */
  imageIds?: string[];
}

/**
 * Metadata stored alongside widget state.
 * Used for debugging and future database persistence.
 */
export interface WidgetStateMetadata {
  mcpServerName: string;
  resourceUri: string;
  instanceId?: string;
  messageId?: string;
  conversationId?: string;
}

/**
 * Internal entry structure for the store.
 */
interface WidgetStateEntry {
  state: WidgetState;
  metadata: WidgetStateMetadata;
  updatedAt: number;
}

/**
 * Widget State Store
 *
 * In-memory store for widget state during active conversations.
 * State persists across widget re-renders but is cleared when
 * the conversation closes.
 *
 * Key format: `{conversationId}:{messageId}` or `{conversationId}:pip:{instanceId}`
 */
class WidgetStateStore {
  private store: Map<string, WidgetStateEntry> = new Map();

  /**
   * Get widget state by key.
   * @param widgetId - The widget identifier key
   * @returns Widget state or null if not found
   */
  get(widgetId: string): WidgetState | null {
    const entry = this.store.get(widgetId);
    return entry?.state ?? null;
  }

  /**
   * Get widget state with metadata.
   * @param widgetId - The widget identifier key
   * @returns Entry with state and metadata, or null if not found
   */
  getWithMetadata(widgetId: string): { state: WidgetState; metadata: WidgetStateMetadata } | null {
    const entry = this.store.get(widgetId);
    if (!entry) return null;
    return { state: entry.state, metadata: entry.metadata };
  }

  /**
   * Store widget state.
   * @param widgetId - The widget identifier key
   * @param state - Widget state to store
   * @param metadata - Associated metadata
   */
  set(widgetId: string, state: WidgetState, metadata: WidgetStateMetadata): void {
    this.store.set(widgetId, {
      state,
      metadata,
      updatedAt: Date.now(),
    });

    console.debug(`[WidgetStateStore] Set state for ${widgetId}`, {
      hasModelContent: !!state.modelContent,
      hasPrivateContent: !!state.privateContent,
      imageIds: state.imageIds?.length ?? 0,
    });
  }

  /**
   * Delete widget state.
   * @param widgetId - The widget identifier key
   * @returns true if an entry was deleted
   */
  delete(widgetId: string): boolean {
    const deleted = this.store.delete(widgetId);
    if (deleted) {
      console.debug(`[WidgetStateStore] Deleted state for ${widgetId}`);
    }
    return deleted;
  }

  /**
   * Clear all widget state for a conversation.
   * Called when a conversation is closed.
   * @param conversationId - The conversation to clear
   * @returns Number of entries cleared
   */
  clearConversation(conversationId: string): number {
    const prefix = `${conversationId}:`;
    let cleared = 0;

    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        cleared++;
      }
    }

    if (cleared > 0) {
      console.debug(`[WidgetStateStore] Cleared ${cleared} entries for conversation ${conversationId}`);
    }

    return cleared;
  }

  /**
   * Clear all widget state.
   * Called on app close or conversation switch.
   */
  clear(): void {
    const size = this.store.size;
    this.store.clear();
    console.debug(`[WidgetStateStore] Cleared all ${size} entries`);
  }

  /**
   * Get all widget states with modelContent for a conversation.
   * Used to build AI context for follow-up turns.
   * @param conversationId - The conversation to query
   * @returns Array of entries with modelContent
   */
  getModelContentForConversation(conversationId: string): Array<{
    widgetId: string;
    modelContent: string | Record<string, unknown>;
    metadata: WidgetStateMetadata;
  }> {
    const prefix = `${conversationId}:`;
    const results: Array<{
      widgetId: string;
      modelContent: string | Record<string, unknown>;
      metadata: WidgetStateMetadata;
    }> = [];

    for (const [key, entry] of this.store.entries()) {
      if (key.startsWith(prefix) && entry.state.modelContent) {
        results.push({
          widgetId: key,
          modelContent: entry.state.modelContent,
          metadata: entry.metadata,
        });
      }
    }

    return results;
  }

  /**
   * Get all widget IDs in the store.
   * For debugging purposes.
   */
  keys(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get the number of stored widget states.
   */
  size(): number {
    return this.store.size;
  }
}

/**
 * Singleton instance of the widget state store.
 * Used across the renderer process for consistent state access.
 */
export const widgetStateStore = new WidgetStateStore();

/**
 * Generate a widget ID for inline widgets.
 * Format: `{conversationId}:{messageId}`
 *
 * @param conversationId - The conversation ID
 * @param messageId - The message ID containing this widget
 */
export const makeInlineWidgetId = ({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}): string => {
  return `${conversationId}:${messageId}`;
};

/**
 * Generate a widget ID for PIP mode.
 * Format: `{conversationId}:pip:{instanceId}`
 *
 * PIP pips may not have a message context if they were created
 * through direct interaction rather than a tool call.
 *
 * @param conversationId - The conversation ID
 * @param instanceId - The instance ID
 */
export const makePipWidgetId = ({
  conversationId,
  instanceId,
}: {
  conversationId: string;
  instanceId: string;
}): string => {
  return `${conversationId}:pip:${instanceId}`;
};

/**
 * Parse a widget ID to extract its components.
 * Returns null for invalid formats.
 *
 * @param widgetId - The widget ID to parse
 */
export const parseWidgetId = (widgetId: string): {
  conversationId: string;
  type: "inline" | "pip";
  id: string;
} | null => {
  const parts = widgetId.split(":");
  if (parts.length < 2) return null;

  const conversationId = parts[0];

  if (parts[1] === "pip" && parts.length >= 3) {
    return {
      conversationId,
      type: "pip",
      id: parts.slice(2).join(":"),
    };
  }

  return {
    conversationId,
    type: "inline",
    id: parts.slice(1).join(":"),
  };
};
