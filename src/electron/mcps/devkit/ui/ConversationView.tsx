/**
 * Conversation View
 *
 * Conversation history inspector with virtualized scrolling.
 * Expandable messages show syntax-highlighted JSON trees with
 * collapsible nested objects/arrays and copy support.
 */

import { useState, useRef, useCallback, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button, Text, Badge, Card } from "open-mcp-app-ui";
import { Copy } from "lucide-react";
import { Toolbar, StatusBar, EmptyState } from "./shared.js";
import type { ConversationData, ConversationMessage } from "./types.js";

// =============================================================================
// Constants & Helpers
// =============================================================================

/**
 * Map conversation roles to Badge semantic variants.
 * User is informational (blue), assistant is success (green),
 * system is cautionary (yellow), tool is neutral.
 */
const ROLE_BADGE_VARIANTS: Record<string, "info" | "success" | "warning" | "secondary"> = {
  user: "info",
  assistant: "success",
  system: "warning",
  tool: "secondary",
};

/**
 * Count tool calls in a conversation message.
 * Handles both AI SDK v5 (tool-invocation) and v6 (dynamic-tool) formats.
 */
const countToolCalls = (msg: ConversationMessage): number => {
  if (!msg.parts || !Array.isArray(msg.parts)) return 0;
  let count = 0;
  for (const part of msg.parts) {
    if (part.type === "tool-invocation") count++;
    if (part.type === "dynamic-tool") count++;
    if (part.type && part.type.startsWith("tool-") && part.type !== "tool-invocation") count++;
  }
  return count;
};

/**
 * Generate a short preview string for a conversation message.
 * Shows tool call info when present, otherwise truncated text content.
 */
const getMessagePreview = (msg: ConversationMessage): string => {
  if (msg.parts && Array.isArray(msg.parts)) {
    const previews: string[] = [];
    let textPreview: string | null = null;
    let toolCount = 0;
    const toolNames: string[] = [];

    for (const part of msg.parts) {
      if (part.type === "text" && part.text && !textPreview) {
        const preview = part.text.substring(0, 60);
        textPreview = preview.length < part.text.length ? preview + "..." : preview;
      }
      if (part.type === "tool-invocation" && part.toolInvocation) {
        toolCount++;
        toolNames.push(part.toolInvocation.toolName);
      }
      if (part.type === "dynamic-tool" || (part.type && part.type.startsWith("tool-") && part.type !== "tool-invocation")) {
        toolCount++;
        const name = part.type === "dynamic-tool" ? part.toolName : part.type.substring(5);
        if (name) toolNames.push(name);
      }
    }

    if (toolCount > 0) {
      const toolInfo = toolNames.length <= 2
        ? toolNames.join(", ")
        : `${toolNames.slice(0, 2).join(", ")} +${toolCount - 2} more`;
      previews.push(`[${toolCount} tool${toolCount > 1 ? "s" : ""}: ${toolInfo}]`);
    }
    if (textPreview) previews.push(textPreview);
    if (previews.length > 0) return previews.join(" ");
    return `[${msg.parts.length} parts]`;
  }

  if (msg.content && typeof msg.content === "string") {
    const preview = msg.content.substring(0, 80);
    return preview.length < (msg.content as string).length ? preview + "..." : preview;
  }
  return "[No content]";
};

// =============================================================================
// JSON Tree
// =============================================================================

/**
 * Recursively render a JSON value as an interactive tree with expand/collapse
 * on objects and arrays. Primitive values are syntax-highlighted inline.
 * Matches the DevConsole's JSON color scheme:
 *   keys: #79C0FF, strings: #A5D6FF, numbers: #FFA657,
 *   booleans: #FF7B72, null: #8B949E
 */
const JSONTreeNode = ({
  value,
  indent = 0,
  defaultExpanded = false,
}: {
  value: unknown;
  indent?: number;
  defaultExpanded?: boolean;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const innerSpaces = "  ".repeat(indent + 1);
  const closingSpaces = "  ".repeat(indent);

  if (value === null) return <span style={{ color: "#8B949E" }}>null</span>;
  if (typeof value === "boolean") return <span style={{ color: "#FF7B72" }}>{String(value)}</span>;
  if (typeof value === "number") return <span style={{ color: "#FFA657" }}>{String(value)}</span>;

  if (typeof value === "string") {
    // Long strings get a truncated preview when in a tree context
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return <span style={{ color: "#A5D6FF" }}>"{escaped}"</span>;
  }

  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const openBrace = isArray ? "[" : "{";
  const closeBrace = isArray ? "]" : "}";

  if (entries.length === 0) return <>{openBrace}{closeBrace}</>;

  // Preview: Array(N) or { key1, key2, ... }
  const preview = isArray
    ? `Array(${entries.length})`
    : entries.length <= 2
      ? `{ ${entries.map(([k]) => k).join(", ")} }`
      : `{ ${entries.slice(0, 2).map(([k]) => k).join(", ")}, … }`;

  if (!expanded) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        className="cursor-pointer select-none"
      >
        <span className="text-txt-tertiary">▶ </span>
        <span className="text-txt-tertiary">{preview}</span>
      </span>
    );
  }

  return (
    <>
      <span
        onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        className="cursor-pointer select-none text-txt-tertiary"
      >
        ▼{" "}
      </span>
      {openBrace + "\n"}
      {entries.map(([key, val], i) => (
        <span key={key + i}>
          {innerSpaces}
          {!isArray && (
            <>
              <span style={{ color: "#79C0FF" }}>"{key}"</span>
              {": "}
            </>
          )}
          <JSONTreeNode value={val} indent={indent + 1} />
          {i < entries.length - 1 ? ",\n" : "\n"}
        </span>
      ))}
      {closingSpaces}{closeBrace}
    </>
  );
};

