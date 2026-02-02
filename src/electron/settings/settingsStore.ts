/**
 * Settings Store
 *
 * Stores and manages application settings locally.
 * Supports enterprise defaults that users can override.
 * Theme values are forwarded to MCP Apps via hostContext.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Logo configuration for branding.
 * Supports inline SVG or remote URLs.
 */
export interface BrandingLogo {
  svg?: string;
  lightSvg?: string;
  url?: string;
  lightUrl?: string;
}

/**
 * Branding settings for enterprise customization.
 */
export interface BrandingSettings {
  appName: string;
  logo: BrandingLogo | null;
}

/**
 * Color settings for a theme mode.
 * Maps to MCP Apps spec CSS variables.
 */
export interface ThemeColors {
  background?: {
    primary?: string;
    secondary?: string;
    tertiary?: string;
    inverse?: string;
    ghost?: string;
    info?: string;
    danger?: string;
    success?: string;
    warning?: string;
    disabled?: string;
  };
  text?: {
    primary?: string;
    secondary?: string;
    tertiary?: string;
    inverse?: string;
    ghost?: string;
    info?: string;
    danger?: string;
    success?: string;
    warning?: string;
    disabled?: string;
  };
  border?: {
    primary?: string;
    secondary?: string;
    tertiary?: string;
    inverse?: string;
    ghost?: string;
    info?: string;
    danger?: string;
    success?: string;
    warning?: string;
    disabled?: string;
  };
  ring?: {
    primary?: string;
    secondary?: string;
    inverse?: string;
    info?: string;
    danger?: string;
    success?: string;
    warning?: string;
  };
  input?: {
    background?: string;
    text?: string;
    border?: string;
  };
  solid?: {
    primary?: string;
    info?: string;
    danger?: string;
    success?: string;
    warning?: string;
  };
}

/**
 * Text size settings (MCP Apps spec).
 */
export interface TextSizes {
  xs?: string;
  sm?: string;
  md?: string;
  lg?: string;
}

/**
 * Heading size settings (MCP Apps spec).
 */
export interface HeadingSizes {
  xs?: string;
  sm?: string;
  md?: string;
  lg?: string;
  xl?: string;
  "2xl"?: string;
  "3xl"?: string;
}

/**
 * Typography settings (MCP Apps spec).
 * Maps to --font-* CSS variables.
 */
export interface ThemeTypography {
  /** Font family for sans-serif text. Maps to --font-sans */
  fontSans?: string;
  /** Font family for monospace text. Maps to --font-mono */
  fontMono?: string;
  /** Normal font weight. Maps to --font-weight-normal */
  fontWeightNormal?: number;
  /** Medium font weight. Maps to --font-weight-medium */
  fontWeightMedium?: number;
  /** Semibold font weight. Maps to --font-weight-semibold */
  fontWeightSemibold?: number;
  /** Bold font weight. Maps to --font-weight-bold */
  fontWeightBold?: number;
  /** Text sizes. Maps to --font-text-{size}-size */
  textSize?: TextSizes;
  /** Text line heights. Maps to --font-text-{size}-line-height */
  textLineHeight?: TextSizes;
  /** Heading sizes. Maps to --font-heading-{size}-size */
  headingSize?: HeadingSizes;
  /** Heading line heights. Maps to --font-heading-{size}-line-height */
  headingLineHeight?: HeadingSizes;
}

/**
 * Border settings.
 */
export interface ThemeBorders {
  radiusXs?: string;
  radiusSm?: string;
  radiusMd?: string;
  radiusLg?: string;
  radiusXl?: string;
  radiusFull?: string;
  widthRegular?: string;
}

/**
 * Shadow settings.
 */
export interface ThemeShadows {
  hairline?: string;
  sm?: string;
  md?: string;
  lg?: string;
}

/**
 * Theme mode settings (dark or light).
 */
export interface ThemeMode {
  colors?: ThemeColors;
  typography?: ThemeTypography;
  borders?: ThemeBorders;
  shadows?: ThemeShadows;
}

/**
 * Complete theme settings.
 */
export interface ThemeSettings {
  dark: ThemeMode;
  light: ThemeMode;
}

/**
 * Complete settings structure.
 */
export interface Settings {
  branding: BrandingSettings;
  theme: ThemeSettings;
}

/**
 * Settings file format with metadata.
 */
