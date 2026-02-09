import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CaretRight,
  CaretDown,
  Plus,
  Warning,
  XCircle,
  PushPin,
  PushPinSlash,
  PencilSimple,
  Check,
  X,
} from "@phosphor-icons/react";
import { ChatInput } from "./ChatInput";
import { Button } from "./Button";
import { Alert, AlertTitle, AlertDescription } from "./Alert";
import { InlineWidget } from "./InlineWidget";
import { Spinner } from "./Spinner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./DropdownMenu";
import { Input } from "./Input";
import { cn, startUpgrade } from "../lib/utils";
import { useTheme } from "../contexts/ThemeContext";
import { useApp } from "../contexts/AppContext";
import { widgetStateStore, makePipWidgetId, parseWidgetId } from "../lib/widgetStateStore";
import type {
  ChatSessionState,
  ChatSessionSummary,
  ChatSessionWithState,
  PersistedPipState,
  PersistedPipSnapshot,
} from "../electron/preload";

/**
 * Maps file extensions to IANA media types for images.
 * Used when constructing FileUIPart for image attachments.
 */
const getMediaType = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mediaTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return mediaTypes[ext || ""] || "image/jpeg";
};

interface ViewChatProps {
  isActive: boolean;
  folderPath: string | null;
  focusTrigger?: number;
  samplingApproval?: import("./ChatInput").SamplingApproval;
}

/**
 * ViewChat Component
 *
 * Renders a single chat tab with message history, input area, and folder selection.
 * Uses the Vercel AI SDK v6 useChat hook with DefaultChatTransport for message
 * management and streaming.
 *
 * ARCHITECTURE NOTE: Message State Separation
 * -------------------------------------------
 * This component maintains TWO separate message sources:
 *
 * 1. `streamedMessages` - Managed by useChat hook (AI SDK internal state)
 *    These are the messages from the AI conversation stream.
 *
 * 2. `injectedMessages` - Managed by local React state
 *    These are UI-initiated events (pip created/destroyed, UI tool calls)
 *    that need to be part of the agent's context but are hidden from the user.
 *
 * The transport merges these before sending to the agent, so the agent sees both.
 * The UI only renders `streamedMessages` so users don't see injected context.
 * Dev Console shows the full merged view for debugging.
 *
 * WHY SEPARATE STATE: Calling setMessages() on useChat while streaming breaks
 * the hook's internal state management. By keeping injected messages separate,
 * we preserve useChat's integrity while still providing context to the agent.
 */

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

const DEFAULT_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

const normalizeTokenUsage = (value: unknown): TokenUsage => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_TOKEN_USAGE };
  }

  const candidate = value as Partial<TokenUsage>;
  return {
    inputTokens: Number.isFinite(candidate.inputTokens) ? Number(candidate.inputTokens) : 0,
    outputTokens: Number.isFinite(candidate.outputTokens) ? Number(candidate.outputTokens) : 0,
    totalTokens: Number.isFinite(candidate.totalTokens) ? Number(candidate.totalTokens) : 0,
  };
};

