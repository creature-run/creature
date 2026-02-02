import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { useTheme } from "../contexts/ThemeContext";
import { useApp } from "../contexts/AppContext";
import { cn } from "../lib/utils";
import {
  createCreatureAppBridge,
  type CreatureAppBridgeInstance,
} from "../lib/appBridge";
import { widgetStateStore } from "../lib/widgetStateStore";
import type { McpUiTheme, McpUiDisplayMode } from "@modelcontextprotocol/ext-apps";

const PLACEHOLDER_HTML = `<!DOCTYPE html><html><head></head><body></body></html>`;

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

const initializedWidgets = new Set<string>();

interface InlineWidgetProps {
  resourceUri: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  toolName: string;
  serverName: string;
  displayModes?: string[];
  /** Message ID containing this inline widget. Used for widget state keying. */
  messageId: string;
  onExpandToPip?: () => void;
}

const IconExpand = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

export const InlineWidget = memo(function InlineWidget({
  resourceUri,
  toolInput,
  toolResult,
  toolName,
  serverName,
  displayModes,
  messageId,
  onExpandToPip,
}: InlineWidgetProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [isLoadingHtml, setIsLoadingHtml] = useState(true);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(toolName.replace(/_/g, " "));
  const [iframeHeight, setIframeHeight] = useState(60);
  const { isDarkMode, colors, specStyleVariables } = useTheme();
  const { session, auth } = useApp();

  const MIN_HEIGHT = 60;
  const MAX_HEIGHT = 300;

  const bridgeRef = useRef<CreatureAppBridgeInstance | null>(null);
  const lastInitializedRef = useRef<string | null>(null);

  // Unique identifier for this widget instance (prevents duplicate bridges)
  const widgetInstanceId = useRef(
    `${serverName}:${resourceUri}:${JSON.stringify(toolInput)}`
  ).current;

  // Widget state key: conversationId + messageId
  const widgetStateKey = useMemo(() => {
    return `${session.sessionId}:${messageId}`;
  }, [session.sessionId, messageId]);

  const propsRef = useRef({ toolInput, toolResult, toolName, resourceUri, serverName, displayModes, colors, messageId });
  propsRef.current = { toolInput, toolResult, toolName, resourceUri, serverName, displayModes, colors, messageId };

  const canExpandToPip = displayModes?.includes("pip") && onExpandToPip;

  const getTheme = useCallback((): McpUiTheme => {
    return isDarkMode ? "dark" : "light";
  }, [isDarkMode]);

  useEffect(() => {
    let cancelled = false;

    const fetchHtml = async () => {
      try {
        const result = await window.electronAPI.controlPlane.getResourceHtml({
          serverName,
          resourceUri,
        });

        if (cancelled) return;

        if (result.success && result.html) {
          setHtmlContent(result.html);
        } else {
          setError(result.error || "Failed to load widget");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load widget");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingHtml(false);
        }
      }
    };

    fetchHtml();

    return () => {
      cancelled = true;
    };
  }, [serverName, resourceUri]);

  useEffect(() => {
    const iframe = iframeRef.current;
    const container = containerRef.current;
    if (!iframe || !container || !htmlContent) return;

    if (lastInitializedRef.current === widgetInstanceId) {
      return;
    }

    let isCleanedUp = false;

    const initBridge = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      if (isCleanedUp || !iframe.contentWindow) {
        return;
      }

      if (lastInitializedRef.current === widgetInstanceId) {
        return;
      }

      lastInitializedRef.current = widgetInstanceId;

      const props = propsRef.current;
      const viewportWidth = container.clientWidth || 400;

      const resultObj = props.toolResult as {
        structuredContent?: {
          title?: string;
          inlineTitle?: string;
          inlineHeight?: number;
        };
      } | undefined;

      // Restore widget state from store if available
      const restoredWidgetState = widgetStateStore.get(widgetStateKey);

      try {
        const bridgeInstance = await createCreatureAppBridge({
          iframe,
          instanceId: `inline-${props.resourceUri}`,
          serverName: props.serverName,
          resourceUri: props.resourceUri,
          conversationId: session.sessionId,
          messageId: props.messageId,
          hostContextParams: {
            theme: getTheme(),
            displayMode: "inline" as McpUiDisplayMode,
            availableDisplayModes: (props.displayModes || ["inline"]) as McpUiDisplayMode[],
            containerDimensions: {
              maxWidth: viewportWidth,
              maxHeight: MAX_HEIGHT,
            },
            widgetState: restoredWidgetState || undefined,
          },
          onInitialized: () => {
            console.log(`[InlineWidget] AppBridge initialized for ${props.resourceUri}`);
            initializedWidgets.add(widgetInstanceId);
            setIsLoaded(true);

            bridgeInstance.bridge.sendToolInput({
              arguments: props.toolInput,
            });

            const result = props.toolResult as {
              content?: Array<{ type: string; text: string }>;
              structuredContent?: object;
            };

            bridgeInstance.bridge.sendToolResult({
              content: result?.content || [{ type: "text", text: JSON.stringify(props.toolResult) }],
              structuredContent: result?.structuredContent,
              isError: false,
              toolName: props.toolName,
            });

            if (resultObj?.structuredContent?.inlineTitle) {
              setTitle(resultObj.structuredContent.inlineTitle);
            } else if (resultObj?.structuredContent?.title) {
              setTitle(resultObj.structuredContent.title);
            }

            const requestedHeight = resultObj?.structuredContent?.inlineHeight;
            if (typeof requestedHeight === "number" && requestedHeight > 0) {
              const clampedHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, requestedHeight));
              setIframeHeight(clampedHeight);
            } else {
              setTimeout(() => {
                const contentHeight = iframe.contentDocument?.body?.scrollHeight || 150;
                const clampedHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, contentHeight));
                setIframeHeight(clampedHeight);
              }, 150);
            }
          },
          onLog: (params) => {
            window.electronAPI.logs.fromUI({
              instanceId: `inline-${props.resourceUri}`,
              mcpServer: props.serverName,
              level: params.level,
              message: typeof params.data === "string" ? params.data : JSON.stringify(params.data),
              timestamp: new Date().toISOString(),
            });
          },
        });

        if (isCleanedUp) {
          await bridgeInstance.cleanup();
          return;
        }

        bridgeRef.current = bridgeInstance;
        setBridgeReady(true);
      } catch (err) {
        console.error(`[InlineWidget] Failed to create AppBridge for ${resourceUri}:`, err);
        setError(`Widget failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    initBridge();

    return () => {
      isCleanedUp = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [htmlContent, widgetInstanceId, widgetStateKey, session.sessionId]);

  useEffect(() => {
    const iframe = iframeRef.current;

    if (!bridgeReady || !iframe || !htmlContent) {
      return;
    }

    iframe.srcdoc = htmlContent;
  }, [bridgeReady, htmlContent]);

  /**
   * Send host-context-changed notification when theme changes.
   * Uses specStyleVariables from ThemeContext to avoid DOM timing issues.
   * The variables are stored in context state after being loaded from IPC,
   * so they're always in sync with the current theme.
   */
  useEffect(() => {
    if (!isLoaded || !bridgeRef.current) return;

    bridgeRef.current.bridge.sendHostContextChange({
      theme: getTheme(),
      styles: {
        variables: specStyleVariables,
      },
    });
  }, [isLoaded, isDarkMode, getTheme, specStyleVariables]);

  if (error) {
    return (
      <div className="w-full p-4 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (isLoadingHtml || !htmlContent) {
    return (
      <div className="w-full my-2 rounded-lg overflow-hidden border border-border-primary">
        <div className="flex items-center h-7 px-2 bg-background-tertiary border-b border-border-primary">
          <span className="flex-1 text-xs text-text-secondary truncate">
            {title}
          </span>
        </div>
        <div 
          className="w-full flex items-center justify-center text-text-secondary text-sm"
          style={{ height: `${MIN_HEIGHT}px`, backgroundColor: colors.backgroundSecondary }}
        >
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full my-2 rounded-lg overflow-hidden border border-border-primary">
      <div className="flex items-center h-7 px-2 bg-background-tertiary border-b border-border-primary">
        <span className="flex-1 text-xs text-text-secondary truncate">
          {title}
        </span>
        {canExpandToPip && (
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-background-secondary transition-colors cursor-pointer"
            onClick={onExpandToPip}
            title="Open in pip"
          >
            <IconExpand />
          </button>
        )}
      </div>

      <iframe
        ref={iframeRef}
        srcDoc={PLACEHOLDER_HTML}
        sandbox="allow-scripts allow-same-origin allow-forms"
        className={cn(
          "w-full border-0 transition-opacity duration-200",
          isLoaded ? "opacity-100" : "opacity-50"
        )}
        style={{
          height: `${iframeHeight}px`,
          backgroundColor: colors.backgroundSecondary,
          overflowY: "auto",
          overflowX: "hidden",
        }}
        title={`Inline widget: ${resourceUri}`}
      />
    </div>
  );
});
