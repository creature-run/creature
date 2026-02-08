import { BaseHostEmulator } from "./BaseHostEmulator.js";
import type { HostIdentity, HostCapabilities, HostQuirks } from "./types.js";
import type { HostContext, ToolResult } from "../../src/core/types.js";

export class ClaudeDesktopEmulator extends BaseHostEmulator {
  readonly identity: HostIdentity = {
    vendor: "claude",
    formFactor: "desktop",
    userAgent: "ClaudeDesktop/1.0.0",
  };

  readonly capabilities: HostCapabilities = {
    multiInstance: false,
    viewsRouting: false,
    pipMode: false,
    fullscreenMode: false,
    webSocket: false,
    widgetState: true,
    modelContext: true,
    fileSystemAccess: true,
  };

  readonly quirks: HostQuirks = {
    ignoresDisplayModeRequest: true,
  };

  private guestWindow: Window | null = null;

  sendToolInput(toolName: string, args: Record<string, unknown>): void {
    this.recordMessage("tool-input-sent", { toolName, arguments: args });
    this.sendToGuest({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { toolName, arguments: args },
    });
  }

  sendToolResult(result: ToolResult): void {
    this.recordMessage("tool-result-sent", result);
    this.sendToGuest({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: result,
    });
  }

  sendHostContextChange(context: Partial<HostContext>): void {
    this.sendToGuest({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: context,
    });
  }

  injectIntoWindow(window: Window): void {
    this.guestWindow = window;
  }

  createPostMessageTarget(): { postMessage: (data: unknown) => void } {
    return {
      postMessage: (data: unknown) => {
        this.handleGuestMessage(data);
      },
    };
  }

  private sendToGuest(message: unknown): void {
    if (this.guestWindow) {
      this.guestWindow.postMessage(message, "*");
    }
  }

  private handleGuestMessage(data: unknown): void {
    if (!data || typeof data !== "object") return;

    const msg = data as { jsonrpc?: string; method?: string; params?: unknown; id?: number };
    if (msg.jsonrpc !== "2.0") return;

    if (msg.method === "ui/initialize") {
      this.recordMessage("initialize", msg.params);
      this.sendToGuest({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-01-26",
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            updateModelContext: { text: {} },
          },
          hostContext: this.getHostContext(),
        },
      });
      return;
    }

    if (msg.method === "ui/notifications/widget-state-changed") {
      this.recordMessage("widget-state-changed", msg.params);
      return;
    }

    if (msg.method === "ui/update-model-context") {
      this.recordMessage("update-model-context", msg.params);
      this.sendToGuest({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    if (msg.method === "ui/call-server-tool") {
      this.recordMessage("call-server-tool", msg.params);
      this.sendToGuest({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: "Mock tool result" }],
          structuredContent: {},
        },
      });
      return;
    }

    if (msg.method === "ui/request-display-mode") {
      this.recordMessage("request-display-mode", msg.params);
      this.sendToGuest({
        jsonrpc: "2.0",
        id: msg.id,
        result: { mode: "inline" },
      });
      return;
    }

    if (msg.method === "ui/send-message") {
      this.recordMessage("send-message", msg.params);
      this.sendToGuest({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    if (msg.method === "ui/open-link") {
      this.recordMessage("open-link", msg.params);
      this.sendToGuest({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }

    if (msg.method === "ui/logging/message") {
      this.recordMessage("log", msg.params);
      return;
    }

    if (msg.method === "ui/size-change") {
      this.recordMessage("size-change", msg.params);
      return;
    }
  }
}