// =============================================================================
// Row Component
// =============================================================================

/**
 * A single conversation message row matching the log viewer's look and feel.
 * Collapsed: shows role label, tool count, message ID, and preview.
 * Expanded: shows syntax-highlighted, interactive JSON tree with
 * collapsible nested objects/arrays and a copy button.
 */
const MessageRow = memo(({
  message,
  index,
  isExpanded,
  onToggle,
}: {
  message: ConversationMessage;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  const role = message.role || "unknown";
  const toolCount = countToolCalls(message);
  const preview = getMessagePreview(message);
  const msgId = message.id || `msg-${index}`;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(message, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [message]);

  return (
    <div>
      <div
        className="flex items-center gap-1.5 px-3 py-0.5 hover:bg-bg-secondary transition-colors cursor-pointer font-mono text-[12px]"
        onClick={onToggle}
      >
        <Badge
          variant={ROLE_BADGE_VARIANTS[role] ?? "secondary"}
          className="shrink-0 uppercase font-mono !text-[10px] !py-0"
        >
          {role}
        </Badge>
        {toolCount > 0 && (
          <Badge variant="info" className="shrink-0 font-mono !text-[10px] !py-0">
            {toolCount} tool{toolCount > 1 ? "s" : ""}
          </Badge>
        )}
        <Text variant="tertiary" as="span" className="shrink-0 whitespace-nowrap text-[11px]">
          {msgId}
        </Text>
        <Text variant="secondary" as="span" className="truncate min-w-0 flex-1 text-[12px]">
          {preview}
        </Text>
        <Text variant="tertiary" as="span" className="shrink-0 text-[10px]">
          {isExpanded ? "▼" : "▶"}
        </Text>
      </div>
      {isExpanded && (
        <div className="mx-3 my-1">
          <div className="flex items-center gap-1 mb-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              title="Copy message JSON"
              className="!p-0.5 !text-[11px]"
              style={{
                width: 20,
                height: 20,
                color: copied ? "var(--color-text-success)" : undefined,
              }}
            >
              {copied ? "✓" : "⎘"}
            </Button>
          </div>
          <Card
            variant="default"
            padding="sm"
            className="overflow-y-auto overflow-x-hidden"
            style={{ maxHeight: 400 }}
          >
            <pre className="m-0 font-mono text-[11px] leading-snug whitespace-pre-wrap break-words">
              <JSONTreeNode value={message} defaultExpanded />
            </pre>
          </Card>
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Main View
// =============================================================================

/**
 * Conversation history viewer with virtualized scrolling.
 * Preserves scroll position and expanded state across data refreshes.
 */
export const ConversationView = ({
  data,
  isLoading,
  onRefresh,
}: {
  data: ConversationData | null;
  isLoading: boolean;
  onRefresh: () => void;
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const messages = data?.messages ?? [];

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 10,
  });

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCopy = useCallback(() => {
    if (messages.length > 0) {
      navigator.clipboard.writeText(JSON.stringify(messages, null, 2));
    }
  }, [messages]);

  return (
    <div className="devkit-dark-panel flex flex-col flex-1 min-h-0">
      <Toolbar
        onRefresh={onRefresh}
        isLoading={isLoading}
        actions={messages.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={handleCopy} className="!text-xs !px-2 !py-0.5">
            <Copy size={12} /> Copy
          </Button>
        ) : undefined}
      />
      <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0 py-1">
        {messages.length === 0 ? (
          <EmptyState message="No conversation history" />
        ) : (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const msg = messages[virtualRow.index];
              const msgId = msg.id || `msg-${virtualRow.index}`;
              return (
                <div
                  key={msgId}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <MessageRow
                    message={msg}
                    index={virtualRow.index}
                    isExpanded={expandedIds.has(msgId)}
                    onToggle={() => toggleExpanded(msgId)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <StatusBar>
        <Text variant="tertiary" as="span" size="sm">{messages.length} messages</Text>
      </StatusBar>
    </div>
  );
};
