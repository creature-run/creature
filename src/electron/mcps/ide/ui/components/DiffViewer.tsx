import { useRef, useEffect } from "react";
import * as monaco from "monaco-editor";

interface DiffViewerProps {
  originalContent: string;
  modifiedContent: string;
  language: string;
  filePath: string;
  theme: string;
  onAccept: () => void;
  onReject: () => void;
}

/**
 * Side-by-side diff viewer for comparing file changes.
 * Uses Monaco's built-in diff editor with the bundled instance.
 */
export const DiffViewer = ({
  originalContent,
  modifiedContent,
  language,
  filePath,
  theme,
  onAccept,
  onReject,
}: DiffViewerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const originalModel = monaco.editor.createModel(originalContent, language);
    const modifiedModel = monaco.editor.createModel(modifiedContent, language);

    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      theme,
      readOnly: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderOverviewRuler: false,
      padding: { top: 10, bottom: 0 },
      enableSplitViewResizing: true,
      ignoreTrimWhitespace: false,
    });

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    editorRef.current = diffEditor;

    return () => {
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [originalContent, modifiedContent, language, theme]);

  const fileName = filePath.split("/").pop() || filePath;

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <div className="diff-title">
          <span className="diff-filename">{fileName}</span>
          <span className="diff-path">{filePath}</span>
        </div>
        <div className="diff-actions">
          <button className="diff-btn diff-btn-reject" onClick={onReject}>
            Reject
          </button>
          <button className="diff-btn diff-btn-accept" onClick={onAccept}>
            Accept
          </button>
        </div>
      </div>
      <div className="diff-labels">
        <span className="diff-label diff-label-original">Original</span>
        <span className="diff-label diff-label-modified">Modified</span>
      </div>
      <div className="diff-container" ref={containerRef} />
    </div>
  );
};

export default DiffViewer;
