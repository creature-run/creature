import { useCallback } from "react";
import {
  ArrowClockwise,
  CaretRight,
  Folder,
  FolderOpen,
  File,
  FileTs,
  FileJs,
  FileJsx,
  FileHtml,
  FileCss,
  FilePy,
  FileRs,
  FileCode,
  BracketsCurly,
  FileText,
} from "@phosphor-icons/react";

/**
 * File or directory item from the server.
 */
interface FileItem {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: FileItem[];
}

/**
 * Props for the FileTree component.
 * Expansion state is managed externally to ensure only user interactions
 * can expand/collapse directories (agent tool calls don't affect it).
 */
interface FileTreeProps {
  items: FileItem[];
  onFileSelect: (path: string) => void;
  onRefresh: () => void;
  selectedPath?: string;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
}

/**
 * FileTree Component
 *
 * Displays a hierarchical file browser.
 * Directories can be expanded/collapsed by user clicks only.
 * Files can be clicked to open in the editor.
 *
 * Expansion state is managed externally (in App.tsx) to ensure:
 * - Only user interactions modify expansion state
 * - Agent tool calls (like ide_dir_list) don't auto-expand directories
 * - State persists across tree data updates
 */
export const FileTree = ({ items, onFileSelect, onRefresh, selectedPath, expandedPaths, onToggleExpand }: FileTreeProps) => {
  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span className="file-tree-title">Explorer</span>
        <button className="file-tree-refresh" onClick={onRefresh} title="Refresh">
          <ArrowClockwise size={14} weight="bold" />
        </button>
      </div>
      <div className="file-tree-content">
        {items.map((item) => (
          <FileTreeNode
            key={item.path}
            item={item}
            depth={0}
            onFileSelect={onFileSelect}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * Props for FileTreeNode component.
 * Expansion state comes from parent, not local state.
 */
interface FileTreeNodeProps {
  item: FileItem;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedPath?: string;
  expandedPaths: Set<string>;
  onToggleExpand: (path: string) => void;
}

/**
 * FileTreeNode Component
 *
 * Renders a single file or directory in the tree.
 * Directories show expand/collapse icons and can have children.
 *
 * Expansion state is read from the parent-managed `expandedPaths` set,
 * ensuring that only explicit user clicks can toggle expansion.
 * This prevents agent tool calls from auto-expanding the tree.
 */
const FileTreeNode = ({ item, depth, onFileSelect, selectedPath, expandedPaths, onToggleExpand }: FileTreeNodeProps) => {
  const isExpanded = expandedPaths.has(item.path);

  const handleClick = useCallback(() => {
    if (item.type === "directory") {
      onToggleExpand(item.path);
    } else {
      onFileSelect(item.path);
    }
  }, [item, onFileSelect, onToggleExpand]);

  const isSelected = selectedPath === item.path;
  const paddingLeft = 12 + depth * 16;

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-item ${item.type} ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft }}
        onClick={handleClick}
      >
        {item.type === "directory" && (
          <span className={`expand-icon ${isExpanded ? "expanded" : ""}`}>
            <CaretRight size={10} weight="bold" />
          </span>
        )}
        <span className="file-icon">
          {item.type === "directory" ? (
            isExpanded ? <FolderOpen size={14} weight="duotone" /> : <Folder size={14} weight="duotone" />
          ) : (
            <FileIcon filename={item.name} />
          )}
        </span>
        <span className="file-name">{item.name}</span>
      </div>
      {item.type === "directory" && isExpanded && item.children && (
        <div className="file-tree-children">
          {item.children.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              onFileSelect={onFileSelect}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * FileIcon Component
 *
 * Returns an appropriate Phosphor icon for a file based on its extension.
 */
const FileIcon = ({ filename }: { filename: string }) => {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const size = 14;
  const weight = "duotone" as const;

  switch (ext) {
    case "ts":
    case "tsx":
      return <FileTs size={size} weight={weight} />;
    case "js":
      return <FileJs size={size} weight={weight} />;
    case "jsx":
      return <FileJsx size={size} weight={weight} />;
    case "json":
      return <BracketsCurly size={size} weight={weight} />;
    case "md":
      return <FileText size={size} weight={weight} />;
    case "css":
    case "scss":
    case "sass":
    case "less":
      return <FileCss size={size} weight={weight} />;
    case "html":
    case "htm":
      return <FileHtml size={size} weight={weight} />;
    case "py":
      return <FilePy size={size} weight={weight} />;
    case "rs":
      return <FileRs size={size} weight={weight} />;
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "h":
      return <FileCode size={size} weight={weight} />;
    default:
      return <File size={size} weight={weight} />;
  }
};

export type { FileItem };
