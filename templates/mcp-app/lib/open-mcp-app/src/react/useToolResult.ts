import { useState, useCallback } from "react";
import type { ToolResult, UseToolResultReturn } from "./types.js";

export type { UseToolResultReturn };

/**
 * Hook to access tool result data.
 * Extracts data, instanceId, title, and error state from tool results.
 */
export function useToolResult<T = Record<string, unknown>>(): UseToolResultReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const onToolResult = useCallback((result: ToolResult) => {
    const structured = result.structuredContent as (T & { title?: string; instanceId?: string }) | undefined;

    if (structured) {
      const { title: resultTitle, instanceId: resultInstanceId, ...rest } = structured;
      setData(rest as T);
      if (resultTitle) {
        setTitle(resultTitle);
      }
      if (resultInstanceId) {
        setInstanceId(resultInstanceId);
      }
    }

    setIsError(result.isError || false);

    if (result.content?.[0]?.text) {
      setText(result.content[0].text);
    }
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setInstanceId(null);
    setTitle(null);
    setIsError(false);
    setText(null);
  }, []);

  return {
    data,
    instanceId,
    title,
    isError,
    text,
    onToolResult,
    reset,
  };
}