const sortSessionSummaries = (sessions: ChatSessionSummary[]): ChatSessionSummary[] => {
  return [...sessions].sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const normalizePersistedPipState = (value: unknown): PersistedPipState => {
  if (!value || typeof value !== "object") {
    return {
      pips: [],
      pipOrder: [],
      activePipId: null,
    };
  }

  const raw = value as {
    pips?: unknown;
    pipOrder?: unknown;
    activePipId?: unknown;
  };

  const pips = Array.isArray(raw.pips)
    ? raw.pips
        .map((pip): PersistedPipSnapshot | null => {
          if (!pip || typeof pip !== "object") return null;
          const snapshot = pip as Partial<PersistedPipSnapshot>;
          if (
            typeof snapshot.instanceId !== "string" ||
            typeof snapshot.serverName !== "string" ||
            typeof snapshot.resourceUri !== "string" ||
            typeof snapshot.toolName !== "string" ||
            typeof snapshot.title !== "string"
          ) {
            return null;
          }
          return {
            instanceId: snapshot.instanceId,
            serverName: snapshot.serverName,
            resourceUri: snapshot.resourceUri,
            toolName: snapshot.toolName,
            title: snapshot.title,
            createdAt:
              typeof snapshot.createdAt === "number" && Number.isFinite(snapshot.createdAt)
                ? Number(snapshot.createdAt)
                : Date.now(),
            ...(typeof snapshot.triggeredByTool === "boolean"
              ? { triggeredByTool: snapshot.triggeredByTool }
              : {}),
            ...(typeof snapshot.openInBackground === "boolean"
              ? { openInBackground: snapshot.openInBackground }
              : {}),
            ...(snapshot.widgetState ? { widgetState: snapshot.widgetState } : {}),
          };
        })
        .filter((pip): pip is PersistedPipSnapshot => !!pip)
    : [];

  const instanceIds = new Set(pips.map((pip) => pip.instanceId));
  const pipOrder: string[] = [];
  const pushOrder = (instanceId: string) => {
    if (!instanceIds.has(instanceId) || pipOrder.includes(instanceId)) return;
    pipOrder.push(instanceId);
  };

  if (Array.isArray(raw.pipOrder)) {
    for (const value of raw.pipOrder) {
      if (typeof value === "string") {
        pushOrder(value);
      }
    }
  }

  for (const pip of pips) {
    pushOrder(pip.instanceId);
  }

  const activePipId =
    typeof raw.activePipId === "string" && instanceIds.has(raw.activePipId)
      ? raw.activePipId
      : null;

  return {
    pips,
    pipOrder,
    activePipId,
  };
};

// ============================================================================
// ChatSession Component (Internal)
// ============================================================================

interface ChatSessionProps {
  isActive: boolean;
  folderPath: string | null;
  focusTrigger?: number;
  samplingApproval?: import("./ChatInput").SamplingApproval;
}

/**
 * ChatSession Component
 *
 * Internal component that handles the actual chat session.
 * Uses the AI SDK v6 useChat hook with DefaultChatTransport for streaming.
 *
 * Separated from ViewChat to avoid initializing chat before folder is selected.
 */
function ChatSession({ isActive, folderPath, focusTrigger, samplingApproval }: ChatSessionProps) {
  const { isDarkMode } = useTheme();
  const { session, setProject, setSessionId, closeAllPips, pips, setActivePipId } = useApp();
  const [input, setInput] = useState("");

  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({ ...DEFAULT_TOKEN_USAGE });
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [isScrolled, setIsScrolled] = useState(false);
  const userScrolledUpRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const [sessionOptions, setSessionOptions] = useState<ChatSessionSummary[]>([]);
  const [seedMessages, setSeedMessages] = useState<UIMessage[]>([]);
  const [isSessionLoading, setIsSessionLoading] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [isSessionMetaUpdating, setIsSessionMetaUpdating] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [isSessionMenuOpen, setIsSessionMenuOpen] = useState(false);
  const [widgetStateRevision, setWidgetStateRevision] = useState(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratingSessionRef = useRef(true);
  const restoreGenerationRef = useRef(0);

  /**
   * Separate state for UI-injected messages (pip events, UI tool calls).
   *
   * CRITICAL: These messages MUST be kept separate from useChat's messages.
   * Calling useChat's setMessages() while streaming is in progress breaks
   * the hook's internal state management, causing it to create duplicate
   * message entries with the same ID. When duplicates exist, only the first
   * (incomplete) version gets rendered, hiding subsequent tool calls.
   *
   * By using a separate state and merging at render time, we preserve
   * useChat's internal state integrity.
   *
   * Each injected message includes an `_order` index for correct sorting
   * when merging with streamed messages.
   */
  const [injectedMessages, setInjectedMessages] = useState<(UIMessage & { _order?: number })[]>([]);

  /**
   * Global message order counter.
   * Incremented each time a new message is tracked to ensure correct ordering.
   */
  const messageOrderCounterRef = useRef(0);

  /**
   * Maps message IDs to their assigned order index.
   * Used to ensure consistent ordering across renders and to detect new messages.
   */
  const messageOrderMapRef = useRef(new Map<string, number>());

  /**
   * Gets the next order index and increments the counter.
   */
  const getNextOrder = useCallback((): number => {
    return messageOrderCounterRef.current++;
  }, []);

  /**
   * Toggles the expanded state of a tool call output.
   */
  const toggleToolExpanded = useCallback((toolId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  }, []);

  /**
   * Ref to current folder path for use in transport callback.
   * Avoids recreating transport when folder changes.
   */
  const folderPathRef = useRef(folderPath);
  folderPathRef.current = folderPath;

  /**
   * Ref to current custom instructions for use in transport callback.
   * Avoids recreating transport when custom instructions change.
   */
  const customInstructionsRef = useRef(session.project?.context?.custom_instructions || null);
  customInstructionsRef.current = session.project?.context?.custom_instructions || null;

  /**
   * Ref to injected messages for use in transport callback.
   * Allows the transport to include injected context (pip events, UI tool calls)
   * in the messages sent to the agent without recreating the transport.
   */
  const injectedMessagesRef = useRef<(UIMessage & { _order?: number })[]>([]);
  injectedMessagesRef.current = injectedMessages;

  /**
   * Create a stable transport instance for useChat.
   * The transport handles communication with the chat API endpoint.
   *
   * Merges injected messages with streamed messages so the agent receives
   * full context (pip events, UI tool calls) even though users don't see them.
   * Messages are sorted by their assigned order index for correct sequencing.
   */
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "http://localhost:43891/api/chat",
        headers: {
          "X-Session-Id": session.sessionId,
        },
        prepareSendMessagesRequest: (options) => {
          // Merge streamed messages with injected context for agent
          // Sort by order index to maintain correct sequence
          const orderMap = messageOrderMapRef.current;
          const allMessages = [...options.messages, ...injectedMessagesRef.current].sort((a, b) => {
            const msgA = a as UIMessage & { _order?: number };
            const msgB = b as UIMessage & { _order?: number };
            const aOrder = msgA._order ?? orderMap.get(msgA.id) ?? Infinity;
            const bOrder = msgB._order ?? orderMap.get(msgB.id) ?? Infinity;
            return aOrder - bOrder;
          });
          
          return {
            ...options,
            body: {
              messages: allMessages,
              sessionId: session.sessionId,
              folderPath: folderPathRef.current,
              customInstructions: customInstructionsRef.current,
            },
          };
        },
      }),
    [session.sessionId]
  );

  /**
   * useChat hook with ChatInit options.
   * Provides reactive state (messages, status, error) and actions (sendMessage, stop).
   * The hook internally creates and manages a Chat instance.
   */
  /**
   * Check if an error indicates the usage limit has been exceeded.
   * The API returns a 402 with "UsageLimitExceeded" type when the free plan limit is reached.
   * Also checks for "Payment Required" (HTTP 402 status text).
   */
  const isUsageLimitExceeded = useCallback((err: Error | null): boolean => {
    if (!err) return false;
    return err.message.includes("UsageLimitExceeded") || 
           err.message.includes("Monthly usage limit reached") ||
           err.message.includes("Payment Required");
  }, []);

  const { messages: streamedMessages, status, error, sendMessage, stop } = useChat({
    id: session.sessionId,
    messages: seedMessages,
    transport,
    onFinish: ({ message }) => {
      const metadata = message.metadata as {
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
        };
      } | undefined;
      if (metadata?.usage) {
        setTokenUsage((prev) => ({
          inputTokens: prev.inputTokens + (metadata.usage?.promptTokens ?? 0),
          outputTokens: prev.outputTokens + (metadata.usage?.completionTokens ?? 0),
          totalTokens: prev.totalTokens + (metadata.usage?.totalTokens ?? 0),
        }));
      }
    },
  });

  const toUiMessages = useCallback((items: unknown[]): UIMessage[] => {
    return items.filter((item): item is UIMessage => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as { id?: unknown; role?: unknown };
      return typeof candidate.id === "string" && typeof candidate.role === "string";
    });
  }, []);

  const toInjectedUiMessages = useCallback((items: unknown[]): (UIMessage & { _order?: number })[] => {
    return items
      .filter((item): item is UIMessage & { _order?: number } => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as { id?: unknown; role?: unknown };
        return typeof candidate.id === "string" && typeof candidate.role === "string";
      })
      .map((message) => {
        const candidate = message as UIMessage & { _order?: unknown };
        if (Number.isFinite(candidate._order)) {
          return { ...message, _order: Number(candidate._order) };
        }
        return message;
      });
  }, []);

  const upsertSessionSummary = useCallback((summary: ChatSessionSummary) => {
    setSessionOptions((prev) => {
      return sortSessionSummaries([
        summary,
        ...prev.filter((sessionOption) => sessionOption.id !== summary.id),
      ]);
    });
  }, []);

  const buildPersistedPipState = useCallback((): PersistedPipState => {
    const pipSnapshots: PersistedPipSnapshot[] = pips.pips
      .filter((pip) => pip.pipType === "mcp" && pip.mcpServer && pip.resourceUri)
      .map((pip) => {
        const widgetState = widgetStateStore.get(
          makePipWidgetId({ conversationId: session.sessionId, instanceId: pip.instanceId })
        );

        const snapshot: PersistedPipSnapshot = {
          instanceId: pip.instanceId,
          serverName: pip.mcpServer!,
          resourceUri: pip.resourceUri!,
          toolName: pip.toolName || "",
          title: pip.title || "",
          createdAt: Number.isFinite(pip.createdAt) ? pip.createdAt : Date.now(),
        };

        if (typeof pip.triggeredByTool === "boolean") {
          snapshot.triggeredByTool = pip.triggeredByTool;
        }

        if (typeof pip.openInBackground === "boolean") {
          snapshot.openInBackground = pip.openInBackground;
        }

        if (widgetState) {
          snapshot.widgetState = widgetState;
        }

        return snapshot;
      });

    const snapshotIds = new Set(pipSnapshots.map((snapshot) => snapshot.instanceId));
    const pipOrder: string[] = [];
    const pushOrder = (instanceId: string) => {
      if (!snapshotIds.has(instanceId) || pipOrder.includes(instanceId)) return;
      pipOrder.push(instanceId);
    };

    for (const instanceId of pips.pipOrder) {
      pushOrder(instanceId);
    }
    for (const snapshot of pipSnapshots) {
      pushOrder(snapshot.instanceId);
    }

    const activePipId =
      pips.activePipId && snapshotIds.has(pips.activePipId) ? pips.activePipId : null;

    return {
      pips: pipSnapshots,
      pipOrder,
      activePipId,
    };
  }, [pips.activePipId, pips.pipOrder, pips.pips, session.sessionId, widgetStateRevision]);

  const restoreWidgetStateStoreForSession = useCallback(
    (conversationId: string, pipState: PersistedPipState) => {
      for (const key of widgetStateStore.keys()) {
        const parsed = parseWidgetId(key);
        if (parsed?.conversationId === conversationId && parsed.type === "pip") {
          widgetStateStore.delete(key);
        }
      }

      for (const snapshot of pipState.pips) {
        if (!snapshot.widgetState) continue;

        const widgetId = makePipWidgetId({
          conversationId,
          instanceId: snapshot.instanceId,
        });
        widgetStateStore.set(widgetId, snapshot.widgetState, {
          mcpServerName: snapshot.serverName,
          resourceUri: snapshot.resourceUri,
          instanceId: snapshot.instanceId,
          conversationId,
        });
      }
    },
    []
  );

  const restorePipsForSession = useCallback(
    async ({
      pipState,
      generation,
    }: {
      pipState: PersistedPipState;
      generation: number;
    }) => {
      if (!session.project?.id || pipState.pips.length === 0) {
        return;
      }

      try {
        const result = await window.electronAPI.controlPlane.restorePips({ pipState });
        if (restoreGenerationRef.current !== generation) {
          return;
        }

        const activePipId =
          result.activePipId ||
          pipState.activePipId ||
          result.restoredInstanceIds[0] ||
          null;

        if (activePipId) {
          requestAnimationFrame(() => {
            if (restoreGenerationRef.current === generation) {
              setActivePipId(activePipId);
            }
          });
        }
      } catch (error) {
        console.error("[ViewChat] Failed to restore pips:", error);
      }
    },
    [session.project?.id, setActivePipId]
  );

  const hydrateFromSession = useCallback(
    (payload: ChatSessionWithState, allSessions: ChatSessionSummary[]) => {
      const nextStreamed = toUiMessages(payload.state.streamedMessages);
      const nextInjected = toInjectedUiMessages(payload.state.injectedMessages);
      const nextPipState = normalizePersistedPipState(payload.state.pipState);
      const nextOrderEntries = Object.entries(payload.state.messageOrder ?? {});
      const nextOrderMap = new Map<string, number>();
      for (const [id, value] of nextOrderEntries) {
        if (Number.isFinite(value)) {
          nextOrderMap.set(id, Number(value));
        }
      }
      const nextOrder = Number.isFinite(payload.state.nextOrder)
        ? Math.max(0, Math.floor(payload.state.nextOrder))
        : nextOrderMap.size;

      hydratingSessionRef.current = true;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      setSessionOptions(sortSessionSummaries(allSessions));
      setSeedMessages(nextStreamed);
      setInjectedMessages(nextInjected);
      setTokenUsage(normalizeTokenUsage(payload.state.tokenUsage));
      messageOrderMapRef.current = nextOrderMap;
      messageOrderCounterRef.current = nextOrder;
      userScrolledUpRef.current = false;
      setMessageQueue([]);
      setExpandedTools(new Set());
      setInput("");
      setRenamingSessionId(null);
      setRenameDraft("");
      setIsSessionMenuOpen(false);
      setSessionId(payload.summary.id);
      restoreGenerationRef.current += 1;
      const restoreGeneration = restoreGenerationRef.current;

      restoreWidgetStateStoreForSession(payload.summary.id, nextPipState);
      void restorePipsForSession({
        pipState: nextPipState,
        generation: restoreGeneration,
      });

      setTimeout(() => {
        hydratingSessionRef.current = false;
      }, 0);
    },
    [
      restorePipsForSession,
      restoreWidgetStateStoreForSession,
      setSessionId,
      toInjectedUiMessages,
      toUiMessages,
    ]
  );

  const buildPersistedState = useCallback((): ChatSessionState => {
    const messageOrder: Record<string, number> = {};
    for (const [id, order] of messageOrderMapRef.current.entries()) {
      messageOrder[id] = order;
    }

    return {
      streamedMessages,
      injectedMessages,
      messageOrder,
      nextOrder: messageOrderCounterRef.current,
      tokenUsage,
      pipState: buildPersistedPipState(),
    };
  }, [buildPersistedPipState, streamedMessages, injectedMessages, tokenUsage]);

  const persistState = useCallback(
    async (state: ChatSessionState) => {
      if (!session.project?.id || !session.sessionId) return;

      const result = await window.electronAPI.chatSession.save({
        projectId: session.project.id,
        sessionId: session.sessionId,
        state,
      });

      if (result.success && result.session) {
        upsertSessionSummary(result.session);
      }
    },
    [session.project?.id, session.sessionId, upsertSessionSummary]
  );

  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (hydratingSessionRef.current) return;
    await persistState(buildPersistedState());
  }, [buildPersistedState, persistState]);

  const flushPendingSaveRef = useRef(flushPendingSave);
  useEffect(() => {
    flushPendingSaveRef.current = flushPendingSave;
  }, [flushPendingSave]);

  useEffect(() => {
    const unsubscribe = widgetStateStore.onChange((event) => {
      if (event.conversationId && event.conversationId !== session.sessionId) {
        return;
      }
      setWidgetStateRevision((value) => value + 1);
    });

    return unsubscribe;
  }, [session.sessionId]);

  const applySessionUpdate = useCallback(
    (result: { session?: ChatSessionSummary; sessions?: ChatSessionSummary[] }) => {
      if (result.sessions) {
        setSessionOptions(sortSessionSummaries(result.sessions));
        return;
      }
      if (result.session) {
        upsertSessionSummary(result.session);
      }
    },
    [upsertSessionSummary]
  );

  const handleStartRenameSession = useCallback((sessionOption: ChatSessionSummary) => {
    setRenamingSessionId(sessionOption.id);
    setRenameDraft(sessionOption.title);
    setIsSessionMenuOpen(true);
  }, []);

  const handleCancelRenameSession = useCallback(() => {
    setRenamingSessionId(null);
    setRenameDraft("");
  }, []);

  const handleConfirmRenameSession = useCallback(async () => {
    if (!session.project?.id || !renamingSessionId) return;
    const normalizedTitle = renameDraft.trim();
    if (!normalizedTitle) return;
    if (isSessionMetaUpdating) return;

    setIsSessionMetaUpdating(true);
    try {
      const result = await window.electronAPI.chatSession.rename({
        projectId: session.project.id,
        sessionId: renamingSessionId,
        title: renameDraft,
      });

      if (result.success) {
        applySessionUpdate(result);
        setRenamingSessionId(null);
        setRenameDraft("");
      }
    } catch (renameError) {
      console.error("[ViewChat] Failed to rename session:", renameError);
    } finally {
      setIsSessionMetaUpdating(false);
    }
  }, [
    applySessionUpdate,
    isSessionMetaUpdating,
    renameDraft,
    renamingSessionId,
    session.project?.id,
  ]);

  const handleSetPinned = useCallback(
    async (sessionOption: ChatSessionSummary, pinned: boolean) => {
      if (!session.project?.id || isSessionMetaUpdating) return;

      setIsSessionMetaUpdating(true);
      try {
        const result = await window.electronAPI.chatSession.setPinned({
          projectId: session.project.id,
          sessionId: sessionOption.id,
          pinned,
        });

        if (result.success) {
          applySessionUpdate(result);
        }
      } catch (pinError) {
        console.error("[ViewChat] Failed to update session pin:", pinError);
      } finally {
        setIsSessionMetaUpdating(false);
      }
    },
    [applySessionUpdate, isSessionMetaUpdating, session.project?.id]
  );

  const handleSwitchSession = useCallback(
    async (targetSessionId: string) => {
      if (!session.project?.id || !targetSessionId || targetSessionId === session.sessionId) {
        return;
      }
      if (isSwitchingSession || isSessionMetaUpdating) return;

      setIsSwitchingSession(true);
      try {
        setRenamingSessionId(null);
        setRenameDraft("");
        setIsSessionMenuOpen(false);
        await stop();
        await flushPendingSave();
        await closeAllPips();

        const result = await window.electronAPI.chatSession.switch({
          projectId: session.project.id,
          sessionId: targetSessionId,
        });

        if (result.success && result.session && result.sessions) {
          hydrateFromSession(result.session, result.sessions);
        }
      } catch (switchError) {
        console.error("[ViewChat] Failed to switch session:", switchError);
      } finally {
        setIsSwitchingSession(false);
      }
    },
    [
      closeAllPips,
      flushPendingSave,
      hydrateFromSession,
      isSessionMetaUpdating,
      isSwitchingSession,
      session.project?.id,
      session.sessionId,
      stop,
    ]
  );

  const handleCreateSession = useCallback(async () => {
    if (!session.project?.id || isSwitchingSession || isSessionMetaUpdating) return;

    setIsSwitchingSession(true);
    try {
      setRenamingSessionId(null);
      setRenameDraft("");
      setIsSessionMenuOpen(false);
      await stop();
      await flushPendingSave();
      await closeAllPips();

      const result = await window.electronAPI.chatSession.create({
        projectId: session.project.id,
      });

      if (result.success && result.session && result.sessions) {
        hydrateFromSession(result.session, result.sessions);
      }
    } catch (createError) {
      console.error("[ViewChat] Failed to create session:", createError);
    } finally {
      setIsSwitchingSession(false);
    }
  }, [
    closeAllPips,
    flushPendingSave,
    hydrateFromSession,
    isSessionMetaUpdating,
    isSwitchingSession,
    session.project?.id,
    stop,
  ]);

  useEffect(() => {
    const projectId = session.project?.id;
    hydratingSessionRef.current = true;
    restoreGenerationRef.current += 1;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setSeedMessages([]);
    setInjectedMessages([]);
    setTokenUsage({ ...DEFAULT_TOKEN_USAGE });
    setSessionOptions([]);
    setIsSessionMetaUpdating(false);
    setRenamingSessionId(null);
    setRenameDraft("");
    setIsSessionMenuOpen(false);
    messageOrderMapRef.current = new Map<string, number>();
    messageOrderCounterRef.current = 0;
    setMessageQueue([]);
    setExpandedTools(new Set());
    setInput("");

    if (!projectId) {
      setSessionOptions([]);
      return;
    }

    let cancelled = false;
    const loadActiveSession = async () => {
      let loaded = false;
      setIsSessionLoading(true);
      try {
        const result = await window.electronAPI.chatSession.getActive({
          projectId,
        });

        if (cancelled) return;
        if (result.success && result.session && result.sessions) {
          hydrateFromSession(result.session, result.sessions);
          loaded = true;
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error("[ViewChat] Failed to load active session:", loadError);
        }
      } finally {
        if (!cancelled) {
          if (!loaded) {
            hydratingSessionRef.current = false;
          }
          setIsSessionLoading(false);
        }
      }
    };

    void loadActiveSession();

    return () => {
      cancelled = true;
    };
  }, [hydrateFromSession, session.project?.id]);

  useEffect(() => {
    if (!session.project?.id || isSessionLoading || isSwitchingSession) return;
    if (hydratingSessionRef.current) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    const state = buildPersistedState();
    saveTimerRef.current = setTimeout(() => {
      void persistState(state);
      saveTimerRef.current = null;
    }, 1000);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    buildPersistedState,
    injectedMessages,
    isSessionLoading,
    isSwitchingSession,
    persistState,
    session.project?.id,
    session.sessionId,
    streamedMessages,
    tokenUsage,
  ]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void flushPendingSaveRef.current();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    return () => {
      void flushPendingSaveRef.current();
    };
  }, []);

  /**
   * Merge streamed messages with injected context for Dev Console and agent.
   * This represents the full conversation context that the agent receives.
   * Messages are sorted by their assigned order index.
   *
   * Note: The UI renders `streamedMessages` directly (not this merged array)
   * so users only see the actual conversation, not injected context.
   */
  const messagesForAgent = useMemo(() => {
    return [...streamedMessages, ...injectedMessages].sort((a, b) => {
      const msgA = a as UIMessage & { _order?: number };
      const msgB = b as UIMessage & { _order?: number };
      const aOrder = msgA._order ?? messageOrderMapRef.current.get(msgA.id) ?? Infinity;
      const bOrder = msgB._order ?? messageOrderMapRef.current.get(msgB.id) ?? Infinity;
      return aOrder - bOrder;
    });
  }, [streamedMessages, injectedMessages]);

  /**
   * Track new streamed messages and assign them order indices.
   * Runs whenever streamedMessages changes to detect and order new messages.
   * This ensures all messages have consistent ordering for sorting.
   */
  useEffect(() => {
    for (const msg of streamedMessages) {
      if (!messageOrderMapRef.current.has(msg.id)) {
        messageOrderMapRef.current.set(msg.id, getNextOrder());
      }
    }
  }, [streamedMessages, getNextOrder]);

  /**
   * Focus input when navigating to chat view.
   * Triggered when:
   * - Navigating from Project List
   * - Closing Project Settings
   */
  useEffect(() => {
    if (focusTrigger && focusTrigger > 0) {
      inputRef.current?.focus();
    }
  }, [focusTrigger]);

  /**
   * Auto-scroll to bottom when streamed messages change,
   * but only if the user hasn't scrolled up manually.
   * Uses a ref to avoid re-render jitter during streaming.
   */
  useEffect(() => {
    if (!outputRef.current || userScrolledUpRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [streamedMessages]);

  /**
   * Track scroll position to show/hide top shadow.
   * Re-enables auto-scroll when user scrolls back to the bottom.
   */
  useEffect(() => {
    const handleScroll = () => {
      if (outputRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
        setIsScrolled(scrollTop > 0);

        // Re-enable auto-scroll when user scrolls back to the bottom
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        if (distanceFromBottom < 10) {
          userScrolledUpRef.current = false;
        }
      }
    };

    // Detect actual user scroll-up intent via wheel event
    const handleWheel = (e: WheelEvent) => {
      if (outputRef.current && e.deltaY < 0) {
        // User is scrolling up
        const { scrollTop, scrollHeight, clientHeight } = outputRef.current;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        if (distanceFromBottom > 10) {
          userScrolledUpRef.current = true;
        }
      }
    };

    const scrollElement = outputRef.current;
    if (scrollElement) {
      scrollElement.addEventListener("scroll", handleScroll);
      scrollElement.addEventListener("wheel", handleWheel, { passive: true });
      return () => {
        scrollElement.removeEventListener("scroll", handleScroll);
        scrollElement.removeEventListener("wheel", handleWheel);
      };
    }
  }, []);

  /**
   * Broadcast conversation updates to the main process for Devkit inspection.
   * Sends the full merged conversation (streamed + injected) that the agent sees.
   * Strips structuredContent (UI-only per MCP Apps spec).
   *
   * Debounced at 500ms and deferred via setTimeout to avoid blocking the
   * React render cycle. The JSON.parse(JSON.stringify(...)) deep clone is
   * expensive for large conversations and must not run synchronously during render.
   */
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        const serializable = JSON.parse(
          JSON.stringify(messagesForAgent, (key, value) => {
            if (key === "structuredContent") return undefined;
            return value;
          })
        );
        window.electronAPI.devConsole.updateConversation(serializable);
      } catch (e) {
        console.error("[ViewChat] Failed to serialize conversation for Dev Console:", e);
      }
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [messagesForAgent]);

  /**
   * Container click handler - intentionally does not auto-focus the input.
   * Users can click directly on the input to focus it.
   */
  const handleContainerClick = () => {
    // No auto-focus on container click
  };

  const isStreaming = status === "streaming" || status === "submitted";
  const hasStreamError = status === "error";
  const activeSession = sessionOptions.find((sessionOption) => sessionOption.id === session.sessionId);
  const isSessionBusy = isSessionLoading || isSwitchingSession || isSessionMetaUpdating;
  const activeSessionTitle = activeSession?.title ?? "Session";

  /**
   * Handles form submission from ChatInput.
   * Builds a message with file attachments when images are present,
   * using AI SDK v6's FileUIPart format for multimodal content.
   */
  const handleSubmit = useCallback(
    (finalContent: string, _attachedPaths: string[], images: Array<{ url?: string; filename: string }>) => {
      if (isSessionBusy) return;
      if (!finalContent.trim() && images.length === 0) return;

      // Re-enable auto-scroll when user sends a new message
      userScrolledUpRef.current = false;

      // Check if we have valid images with URLs
      const validImages = images.filter((img) => img.url);
      
      if (validImages.length > 0) {
        // Build FileUIPart array for images (AI SDK v6 format)
        const fileParts = validImages.map((img) => ({
          type: "file" as const,
          mediaType: getMediaType(img.filename),
          url: img.url!,
          filename: img.filename,
        }));

        if (isStreaming) {
          // For now, queue only supports text - log warning if images are queued
          console.warn("[ViewChat] Queuing message with images - images will be dropped from queue");
          setMessageQueue((queue) => [...queue, finalContent]);
        } else {
          // Send with text and files using AI SDK v6 format
          sendMessage({ text: finalContent || " ", files: fileParts });
        }
      } else {
        // Text-only message
        if (isStreaming) {
          setMessageQueue((queue) => [...queue, finalContent]);
        } else {
          sendMessage({ text: finalContent });
        }
      }
    },
    [isSessionBusy, isStreaming, sendMessage]
  );

  /**
   * Removes a message from the queue by index.
   */
  const handleRemoveFromQueue = useCallback((index: number) => {
    setMessageQueue((queue) => queue.filter((_, i) => i !== index));
  }, []);

  /**
   * Clears all queued messages.
   */
  const handleClearQueue = useCallback(() => {
    setMessageQueue([]);
  }, []);

  /**
   * Track previous streaming state to refocus input when streaming completes.
   */
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && isActive) {
      inputRef.current?.focus();
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, isActive]);

  /**
   * Process queued messages when agent becomes ready.
   */
  useEffect(() => {
    if (!isStreaming && messageQueue.length > 0) {
      const [nextMessage, ...remainingQueue] = messageQueue;
      setMessageQueue(remainingQueue);
      // Re-enable auto-scroll for queued message responses
      userScrolledUpRef.current = false;
      sendMessage({ text: nextMessage });
    }
  }, [isStreaming, messageQueue, sendMessage]);

  /**
   * Listen for pip destroyed events and inject into conversation history.
   * Informs the agent that a PIP tab was closed so it knows the widget is no longer active.
   * Uses separate injectedMessages state to avoid breaking useChat's internal state.
   * Assigns order index for correct sorting with streamed messages.
   */
  useEffect(() => {
    const unsubscribe = window.electronAPI.controlPlane.onPipDestroyed((event) => {
      const messageId = `pip-destroyed-${event.instanceId}`;

      setInjectedMessages((prev) => {
        if (prev.some((m) => m.id === messageId)) return prev;
        const destroyedMessage: UIMessage & { _order: number } = {
          id: messageId,
          role: "user",
          parts: [
            {
              type: "text",
              text: `[User closed PIP tab with Instance ID "${event.instanceId}" for MCP App "${event.serverName}"]`,
            },
          ],
          _order: getNextOrder(),
        };
        return [...prev, destroyedMessage];
      });
    });

    return unsubscribe;
  }, [getNextOrder]);

  /**
   * Listen for pip created events and inject into conversation history.
   * Informs the agent about new PIP tabs so it knows about active widgets and their instance IDs.
   * Uses separate injectedMessages state to avoid breaking useChat's internal state.
   * Assigns order index for correct sorting with streamed messages.
   */
  useEffect(() => {
    const unsubscribe = window.electronAPI.controlPlane.onPipCreatedForHistory((event) => {
      const messageId = `pip-created-${event.instanceId}`;

      setInjectedMessages((prev) => {
        if (prev.some((m) => m.id === messageId)) return prev;
        const createdMessage: UIMessage & { _order: number } = {
          id: messageId,
          role: "user",
          parts: [
            {
              type: "text",
              text: `[MCP App "${event.serverName}" created a PIP tab with Instance ID "${event.instanceId}"]`,
            },
          ],
          _order: getNextOrder(),
        };
        return [...prev, createdMessage];
      });
    });

    return unsubscribe;
  }, [getNextOrder]);

  const handleMarkdownLinkClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>, href?: string) => {
      event.preventDefault();

      if (!href) return;

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(href);
      } catch {
        return;
      }

      if (!MARKDOWN_ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
        return;
      }

      void window.electronAPI.shell.openExternal(parsedUrl.toString()).catch((openError) => {
        console.error("[ViewChat] Failed to open markdown link:", openError);
      });
    },
    []
  );

  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children, ...props }) => (
        <a
          {...props}
          href={href}
          rel="noopener noreferrer"
          onClick={(event) => handleMarkdownLinkClick(event, href)}
        >
          {children}
        </a>
      ),
    }),
    [handleMarkdownLinkClick]
  );

  const renderMarkdownBlock = useCallback(
    (text: string, key: string) => (
      <ReactMarkdown key={key} remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    ),
    [markdownComponents]
  );

  const renderMessageParts = useCallback(
    (msg: UIMessage, role: "assistant" | "user") => {
      const rendered: React.ReactNode[] = [];
      const parts = msg.parts || [];
      const isCurrentStreamingMessage =
        role === "assistant" && isStreaming && msg.id === streamedMessages[streamedMessages.length - 1]?.id;

      let textBuffer = "";
      let textStartIndex: number | null = null;

      const flushTextBuffer = () => {
        if (textStartIndex === null || textBuffer.length === 0) return;
        rendered.push(renderMarkdownBlock(textBuffer, `${msg.id}-md-${textStartIndex}`));
        textBuffer = "";
        textStartIndex = null;
      };

      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];

        if (part.type === "text") {
          if (textStartIndex === null) {
            textStartIndex = partIndex;
          }
          textBuffer += part.text;
          continue;
        }

        flushTextBuffer();

        if (part.type === "step-start") {
          continue;
        }

        if (role === "user") {
          continue;
        }

        if (part.type.startsWith("tool-")) {
          const toolPart = part as {
            type: string;
            toolName?: string;
            state: string;
            input?: unknown;
            output?: unknown;
          };
          const toolName = part.type.substring(5);

          const stuckAtInputAvailable =
            toolPart.state === "input-available" && !isCurrentStreamingMessage;

          const isRunning =
            (toolPart.state === "input-streaming" || toolPart.state === "input-available") &&
            !stuckAtInputAvailable;
          const isComplete = toolPart.state === "output-available" || stuckAtInputAvailable;
          const isError = toolPart.state === "output-error";

          const output = toolPart.output as {
            _inlineDisplay?: {
              resourceUri: string;
              serverName: string;
              toolName: string;
              displayModes: string[];
            };
            hasUi?: boolean;
            terminalUrl?: string;
            _mcpResource?: { text?: string };
            sessionId?: string;
          } | undefined;

          const hasMcpUi = !!(
            output?.hasUi ||
            output?.terminalUrl ||
            output?._mcpResource?.text
          );
          const inlineDisplay = output?._inlineDisplay;
          const toolId = `${msg.id}-${partIndex}`;
          const isExpanded = expandedTools.has(toolId);

          if (isComplete && inlineDisplay?.resourceUri) {
            rendered.push(
              <InlineWidget
                key={toolId}
                resourceUri={inlineDisplay.resourceUri}
                toolInput={(toolPart.input as Record<string, unknown>) || {}}
                toolResult={toolPart.output}
                toolName={inlineDisplay.toolName}
                serverName={inlineDisplay.serverName}
                displayModes={inlineDisplay.displayModes}
                messageId={msg.id}
                onExpandToPip={() => {
                  // For multi-session MCPs (like terminal), the tool result
                  // contains a sessionId. We should restore the session
                  // rather than re-run the command, preserving output history.
                  const structuredContent = (toolPart.output as { structuredContent?: { sessionId?: string } })?.structuredContent;
                  const sessionId = structuredContent?.sessionId;

                  if (sessionId && inlineDisplay.toolName === "terminal_run") {
                    // Use terminal_get to restore session without clearing buffer
                    window.electronAPI.controlPlane.callTool({
                      serverName: inlineDisplay.serverName,
                      toolName: "terminal_get",
                      args: { sessionId, displayMode: "pip" },
                    });
                  } else {
                    // Default: re-run the tool with pip mode
                    window.electronAPI.controlPlane.callTool({
                      serverName: inlineDisplay.serverName,
                      toolName: inlineDisplay.toolName,
                      args: {
                        ...((toolPart.input as Record<string, unknown>) || {}),
                        displayMode: "pip",
                      },
                    });
                  }
                }}
              />
            );
            continue;
          }

          const hasOutput =
            isComplete && toolPart.output && !hasMcpUi && !inlineDisplay;

          rendered.push(
            <div
              key={toolId}
              className={cn(
                "bg-background-secondary border border-border-primary rounded-md px-3.5 py-2.5 my-2 text-sm overflow-hidden",
                isError && "border-l-2 border-l-red-400"
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2",
                  hasOutput && "cursor-pointer"
                )}
                onClick={() => hasOutput && toggleToolExpanded(toolId)}
              >
                {isRunning && (
                  <Spinner size={12} />
                )}
                {isError && (
                  <span className="text-red-400 text-xs font-bold">✕</span>
                )}
                <span className="text-text-primary/70 font-medium">{toolName}</span>
                {hasOutput && (
                  <span className="text-text-secondary ml-auto">
                    {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                  </span>
                )}
              </div>
              {hasOutput && isExpanded && (
                <span className="block mt-2 text-text-secondary whitespace-pre-wrap break-all text-[11px] font-mono">
                  {JSON.stringify(toolPart.output, null, 2)}
                </span>
              )}
            </div>
          );
        }
      }

      flushTextBuffer();

      return rendered;
    },
    [expandedTools, isStreaming, renderMarkdownBlock, streamedMessages, toggleToolExpanded]
  );

  return (
    <div
      className={cn("flex-col h-full relative", isActive ? "flex" : "hidden")}
      onClick={handleContainerClick}
    >
      {/* Subtle fade under title bar - only shown when scrolled */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 left-0 right-0 h-2 z-10 transition-opacity duration-300",
          "bg-gradient-to-b",
          isDarkMode
            ? "from-black/[0.4] via-black/[0.2] to-transparent"
            : "from-black/[0.04] via-black/[0.02] to-transparent",
          isScrolled ? "opacity-100" : "opacity-0"
        )}
      />
      {/* Scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto show-scrollbar pb-[120px] [@media(min-height:800px)]:pb-[175px]" ref={outputRef}>
        <div className="p-6 pb-[80px] w-full max-w-[750px] mx-auto">
          <div className="mb-5 mt-1 flex items-center">
            <DropdownMenu
              open={isSessionMenuOpen}
              onOpenChange={(open) => {
                setIsSessionMenuOpen(open);
                if (!open) {
                  handleCancelRenameSession();
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border-secondary bg-background-secondary px-2.5 py-1 text-xs text-text-secondary transition-colors",
                    "hover:text-text-primary hover:border-border-primary",
                    isSessionBusy && "opacity-70 cursor-not-allowed"
                  )}
                  disabled={isSessionBusy}
                >
                  {activeSession?.isPinned && <PushPin size={12} />}
                  <span className="max-w-[360px] truncate">
                    {isSessionLoading ? "Loading session..." : activeSessionTitle}
                  </span>
                  <CaretDown size={12} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom" className="min-w-[300px]">
                {sessionOptions.map((sessionOption) => (
                  <DropdownMenuItem
                    key={sessionOption.id}
                    onSelect={(event) => {
                      event.preventDefault();
                    }}
                    className="text-xs"
                  >
                    {renamingSessionId === sessionOption.id ? (
                      <div
                        className="flex w-full items-center gap-1.5"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <Input
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void handleConfirmRenameSession();
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              handleCancelRenameSession();
                            }
                          }}
                          autoFocus
                          disabled={isSessionBusy}
                          className="h-7 text-xs"
                          maxLength={64}
                        />
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                          disabled={isSessionBusy || !renameDraft.trim()}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleConfirmRenameSession();
                          }}
                        >
                          <Check size={12} />
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                          disabled={isSessionBusy}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleCancelRenameSession();
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex w-full items-center gap-1.5">
                        <button
                          type="button"
                          className={cn(
                            "flex flex-1 items-center gap-1.5 truncate text-left",
                            sessionOption.id !== session.sessionId &&
                              !isSessionBusy &&
                              "hover:text-text-primary"
                          )}
                          disabled={isSessionBusy || sessionOption.id === session.sessionId}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (sessionOption.id !== session.sessionId) {
                              void handleSwitchSession(sessionOption.id);
                              setIsSessionMenuOpen(false);
                            }
                          }}
                        >
                          {sessionOption.isPinned && <PushPin size={10} />}
                          <span className="truncate">{sessionOption.title}</span>
                        </button>
                        {sessionOption.id === session.sessionId && (
                          <span className="text-[10px] text-text-secondary">Current</span>
                        )}
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                          disabled={isSessionBusy}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleSetPinned(sessionOption, !sessionOption.isPinned);
                          }}
                        >
                          {sessionOption.isPinned ? <PushPinSlash size={12} /> : <PushPin size={12} />}
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                          disabled={isSessionBusy}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleStartRenameSession(sessionOption);
                          }}
                        >
                          <PencilSimple size={12} />
                        </button>
                      </div>
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  disabled={isSessionBusy}
                  onSelect={(event) => {
                    event.preventDefault();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCreateSession();
                    setIsSessionMenuOpen(false);
                  }}
                  className="text-xs"
                >
                  <Plus size={12} />
                  <span>New Session</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Message list - renders only streamed messages (users don't see injected context) */}
          {streamedMessages.map((msg) => (
              <div key={msg.id}>
                {msg.role === "user" ? (
                  <div className="mb-4 mt-[40px] break-words">
                    {/* Render image file attachments in a compact grid */}
                    {msg.parts?.some((part) => part.type === "file" && (part as { mediaType?: string }).mediaType?.startsWith("image/")) && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {msg.parts?.map((part, i) => {
                          if (part.type === "file") {
                            const filePart = part as { type: string; mediaType?: string; url?: string; filename?: string };
                            if (filePart.mediaType?.startsWith("image/")) {
                              return (
                                <img
                                  key={i}
                                  src={filePart.url}
                                  alt={filePart.filename || "Attached image"}
                                  className="w-[50px] h-[50px] rounded border border-border-primary object-cover"
                                />
                              );
                            }
                          }
                          return null;
                        })}
                      </div>
                    )}
                    <div className="text-text-primary text-base leading-relaxed break-words [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_code]:bg-background-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em] [&_code]:font-mono [&_code]:break-all [&_pre]:bg-background-secondary [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-primary [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary [&_table]:my-2 [&_table]:w-full [&_table]:text-sm [&_table]:border-collapse [&_th]:border [&_th]:border-border-primary [&_th]:px-2 [&_th]:py-1 [&_th]:font-medium [&_th]:text-left [&_td]:border [&_td]:border-border-primary [&_td]:px-2 [&_td]:py-1 [&_hr]:my-3 [&_hr]:border-border-primary [&_a]:text-ring-primary [&_a]:no-underline [&_a:hover]:underline [&_input[type='checkbox']]:mr-1.5">
                      {renderMessageParts(msg, "user")}
                    </div>
                  </div>
                ) : (
                  <div className="bg-background-secondary rounded-md p-4 mb-4 overflow-hidden">
                    <div className="text-text-primary text-base leading-relaxed break-words [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_code]:bg-background-tertiary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em] [&_code]:font-mono [&_code]:break-all [&_pre]:bg-background-tertiary [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-2 [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:pl-6 [&_li]:my-1 [&_a]:text-ring-primary [&_a]:no-underline [&_a:hover]:underline">
                      {msg.parts?.map((part, i) => {
                        if (part.type === "text") {
                          return <ReactMarkdown key={i}>{part.text}</ReactMarkdown>;
                        }

                        // Skip step-start parts (internal markers)
                        if (part.type === "step-start") {
                          return null;
                        }

                        // AI SDK v6 format: tool-{toolName}
                        if (part.type.startsWith("tool-")) {
                          const toolPart = part as {
                            type: string;
                            toolName?: string;
                            state: string;
                            input?: unknown;
                            output?: unknown;
                          };
                          // For the mcp_tool proxy, show the actual serverName/toolName
                          // from the input args instead of the generic "mcp_tool" label
                          const rawToolName = part.type.substring(5);
                          const toolInput = toolPart.input as { serverName?: string; toolName?: string } | undefined;
                          const isMcpProxy = rawToolName === "mcp_tool";
                          const hasProxyNames = isMcpProxy && !!toolInput?.serverName && !!toolInput?.toolName;
                          const toolServerName = hasProxyNames ? toolInput!.serverName : null;
                          const toolDisplayName = hasProxyNames ? toolInput!.toolName : (isMcpProxy ? null : rawToolName);

                          const isCurrentStreamingMessage =
                            isStreaming && msg.id === streamedMessages[streamedMessages.length - 1]?.id;
                          const stuckAtInputAvailable =
                            toolPart.state === "input-available" && !isCurrentStreamingMessage;

                          // When the stream dies with an error, tool parts stuck in
                          // input-available are abandoned (no result will ever arrive).
                          // Show them as errors so the UI doesn't appear frozen.
                          const isAbandoned = stuckAtInputAvailable && hasStreamError;

                          const isRunning =
                            (toolPart.state === "input-streaming" ||
                              toolPart.state === "input-available") &&
                            !stuckAtInputAvailable;
                          const isComplete =
                            toolPart.state === "output-available" || (stuckAtInputAvailable && !isAbandoned);
                          const isError = toolPart.state === "output-error" || isAbandoned;

                          const output = toolPart.output as {
                            _inlineDisplay?: {
                              resourceUri: string;
                              serverName: string;
                              toolName: string;
                              displayModes: string[];
                            };
                            hasUi?: boolean;
                            terminalUrl?: string;
                            _mcpResource?: { text?: string };
                            sessionId?: string;
                          } | undefined;

                          const hasMcpUi = !!(
                            output?.hasUi ||
                            output?.terminalUrl ||
                            output?._mcpResource?.text
                          );
                          const inlineDisplay = output?._inlineDisplay;
                          const toolId = `${msg.id}-${i}`;
                          const isExpanded = expandedTools.has(toolId);

                          if (isComplete && inlineDisplay?.resourceUri) {
                            return (
                              <InlineWidget
                                key={toolId}
                                resourceUri={inlineDisplay.resourceUri}
                                toolInput={(toolPart.input as Record<string, unknown>) || {}}
                                toolResult={toolPart.output}
                                toolName={inlineDisplay.toolName}
                                serverName={inlineDisplay.serverName}
                                displayModes={inlineDisplay.displayModes}
                                messageId={msg.id}
                                onExpandToPip={() => {
                                  // For multi-session MCPs (like terminal), the tool result
                                  // contains a sessionId. We should restore the session
                                  // rather than re-run the command, preserving output history.
                                  const structuredContent = (toolPart.output as { structuredContent?: { sessionId?: string } })?.structuredContent;
                                  const sessionId = structuredContent?.sessionId;

                                  if (sessionId && inlineDisplay.toolName === "terminal_run") {
                                    // Use terminal_get to restore session without clearing buffer
                                    window.electronAPI.controlPlane.callTool({
                                      serverName: inlineDisplay.serverName,
                                      toolName: "terminal_get",
                                      args: { sessionId, displayMode: "pip" },
                                    });
                                  } else {
                                    // Default: re-run the tool with pip mode
                                    window.electronAPI.controlPlane.callTool({
                                      serverName: inlineDisplay.serverName,
                                      toolName: inlineDisplay.toolName,
                                      args: {
                                        ...((toolPart.input as Record<string, unknown>) || {}),
                                        displayMode: "pip",
                                      },
                                    });
                                  }
                                }}
                              />
                            );
                          }

                          const hasOutput =
                            isComplete && toolPart.output && !hasMcpUi && !inlineDisplay;

                          return (
                            <div
                              key={i}
                              className={cn(
                                "bg-background-secondary border border-border-primary rounded-md px-3.5 py-2.5 my-2 text-sm overflow-hidden",
                                isError && "border-l-2 border-l-red-400"
                              )}
                            >
                              <div
                                className={cn(
                                  "flex items-center gap-1.5",
                                  hasOutput && "cursor-pointer"
                                )}
                                onClick={() => hasOutput && toggleToolExpanded(toolId)}
                              >
                                {isError && (
                                  <span className="text-red-400 text-xs font-bold">✕</span>
                                )}
                                {toolServerName && (
                                  <>
                                    <span className="text-text-primary/70 font-medium">{toolServerName}</span>
                                    <CaretRight size={10} weight="bold" className="text-text-secondary/50" />
                                  </>
                                )}
                                {toolDisplayName && (
                                  <span className="text-text-primary/70 font-medium">{toolDisplayName}</span>
                                )}
                                {isRunning && (
                                  <span className="ml-auto">
                                    <Spinner size={12} />
                                  </span>
                                )}
                                {hasOutput && !isRunning && (
                                  <span className="text-text-secondary ml-auto">
                                    {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                                  </span>
                                )}
                              </div>
                              {hasOutput && isExpanded && (
                                <span className="block mt-2 text-text-secondary whitespace-pre-wrap break-all text-[11px] font-mono">
                                  {JSON.stringify(toolPart.output, null, 2)}
                                </span>
                              )}
                            </div>
                          );
                        }

                        return null;
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))}

          {/* Streaming indicator */}
          {isStreaming && (
            <div className="flex items-center gap-1.5 py-2 text-text-secondary text-xs">
              <Spinner size={12} />
              <span>
                Working...{messageQueue.length > 0 && ` (${messageQueue.length} queued)`}
              </span>
            </div>
          )}

          {/* Error display */}
          {error && (
            isUsageLimitExceeded(error) ? (
              /* Usage Limit Paywall */
              <div className="mb-4 rounded-lg border border-border-secondary bg-background-tertiary p-5">
                <div className="flex items-center gap-2 mb-2">
                  <Warning size={14} weight="fill" className="text-text-primary" />
                  <h5 className="text-sm font-medium text-text-primary">
                    Monthly Usage Limit Reached
                  </h5>
                </div>
                <p className="text-sm text-text-secondary mb-4">
                  You&apos;ve used your free plan&apos;s monthly AI allowance.
                  Upgrade to Starter for $4/month with AI usage billed at provider rates.
                </p>
                <Button
                  onClick={() => startUpgrade()}
                  size="sm"
                >
                  Upgrade to Starter
                </Button>
              </div>
            ) : (
              /* General Error */
              <Alert variant="destructive" className="mb-4">
                <XCircle size={18} weight="fill" className="mt-0.5" />
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription>
                  {error.message}
                </AlertDescription>
              </Alert>
            )
          )}
        </div>
      </div>

      {/* Gradient overlay that fades content behind the chat input area.
          Uses solid background color (not opacity) to fully hide scrolled content.
          Gradient finishes early so text is fully hidden before reaching the input. */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 right-[12px] h-[190px] [@media(min-height:800px)]:h-[250px] z-[15]"
        style={{
          background: `linear-gradient(to bottom, transparent 0%, var(--color-background-primary) 25%)`,
        }}
      />

      {/* Floating input area - positioned at bottom, matches content width */}
      <div className="absolute bottom-[0px] [@media(min-height:800px)]:bottom-[40px] left-0 right-0 pointer-events-none z-20">
        <div className="w-full max-w-[750px] mx-auto px-6 pointer-events-auto">
          <ChatInput
            input={input}
            setInput={setInput}
            isStreaming={isStreaming}
            folderPath={folderPath}
            inputRef={inputRef}
            onSubmit={handleSubmit}
            onStop={stop}
            tokenUsage={tokenUsage}
            project={session.project}
            onProjectUpdate={setProject}
            messageQueue={messageQueue}
            onRemoveFromQueue={handleRemoveFromQueue}
            onClearQueue={handleClearQueue}
            samplingApproval={samplingApproval}
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ViewChat Component (Exported)
// ============================================================================

/**
 * ViewChat Component
 *
 * Main chat view that renders the chat session.
 * With the new project-based flow, folder selection is handled by the project picker.
 * Chat now works with or without a folder.
 */
export function ViewChat({ isActive, folderPath, focusTrigger, samplingApproval }: ViewChatProps) {
  return (
    <ChatSession
      isActive={isActive}
      folderPath={folderPath}
      focusTrigger={focusTrigger}
      samplingApproval={samplingApproval}
    />
  );
}
