import { useState, useEffect, useRef } from "react";
import type { CreatureIconProps } from "./types.js";

export type { CreatureIconProps };

/**
 * CreatureIcon Component
 * 
 * The Creature mascot icon with theme-aware colors.
 * Uses the main creature shape with optional eyes, adapting colors for dark/light mode.
 * Supports optional eye blinking animation at random intervals.
 */
export function CreatureIcon({ 
  isDarkMode, 
  showEyes = true,
  enableBlink = false,
  width = 26,
  height = 26,
  className = "",
}: CreatureIconProps) {
  const fillColor = isDarkMode ? "#F8F7F6" : "#0D0D0C";
  const [isBlinking, setIsBlinking] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Manages the blinking animation with random intervals.
   * Blinks last ~150ms, then schedules next blink between 2-6 seconds.
   */
  useEffect(() => {
    if (!enableBlink || !showEyes) {
      return;
    }

    const scheduleNextBlink = () => {
      // Random interval between 2 and 6 seconds
      const nextBlinkDelay = Math.random() * 4000 + 2000;
      
      timeoutRef.current = setTimeout(() => {
        setIsBlinking(true);
        
        // Blink duration: 150ms
        setTimeout(() => {
          setIsBlinking(false);
          scheduleNextBlink();
        }, 150);
      }, nextBlinkDelay);
    };

    scheduleNextBlink();

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [enableBlink, showEyes]);

  return (
    <svg 
      width={width} 
      height={height} 
      viewBox="0 0 110 111" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Main body shape */}
      <path 
        fillRule="evenodd" 
        clipRule="evenodd" 
        d="M76.7407 18.0698L69.6709 0L47.7099 28.6693L11.7829 31.4596L8.12513 55.4302L15.3684 62.8469L21.6574 63.9457L0 88.9139C11.8118 94.2343 23.6381 99.5546 35.4499 104.861L54.2013 93.3813L62.7746 105.265L71.5215 110.889L87.5115 105.439L85.0537 85.1115L100.971 91.1693L109.053 74.5286L106.812 62.0084L94.7692 52.4953L101.608 26.3995L98.0532 1.81982L78.3892 18.2808L76.7407 18.0698ZM76.5816 94.1909L71.2034 65.0011L95.6366 73.5166L101.318 63.1072L80.9622 47.0159C84.5477 35.4354 88.191 23.826 91.5452 12.1877L77.1744 24.5698L69.6709 23.4566L68.3264 8.84802L49.9797 32.7897L15.5563 35.4643L13.113 51.4544L36.621 53.2616L7.08419 87.338L24.6212 95.2318L48.1147 77.5069L64.2348 99.8582L76.6105 94.1764L76.5816 94.1909Z" 
        fill={fillColor}
      />
      {/* Eyes (optional) */}
      {showEyes && (
        <>
          <g
            style={{
              transformOrigin: "64px 33.65px",
              transform: isBlinking ? "scaleY(0.1)" : "scaleY(1)",
              transition: "transform 0.1s ease-out",
            }}
          >
            <path 
              d="M65.6051 34.48C66.4951 32.97 66.6051 31.3799 65.8451 30.9299C65.0851 30.4899 63.7451 31.3499 62.8551 32.8699C61.9651 34.3799 61.8551 35.97 62.6151 36.42C63.3751 36.86 64.7151 36 65.6051 34.48Z" 
              fill={fillColor}
            />
          </g>
          <g
            style={{
              transformOrigin: "70px 36.265px",
              transform: isBlinking ? "scaleY(0.1)" : "scaleY(1)",
              transition: "transform 0.1s ease-out",
            }}
          >
            <path 
              d="M71.7651 37.0999C72.6951 35.1499 72.6551 33.1899 71.6751 32.73C70.6951 32.27 69.1551 33.4799 68.2351 35.4299C67.3051 37.3799 67.3451 39.3399 68.3251 39.7999C69.3051 40.2599 70.8451 39.0499 71.7651 37.0999Z" 
              fill={fillColor}
            />
          </g>
        </>
      )}
    </svg>
  );
}

export default CreatureIcon;
