/**
 * Host Context Builder
 *
 * Builds MCP Apps spec-compliant hostContext objects for Guest UIs.
 * Reads all spec-defined CSS variables directly from the DOM to ensure
 * MCP Apps receive the complete theme.
 *
 * @see https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx#theming
 */

import type {
  McpUiHostContext,
  McpUiTheme,
  McpUiDisplayMode,
  McpUiStyles,
  McpUiStyleVariableKey,
} from "@modelcontextprotocol/ext-apps";

/**
 * All CSS variable keys defined in the MCP Apps specification.
 * This list must stay in sync with McpUiStyleVariableKey from the spec.
 * Exported for use by ThemeContext to filter CSS variables.
 */
export const SPEC_STYLE_VARIABLE_KEYS: McpUiStyleVariableKey[] = [
  // Background colors
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-background-inverse",
  "--color-background-ghost",
  "--color-background-info",
  "--color-background-danger",
  "--color-background-success",
  "--color-background-warning",
  "--color-background-disabled",
  // Text colors
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-inverse",
  "--color-text-ghost",
  "--color-text-info",
  "--color-text-danger",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-disabled",
  // Border colors
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-tertiary",
  "--color-border-inverse",
  "--color-border-ghost",
  "--color-border-info",
  "--color-border-danger",
  "--color-border-success",
  "--color-border-warning",
  "--color-border-disabled",
  // Ring/focus colors
  "--color-ring-primary",
  "--color-ring-secondary",
  "--color-ring-inverse",
  "--color-ring-info",
  "--color-ring-danger",
  "--color-ring-success",
  "--color-ring-warning",
  // Typography - Family
  "--font-sans",
  "--font-mono",
  // Typography - Weight
  "--font-weight-normal",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  // Typography - Text Size
  "--font-text-xs-size",
  "--font-text-sm-size",
  "--font-text-md-size",
  "--font-text-lg-size",
  // Typography - Heading Size
  "--font-heading-xs-size",
  "--font-heading-sm-size",
  "--font-heading-md-size",
  "--font-heading-lg-size",
  "--font-heading-xl-size",
  "--font-heading-2xl-size",
  "--font-heading-3xl-size",
  // Typography - Text Line Height
  "--font-text-xs-line-height",
  "--font-text-sm-line-height",
  "--font-text-md-line-height",
  "--font-text-lg-line-height",
  // Typography - Heading Line Height
  "--font-heading-xs-line-height",
  "--font-heading-sm-line-height",
  "--font-heading-md-line-height",
  "--font-heading-lg-line-height",
  "--font-heading-xl-line-height",
  "--font-heading-2xl-line-height",
  "--font-heading-3xl-line-height",
  // Border radius
  "--border-radius-xs",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-xl",
  "--border-radius-full",
  // Border width
  "--border-width-regular",
  // Shadows
  "--shadow-hairline",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
];

/**
 * Experimental CSS variable keys beyond the MCP Apps spec.
 * These are sent via `experimental.styles.variables` in hostContext
 * to follow the SDK's experimental namespace paradigm.
 */
type ExperimentalStyleVariableKey =
  // Input colors (not in spec)
  | "--color-input-background"
  | "--color-input-text"
  | "--color-input-border"
  // Solid colors (not in spec - for filled buttons, badges, etc.)
  | "--color-solid-primary"
  | "--color-solid-info"
  | "--color-solid-danger"
  | "--color-solid-success"
  | "--color-solid-warning";

/**
 * Experimental extension CSS variables.
 * Sent in hostContext.experimental.styles.variables.
 */
const EXPERIMENTAL_STYLE_VARIABLE_KEYS: ExperimentalStyleVariableKey[] = [
  // Input colors
  "--color-input-background",
  "--color-input-text",
  "--color-input-border",
  // Solid colors
  "--color-solid-primary",
  "--color-solid-info",
  "--color-solid-danger",
  "--color-solid-success",
  "--color-solid-warning",
];

/**
 * Type for experimental style variables.
 */
export type ExperimentalStyles = Record<ExperimentalStyleVariableKey, string | undefined>;

/**
 * User identity context.
 * Apps can use this for auto-registration and personalization.
 */