export interface SettingsFile {
  $version: number;
  $source?: string;
  branding?: Partial<BrandingSettings>;
  theme?: {
    dark?: ThemeMode;
    light?: ThemeMode;
  };
}

/**
 * Storage format for the settings JSON file.
 */
interface SettingsStorage {
  version: number;
  enterprise: Partial<SettingsFile> | null;
  user: Partial<SettingsFile> | null;
}

const STORAGE_VERSION = 1;

/**
 * Default branding settings.
 */
const DEFAULT_BRANDING: BrandingSettings = {
  appName: "Creature",
  logo: null,
};

/**
 * Default dark mode theme.
 * Values from MCP Apps spec + Creature extensions.
 */
const DEFAULT_DARK_THEME: ThemeMode = {
  colors: {
    background: {
      primary: "#0D0D0B",
      secondary: "#1A1917",
      tertiary: "#141311",
      inverse: "#efefef",
      ghost: "transparent",
      info: "#1e3a5f",
      danger: "#5f1e1e",
      success: "#1e5f2e",
      warning: "#5f4a1e",
      disabled: "#1A1917",
    },
    text: {
      primary: "#efefef",
      secondary: "#888888",
      tertiary: "#4A4846",
      inverse: "#0D0D0B",
      ghost: "#3A3836",
      info: "#58a6ff",
      danger: "#F85149",
      success: "#3fb950",
      warning: "#d29922",
      disabled: "#4A4846",
    },
    border: {
      primary: "#4A4846",
      secondary: "#242222",
      tertiary: "#1A1917",
      inverse: "#ABABAB",
      ghost: "transparent",
      info: "#58a6ff",
      danger: "#F85149",
      success: "#3fb950",
      warning: "#d29922",
      disabled: "#242222",
    },
    ring: {
      primary: "#cdcdcd",
      secondary: "#666666",
      inverse: "#0D0D0B",
      info: "#58a6ff",
      danger: "#F85149",
      success: "#3fb950",
      warning: "#d29922",
    },
    input: {
      background: "#1A1917",
      text: "#efefef",
      border: "#4A4846",
    },
    solid: {
      primary: "#efefef",
      info: "#58a6ff",
      danger: "#F85149",
      success: "#3fb950",
      warning: "#d29922",
    },
  },
  typography: {
    fontSans: '"Sora", system-ui, sans-serif',
    fontMono: '"SF Mono", Monaco, Consolas, "Liberation Mono", monospace',
    fontWeightNormal: 400,
    fontWeightMedium: 500,
    fontWeightSemibold: 600,
    fontWeightBold: 700,
    textSize: {
      xs: "0.6875rem",
      sm: "0.75rem",
      md: "0.875rem",
      lg: "1rem",
    },
    textLineHeight: {
      xs: "1rem",
      sm: "1.25rem",
      md: "1.5rem",
      lg: "1.75rem",
    },
    headingSize: {
      xs: "0.875rem",
      sm: "1rem",
      md: "1.125rem",
      lg: "1.25rem",
      xl: "1.5rem",
      "2xl": "1.875rem",
      "3xl": "2.25rem",
    },
    headingLineHeight: {
      xs: "1.25rem",
      sm: "1.5rem",
      md: "1.75rem",
      lg: "2rem",
      xl: "2.25rem",
      "2xl": "2.5rem",
      "3xl": "2.75rem",
    },
  },
  borders: {
    radiusXs: "0.125rem",
    radiusSm: "0.1875rem",
    radiusMd: "0.25rem",
    radiusLg: "0.375rem",
    radiusXl: "0.5rem",
    radiusFull: "9999px",
    widthRegular: "1px",
  },
  shadows: {
    hairline: "0 0 0 1px rgba(0, 0, 0, 0.1)",
    sm: "0 1px 2px 0 rgba(0, 0, 0, 0.3)",
    md: "0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -2px rgba(0, 0, 0, 0.3)",
    lg: "0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -4px rgba(0, 0, 0, 0.3)",
  },
};

/**
 * Default light mode theme.
 * Values from MCP Apps spec + Creature extensions.
 */
