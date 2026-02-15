import React, { useState, useCallback, useEffect } from "react";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { Button } from "open-mcp-app-ui";

/**
 * Props for the NavigationBar component.
 */
interface NavigationBarProps {
  currentUrl: string;
  isLoading?: boolean;
  onNavigate: (url: string) => void;
  onReload: () => void;
  onBack: () => void;
  onForward: () => void;
}

/**
 * NavigationBar Component
 *
 * Provides browser navigation controls: back, forward, reload, and URL input.
 * Uses open-mcp-app-ui Button components for navigation actions.
 *
 * The URL input uses a raw <input> with omu-control class instead of the
 * full Input component, because the Input wrapper div disrupts the compact
 * single-row nav bar layout (it adds label/error container structure).
 */
export const NavigationBar: React.FC<NavigationBarProps> = ({
  currentUrl,
  isLoading = false,
  onNavigate,
  onReload,
  onBack,
  onForward,
}) => {
  const [inputValue, setInputValue] = useState(currentUrl);

  /**
   * Sync input with external URL changes (e.g., from navigation).
   */
  useEffect(() => {
    setInputValue(currentUrl);
  }, [currentUrl]);

  /**
   * Handle form submission for navigation.
   */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = inputValue.trim();
      if (trimmed) {
        // Add protocol if missing
        const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
        onNavigate(url);
      }
    },
    [inputValue, onNavigate]
  );

  return (
    <div className="flex items-center gap-2 px-3 h-10 bg-bg-primary border-b border-bdr-secondary shrink-0">
      <div className="flex gap-1">
        <Button variant="ghost" size="sm" onClick={onBack} title="Go back" aria-label="Go back" className="w-7 h-7 !p-0">
          <ChevronLeft size={16} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onForward} title="Go forward" aria-label="Go forward" className="w-7 h-7 !p-0">
          <ChevronRight size={16} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onReload} title="Reload" aria-label="Reload" className="w-7 h-7 !p-0">
          <RotateCw size={14} className={isLoading ? "animate-spin" : ""} />
        </Button>
      </div>
      <form className="flex flex-1" onSubmit={handleSubmit}>
        <input
          type="text"
          className="omu-control flex-1 h-7 px-3 rounded-md bg-bg-secondary text-txt-primary text-[13px] placeholder:text-txt-tertiary"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Enter URL..."
          aria-label="URL input"
        />
      </form>
    </div>
  );
};
