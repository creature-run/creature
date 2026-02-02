import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from "react";
import { cva } from "class-variance-authority";
import { SPEC_STYLE_VARIABLE_KEYS } from "../lib/hostContext";
import type { McpUiStyles } from "@modelcontextprotocol/ext-apps";

/**
 * ThemeContext
 * 
 * Centralized theme management for the application.
 * Loads settings on startup and applies CSS variable overrides.
 * Uses MCP Apps spec-compliant variable names.
 */

/**
 * Theme colors using MCP Apps spec naming.
 * These are computed CSS values from the current theme.
 */
export interface ThemeColors {
  /** Main background (--color-background-primary) */
  backgroundPrimary: string;
  /** Card/surface background (--color-background-secondary) */
  backgroundSecondary: string;
  /** Tertiary background (--color-background-tertiary) */
  backgroundTertiary: string;
  /** Primary text (--color-text-primary) */
  textPrimary: string;
  /** Secondary/muted text (--color-text-secondary) */
  textSecondary: string;
  /** Inverse text (--color-text-inverse) */
  textInverse: string;
  /** Primary border (--color-border-primary) */
  borderPrimary: string;
  /** Secondary border (--color-border-secondary) */
  borderSecondary: string;
  /** Ring/focus color (--color-ring-primary) */
  ringPrimary: string;
  /** Border radius (--border-radius-md) */
  borderRadius: string;
}

interface ThemeContextValue {
  isDarkMode: boolean;
  toggleTheme: () => void;
  colors: ThemeColors;
  settingsLoaded: boolean;
  /** MCP Apps spec-compliant CSS variables for passing to MCP Apps */
  specStyleVariables: Partial<McpUiStyles>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Button variants using MCP Apps spec color classes.
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-xs font-medium transition-colors duration-200 cursor-pointer select-none focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0 group",
  {
    variants: {
      variant: {
        default:
          "bg-background-inverse text-text-inverse hover:bg-background-inverse/90",
        destructive:
          "bg-solid-danger text-text-inverse hover:bg-solid-danger/90",
        outline:
          "border border-border-primary bg-transparent text-text-primary hover:border-ring-primary hover:text-text-primary [&_svg]:transition-colors [&_svg]:duration-200 [&_svg_path]:fill-current",
        "outline-muted":
          "border border-border-secondary bg-transparent text-text-secondary hover:border-ring-primary hover:text-text-primary",
        secondary:
          "bg-background-secondary text-text-primary hover:bg-background-secondary/80",
        ghost: "hover:bg-background-secondary hover:text-text-primary",
        link: "text-text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[34px] px-3",
        sm: "h-7 rounded-md px-2.5",
        lg: "h-11 rounded-md px-6",
        icon: "h-[34px] w-[34px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Apply CSS variables to the document root.
 * Called when settings are loaded or theme mode changes.
 */
const applyCssVariables = (variables: Record<string, string>) => {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(variables)) {
    if (value) {
      root.style.setProperty(key, value);
    }
  }
};

/**
 * Reads theme colors from computed CSS custom properties.
 */
const getColorsFromCSS = (): ThemeColors => {
  const style = getComputedStyle(document.documentElement);
  return {
    backgroundPrimary: style.getPropertyValue("--color-background-primary").trim(),
    backgroundSecondary: style.getPropertyValue("--color-background-secondary").trim(),
    backgroundTertiary: style.getPropertyValue("--color-background-tertiary").trim(),
    textPrimary: style.getPropertyValue("--color-text-primary").trim(),
    textSecondary: style.getPropertyValue("--color-text-secondary").trim(),
    textInverse: style.getPropertyValue("--color-text-inverse").trim(),
    borderPrimary: style.getPropertyValue("--color-border-primary").trim(),
    borderSecondary: style.getPropertyValue("--color-border-secondary").trim(),
    ringPrimary: style.getPropertyValue("--color-ring-primary").trim(),
    borderRadius: style.getPropertyValue("--border-radius-md").trim(),
  };
};

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem("theme");
    return saved !== "light";
  });

