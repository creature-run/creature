/**
 * System Prompt View
 *
 * Read-only text display with character count and copy button.
 * No virtualization needed since this is a single text block.
 */

import { useCallback } from "react";
import { Button, Text } from "open-mcp-app-ui";
import { Copy } from "lucide-react";
import { Toolbar, StatusBar, EmptyState } from "./shared.js";
import type { PromptData } from "./types.js";

/**
 * System prompt viewer.
 * Read-only text display with character count and copy button.
 */
export const PromptView = ({
  data,
  isLoading,
  onRefresh,
}: {
  data: PromptData | null;
  isLoading: boolean;
  onRefresh: () => void;
}) => {
  const prompt = data?.prompt ?? "";
  const hasPrompt = prompt && !prompt.startsWith("(No active session");

  const handleCopy = useCallback(() => {
    if (hasPrompt) navigator.clipboard.writeText(prompt);
  }, [prompt, hasPrompt]);

  return (
    <div className="devkit-dark-panel flex flex-col flex-1 min-h-0">
      <Toolbar
        onRefresh={onRefresh}
        isLoading={isLoading}
        actions={hasPrompt ? (
          <Button variant="ghost" size="sm" onClick={handleCopy} className="!text-xs !px-2 !py-0.5">
            <Copy size={12} /> Copy
          </Button>
        ) : undefined}
      />
      <div className="flex-1 overflow-y-auto min-h-0">
        {!hasPrompt ? (
          <EmptyState message="No system prompt available" />
        ) : (
          <pre className="px-3 py-2 font-mono whitespace-pre-wrap break-words">
            <Text variant="primary" as="span" size="sm">{prompt}</Text>
          </pre>
        )}
      </div>
      <StatusBar>
        <Text variant="tertiary" as="span" size="sm">{hasPrompt ? `${prompt.length} characters` : ""}</Text>
      </StatusBar>
    </div>
  );
};