export interface CreatureUserContext {
  /** Unique user identifier */
  id: string;
  /** User's display name */
  name?: string;
  /** User's email (requires user consent) */
  email?: string;
}

/**
 * Organization context.
 * Apps can use this to scope data and features to the org.
 */
export interface CreatureOrganizationContext {
  /** Unique organization identifier */
  id: string;
  /** Organization display name */
  name?: string;
  /** Organization slug for URL-friendly identifiers */
  slug?: string;
}

/**
 * Project context.
 * Apps can use this to scope data to specific projects.
 */
export interface CreatureProjectContext {
  /** Unique project identifier */
  id: string;
  /** Project display name */
  name?: string;
}

/**
 * Session context.
 * Allows apps to maintain state across tool calls in the same session.
 */
export interface CreatureSessionContext {
  /** Unique session identifier */
  id: string;
  /** Conversation/chat ID this session belongs to */
  conversationId?: string;
}

/**
 * Creature-specific identity and context information.
 * ONLY populated when running in Creature. Never sent in ChatGPT environment.
 * 
 * Apps can detect Creature environment via:
 * ```typescript
 * const isCreature = !!hostContext.creature;
 * ```
 */
export interface CreatureIdentityContext {
  /**
   * Creature-signed App Token (JWT) for secure backend verification.
   * Apps can send this to their backend, which verifies via JWKS.
   */
  token: string;
  /** User identity context for auto-registration and personalization */
  user?: CreatureUserContext;
  /** Organization context for scoping data to the org */
  organization?: CreatureOrganizationContext;
  /** Project context for scoping data to projects */
  project?: CreatureProjectContext;
  /** Session context for state across tool calls */
  session?: CreatureSessionContext;
}

/**
 * Context about how the view was opened.
 * Allows SDK to determine initialization behavior.
 */
export interface OpenContext {
  /**
   * How the view was opened:
   * - "tool": Opened by an agent tool call (expect tool-input/tool-result)
   * - "user": Opened directly by user (no tool notifications coming)
   */
  triggeredBy: "tool" | "user";
}

/**
 * Creature-specific extensions to hostContext.
 * Uses the MCP Apps spec extensibility mechanism ([key: string]: unknown).
 */
export interface CreatureHostContextExtensions {
  /**
   * Creature-specific identity and context information.
   * ONLY populated when running in Creature. Never sent in ChatGPT environment.
   * Apps can detect Creature environment via: `!!hostContext.creature`
   */
  creature?: CreatureIdentityContext;
  /**
   * Widget state restored from storage.
   * Follows ChatGPT Apps format for cross-platform compatibility.
   */
  widgetState?: {
    modelContent?: string | Record<string, unknown> | null;
    privateContent?: Record<string, unknown> | null;
    imageIds?: string[];
  };
  /**
   * Context about how the view was opened.
   * Per MCP Apps spec extensibility, sent in hostContext.
   */
  openContext?: OpenContext;
  /**
   * Experimental (non-standard) extensions to the MCP Apps spec.
   * Follows the SDK's `experimental` namespace paradigm.
   */
  experimental?: {
    /**
     * Additional CSS variables beyond the MCP Apps spec.
     * Apps should apply these alongside spec styles for enhanced theming.
     */
    styles?: {
      variables?: ExperimentalStyles;
    };
  };
}

/**
 * Parameters for building a hostContext object.
 */
export interface BuildHostContextParams {
  theme: McpUiTheme;
  displayMode: McpUiDisplayMode;
  availableDisplayModes?: McpUiDisplayMode[];
  containerDimensions?: McpUiHostContext["containerDimensions"];
  /**
   * Widget state to restore. Passed to Guest UI via hostContext.
   */
  widgetState?: CreatureHostContextExtensions["widgetState"];
  /**
   * Context about how the view was opened.
   * SDK uses this to determine initialization behavior.
   */
  openContext?: OpenContext;
  /**
   * Pre-computed style variables to use instead of reading from DOM.
   * Used by popout windows where globals.css is not loaded.
   */
  styles?: Partial<McpUiStyles>;
  /**
   * Host application identifier in format "<host>/<version>".
   * Per MCP Apps spec, this is the spec-compliant way for hosts to identify themselves.
   * Example: "creature/1.0.0"
   */
  userAgent?: string;
}