  const [colors, setColors] = useState<ThemeColors>({
    backgroundPrimary: "",
    backgroundSecondary: "",
    backgroundTertiary: "",
    textPrimary: "",
    textSecondary: "",
    textInverse: "",
    borderPrimary: "",
    borderSecondary: "",
    ringPrimary: "",
    borderRadius: "",
  });

  const [settingsLoaded, setSettingsLoaded] = useState(false);

  /**
   * MCP Apps spec-compliant CSS variables.
   * Stored directly from IPC response to avoid DOM timing issues.
   */
  const [specStyleVariables, setSpecStyleVariables] = useState<Partial<McpUiStyles>>({});

  /**
   * Load and apply settings CSS variables.
   */
  const loadAndApplySettings = useCallback(async (mode: "dark" | "light") => {
    try {
      const cssVars = await window.electronAPI.settings.getCssVariables({ mode });
      applyCssVariables(cssVars);

      // Filter to spec-compliant variables and store in state
      // This avoids DOM timing issues when MCP Apps need the variables
      const specVars: Partial<McpUiStyles> = {};
      for (const key of SPEC_STYLE_VARIABLE_KEYS) {
        if (cssVars[key]) {
          specVars[key] = cssVars[key];
        }
      }
      setSpecStyleVariables(specVars);

      // Update colors state immediately after CSS variables are applied
      // This must be synchronous so colors are set before settingsLoaded becomes true
      setColors(getColorsFromCSS());
    } catch (error) {
      console.error("[ThemeContext] Failed to load settings:", error);
    }
  }, []);

  /**
   * Load settings on mount.
   * Block rendering until settings are loaded.
   */
  useEffect(() => {
    const initializeTheme = async () => {
      const mode = isDarkMode ? "dark" : "light";
      await loadAndApplySettings(mode);
      setSettingsLoaded(true);
    };

    initializeTheme();
  }, []); // Only run once on mount

  /**
   * Re-apply settings when theme mode changes.
   */
  useEffect(() => {
    if (!settingsLoaded) return;

    if (isDarkMode) {
      document.documentElement.classList.remove("light");
      document.body.classList.remove("light");
    } else {
      document.documentElement.classList.add("light");
      document.body.classList.add("light");
    }

    const mode = isDarkMode ? "dark" : "light";
    loadAndApplySettings(mode);
  }, [isDarkMode, settingsLoaded, loadAndApplySettings]);

  /**
   * Listen for settings changes from main process.
   */
  useEffect(() => {
    const unsubscribe = window.electronAPI.settings.onChanged(() => {
      const mode = isDarkMode ? "dark" : "light";
      loadAndApplySettings(mode);
    });

    return unsubscribe;
  }, [isDarkMode, loadAndApplySettings]);

  /**
   * Toggle between dark and light mode.
   * Also broadcasts the change to any popout windows so they stay in sync.
   * Note: The actual broadcast happens in a separate effect that watches specStyleVariables,
   * ensuring popout windows receive the updated styles after they're loaded.
   */
  const toggleTheme = useCallback(() => {
    const newMode = !isDarkMode;
    setIsDarkMode(newMode);
    localStorage.setItem("theme", newMode ? "dark" : "light");
  }, [isDarkMode]);

  /**
   * Broadcast theme changes to popout windows when specStyleVariables update.
   * This ensures popout windows receive the correct styles after they're loaded,
   * avoiding the timing issue of reading from DOM before CSS is applied.
   */
  useEffect(() => {
    // Skip initial render before settings are loaded
    if (!settingsLoaded) return;

    const theme = isDarkMode ? "dark" : "light";
    window.electronAPI.window.broadcastTheme({
      theme,
      styles: specStyleVariables as Record<string, string>
    });
  }, [isDarkMode, specStyleVariables, settingsLoaded]);

  // Don't render children until settings are loaded
  if (!settingsLoaded) {
    return null;
  }

  return (
    <ThemeContext.Provider value={{ isDarkMode, toggleTheme, colors, settingsLoaded, specStyleVariables }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
