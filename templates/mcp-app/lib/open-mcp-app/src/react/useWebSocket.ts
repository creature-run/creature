import { useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from "react";
import { createWebSocket } from "../core/websocket.js";
import type { WebSocketClient } from "../core/types.js";
import type { WebSocketStatus, UseWebSocketConfig, UseWebSocketReturn } from "./types.js";

export type { UseWebSocketConfig, UseWebSocketReturn };

interface WebSocketState {
  status: WebSocketStatus;
  error: string | undefined;
}

export function useWebSocket<TSend = unknown, TReceive = unknown>(
  url: string | undefined,
  config: UseWebSocketConfig<TReceive> = {}
): UseWebSocketReturn<TSend> {
  const { onMessage, enabled = true } = config;

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const stateRef = useRef<WebSocketState>({ status: "disconnected", error: undefined });
  const listenersRef = useRef(new Set<() => void>());
  const clientRef = useRef<WebSocketClient<TSend, TReceive> | null>(null);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const getSnapshot = useCallback(() => stateRef.current, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!url || !enabled) {
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
        stateRef.current = { status: "disconnected", error: undefined };
        listenersRef.current.forEach((l) => l());
      }
      return;
    }

    const client = createWebSocket<TSend, TReceive>(url, {
      onMessage: (msg) => onMessageRef.current?.(msg),
      onStatusChange: (status, error) => {
        stateRef.current = { status, error };
        listenersRef.current.forEach((l) => l());
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, enabled]);

  const send = useMemo(() => {
    return (message: TSend) => {
      clientRef.current?.send(message);
    };
  }, []);

  return {
    status: state.status,
    error: state.error,
    send,
  };
}