const DEFAULT_LIGHT_THEME: ThemeMode = {
  colors: {
    background: {
      primary: "#ffffff",
      secondary: "#e8e8e8",
      tertiary: "#eaeaea",
      inverse: "#1F1E1D",
      ghost: "transparent",
      info: "#dbeafe",
      danger: "#fee2e2",
      success: "#dcfce7",
      warning: "#fef3c7",
      disabled: "#e8e8e8",
    },
    text: {
      primary: "#1F1E1D",
      secondary: "#6B6A68",
      tertiary: "#9A9998",
      inverse: "#F8F7F6",
      ghost: "#B8B7B5",
      info: "#0366d6",
      danger: "#DC2626",
      success: "#22863a",
      warning: "#b08800",
      disabled: "#9A9998",
    },
    border: {
      primary: "#b8b8b8",
      secondary: "#d8d8d8",
      tertiary: "#e8e8e8",
      inverse: "#1F1E1D",
      ghost: "transparent",
      info: "#0366d6",
      danger: "#DC2626",
      success: "#22863a",
      warning: "#b08800",
      disabled: "#d8d8d8",
    },
    ring: {
      primary: "#666666",
      secondary: "#AAAAAA",
      inverse: "#F8F7F6",
      info: "#0366d6",
      danger: "#DC2626",
      success: "#22863a",
      warning: "#b08800",
    },
    input: {
      background: "#ffffff",
      text: "#1F1E1D",
      border: "#b8b8b8",
    },
    solid: {
      primary: "#1F1E1D",
      info: "#0366d6",
      danger: "#DC2626",
      success: "#22863a",
      warning: "#b08800",
    },
  },
  typography: {
    fontSans: '"Sora", system-ui, sans-serif',
    fontMono: '"SF Mono", Monaco, Consolas, "Liberation Mono", monospace',
    fontWeightNormal: 400,
    fontWeightMedium: 500,
    fontWeightSemibold: 600,
    fontWeightBold: 700,
    textSize: {
      xs: "0.6875rem",
      sm: "0.75rem",
      md: "0.875rem",
      lg: "1rem",
    },
    textLineHeight: {
      xs: "1rem",
      sm: "1.25rem",
      md: "1.5rem",
      lg: "1.75rem",
    },
    headingSize: {
      xs: "0.875rem",
      sm: "1rem",
      md: "1.125rem",
      lg: "1.25rem",
      xl: "1.5rem",
      "2xl": "1.875rem",
      "3xl": "2.25rem",
    },
    headingLineHeight: {
      xs: "1.25rem",
      sm: "1.5rem",
      md: "1.75rem",
      lg: "2rem",
      xl: "2.25rem",
      "2xl": "2.5rem",
      "3xl": "2.75rem",
    },
  },
  borders: {
    radiusXs: "0.125rem",
    radiusSm: "0.1875rem",
    radiusMd: "0.25rem",
    radiusLg: "0.375rem",
    radiusXl: "0.5rem",
    radiusFull: "9999px",
    widthRegular: "1px",
  },
  shadows: {
    hairline: "0 0 0 1px rgba(0, 0, 0, 0.05)",
    sm: "0 1px 2px 0 rgba(0, 0, 0, 0.1)",
    md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
    lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
  },
};

/**
 * Default theme settings with full values for both modes.
 */
const DEFAULT_THEME: ThemeSettings = {
  dark: DEFAULT_DARK_THEME,
  light: DEFAULT_LIGHT_THEME,
};

/**
 * Default settings.
 */
const DEFAULT_SETTINGS: Settings = {
  branding: DEFAULT_BRANDING,
  theme: DEFAULT_THEME,
};

/**
 * Get the path to the settings storage file.
 */
const getStoragePath = (): string => {
  return path.join(app.getPath("userData"), "settings.json");
};

/**
 * Deep merge two objects.
 * Source values override target values.
 * Uses `any` internally since we know the structure from our types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deepMerge = (target: any, source: any): any => {
  if (!source) return target;
  
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }

  return result;
};

/**
 * Load settings storage from disk.
 */
const loadStorage = (): SettingsStorage => {
  try {
    const storagePath = getStoragePath();

    if (!fs.existsSync(storagePath)) {
      return { version: STORAGE_VERSION, enterprise: null, user: null };
    }

    const data = fs.readFileSync(storagePath, "utf8");
    const storage = JSON.parse(data) as SettingsStorage;

    if (storage.version !== STORAGE_VERSION) {
      console.log("[SettingsStore] Migrating storage from version", storage.version);
      storage.version = STORAGE_VERSION;
    }

    return storage;
  } catch (error) {
    console.error("[SettingsStore] Failed to load storage:", error);
    return { version: STORAGE_VERSION, enterprise: null, user: null };
  }
};

/**
 * Save settings storage to disk.
 */
