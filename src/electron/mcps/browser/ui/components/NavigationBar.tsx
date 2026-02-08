import React, { useState, useCallback, useEffect } from "react";

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
 * Uses Tailwind 4 with SDK theme tokens for host-consistent styling.
 * Includes a bottom border to visually separate from the webview content below.
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
        <button
          className="w-7 h-7 flex items-center justify-center border-none rounded-md bg-transparent text-txt-primary cursor-pointer transition-colors hover:bg-txt-primary hover:text-bg-primary"
          onClick={onBack}
          title="Go back"
          aria-label="Go back"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center border-none rounded-md bg-transparent text-txt-primary cursor-pointer transition-colors hover:bg-txt-primary hover:text-bg-primary"
          onClick={onForward}
          title="Go forward"
          aria-label="Go forward"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center border-none rounded-md bg-transparent text-txt-primary cursor-pointer transition-colors hover:bg-txt-primary hover:text-bg-primary"
          onClick={onReload}
          title="Reload"
          aria-label="Reload"
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
          >
            <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
          </svg>
        </button>
      </div>
      <form className="flex flex-1" onSubmit={handleSubmit}>
        <input
          type="text"
          className="flex-1 h-7 px-3 border-none rounded-md bg-bg-secondary text-txt-primary text-[13px] outline-none focus:outline-1 focus:outline-txt-primary placeholder:text-txt-secondary"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Enter URL..."
          aria-label="URL input"
        />
      </form>
    </div>
  );
};

