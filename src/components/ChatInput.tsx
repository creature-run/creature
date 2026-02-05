import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { cn, truncatePathLeft } from "../lib/utils";
import { Folder, FileText, PaperPlaneRight, Stop } from "@phosphor-icons/react";
import { useApp } from "../contexts/AppContext";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "./HoverCard";
import { Button } from "./Button";
import type { SamplingEvent } from "./SamplingDialog";

export interface FileReference {
  id: string;
  path: string;
  type: "file" | "folder";
  source: "mention" | "drag";
}

export interface ImageAttachment {
  id: string;
  localPath: string;
  url?: string;
  filename: string;
  size: number;
  uploading: boolean;
  error?: string;
}

export type SamplingApproval = {
  event: SamplingEvent;
  onApprove: (params: { requestId: string; stage: "request" | "review"; editedText: string }) => void;
  onReject: (params: { requestId: string; stage: "request" | "review" }) => void;
};

interface SearchResult {
  path: string;
  type: "file" | "folder";
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ProjectWithValidation {
  id: string;
  org_id: string;
  created_by: string;
  name: string;
  profile: "dev-general" | "dev-mcp";
  context: {
    local_directory?: { path: string };
    custom_instructions?: string;
  };
  mcps: Array<{
    name: string;
    registry?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    enabled: boolean;
  }>;
  deleted_at?: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  _localValidation?: {
    valid: boolean;
    error?: string;
  };
}

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  isStreaming: boolean;
  folderPath: string | null;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (finalContent: string, attachedPaths: string[], images: ImageAttachment[]) => void;
  onStop: () => void;
  tokenUsage?: TokenUsage;
  project: ProjectWithValidation | null;
  onProjectUpdate: (project: ProjectWithValidation | null) => void;
  messageQueue?: string[];
  onRemoveFromQueue?: (index: number) => void;
  onClearQueue?: () => void;
  samplingApproval?: SamplingApproval;
}

/**
 * Formats a number with K (thousands) or M (millions) suffix.
 * Examples: 1500 → "1.5K", 1000000 → "1M", 500 → "500"
 */
const formatCompactNumber = (num: number): string => {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return num.toString();
};


