export * from "./types.js";
export { BaseHostEmulator } from "./BaseHostEmulator.js";
export { CreatureDesktopEmulator } from "./CreatureDesktopEmulator.js";
export { ClaudeDesktopEmulator } from "./ClaudeDesktopEmulator.js";
export { ChatGptWebEmulator } from "./ChatGptWebEmulator.js";

import type { HostEmulator, Vendor, FormFactor } from "./types.js";
import { CreatureDesktopEmulator } from "./CreatureDesktopEmulator.js";
import { ClaudeDesktopEmulator } from "./ClaudeDesktopEmulator.js";
import { ChatGptWebEmulator } from "./ChatGptWebEmulator.js";

export type EmulatorKey = "creature-desktop" | "claude-desktop" | "chatgpt-web";

export function createEmulator(key: EmulatorKey): HostEmulator {
  switch (key) {
    case "creature-desktop":
      return new CreatureDesktopEmulator();
    case "claude-desktop":
      return new ClaudeDesktopEmulator();
    case "chatgpt-web":
      return new ChatGptWebEmulator();
    default:
      throw new Error(`Unknown emulator: ${key}`);
  }
}

export const allEmulatorKeys: EmulatorKey[] = [
  "creature-desktop",
  "claude-desktop",
  "chatgpt-web",
];

export function createAllEmulators(): HostEmulator[] {
  return allEmulatorKeys.map(createEmulator);
}

export function getEmulatorsByVendor(vendor: Vendor): HostEmulator[] {
  return allEmulatorKeys
    .filter((key) => key.startsWith(vendor))
    .map(createEmulator);
}

export function getEmulatorsByFormFactor(formFactor: FormFactor): HostEmulator[] {
  return allEmulatorKeys
    .filter((key) => key.endsWith(formFactor))
    .map(createEmulator);
}

export function getMcpAppsEmulators(): HostEmulator[] {
  return ["creature-desktop", "claude-desktop"].map(createEmulator) as HostEmulator[];
}
