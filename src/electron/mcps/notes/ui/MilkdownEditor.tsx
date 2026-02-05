/**
 * MilkdownEditor Component
 *
 * A WYSIWYG markdown editor using Milkdown.
 *
 * Primarily UNCONTROLLED for user typing, but exposes a `setContent` method
 * via ref for imperative updates (e.g., when agent saves new content).
 * This avoids feedback loops while still allowing external content updates.
 */

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
} from "react";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { replaceAll } from "@milkdown/utils";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";

// =============================================================================
// Types
// =============================================================================

export interface MilkdownEditorProps {
  /** Initial markdown content (only used on mount) */
  defaultValue: string;
  /** Callback when content changes (from user typing) */
  onChange: (markdown: string) => void;
  /** Placeholder text when empty */
  placeholder?: string;
}

export interface MilkdownEditorRef {
  /**
   * Imperatively set editor content.
   * Use this for external updates (e.g., agent saves).
   * Will NOT trigger onChange to prevent feedback loops.
   */
  setContent: (markdown: string) => void;
  /** Get current editor content */
  getContent: () => string;
}

// =============================================================================
// Inner Editor Component
// =============================================================================

interface MilkdownEditorInnerProps extends MilkdownEditorProps {
  /**
   * Ref to skip the next onChange call.
   * Set to true before calling replaceAll, then cleared in the listener.
   * This handles Milkdown's content normalization (e.g., `-` → `*` for lists)
   * where exact content comparison would fail.
   */
  skipNextOnChangeRef: React.MutableRefObject<boolean>;
  /** Ref to store the setContent function for parent access */
  setContentRef: React.MutableRefObject<((markdown: string) => void) | null>;
  /** Ref to store the getContent function for parent access */
  getContentRef: React.MutableRefObject<(() => string) | null>;
}

/**
 * Inner editor component that uses the Milkdown hooks.
 * Must be rendered inside MilkdownProvider.
 */
const MilkdownEditorInner = ({
  defaultValue,
  onChange,
  placeholder,
  skipNextOnChangeRef,
  setContentRef,
  getContentRef,
}: MilkdownEditorInnerProps) => {
  /** Track current content for getContent */
  const currentContentRef = useRef(defaultValue);
  
  /** Ref to the wrapper element for click handling */
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, defaultValue);
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
          currentContentRef.current = markdown;

          // Skip onChange if this is the echo of an external setContent call.
          // Using a skip flag (instead of content comparison) handles Milkdown's
          // content normalization where the output differs from input (e.g., - → *)
          if (skipNextOnChangeRef.current) {
            skipNextOnChangeRef.current = false;
            return;
          }

          onChange(markdown);
        });
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(clipboard)
      .use(listener)
  );

  /**
   * Imperatively set editor content.
   * Sets skip flag so the listener ignores the resulting onChange.
   */
  const setContent = useCallback(
    (markdown: string) => {
      const editor = get();
      if (!editor) return;

      // Set flag to skip the next onChange (from replaceAll's listener call)
      skipNextOnChangeRef.current = true;
      editor.action(replaceAll(markdown));
      currentContentRef.current = markdown;
    },
    [get, skipNextOnChangeRef]
  );

  /**
   * Get current editor content.
   */
  const getContent = useCallback(() => {
    return currentContentRef.current;
  }, []);

  /**
   * Handle clicks on the wrapper to focus the editor.
   * This allows clicking anywhere in the content area (even when empty)
   * to start editing, not just on the text itself.
   */
  const handleWrapperClick = useCallback(() => {
    const editorEl = wrapperRef.current?.querySelector('.ProseMirror');
    if (editorEl instanceof HTMLElement) {
      editorEl.focus();
    }
  }, []);

  // Expose functions to parent via refs
  setContentRef.current = setContent;
  getContentRef.current = getContent;

  return (
    <div
      ref={wrapperRef}
      className="milkdown-wrapper flex-1 overflow-y-auto p-4 flex flex-col min-h-0 cursor-text"
      data-placeholder={placeholder}
      onClick={handleWrapperClick}
    >
      <Milkdown />
    </div>
  );
};

// =============================================================================
// Main Export
// =============================================================================

/**
 * MilkdownEditor - WYSIWYG markdown editor component.
 *
 * Primarily uncontrolled for smooth typing, but exposes imperative methods
 * via ref for external content updates:
 *
 * ```tsx
 * const editorRef = useRef<MilkdownEditorRef>(null);
 *
 * // Update content imperatively (e.g., from agent save)
 * editorRef.current?.setContent(newMarkdown);
 *
 * <MilkdownEditor
 *   ref={editorRef}
 *   defaultValue={content}
 *   onChange={handleChange}
 * />
 * ```
 */
const MilkdownEditor = forwardRef<MilkdownEditorRef, MilkdownEditorProps>(
  (props, ref) => {
    /**
     * Skip flag for the next onChange call.
     * Set before replaceAll, cleared after the listener fires.
     */
    const skipNextOnChangeRef = useRef(false);

    /** Refs to store imperative methods from inner component */
    const setContentRef = useRef<((markdown: string) => void) | null>(null);
    const getContentRef = useRef<(() => string) | null>(null);

    // Expose imperative methods to parent
    useImperativeHandle(
      ref,
      () => ({
        setContent: (markdown: string) => {
          setContentRef.current?.(markdown);
        },
        getContent: () => {
          return getContentRef.current?.() ?? "";
        },
      }),
      []
    );

    return (
      <MilkdownProvider>
        <MilkdownEditorInner
          {...props}
          skipNextOnChangeRef={skipNextOnChangeRef}
          setContentRef={setContentRef}
          getContentRef={getContentRef}
        />
      </MilkdownProvider>
    );
  }
);

MilkdownEditor.displayName = "MilkdownEditor";

export default MilkdownEditor;
