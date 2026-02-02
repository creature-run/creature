import { Spinner as SpinnerIcon } from "@phosphor-icons/react";

interface SpinnerProps {
  /** Size of the spinner in pixels. Defaults to 18. */
  size?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Spinner Component
 *
 * A minimal, reusable loading spinner using Phosphor's Spinner icon.
 * Used throughout the app for consistent loading states.
 */
export function Spinner({ size = 18, className = "" }: SpinnerProps) {
  return (
    <SpinnerIcon
      size={size}
      weight="bold"
      className={`text-text-secondary ${className}`}
      style={{ animation: "spin 2.5s linear infinite" }}
    />
  );
}

