/**
 * MCP App UI
 *
 * Skeleton UI with host-themed styling.
 * Replace this with your app's components.
 */

import { HostProvider } from "open-mcp-app/react";
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

/**
 * Creature mascot icon (body silhouette only, no eyes).
 * Uses currentColor so it inherits the parent's text color for theme awareness.
 */
const CreatureIcon = ({ size = 48 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 110 111"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M76.7407 18.0698L69.6709 0L47.7099 28.6693L11.7829 31.4596L8.12513 55.4302L15.3684 62.8469L21.6574 63.9457L0 88.9139C11.8118 94.2343 23.6381 99.5546 35.4499 104.861L54.2013 93.3813L62.7746 105.265L71.5215 110.889L87.5115 105.439L85.0537 85.1115L100.971 91.1693L109.053 74.5286L106.812 62.0084L94.7692 52.4953L101.608 26.3995L98.0532 1.81982L78.3892 18.2808L76.7407 18.0698ZM76.5816 94.1909L71.2034 65.0011L95.6366 73.5166L101.318 63.1072L80.9622 47.0159C84.5477 35.4354 88.191 23.826 91.5452 12.1877L77.1744 24.5698L69.6709 23.4566L68.3264 8.84802L49.9797 32.7897L15.5563 35.4643L13.113 51.4544L36.621 53.2616L7.08419 87.338L24.6212 95.2318L48.1147 77.5069L64.2348 99.8582L76.6105 94.1764L76.5816 94.1909Z"
      fill="currentColor"
    />
  </svg>
);

export default function App() {
  return (
    <HostProvider name="__APP_NAME__" version="0.1.0">
      <div className="flex flex-col items-center justify-center h-full gap-3 bg-bg-primary">
        <div className="opacity-30">
          <CreatureIcon />
        </div>
        <p className="text-sm font-medium text-txt-secondary">MCP App Template</p>
        <p className="text-xs text-txt-tertiary max-w-64 text-center">
          Your new MCP App is ready. Work with the agent to build tools, add UI components, and make it your own.
        </p>
      </div>
    </HostProvider>
  );
}
