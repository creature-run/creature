import type {
  WebSocketStatus,
  WebSocketClientConfig,
  WebSocketClient,
} from "./types.js";

/**
 * Create a WebSocket client with automatic reconnection.
 *
 * @param url - WebSocket server URL
 * @param config - Client configuration
 * @returns WebSocket client instance
 */
export function createWebSocket<TSend = unknown, TReceive = unknown>(
  url: string,
  config: WebSocketClientConfig<TReceive> = {}
): WebSocketClient<TSend, TReceive> {
  const {
    onMessage,
    onStatusChange,
    reconnect = true,
    reconnectInterval = 1000,
  } = config;

  let ws: WebSocket | null = null;
  let status: WebSocketStatus = "disconnected";
  let error: string | undefined;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  const setStatus = (newStatus: WebSocketStatus, newError?: string) => {
    status = newStatus;
    error = newError;
    onStatusChange?.(status, error);
  };

  const connect = () => {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      console.log("[WebSocket] Already connected/connecting to:", url);
      return;
    }

    intentionalClose = false;
    setStatus("connecting");
    console.log("[WebSocket] Connecting to:", url);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error("[WebSocket] Failed to create WebSocket:", e);
      setStatus("error", "Failed to create WebSocket");
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log("[WebSocket] Connected to:", url);
      reconnectAttempts = 0;
      setStatus("connected");
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as TReceive;
        console.log("[WebSocket] Received message:", message);
        onMessage?.(message);
      } catch (e) {
        console.error("[WebSocket] Failed to parse message:", e);
      }
    };

    ws.onerror = (e) => {
      console.error("[WebSocket] Error:", e);
      setStatus("error", "Connection error");
    };

    ws.onclose = (event) => {
      ws = null;

      if (intentionalClose) {
        setStatus("disconnected");
        return;
      }

      if (event.code === 4004) {
        setStatus("error", "Instance WebSocket not found");
        return;
      }

      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (!reconnect) {
      setStatus("disconnected");
      return;
    }

    const delay = Math.min(reconnectInterval * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;

    setStatus("connecting");
    reconnectTimer = setTimeout(connect, delay);
  };

  const disconnect = () => {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.close();
    ws = null;
    setStatus("disconnected");
  };

  const send = (message: TSend) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  return {
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    connect,
    disconnect,
    send,
  };
}