export function ChatInput({
  input,
  setInput,
  isStreaming,
  folderPath,
  inputRef,
  onSubmit,
  onStop,
  tokenUsage,
  project,
  onProjectUpdate,
  messageQueue = [],
  onRemoveFromQueue,
  onClearQueue,
  samplingApproval,
}: ChatInputProps) {
  const { setProjectSettingsOpen } = useApp();
  const [pendingFileRefs, setPendingFileRefs] = useState<FileReference[]>([]);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const isSampling = samplingApproval?.event != null;
  const [samplingText, setSamplingText] = useState("");

  // @-mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<SearchResult[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const mentionStartPos = useRef<number | null>(null);

  // Use refs to access latest state in event handlers
  const mentionResultsRef = useRef(mentionResults);
  const mentionIndexRef = useRef(mentionIndex);
  const mentionQueryRef = useRef(mentionQuery);
  
  useEffect(() => {
    mentionResultsRef.current = mentionResults;
  }, [mentionResults]);
  
  useEffect(() => {
    mentionIndexRef.current = mentionIndex;
  }, [mentionIndex]);
  
  useEffect(() => {
    mentionQueryRef.current = mentionQuery;
  }, [mentionQuery]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      imageAttachments.forEach((img) => {
        if (img.localPath.startsWith('blob:')) {
          URL.revokeObjectURL(img.localPath);
        }
      });
    };
  }, [imageAttachments]);

  const removeFileRef = useCallback((id: string) => {
    setPendingFileRefs((prev) => prev.filter((ref) => ref.id !== id));
  }, []);

  const addFileRef = useCallback(
    (path: string, type: "file" | "folder", source: "mention" | "drag") => {
      setPendingFileRefs((prev) => {
        const exists = prev.some((ref) => ref.path === path);
        if (exists) return prev;
        return [...prev, { id: crypto.randomUUID(), path, type, source }];
      });
    },
    []
  );

  // Search files when mention query changes
  useEffect(() => {
    if (!mentionQuery || !folderPath || mentionQuery.length < 1) {
      setMentionResults([]);
      return;
    }

    const searchFiles = async () => {
      setIsSearching(true);
      try {
        const result = await window.electronAPI.searchFiles(mentionQuery, folderPath);
        setMentionResults(result.results || []);
        setMentionIndex(0);
      } catch {
        setMentionResults([]);
      } finally {
        setIsSearching(false);
      }
    };

    const debounce = setTimeout(searchFiles, 150);
    return () => clearTimeout(debounce);
  }, [mentionQuery, folderPath]);

  /**
   * Height constraints for the textarea in pixels.
   * MIN_HEIGHT: Comfortable single-line input with padding.
   * MAX_HEIGHT: Maximum height for multi-line input before scrolling.
   */
  const MIN_HEIGHT = 48;
  const MAX_HEIGHT = 180;

  /**
   * Auto-resize the textarea to fit its content.
   * Resets to minimum height then expands to scrollHeight.
   * The outer container handles max-height and scrolling.
   */
  const autoResize = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = `${MIN_HEIGHT}px`;
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [inputRef]);

  const samplingSeed = useMemo(() => {
    if (!samplingApproval) return "";
    const event = samplingApproval.event;
    if (event.stage === "request") {
      const textBlocks = event.messages
        .flatMap((message) => (Array.isArray(message.content) ? message.content : [message.content]))
        .filter((block) => block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text")
        .map((block) => (block as { text?: string }).text)
        .filter((text): text is string => typeof text === "string");
      return textBlocks.join("\n\n");
    }
    const textBlocks = event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    return textBlocks.join("\n\n");
  }, [samplingApproval]);

  useEffect(() => {
    if (!isSampling) return;
    setSamplingText(samplingSeed);
    autoResize();
  }, [isSampling, samplingSeed, autoResize]);

  // Detect @ mentions in input
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursorPos = e.target.selectionStart || 0;
      setInput(value);

      // Auto-resize after content change
      autoResize();

      // Find @ symbol before cursor
      const textBeforeCursor = value.slice(0, cursorPos);
      const lastAtIndex = textBeforeCursor.lastIndexOf("@");

      if (lastAtIndex !== -1) {
        const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
        // Check if there's no space after @ (still typing the mention)
        if (!textAfterAt.includes(" ")) {
          mentionStartPos.current = lastAtIndex;
          setMentionQuery(textAfterAt);
          return;
        }
      }

      // No active mention
      mentionStartPos.current = null;
      setMentionQuery(null);
    },
    [setInput, autoResize]
  );

  // Select a file or folder from mention results
  const selectMention = useCallback(
    (result: SearchResult) => {
      if (mentionStartPos.current === null) return;

      // Remove the @query from input and add file/folder as chip
      const currentInput = inputRef.current?.value || "";
      const beforeMention = currentInput.slice(0, mentionStartPos.current);
      const cursorPos = inputRef.current?.selectionStart || currentInput.length;
      const afterMention = currentInput.slice(cursorPos);

      setInput(beforeMention + afterMention);
      addFileRef(result.path, result.type, "mention");

      // Reset mention state
      mentionStartPos.current = null;
      setMentionQuery(null);
      setMentionResults([]);

      // Refocus input
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [setInput, addFileRef, inputRef]
  );

  /**
   * Handle all keyboard events.
   * Enter submits, Shift+Enter inserts newline.
   * Arrow keys navigate mention dropdown when open.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const results = mentionResultsRef.current;
      const currentIndex = mentionIndexRef.current;
      const query = mentionQueryRef.current;

      // Handle mention navigation when dropdown is open
      if (query !== null && results.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          setMentionIndex((prev) => Math.min(prev + 1, results.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          setMentionIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          selectMention(results[currentIndex] as SearchResult);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          mentionStartPos.current = null;
          setMentionQuery(null);
          setMentionResults([]);
          return;
        }
      }

      // Enter to submit, Shift+Enter for newline
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        
        // Check if we have any uploading images
        const hasUploadingImages = imageAttachments.some((img) => img.uploading);
        if (hasUploadingImages) {
          console.log("Waiting for images to upload...");
          return;
        }

        // Check if we have any failed images
        const hasFailedImages = imageAttachments.some((img) => img.error);
        if (hasFailedImages) {
          console.error("Some images failed to upload. Please remove them and try again.");
          return;
        }
        
        const currentInput = inputRef.current?.value || "";
        if (!currentInput.trim() && pendingFileRefs.length === 0 && imageAttachments.length === 0) return;

        const fileRefs = pendingFileRefs.filter((ref) => ref.type === "file");
        const folderRefs = pendingFileRefs.filter((ref) => ref.type === "folder");

        let attachmentBlock = "";
        if (fileRefs.length > 0) {
          attachmentBlock += `Attached files (relative to workspace root):\n` +
            fileRefs.map((ref) => `- \`${ref.path}\``).join("\n") + "\n\n";
        }
        if (folderRefs.length > 0) {
          attachmentBlock += `Attached folders (relative to workspace root):\n` +
            folderRefs.map((ref) => `- \`${ref.path}/\``).join("\n") + "\n\n";
        }

        const finalContent = attachmentBlock + currentInput;
        const attachedPaths = pendingFileRefs.map((ref) => ref.path);

        onSubmit(finalContent, attachedPaths, imageAttachments);
        setInput("");
        setPendingFileRefs([]);
        setImageAttachments([]);
        setMentionQuery(null);
        setMentionResults([]);

        // Reset textarea height immediately
        if (inputRef.current) {
          inputRef.current.style.height = "auto";
        }
      }
    },
    [selectMention, pendingFileRefs, imageAttachments, onSubmit, setInput, inputRef]
  );

  /**
   * Checks if a file is an image based on extension.
   */
  const isImageFile = (filename: string): boolean => {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "webp"].includes(ext || "");
  };

  /**
   * Handles image file upload to local storage.
   * Can accept either a file path (string) or a File object.
   */
  const handleImageUpload = useCallback(
    async (fileOrPath: string | File) => {
      const filename = typeof fileOrPath === 'string' 
        ? fileOrPath.split("/").pop() || "image"
        : fileOrPath.name;
      const tempId = `temp-${Date.now()}-${Math.random()}`;

      // Create a temporary object URL for preview if we have a File object
      const previewUrl = typeof fileOrPath !== 'string' 
        ? URL.createObjectURL(fileOrPath)
        : `file://${fileOrPath}`;

      // Add placeholder immediately so user sees it
      const newImage: ImageAttachment = {
        id: tempId,
        localPath: typeof fileOrPath === 'string' ? fileOrPath : previewUrl,
        filename,
        size: typeof fileOrPath !== 'string' ? fileOrPath.size : 0,
        uploading: true,
      };

      setImageAttachments((prev) => [...prev, newImage]);

      // Check if we have a project
      if (!project) {
        console.error("No project selected");
        setImageAttachments((prev) =>
          prev.map((img) =>
            img.id === tempId
              ? { ...img, uploading: false, error: "No project selected" }
              : img
          )
        );
        return;
      }

      // Check if we already have 20 images (Anthropic's limit)
      if (imageAttachments.length >= 20) {
        console.error("Maximum 20 images per message (Anthropic's limit)");
        setImageAttachments((prev) =>
          prev.map((img) =>
            img.id === tempId
              ? { ...img, uploading: false, error: "Maximum 20 images" }
              : img
          )
        );
        return;
      }

      // Upload to S3
      try {
        let result;
        
        if (typeof fileOrPath === 'string') {
          // File path from Electron (local file system)
          console.log(`[ChatInput] Uploading image from path: ${fileOrPath}`);
          result = await window.electronAPI.image.upload(fileOrPath, project.id);
        } else {
          // File object from drag/drop (convert to buffer)
          console.log(`[ChatInput] Uploading image from File object: ${fileOrPath.name}`);
          
          // Read file as array buffer
          const arrayBuffer = await fileOrPath.arrayBuffer();
          const buffer = new Uint8Array(arrayBuffer);
          
          result = await window.electronAPI.image.upload(
            { buffer, filename: fileOrPath.name },
            project.id
          );
        }
        
        console.log(`[ChatInput] Upload result:`, result);

        if (result.success && result.image) {
          console.log(`[ChatInput] Upload successful, URL: ${result.image.url}`);
          
          // Clean up object URL if we created one
          if (previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(previewUrl);
          }
          
          setImageAttachments((prev) =>
            prev.map((img) =>
              img.id === tempId
                ? {
                    ...img,
                    id: result.image!.url,
                    url: result.image!.url,
                    size: result.image!.size,
                    uploading: false,
                  }
                : img
            )
          );
        } else {
          console.error(`[ChatInput] Upload failed:`, result.error);
          setImageAttachments((prev) =>
            prev.map((img) =>
              img.id === tempId
                ? { ...img, uploading: false, error: result.error || "Upload failed" }
                : img
            )
          );
        }
      } catch (error) {
        console.error("[ChatInput] Image upload error:", error);
        setImageAttachments((prev) =>
          prev.map((img) =>
            img.id === tempId
              ? { 
                  ...img, 
                  uploading: false, 
                  error: error instanceof Error ? error.message : "Upload failed" 
                }
              : img
          )
        );
      }
    },
    [project, imageAttachments.length]
  );

  /**
   * Removes an image attachment and cleans up blob URLs.
   */
  const removeImage = useCallback((imageId: string) => {
    setImageAttachments((prev) => {
      const imageToRemove = prev.find((img) => img.id === imageId);
      // Clean up blob URL if it exists
      if (imageToRemove?.localPath.startsWith('blob:')) {
        URL.revokeObjectURL(imageToRemove.localPath);
      }
      return prev.filter((img) => img.id !== imageId);
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Check if we're actually leaving the drop zone (not just moving between children)
    const relatedTarget = e.relatedTarget as Node | null;
    if (!relatedTarget || !dropZoneRef.current?.contains(relatedTarget)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = Array.from(e.dataTransfer.files);
      console.log(`[ChatInput] Dropped ${files.length} file(s)`);
      
      for (const file of files) {
        const filePath = (file as File & { path?: string }).path;
        
        // Check if it's an image by filename
        const isImage = isImageFile(file.name);
        
        if (isImage) {
          console.log(`[ChatInput] Detected as image: ${file.name}`);
          
          if (filePath) {
            // File has a path (dragged from file system)
            console.log(`[ChatInput] Using file path: ${filePath}`);
            await handleImageUpload(filePath);
          } else {
            // File has no path (dragged from browser/external source)
            console.log(`[ChatInput] File has no path, using File object`);
            await handleImageUpload(file);
          }
        } else if (folderPath && filePath) {
          // Handle regular file attachments (code files, etc.)
          console.log(`[ChatInput] Detected as regular file, resolving path...`);
          const result = await window.electronAPI.resolveFilePath(
            filePath,
            folderPath
          );
          if (result?.relativePath) {
            addFileRef(result.relativePath, "file", "drag");
          }
        } else {
          console.warn(`[ChatInput] Cannot handle file: ${file.name} (no path available)`);
        }
      }
      
      // Focus the textarea after handling the drop
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [folderPath, addFileRef, handleImageUpload, inputRef]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      
      // Check if we have any uploading images
      const hasUploadingImages = imageAttachments.some((img) => img.uploading);
      if (hasUploadingImages) {
        console.log("Waiting for images to upload...");
        return;
      }

      // Check if we have any failed images
      const hasFailedImages = imageAttachments.some((img) => img.error);
      if (hasFailedImages) {
        console.error("Some images failed to upload. Please remove them and try again.");
        return;
      }

      if (!input.trim() && pendingFileRefs.length === 0 && imageAttachments.length === 0) return;

      const fileRefs = pendingFileRefs.filter((ref) => ref.type === "file");
      const folderRefs = pendingFileRefs.filter((ref) => ref.type === "folder");

      let attachmentBlock = "";
      if (fileRefs.length > 0) {
        attachmentBlock += `Attached files (relative to workspace root):\n` +
          fileRefs.map((ref) => `- \`${ref.path}\``).join("\n") + "\n\n";
      }
      if (folderRefs.length > 0) {
        attachmentBlock += `Attached folders (relative to workspace root):\n` +
          folderRefs.map((ref) => `- \`${ref.path}/\``).join("\n") + "\n\n";
      }

      const finalContent = attachmentBlock + input;
      const attachedPaths = pendingFileRefs.map((ref) => ref.path);

      onSubmit(finalContent, attachedPaths, imageAttachments);
      setInput("");
      setPendingFileRefs([]);
      
      // Clean up blob URLs before clearing attachments
      imageAttachments.forEach((img) => {
        if (img.localPath.startsWith('blob:')) {
          URL.revokeObjectURL(img.localPath);
        }
      });
      setImageAttachments([]);
      
      setMentionQuery(null);
      setMentionResults([]);
    },
    [input, pendingFileRefs, imageAttachments, onSubmit, setInput]
  );

  if (isSampling && samplingApproval) {
    const { event, onApprove, onReject } = samplingApproval;
    const placeholder =
      event.stage === "request"
        ? "Edit the prompt before it runs..."
        : "Edit the response before it returns...";

    return (
      <div className="relative">
        <div className="flex flex-col rounded-md relative bg-background-primary chat-input-container chat-input-container-focused">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onApprove({ requestId: event.requestId, stage: event.stage, editedText: samplingText });
            }}
            className="relative"
          >
            <div className="absolute right-5 top-4 z-10 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onReject({ requestId: event.requestId, stage: event.stage })}
                className="shrink-0 !h-7 !px-2 text-xs"
              >
                Reject
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!samplingText.trim()}
                className="shrink-0 !h-7 !px-2 text-xs"
              >
                Approve
              </Button>
            </div>

            <div
              className="overflow-y-auto show-scrollbar input-row cursor-text"
              style={{ maxHeight: `${MAX_HEIGHT}px` }}
              onClick={(e) => {
                if (e.target !== inputRef.current) {
                  inputRef.current?.focus();
                }
              }}
            >
              <div className="px-5">
                <textarea
                  ref={inputRef}
                  className="w-full py-4 pr-24 bg-transparent border-none outline-none text-text-primary font-inherit text-sm placeholder:text-text-secondary placeholder:text-[12px] resize-none overflow-hidden"
                  style={{ minHeight: `${MIN_HEIGHT}px` }}
                  value={samplingText}
                  onChange={(event) => {
                    setSamplingText(event.target.value);
                    autoResize();
                  }}
                  placeholder={placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  rows={1}
                />
              </div>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Queue display - shows above main input when messages are queued */}
      {messageQueue.length > 0 && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-[-10px] w-[calc(100%-10px)] pb-2 flex flex-col rounded-t-md bg-background-primary chat-input-container chat-input-container-focused">
          <div className="px-5 pt-[5px] pb-1 border-b border-border-primary relative shadow-[0_1px_3px_0_rgba(0,0,0,0.1)] flex items-center justify-between">
            <span className="text-xs font-medium text-text-secondary">Queue</span>
            {onClearQueue && (
              <button
                type="button"
                onClick={onClearQueue}
                className="-m-1.5 p-2.5 hover:bg-background-tertiary rounded transition-colors flex items-center justify-center"
                title="Clear all queued messages"
              >
                <span className="text-text-secondary hover:text-text-primary text-sm leading-none">×</span>
              </button>
            )}
          </div>
          <div className="max-h-[105px] overflow-y-auto show-scrollbar pb-1.5 pt-1.5">
            {messageQueue.map((queuedMessage, index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-5 h-7 hover:bg-background-tertiary/30 transition-colors group"
              >
                <svg
                  className="w-3 h-3 shrink-0 text-text-secondary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                <span className="flex-1 text-xs font-medium text-text-primary truncate">
                  {queuedMessage}
                </span>
                {onRemoveFromQueue && (
                  <button
                    type="button"
                    onClick={() => onRemoveFromQueue(index)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-background-tertiary rounded flex items-center justify-center"
                    title="Remove from queue"
                  >
                    <span className="text-text-secondary hover:text-text-primary text-lg leading-none">×</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        ref={dropZoneRef}
        className={cn(
          "flex flex-col rounded-md relative bg-background-primary chat-input-container",
          (isDragOver || messageQueue.length > 0) && "chat-input-container-focused"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
      {/* File/folder chips */}
      {pendingFileRefs.length > 0 && (
        <div className="px-5 pt-4 pb-1 flex flex-wrap gap-1">
          {pendingFileRefs.map((ref) => (
            <button
              key={ref.id}
              type="button"
              className="flex items-center gap-1 rounded-full bg-background-tertiary px-2 py-1 text-xs text-text-secondary hover:bg-background-secondary transition-colors"
              onClick={() => removeFileRef(ref.id)}
              title={`Remove ${ref.type === "folder" ? "folder" : "file"}: ${ref.path}`}
            >
              {ref.type === "folder" ? (
                <svg
                  className="w-3 h-3 shrink-0 text-ring-primary"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              ) : (
                <svg
                  className="w-3 h-3 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
              <span className="truncate max-w-[160px]">
                {ref.path}{ref.type === "folder" ? "/" : ""}
              </span>
              <span className="ml-0.5 text-text-secondary/70 hover:text-text-primary">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      {/* @-mention autocomplete dropdown */}
      {mentionQuery !== null && (mentionResults.length > 0 || isSearching) && (
        <div className="absolute bottom-full left-0 right-0 mb-1 bg-background-secondary border border-border-primary rounded-md shadow-lg max-h-[200px] overflow-y-auto z-50">
          {isSearching && mentionResults.length === 0 ? (
            <div className="px-3 py-2 text-sm text-text-secondary">
              Searching...
            </div>
          ) : (
            mentionResults.map((result, index) => (
              <button
              key={`${result.type}-${result.path}`}
              type="button"
              className={cn(
                "w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors",
                index === mentionIndex 
                  ? "bg-background-inverse/20 text-ring-primary" 
                  : "hover:bg-background-secondary"
              )}
              onClick={() => selectMention(result)}
              onMouseEnter={() => setMentionIndex(index)}
              >
                {result.type === "folder" ? (
                  <svg
                    className="w-4 h-4 shrink-0 text-ring-primary"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                ) : (
                  <svg
                    className="w-4 h-4 shrink-0 text-text-secondary"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                )}
                <span className="truncate text-text-primary">
                  {result.path}{result.type === "folder" ? "/" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}

        {/* Form wrapper with relative positioning for drop overlay */}
        <div className="relative">
          {/* Drop overlay - always rendered, visibility controlled by CSS */}
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center text-sm text-text-secondary z-10 pointer-events-none",
              isDragOver ? "opacity-100" : "opacity-0"
            )}
          >
            Drop files to attach
          </div>

          <form onSubmit={handleSubmit} className={cn("relative", isDragOver ? "invisible" : "visible")}>
            {/* Button positioned outside scrollable area so it stays fixed */}
            <div className="absolute right-5 top-4 z-10">
              {isStreaming ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onStop();
                    if (messageQueue.length > 0 && onClearQueue) {
                      onClearQueue();
                    }
                  }}
                  title="Stop"
                  className="shrink-0 !transition-colors !duration-[250ms] !w-7 !h-7 !p-0"
                >
                  <Stop size={10} weight="fill" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  disabled={!input.trim() && pendingFileRefs.length === 0 && imageAttachments.length === 0}
                  title="Send message"
                  className="shrink-0 !w-7 !h-7 !p-0"
                >
                  <PaperPlaneRight size={14} weight="regular" />
                </Button>
              )}
            </div>
            
            {/* Scrollable textarea container */}
            <div 
              className="overflow-y-auto show-scrollbar input-row cursor-text"
              style={{ maxHeight: `${MAX_HEIGHT}px` }}
              onClick={(e) => {
                // Focus textarea when clicking in the empty space
                // Don't focus if clicking on the textarea itself (it handles its own focus)
                if (e.target !== inputRef.current) {
                  inputRef.current?.focus();
                }
              }}
            >
              <div className="px-5">
                <textarea
                  ref={inputRef}
                  className="w-full py-4 pr-12 bg-transparent border-none outline-none text-text-primary font-inherit text-sm placeholder:text-text-secondary placeholder:text-[12px] resize-none overflow-hidden"
                  style={{ minHeight: `${MIN_HEIGHT}px` }}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  placeholder="Enter a message... (@ to attach files)"
                  spellCheck={false}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  rows={1}
                />
              </div>
            </div>

        {/* Image attachments preview */}
        {imageAttachments.length > 0 && (
          <div className="px-5 pt-2 pb-3 flex flex-wrap gap-2">
            {imageAttachments.map((image) => (
              <div
                key={image.id}
                className="relative w-8 h-8 rounded border border-border-primary bg-background-tertiary group"
              >
                {image.uploading ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-background-primary/80">
                    <div className="w-4 h-4 border-2 border-ring-primary border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : image.error ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-background-danger/10 text-text-danger text-[10px] p-1 text-center">
                    Error
                  </div>
                ) : image.url ? (
                  <img
                    src={image.url}
                    alt={image.filename}
                    className="w-full h-full object-cover rounded"
                  />
                ) : (
                  <img
                    src={image.localPath.startsWith('blob:') ? image.localPath : `file://${image.localPath}`}
                    alt={image.filename}
                    className="w-full h-full object-cover rounded"
                  />
                )}
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-background-inverse text-text-inverse flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold leading-none"
                  title="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
            {imageAttachments.length >= 20 && (
              <div className="text-xs text-text-secondary px-2 py-1">
                Max 20 images
              </div>
            )}
          </div>
        )}
          </form>
        </div>

      {/* Footer with context icons, model and token stats */}
      <div className="flex items-center justify-between px-5 py-2.5 border-t border-border-secondary">
        {/* Left side - Context icons */}
        <div className="flex items-center -ml-1.5">
          {/* Folder icon - opens project settings (hidden for playground projects) */}
          {project?.profile !== "playground" && (
            <HoverCard openDelay={200}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "p-1.5 rounded transition-colors hover:bg-background-tertiary",
                    project?.context.local_directory?.path
                      ? "text-text-primary"
                      : "text-text-secondary/40 hover:text-text-secondary"
                  )}
                  onClick={() => setProjectSettingsOpen(true)}
                  disabled={!project}
                >
                  <Folder size={14} weight="regular" />
                </button>
              </HoverCardTrigger>
              <HoverCardContent side="top" align="start">
                {project?.context.local_directory?.path ? (
                  <div className="flex gap-3">
                    <Folder size={18} weight="fill" className="shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium mb-1">Local directory is set</div>
                      <div className="break-all opacity-80">
                        {truncatePathLeft(project.context.local_directory.path, 50)}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3">
                    <Folder size={18} weight="regular" className="shrink-0 mt-0.5" />
                    <div>
                      Click to add a local directory to your project so your agent can read and edit files
                    </div>
                  </div>
                )}
              </HoverCardContent>
            </HoverCard>
          )}
          
          {/* FileText icon - opens project settings */}
          <HoverCard openDelay={200}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                className={cn(
                  "p-1.5 rounded transition-colors hover:bg-background-tertiary",
                  project?.context.custom_instructions
                    ? "text-text-primary"
                    : "text-text-secondary/40 hover:text-text-secondary"
                )}
                onClick={() => setProjectSettingsOpen(true)}
                disabled={!project}
              >
                <FileText size={14} weight="regular" />
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="top" align="start">
              {project?.context.custom_instructions ? (
                <div className="flex gap-3">
                  <FileText size={18} weight="regular" className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium mb-1">Custom instructions are set</div>
                    <div className="opacity-80">Click to edit them</div>
                  </div>
                </div>
              ) : (
                <div className="flex gap-3">
                  <FileText size={18} weight="regular" className="shrink-0 mt-0.5" />
                  <div>
                    Click to add custom instructions to your project for the agent to follow
                  </div>
                </div>
              )}
            </HoverCardContent>
          </HoverCard>
        </div>

        {/* Right side - Model and token stats */}
        <div className="flex items-center gap-2 text-text-secondary text-[10px]">
          <span>Sonnet 4.5</span>
          {tokenUsage && tokenUsage.totalTokens > 0 && (
            <>
              <span title={`Input tokens: ${tokenUsage.inputTokens}, Output tokens: ${tokenUsage.outputTokens}`}>
                {formatCompactNumber(tokenUsage.inputTokens)} / {formatCompactNumber(tokenUsage.outputTokens)}
              </span>
              <span title="Estimated cost (Sonnet 4.5: $3/MTok in, $15/MTok out)">
                ${((tokenUsage.inputTokens * 3 + tokenUsage.outputTokens * 15) / 1_000_000).toFixed(2)}
              </span>
            </>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
