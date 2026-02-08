import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createAllEmulators,
  getMcpAppsEmulators,
  createEmulator,
  type HostEmulator,
} from "./emulators/index.js";

// ============================================================================
// Cross-Host Tests (run against all emulators)
// ============================================================================

describe("Host Emulators", () => {
  const emulators = createAllEmulators();

  describe.each(emulators.map((e) => [e.identity.userAgent, e]))(
    "%s",
    (_name, emulator) => {
      beforeEach(async () => {
        await emulator.setup();
      });

      afterEach(async () => {
        await emulator.teardown();
      });

      it("has valid identity", () => {
        expect(emulator.identity.vendor).toBeDefined();
        expect(emulator.identity.formFactor).toBeDefined();
        expect(emulator.identity.userAgent).toBeDefined();
      });

      it("has valid capabilities", () => {
        expect(typeof emulator.capabilities.multiInstance).toBe("boolean");
        expect(typeof emulator.capabilities.widgetState).toBe("boolean");
        expect(typeof emulator.capabilities.fileSystemAccess).toBe("boolean");
      });

      it("returns host context with theme", () => {
        const context = emulator.getHostContext();
        expect(context.theme).toBeDefined();
        expect(["light", "dark"]).toContain(context.theme);
      });

      it("returns host context with userAgent", () => {
        const context = emulator.getHostContext();
        expect(context.userAgent).toBe(emulator.identity.userAgent);
      });

      it("records tool input messages", () => {
        emulator.sendToolInput("test_tool", { foo: "bar" });
        const messages = emulator.getReceivedMessages();
        expect(messages.length).toBeGreaterThan(0);
      });

      it("records tool result messages", () => {
        emulator.sendToolResult({
          content: [{ type: "text", text: "result" }],
          structuredContent: { data: 123 },
          source: "agent",
        });
        const messages = emulator.getReceivedMessages();
        expect(messages.length).toBeGreaterThan(0);
      });

      it("clears messages", () => {
        emulator.sendToolInput("test_tool", {});
        expect(emulator.getReceivedMessages().length).toBeGreaterThan(0);
        emulator.clearMessages();
        expect(emulator.getReceivedMessages().length).toBe(0);
      });
    }
  );
});

// ============================================================================
// MCP Apps-Specific Tests
// ============================================================================

describe("MCP Apps Emulators", () => {
  const emulators = getMcpAppsEmulators();

  describe.each(emulators.map((e) => [e.identity.userAgent, e]))(
    "%s",
    (_name, emulator) => {
      beforeEach(async () => {
        await emulator.setup();
      });

      afterEach(async () => {
        await emulator.teardown();
      });

      it("does not use window.openai", () => {
        expect(emulator.quirks.usesWindowOpenai).not.toBe(true);
      });

      it("supports widget state", () => {
        expect(emulator.capabilities.widgetState).toBe(true);
      });

      it("supports model context", () => {
        expect(emulator.capabilities.modelContext).toBe(true);
      });

      it("has file system access (desktop)", () => {
        expect(emulator.capabilities.fileSystemAccess).toBe(true);
      });
    }
  );
});

// ============================================================================
// Creature Desktop-Specific Tests
// ============================================================================

describe("Creature Desktop Emulator", () => {
  let emulator: HostEmulator;

  beforeEach(async () => {
    emulator = createEmulator("creature-desktop");
    await emulator.setup();
  });

  afterEach(async () => {
    await emulator.teardown();
  });

  it("supports multi-instance", () => {
    expect(emulator.capabilities.multiInstance).toBe(true);
  });

  it("supports views routing", () => {
    expect(emulator.capabilities.viewsRouting).toBe(true);
  });

  it("supports pip mode", () => {
    expect(emulator.capabilities.pipMode).toBe(true);
  });

  it("supports fullscreen mode", () => {
    expect(emulator.capabilities.fullscreenMode).toBe(true);
  });

  it("supports websocket", () => {
    expect(emulator.capabilities.webSocket).toBe(true);
  });

  it("has creature userAgent", () => {
    expect(emulator.identity.userAgent.toLowerCase()).toContain("creature");
  });

  it("returns available display modes including pip", () => {
    const context = emulator.getHostContext();
    expect(context.availableDisplayModes).toContain("pip");
  });
});