const saveStorage = (storage: SettingsStorage): void => {
  try {
    const storagePath = getStoragePath();
    fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2), "utf8");
  } catch (error) {
    console.error("[SettingsStore] Failed to save storage:", error);
    throw new Error("Failed to save settings");
  }
};

/**
 * Merge a partial settings file into full settings.
 */
const mergePartialSettings = (base: Settings, partial: Partial<SettingsFile> | null): Settings => {
  if (!partial) {
    return base;
  }

  let result = { ...base };

  if (partial.branding) {
    result.branding = deepMerge(result.branding, partial.branding);
  }

  if (partial.theme) {
    result.theme = {
      dark: partial.theme.dark ? deepMerge(result.theme.dark, partial.theme.dark) : result.theme.dark,
      light: partial.theme.light ? deepMerge(result.theme.light, partial.theme.light) : result.theme.light,
    };
  }

  return result;
};

/**
 * Get resolved settings (defaults + enterprise + user merged).
 */
export const getSettings = (): Settings => {
  const storage = loadStorage();

  let settings = { ...DEFAULT_SETTINGS };
  settings = mergePartialSettings(settings, storage.enterprise);
  settings = mergePartialSettings(settings, storage.user);

  return settings;
};

/**
 * Get the enterprise settings source URL (if imported from URL).
 */
export const getEnterpriseSource = (): string | null => {
  const storage = loadStorage();
  return storage.enterprise?.$source ?? null;
};

/**
 * Import enterprise settings from a file or parsed object.
 * Replaces any existing enterprise settings.
 */
export const importEnterpriseSettings = async (params: {
  filePath?: string;
  settings?: SettingsFile;
}): Promise<{ success: boolean; error?: string }> => {
  try {
    let settingsFile: SettingsFile;

    if (params.filePath) {
      const data = fs.readFileSync(params.filePath, "utf8");
      settingsFile = JSON.parse(data) as SettingsFile;
    } else if (params.settings) {
      settingsFile = params.settings;
    } else {
      return { success: false, error: "No settings provided" };
    }

    if (!settingsFile.$version) {
      return { success: false, error: "Invalid settings file: missing $version" };
    }

    const storage = loadStorage();
    storage.enterprise = settingsFile;
    saveStorage(storage);

    console.log("[SettingsStore] Imported enterprise settings");
    return { success: true };
  } catch (error) {
    console.error("[SettingsStore] Failed to import settings:", error);
    return { success: false, error: String(error) };
  }
};

/**
 * Update user settings.
 * These override enterprise defaults.
 */
export const updateUserSettings = (params: {
  branding?: Partial<BrandingSettings>;
  theme?: {
    dark?: ThemeMode;
    light?: ThemeMode;
  };
}): { success: boolean; error?: string } => {
  try {
    const storage = loadStorage();

    if (!storage.user) {
      storage.user = { $version: STORAGE_VERSION };
    }

    if (params.branding) {
      storage.user.branding = deepMerge(storage.user.branding ?? {}, params.branding);
    }

    if (params.theme) {
      if (!storage.user.theme) {
        storage.user.theme = {};
      }
      if (params.theme.dark) {
        storage.user.theme.dark = deepMerge(storage.user.theme.dark ?? {}, params.theme.dark);
      }
      if (params.theme.light) {
        storage.user.theme.light = deepMerge(storage.user.theme.light ?? {}, params.theme.light);
      }
    }

    saveStorage(storage);
    console.log("[SettingsStore] Updated user settings");
    return { success: true };
  } catch (error) {
    console.error("[SettingsStore] Failed to update settings:", error);
    return { success: false, error: String(error) };
  }
};

/**
 * Reset user settings to defaults.
 * Enterprise settings are preserved.
 */
export const resetUserSettings = (): { success: boolean } => {
  const storage = loadStorage();
  storage.user = null;
  saveStorage(storage);
  console.log("[SettingsStore] Reset user settings");
  return { success: true };
};

/**
 * Clear all settings (enterprise and user).
 */
export const clearAllSettings = (): { success: boolean } => {
  const storage: SettingsStorage = {
    version: STORAGE_VERSION,
    enterprise: null,
    user: null,
  };
  saveStorage(storage);
  console.log("[SettingsStore] Cleared all settings");
  return { success: true };
};

/**
 * Export current settings to a file format.
 */