/**
 * Reads MCP Apps spec CSS variables from the document root.
 * Only includes variables defined in the spec (no extensions).
 */
export const getSpecStyleVariables = (): Partial<McpUiStyles> => {
  const style = getComputedStyle(document.documentElement);
  const variables: Partial<McpUiStyles> = {};

  for (const key of SPEC_STYLE_VARIABLE_KEYS) {
    const value = style.getPropertyValue(key).trim();
    if (value) {
      variables[key] = value;
    }
  }

  return variables;
};

/**
 * Reads experimental CSS variables from the document root.
 * These are sent via experimental.styles.variables to follow the SDK paradigm.
 */
export const getExperimentalStyleVariables = (): ExperimentalStyles => {
  const style = getComputedStyle(document.documentElement);
  const variables: Partial<ExperimentalStyles> = {};

  for (const key of EXPERIMENTAL_STYLE_VARIABLE_KEYS) {
    const value = style.getPropertyValue(key).trim();
    if (value) {
      variables[key] = value;
    }
  }

  return variables as ExperimentalStyles;
};

/**
 * Builds a spec-compliant hostContext object for MCP Apps.
 * 
 * Reads all CSS variables from globals.css and passes them to the MCP App:
 * - Spec variables go in `styles.variables` (schema-validated)
 * - Experimental extensions go in `experimental.styles.variables`
 * 
 * If `styles` is provided (e.g., from popout metadata), uses those directly
 * instead of reading from DOM. This handles cases where globals.css isn't loaded.
 * 
 * Widget state restoration: If widgetState is provided, it's passed to the
 * Guest UI via the hostContext extensibility mechanism. The Guest can use
 * this to restore previous state on re-render.
 */
export const buildHostContext = ({
  theme,
  displayMode,
  availableDisplayModes = ["inline", "pip"],
  containerDimensions,
  widgetState,
  openContext,
  styles,
  userAgent,
}: BuildHostContextParams): McpUiHostContext & CreatureHostContextExtensions => {
  // Use provided styles or read from DOM (where globals.css is loaded)
  const specVariables = styles || getSpecStyleVariables();
  const experimentalVariables = getExperimentalStyleVariables();

  const baseContext: McpUiHostContext = {
    theme,
    displayMode,
    availableDisplayModes,
    platform: "desktop",
    deviceCapabilities: {
      touch: false,
      hover: true,
    },
    styles: {
      variables: specVariables as McpUiStyles,
    },
    // Host application identifier per MCP Apps spec (e.g. "creature/1.0.0")
    ...(userAgent && { userAgent }),
  };

  if (containerDimensions) {
    baseContext.containerDimensions = containerDimensions;
  }

  // Add Creature-specific extensions via spec's extensibility mechanism
  const extensions: CreatureHostContextExtensions = {
    experimental: {
      styles: {
        variables: experimentalVariables,
      },
    },
  };

  if (widgetState) {
    extensions.widgetState = widgetState;
  }

  if (openContext) {
    extensions.openContext = openContext;
  }

  return {
    ...baseContext,
    ...extensions,
  };
};

/**
 * Builds a partial hostContext update for change notifications.
 * 
 * Re-reads all CSS variables to capture any theme changes.
 * Includes both spec variables and experimental extensions.
 */
export const buildHostContextUpdate = ({
  theme,
  includeStyles = false,
  containerDimensions,
}: {
  theme?: McpUiTheme;
  includeStyles?: boolean;
  containerDimensions?: McpUiHostContext["containerDimensions"];
}): Partial<McpUiHostContext & CreatureHostContextExtensions> => {
  const update: Partial<McpUiHostContext & CreatureHostContextExtensions> = {};

  if (theme !== undefined) {
    update.theme = theme;
  }

  if (includeStyles) {
    update.styles = {
      variables: getSpecStyleVariables() as McpUiStyles,
    };
    update.experimental = {
      styles: {
        variables: getExperimentalStyleVariables(),
      },
    };
  }

  if (containerDimensions !== undefined) {
    update.containerDimensions = containerDimensions;
  }

  return update;
};