// ============================================================================
// Claude Desktop-Specific Tests
// ============================================================================

describe("Claude Desktop Emulator", () => {
  let emulator: HostEmulator;

  beforeEach(async () => {
    emulator = createEmulator("claude-desktop");
    await emulator.setup();
  });

  afterEach(async () => {
    await emulator.teardown();
  });

  it("does not support multi-instance", () => {
    expect(emulator.capabilities.multiInstance).toBe(false);
  });

  it("does not support views routing", () => {
    expect(emulator.capabilities.viewsRouting).toBe(false);
  });

  it("does not support pip mode", () => {
    expect(emulator.capabilities.pipMode).toBe(false);
  });

  it("ignores display mode requests", () => {
    expect(emulator.quirks.ignoresDisplayModeRequest).toBe(true);
  });

  it("returns inline-only display modes", () => {
    const context = emulator.getHostContext();
    expect(context.availableDisplayModes).toEqual(["inline"]);
  });
});

// ============================================================================
// ChatGPT Web-Specific Tests
// ============================================================================

describe("ChatGPT Web Emulator", () => {
  let emulator: HostEmulator;

  beforeEach(async () => {
    emulator = createEmulator("chatgpt-web");
    await emulator.setup();
  });

  afterEach(async () => {
    await emulator.teardown();
  });

  it("uses window.openai", () => {
    expect(emulator.quirks.usesWindowOpenai).toBe(true);
  });

  it("does not support multi-instance", () => {
    expect(emulator.capabilities.multiInstance).toBe(false);
  });

  it("does not support model context", () => {
    expect(emulator.capabilities.modelContext).toBe(false);
  });

  it("does not have file system access (web)", () => {
    expect(emulator.capabilities.fileSystemAccess).toBe(false);
  });

  it("supports pip mode (coerced to fullscreen on mobile)", () => {
    expect(emulator.capabilities.pipMode).toBe(true);
  });

  it("supports fullscreen mode", () => {
    expect(emulator.capabilities.fullscreenMode).toBe(true);
  });

  it("has web form factor", () => {
    expect(emulator.identity.formFactor).toBe("web");
  });

  it("does not allow null widget state", () => {
    expect(emulator.quirks.widgetStateNullable).toBe(false);
  });
});

// ============================================================================
// Capability Matrix Tests
// ============================================================================

describe("Capability Matrix", () => {
  it("only Creature supports multi-instance", () => {
    const creature = createEmulator("creature-desktop");
    const claude = createEmulator("claude-desktop");
    const chatgpt = createEmulator("chatgpt-web");

    expect(creature.capabilities.multiInstance).toBe(true);
    expect(claude.capabilities.multiInstance).toBe(false);
    expect(chatgpt.capabilities.multiInstance).toBe(false);
  });

  it("desktop apps have file system access", () => {
    const creature = createEmulator("creature-desktop");
    const claude = createEmulator("claude-desktop");
    const chatgpt = createEmulator("chatgpt-web");

    expect(creature.capabilities.fileSystemAccess).toBe(true);
    expect(claude.capabilities.fileSystemAccess).toBe(true);
    expect(chatgpt.capabilities.fileSystemAccess).toBe(false);
  });

  it("only ChatGPT uses window.openai", () => {
    const creature = createEmulator("creature-desktop");
    const claude = createEmulator("claude-desktop");
    const chatgpt = createEmulator("chatgpt-web");

    expect(creature.quirks.usesWindowOpenai).toBeFalsy();
    expect(claude.quirks.usesWindowOpenai).toBeFalsy();
    expect(chatgpt.quirks.usesWindowOpenai).toBe(true);
  });
});
