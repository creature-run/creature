import { useCallback, useState, useEffect, useRef } from "react";
import { ViewChat } from "./components/ViewChat";
import { SidebarLeft } from "./components/SidebarLeft";
import { ViewPips } from "./components/ViewPips";
import { ViewLogin } from "./components/ViewLogin";
import { ProjectList } from "./components/ProjectList";
import { ModalMcpSettings } from "./components/ModalMcpSettings";
import { ViewProjectSettings } from "./components/ViewProjectSettings";
import { ViewAppSettings } from "./components/ViewAppSettings";
import type { SamplingEvent } from "./components/SamplingDialog";
import { Toaster } from "./components/Sonner";
import { useApp } from "./contexts/AppContext";
import { Spinner } from "./components/Spinner";
import { toast } from "sonner";
import type { ProjectWithValidation } from "./electron/preload";
import type { CreateMessageRequestParams } from "@modelcontextprotocol/sdk/types.js";

/** Duration of the pip slide animation in milliseconds */
const PIP_ANIMATION_DURATION = 250;

/**
 * Main Application Component
 *
 * Pure layout component that handles:
 * - Window layout and structure
 * - Side pip area slide animation
 * - Rendering child components
 *
 * All business logic (auth, folder handling, pips) is in AppContext.
 */
function App() {
  // App context for all state
  const {
    session,
    auth,
    ui,
    layout,
    setProject,
    setProjectSettingsOpen,
    setAppSettingsOpen,
    setPipsWidth,
  } = useApp();

  const [samplingQueue, setSamplingQueue] = useState<SamplingEvent[]>([]);
  const activeSampling = samplingQueue[0] ?? null;

  useEffect(() => {
    const cleanup = window.electronAPI.sampling.onEvent((event) => {
      setSamplingQueue((queue) => [...queue, event]);
    });
    return () => {
      cleanup();
    };
  }, []);

  const applyTextToMessages = useCallback(
    (messages: CreateMessageRequestParams["messages"], text: string) => {
      let applied = false;
      return messages.map((message) => {
        const contentBlocks = Array.isArray(message.content) ? message.content : [message.content];
        const nextContent = contentBlocks.map((block) => {
          if (!applied && block && typeof block === "object" && "type" in block && block.type === "text") {
            applied = true;
            return { ...block, text };
          }
          return block;
        });
        if (!applied) {
          nextContent.push({ type: "text", text });
          applied = true;
        }
        return { ...message, content: nextContent };
      });
    },
    []
  );

  const handleSamplingApprove = useCallback(
    async (payload: {
      requestId: string;
      stage: "request";
      editedSystemPrompt?: string;
      editedMessages?: CreateMessageRequestParams["messages"];
      editedText?: string;
    }) => {
      let editedMessages = payload.editedMessages;

      if (payload.editedText && activeSampling) {
        if (activeSampling.stage === "request" && "messages" in activeSampling) {
          editedMessages = applyTextToMessages(activeSampling.messages, payload.editedText);
        }
      }

      await window.electronAPI.sampling.respond({
        requestId: payload.requestId,
        stage: payload.stage,
        action: "approve",
        editedSystemPrompt: payload.editedSystemPrompt,
        editedMessages,
      });
      setSamplingQueue((queue) => queue.slice(1));
    },
    [activeSampling, applyTextToMessages]
  );

  const handleSamplingReject = useCallback(async (payload: { requestId: string; stage: "request" }) => {
    await window.electronAPI.sampling.respond({
      requestId: payload.requestId,
      stage: payload.stage,
      action: "reject",
    });
    setSamplingQueue((queue) => queue.slice(1));
  }, []);


  // -------------------------------------------------------------------------
  // Pip Animation State
  // -------------------------------------------------------------------------

  /** Whether the pip area is currently animating */
  const [isAnimating, setIsAnimating] = useState(false);
  /** Current animated width during animation */
  const [animatedWidth, setAnimatedWidth] = useState(0);
  /** Whether pip content should be rendered (only after animation completes) */
  const [contentReady, setContentReady] = useState(false);
  /** Track previous visibility state to detect changes */
  const prevVisibleRef = useRef(false);
  /** Reference to cancel animation frames on cleanup */
  const animationFrameRef = useRef<number | null>(null);
  /** Store target width for animation (to avoid dependency issues) */
  const targetWidthRef = useRef(0);
  /** Store the last known pips width for closing animation */
  const lastPipsWidthRef = useRef(layout.pipsWidth);
  
  // -------------------------------------------------------------------------
  // Initial Message State (for project creators)
  // -------------------------------------------------------------------------

  // Keep lastPipsWidthRef in sync with layout.pipsWidth
  useEffect(() => {
    if (!isAnimating) {
      lastPipsWidthRef.current = layout.pipsWidth;
    }
  }, [layout.pipsWidth, isAnimating]);

  // -------------------------------------------------------------------------
  // Auto-Updater Notifications
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Show toast for update
    const showUpdateToast = (version: string) => {
      toast.success(`Update v${version} ready`, {
        description: "Restart to apply the update",
        duration: 10000,
        action: {
          label: "Restart",
          onClick: () => {
            window.electronAPI.updater.quitAndInstall();
          },
        },
      });
    };

    // Check if update was already downloaded before we mounted
    // This catches updates that download before React is ready
    window.electronAPI.updater.getPendingInfo()
      .then((info) => {
        if (info.pending && info.version) {
          console.log(`[App] Found pending update on mount: v${info.version}`);
          showUpdateToast(info.version);
        }
      })
      .catch(() => {
        // Updater not available (dev mode) - ignore
      });

    // Listen for update downloaded event (for future updates during this session)
    const cleanupDownloaded = window.electronAPI.updater.onUpdateDownloaded(
      (_, info) => {
        console.log(`[App] Received updater:downloaded event: v${info.version}`);
        showUpdateToast(info.version);
      }
    );

    return () => {
      cleanupDownloaded();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Chat Input Focus State
  // -------------------------------------------------------------------------

  /** Trigger to focus chat input when navigating to chat view */
  const [chatFocusTrigger, setChatFocusTrigger] = useState(0);
  const prevProjectIdRef = useRef<string | null>(null);
  const prevProjectSettingsOpenRef = useRef(false);

  /**
   * Focus chat input when:
   * 1. Navigating from Project List (project changes from null to a project)
   * 2. Closing Project Settings (projectSettingsOpen changes from true to false)
   */
  useEffect(() => {
    const projectChanged = session.project?.id !== prevProjectIdRef.current;
    const settingsClosed = prevProjectSettingsOpenRef.current && !ui.projectSettingsOpen;

    if (session.project && (projectChanged || settingsClosed)) {
      // Increment trigger to signal focus
      setChatFocusTrigger((prev) => prev + 1);
    }

    prevProjectIdRef.current = session.project?.id || null;
    prevProjectSettingsOpenRef.current = ui.projectSettingsOpen;
  }, [session.project, ui.projectSettingsOpen]);

  /**
   * Calculate the target pip width based on window dimensions.
   * Smaller windows get proportionally less pip space to ensure
   * the chat area remains usable.
   */
  const calculateTargetWidth = useCallback(() => {
    const windowWidth = window.innerWidth;
    
    if (windowWidth <= 650) {
      return Math.round(windowWidth * 0.4);
    }
    if (windowWidth <= 850) {
      return Math.round(windowWidth * 0.5);
    }
    // Default: 60% for windows wider than 850px
    return Math.round(windowWidth * 0.6);
  }, []);

  /**
   * Handle fullscreen changes.
   * - Entering fullscreen with pips visible: set pip width to 65%
   * - Leaving fullscreen with pips visible: recalculate using standard breakpoints
   * 
   * Uses a delay to wait for the macOS fullscreen animation to complete
   * before calculating the new pip width.
   */
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = window.electronAPI.window.onFullscreenChanged((isFullscreen) => {
      // Skip if pips aren't visible or we're animating
      if (!layout.isPipAreaVisible || isAnimating) return;

      // Clear any pending timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (isFullscreen) {
        // Entering fullscreen - we know the final size will be screen dimensions
        const screenWidth = window.screen.width;
        const fullscreenPipWidth = Math.round(screenWidth * 0.65);
        setPipsWidth(fullscreenPipWidth);
      } else {
        // Leaving fullscreen - wait for window to resize, then calculate
        timeoutId = setTimeout(() => {
          const newWidth = calculateTargetWidth();
          setPipsWidth(newWidth);
        }, 600);
      }
    });

    return () => {
      cleanup();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [layout.isPipAreaVisible, isAnimating, setPipsWidth, calculateTargetWidth]);

  /**
   * Handle pip visibility changes and trigger slide animations.
   * The animation slides the pip container in from the right,
   * and content is only loaded after the animation completes.
   * 
   * Note: We only depend on isPipAreaVisible to avoid re-running
   * when we update pipsWidth during animation.
   */
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    const isVisible = layout.isPipAreaVisible;

    // No change in visibility
    if (wasVisible === isVisible) return;

    prevVisibleRef.current = isVisible;

    // Cancel any running animation
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    if (isVisible) {
      // Opening: animate from 0 to target width
      const targetWidth = calculateTargetWidth();
      targetWidthRef.current = targetWidth;
      setContentReady(false);
      setIsAnimating(true);
      setAnimatedWidth(0);

      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / PIP_ANIMATION_DURATION, 1);
        // Ease-in-out: smooth acceleration and deceleration
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        setAnimatedWidth(Math.round(targetWidthRef.current * eased));

        if (progress < 1) {
          animationFrameRef.current = requestAnimationFrame(animate);
        } else {
          // Animation complete - set final width and show content
          setPipsWidth(targetWidthRef.current);
          setIsAnimating(false);
          setContentReady(true);
          animationFrameRef.current = null;
        }
      };

      animationFrameRef.current = requestAnimationFrame(animate);
    } else {
      // Closing: animate out with ease-in-out
      setContentReady(false);
      setIsAnimating(true);
      const startWidth = lastPipsWidthRef.current;
      const startTime = performance.now();

      const animate = (currentTime: number) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / PIP_ANIMATION_DURATION, 1);
        // Ease-in-out: smooth acceleration and deceleration
        const eased = progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;

        setAnimatedWidth(Math.round(startWidth * (1 - eased)));

        if (progress < 1) {
          animationFrameRef.current = requestAnimationFrame(animate);
        } else {
          // Animation complete
          setIsAnimating(false);
          setAnimatedWidth(0);
          animationFrameRef.current = null;
        }
      };

      animationFrameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [layout.isPipAreaVisible, calculateTargetWidth, setPipsWidth]);

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  const handleLoginSuccess = useCallback(() => {
    // API key was saved successfully, trigger a re-check of auth state
    // The app will re-render and show the project list
    window.location.reload();
  }, []);

  /**
   * Handles project selection from the project picker.
   * The project is already opened via project:open, so we just need to set it.
   * Optionally accepts an initial message to send to chat.
   */
  const handleProjectSelected = useCallback(
    (project: ProjectWithValidation) => {
      setProject(project);
    },
    [setProject]
  );



  // -------------------------------------------------------------------------
  // Derived State for Pips
  // -------------------------------------------------------------------------

  /**
   * Whether the pip container should be rendered at all.
   * Always render when pips exist to preserve iframe state.
   */
  const shouldRenderPipContainer = true;

  /**
   * The effective width to use for the pip area.
   * During animation, use the animated width; otherwise use the stored width.
   * When hidden, collapse to 0 width.
   */
  const effectivePipWidth = !layout.isPipAreaVisible && !isAnimating 
    ? 0 
    : (isAnimating ? animatedWidth : layout.pipsWidth);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Show loading while checking auth
  if (auth.authChecking) {
    return (
      <div className="h-screen flex items-center justify-center pb-[10%] bg-background-primary">
        <Spinner size={22} />
      </div>
    );
  }

  // Show login screen if no API key configured
  if (!auth.hasApiKey) {
    return <ViewLogin onLoginSuccess={handleLoginSuccess} />;
  }

  // Extract project name for title bar display
  const displayName = session.project?.name || session.folderName || null;

  return (
    <div className="h-screen flex flex-col bg-background-primary text-text-primary">
      {/* Title bar - spans full width with bottom border for traffic lights area */}
      <div className="shrink-0 flex items-center justify-center h-8 border-b border-border-secondary bg-background-primary [-webkit-app-region:drag]">
        {session.project && (
          <div className="text-xs text-text-secondary">
            {displayName}
          </div>
        )}
      </div>
      
      {/* Main content area: Left Sidebar | Main | Right Panels */}
      <div className="flex flex-1 overflow-hidden bg-background-primary">
        {/* Left Sidebar - Icons */}
        <SidebarLeft />

        {/* Content area (chat + pips) - relative container for project settings overlay */}
        <div className="flex flex-1 min-w-0 overflow-hidden relative">
          {/* Main Content - Chat or Project List */}
          <main className="flex-1 min-w-0 overflow-hidden bg-background-primary relative">
            {session.project ? (
              <ViewChat
                isActive={true}
                folderPath={session.folderPath}
                focusTrigger={chatFocusTrigger}
                samplingApproval={
                  activeSampling
                    ? {
                        event: activeSampling,
                        onApprove: ({ requestId, stage, editedText }) =>
                          handleSamplingApprove({ requestId, stage, editedText }),
                        onReject: ({ requestId, stage }) => handleSamplingReject({ requestId, stage }),
                      }
                    : undefined
                }
              />
            ) : (
              <ProjectList
                onProjectSelected={handleProjectSelected}
              />
            )}
          </main>

          {/* Right Pips - MCP Pips with slide animation */}
          {shouldRenderPipContainer && (
            <ViewPips
              width={effectivePipWidth}
              onWidthChange={setPipsWidth}
              showContent={contentReady}
              isVisible={layout.isPipAreaVisible}
            />
          )}

          {/* Project Settings Overlay - covers chat and pips area, not sidebar */}
          {session.project && ui.projectSettingsOpen && (
            <ViewProjectSettings onClose={() => setProjectSettingsOpen(false)} />
          )}

          {/* App Settings Overlay - covers chat and pips area, not sidebar */}
          {ui.appSettingsOpen && (
            <ViewAppSettings
              onClose={() => setAppSettingsOpen(false)}
              currentProviderType={auth.providerType}
            />
          )}
        </div>
      </div>

      {/* Toast Notifications */}
      <Toaster />

      
    </div>
  );
}

export default App;
