/**
 * Host Context and Provider
 *
 * Provides the host client to child components via React context.
 * This enables experimental hooks like `useWidgetState` to access
 * the host without explicit prop drilling.
 */

import { createContext, useContext, useRef, useEffect, type ReactNode } from "react";
import { createHost } from "../core/index.js";
import type { UnifiedHostClient } from "../core/index.js";

// ============================================================================
// Context
// ============================================================================

const HostContext = createContext<UnifiedHostClient | null>(null);

/**
 * Get the host client from context.
 *
 * @throws Error if used outside of HostProvider
 */
export function useHostClient(): UnifiedHostClient {
  const client = useContext(HostContext);
  if (!client) {
    throw new Error(
      "useHostClient must be used within a HostProvider. " +
      "Wrap your app with <HostProvider name=\"...\" version=\"...\">."
    );
  }
  return client;
}

/**
 * Get the host client from context, or null if not in a provider.
 * Useful for optional host features.
 */
export function useHostClientOptional(): UnifiedHostClient | null {
  return useContext(HostContext);
}

// ============================================================================
// Provider
// ============================================================================

export interface HostProviderProps {
  /** App name for the host client */
  name: string;
  /** App version for the host client */
  version: string;
  /** Child components */
  children: ReactNode;
  /**
   * Called when tool input is received.
   * Note: For tool results, use onToolResult in individual components.
   */
  onToolInput?: (args: Record<string, unknown>) => void;
  /** Called when theme changes (MCP Apps only) */
  onThemeChange?: (theme: "light" | "dark") => void;
  /** Called when host requests teardown (MCP Apps only) */
  onTeardown?: () => Promise<void> | void;
}

/**
 * Provides the host client to child components.
 *
 * Creates a single host client instance that is shared across all children.
 * The client connects on mount and disconnects on unmount.
 *
 * @example
 * ```tsx
 * import { HostProvider } from 'open-mcp-app/react';
 *
 * function App() {
 *   return (
 *     <HostProvider name="my-app" version="1.0.0">
 *       <MyWidget />
 *     </HostProvider>
 *   );
 * }
 * ```
 */
export function HostProvider({
  name,
  version,
  children,
  onToolInput,
  onThemeChange,
  onTeardown,
}: HostProviderProps) {
  const clientRef = useRef<UnifiedHostClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = createHost({ name, version });
  }

  const client = clientRef.current;

  // Store callbacks in refs to prevent reconnection on callback changes
  const callbacksRef = useRef({ onToolInput, onThemeChange, onTeardown });
  useEffect(() => {
    callbacksRef.current = { onToolInput, onThemeChange, onTeardown };
  });

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    if (callbacksRef.current.onToolInput) {
      unsubs.push(
        client.on("tool-input", (args) => callbacksRef.current.onToolInput?.(args))
      );
    }

    unsubs.push(
      client.on("theme-change", (theme) => callbacksRef.current.onThemeChange?.(theme))
    );

    unsubs.push(
      client.on("teardown", () => callbacksRef.current.onTeardown?.())
    );

    client.connect();

    return () => {
      unsubs.forEach((unsub) => unsub());
      client.disconnect();
    };
  }, [client]);

  return <HostContext.Provider value={client}>{children}</HostContext.Provider>;
}