export const exportSettings = (): SettingsFile => {
  const settings = getSettings();
  return {
    $version: STORAGE_VERSION,
    branding: settings.branding,
    theme: settings.theme,
  };
};

/**
 * Convert theme settings to CSS variable overrides.
 * Returns a map of CSS variable name to value.
 */
export const themeToCssVariables = (params: {
  theme: ThemeMode;
}): Record<string, string> => {
  const { theme } = params;
  const variables: Record<string, string> = {};

  if (theme.colors?.background) {
    const bg = theme.colors.background;
    if (bg.primary) variables["--color-background-primary"] = bg.primary;
    if (bg.secondary) variables["--color-background-secondary"] = bg.secondary;
    if (bg.tertiary) variables["--color-background-tertiary"] = bg.tertiary;
    if (bg.inverse) variables["--color-background-inverse"] = bg.inverse;
    if (bg.ghost) variables["--color-background-ghost"] = bg.ghost;
    if (bg.info) variables["--color-background-info"] = bg.info;
    if (bg.danger) variables["--color-background-danger"] = bg.danger;
    if (bg.success) variables["--color-background-success"] = bg.success;
    if (bg.warning) variables["--color-background-warning"] = bg.warning;
    if (bg.disabled) variables["--color-background-disabled"] = bg.disabled;
  }

  if (theme.colors?.text) {
    const text = theme.colors.text;
    if (text.primary) variables["--color-text-primary"] = text.primary;
    if (text.secondary) variables["--color-text-secondary"] = text.secondary;
    if (text.tertiary) variables["--color-text-tertiary"] = text.tertiary;
    if (text.inverse) variables["--color-text-inverse"] = text.inverse;
    if (text.ghost) variables["--color-text-ghost"] = text.ghost;
    if (text.info) variables["--color-text-info"] = text.info;
    if (text.danger) variables["--color-text-danger"] = text.danger;
    if (text.success) variables["--color-text-success"] = text.success;
    if (text.warning) variables["--color-text-warning"] = text.warning;
    if (text.disabled) variables["--color-text-disabled"] = text.disabled;
  }

  if (theme.colors?.border) {
    const border = theme.colors.border;
    if (border.primary) variables["--color-border-primary"] = border.primary;
    if (border.secondary) variables["--color-border-secondary"] = border.secondary;
    if (border.tertiary) variables["--color-border-tertiary"] = border.tertiary;
    if (border.inverse) variables["--color-border-inverse"] = border.inverse;
    if (border.ghost) variables["--color-border-ghost"] = border.ghost;
    if (border.info) variables["--color-border-info"] = border.info;
    if (border.danger) variables["--color-border-danger"] = border.danger;
    if (border.success) variables["--color-border-success"] = border.success;
    if (border.warning) variables["--color-border-warning"] = border.warning;
    if (border.disabled) variables["--color-border-disabled"] = border.disabled;
  }

  if (theme.colors?.ring) {
    const ring = theme.colors.ring;
    if (ring.primary) variables["--color-ring-primary"] = ring.primary;
    if (ring.secondary) variables["--color-ring-secondary"] = ring.secondary;
    if (ring.inverse) variables["--color-ring-inverse"] = ring.inverse;
    if (ring.info) variables["--color-ring-info"] = ring.info;
    if (ring.danger) variables["--color-ring-danger"] = ring.danger;
    if (ring.success) variables["--color-ring-success"] = ring.success;
    if (ring.warning) variables["--color-ring-warning"] = ring.warning;
  }

  if (theme.colors?.input) {
    const input = theme.colors.input;
    if (input.background) variables["--color-input-background"] = input.background;
    if (input.text) variables["--color-input-text"] = input.text;
    if (input.border) variables["--color-input-border"] = input.border;
  }

  if (theme.colors?.solid) {
    const solid = theme.colors.solid;
    if (solid.primary) variables["--color-solid-primary"] = solid.primary;
    if (solid.info) variables["--color-solid-info"] = solid.info;
    if (solid.danger) variables["--color-solid-danger"] = solid.danger;
    if (solid.success) variables["--color-solid-success"] = solid.success;
    if (solid.warning) variables["--color-solid-warning"] = solid.warning;
  }

  if (theme.typography) {
    const typo = theme.typography;
    
    // Font families
    if (typo.fontSans) variables["--font-sans"] = typo.fontSans;
    if (typo.fontMono) variables["--font-mono"] = typo.fontMono;
    
    // Font weights
    if (typo.fontWeightNormal) variables["--font-weight-normal"] = String(typo.fontWeightNormal);
    if (typo.fontWeightMedium) variables["--font-weight-medium"] = String(typo.fontWeightMedium);
    if (typo.fontWeightSemibold) variables["--font-weight-semibold"] = String(typo.fontWeightSemibold);
    if (typo.fontWeightBold) variables["--font-weight-bold"] = String(typo.fontWeightBold);
    
    // Text sizes (MCP Apps spec)
    if (typo.textSize) {
      if (typo.textSize.xs) variables["--font-text-xs-size"] = typo.textSize.xs;
      if (typo.textSize.sm) variables["--font-text-sm-size"] = typo.textSize.sm;
      if (typo.textSize.md) variables["--font-text-md-size"] = typo.textSize.md;
      if (typo.textSize.lg) variables["--font-text-lg-size"] = typo.textSize.lg;
    }
    
    // Text line heights (MCP Apps spec)
    if (typo.textLineHeight) {
      if (typo.textLineHeight.xs) variables["--font-text-xs-line-height"] = typo.textLineHeight.xs;
      if (typo.textLineHeight.sm) variables["--font-text-sm-line-height"] = typo.textLineHeight.sm;
      if (typo.textLineHeight.md) variables["--font-text-md-line-height"] = typo.textLineHeight.md;
      if (typo.textLineHeight.lg) variables["--font-text-lg-line-height"] = typo.textLineHeight.lg;
    }
    
    // Heading sizes (MCP Apps spec)
    if (typo.headingSize) {
      if (typo.headingSize.xs) variables["--font-heading-xs-size"] = typo.headingSize.xs;
      if (typo.headingSize.sm) variables["--font-heading-sm-size"] = typo.headingSize.sm;
      if (typo.headingSize.md) variables["--font-heading-md-size"] = typo.headingSize.md;
      if (typo.headingSize.lg) variables["--font-heading-lg-size"] = typo.headingSize.lg;
      if (typo.headingSize.xl) variables["--font-heading-xl-size"] = typo.headingSize.xl;
      if (typo.headingSize["2xl"]) variables["--font-heading-2xl-size"] = typo.headingSize["2xl"];
      if (typo.headingSize["3xl"]) variables["--font-heading-3xl-size"] = typo.headingSize["3xl"];
    }
    
    // Heading line heights (MCP Apps spec)
    if (typo.headingLineHeight) {
      if (typo.headingLineHeight.xs) variables["--font-heading-xs-line-height"] = typo.headingLineHeight.xs;
      if (typo.headingLineHeight.sm) variables["--font-heading-sm-line-height"] = typo.headingLineHeight.sm;
      if (typo.headingLineHeight.md) variables["--font-heading-md-line-height"] = typo.headingLineHeight.md;
      if (typo.headingLineHeight.lg) variables["--font-heading-lg-line-height"] = typo.headingLineHeight.lg;
      if (typo.headingLineHeight.xl) variables["--font-heading-xl-line-height"] = typo.headingLineHeight.xl;
      if (typo.headingLineHeight["2xl"]) variables["--font-heading-2xl-line-height"] = typo.headingLineHeight["2xl"];
      if (typo.headingLineHeight["3xl"]) variables["--font-heading-3xl-line-height"] = typo.headingLineHeight["3xl"];
    }
  }

  if (theme.borders) {
    const borders = theme.borders;
    if (borders.radiusXs) variables["--border-radius-xs"] = borders.radiusXs;
    if (borders.radiusSm) variables["--border-radius-sm"] = borders.radiusSm;
    if (borders.radiusMd) variables["--border-radius-md"] = borders.radiusMd;
    if (borders.radiusLg) variables["--border-radius-lg"] = borders.radiusLg;
    if (borders.radiusXl) variables["--border-radius-xl"] = borders.radiusXl;
    if (borders.radiusFull) variables["--border-radius-full"] = borders.radiusFull;
    if (borders.widthRegular) variables["--border-width-regular"] = borders.widthRegular;
  }

  if (theme.shadows) {
    const shadows = theme.shadows;
    if (shadows.hairline) variables["--shadow-hairline"] = shadows.hairline;
    if (shadows.sm) variables["--shadow-sm"] = shadows.sm;
    if (shadows.md) variables["--shadow-md"] = shadows.md;
    if (shadows.lg) variables["--shadow-lg"] = shadows.lg;
  }

  return variables;
};
