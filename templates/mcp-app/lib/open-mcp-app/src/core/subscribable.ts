/**
 * Subscribable Base Class
 *
 * Provides event emitter pattern for state changes and host events.
 * Used as a base class for all host client implementations.
 */

import type { HostClientState, HostClientEvents, StateListener } from "./types.js";

type BaseEventHandler = HostClientEvents[keyof HostClientEvents];

/**
 * Base class for subscribable host clients.
 * Provides unified event handling for state changes and host events.
 */
export abstract class Subscribable {
  private stateListeners = new Set<StateListener>();
  private eventHandlers = new Map<keyof HostClientEvents, Set<BaseEventHandler>>();
  private mcpEventHandlers = new Map<"theme-change" | "teardown", Set<(...args: unknown[]) => unknown>>();

  /**
   * Subscribe to state changes.
   *
   * @param listener - Callback invoked when state changes
   * @returns Unsubscribe function
   */
  protected subscribeToState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * Register a handler for base events.
   *
   * @param event - The event name
   * @param handler - The event handler
   * @returns Unsubscribe function
   */
  protected onEvent<K extends keyof HostClientEvents>(
    event: K,
    handler: HostClientEvents[K]
  ): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler as BaseEventHandler);
    return () => {
      handlers!.delete(handler as BaseEventHandler);
    };
  }

  /**
   * Get the number of subscribers for an event.
   *
   * @param event - The event name
   * @returns Number of subscribers
   */
  protected getSubscriberCount(event: keyof HostClientEvents): number {
    return this.eventHandlers.get(event)?.size ?? 0;
  }

  /**
   * Register a handler for MCP-specific events (theme-change, teardown).
   *
   * @param event - The event name
   * @param handler - The event handler
   * @returns Unsubscribe function
   */
  protected onMcpEvent<K extends "theme-change" | "teardown">(
    event: K,
    handler: K extends "theme-change"
      ? (theme: "light" | "dark") => void
      : () => Promise<void> | void
  ): () => void {
    let handlers = this.mcpEventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.mcpEventHandlers.set(event, handlers);
    }
    handlers.add(handler as (...args: unknown[]) => unknown);
    return () => {
      handlers!.delete(handler as (...args: unknown[]) => unknown);
    };
  }

  /**
   * Notify all state listeners of a state change.
   */
  protected notifyStateChange(state: HostClientState, prevState: HostClientState): void {
    this.stateListeners.forEach((listener) => listener(state, prevState));
  }

  /**
   * Emit a base event to all registered handlers.
   */
  protected emit<K extends keyof HostClientEvents>(
    event: K,
    ...args: Parameters<HostClientEvents[K]>
  ): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        (handler as (...args: Parameters<HostClientEvents[K]>) => void)(...args);
      });
    }
  }

  /**
   * Emit an MCP-specific event to all registered handlers.
   */
  protected emitMcpEvent<K extends "theme-change" | "teardown">(
    event: K,
    ...args: K extends "theme-change" ? ["light" | "dark"] : []
  ): void | Promise<void> {
    const handlers = this.mcpEventHandlers.get(event);
    if (handlers) {
      if (event === "teardown") {
        const promises: (Promise<void> | void)[] = [];
        handlers.forEach((handler) => {
          promises.push((handler as () => Promise<void> | void)());
        });
        return Promise.all(promises).then(() => {});
      } else {
        handlers.forEach((handler) => {
          (handler as (theme: "light" | "dark") => void)(args[0] as "light" | "dark");
        });
      }
    }
  }
}
