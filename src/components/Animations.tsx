import { useRef, useState, useEffect } from "react";
import Lottie, { LottieRefCurrentProps } from "lottie-react";
import animationIntro from "../assets/animations/animation-intro.json";
import animationIdle from "../assets/animations/animation-idle.json";
import animationSmallIdle from "../assets/animations/animation-small-idle.json";
import { cn } from "../lib/utils";

/** Target frame rate for animations */
const TARGET_FRAME_RATE = 34;

/**
 * Animation variant types.
 * - large: Full-size creature with intro → idle sequence
 * - small: Compact icon for sidebar, idle only
 */
type AnimationVariant = "large" | "small";

/**
 * Props for the Animations component.
 * Uses Lottie for smooth, professional animations.
 */
interface AnimationsProps {
  /** Animation variant - "large" for full creature, "small" for sidebar icon */
  variant?: AnimationVariant;
  /** Whether to show the intro animation (only applies to "large" variant) */
  showIntro?: boolean;
  /** Width of the creature in pixels. Height scales proportionally. */
  size?: number;
  /** Additional CSS class names */
  className?: string;
  /** Whether the app is in dark mode. Affects animation color inversion. */
  isDarkMode?: boolean;
}

/**
 * Animations Component
 *
 * Displays the animated creature character using Lottie.
 * Supports two variants:
 * 
 * - "large" (default): Full-size creature for login screen
 *   - With showIntro=true: Plays intro animation once, then loops idle
 *   - With showIntro=false: Just loops idle animation
 * 
 * - "small": Compact creature icon for sidebar
 *   - Always loops the small idle animation (no intro)
 */
export const Animations = ({
  variant = "large",
  showIntro = true,
  size,
  className = "",
  isDarkMode = true,
}: AnimationsProps) => {
  const introRef = useRef<LottieRefCurrentProps>(null);
  const idleRef = useRef<LottieRefCurrentProps>(null);
  const [isIntroComplete, setIsIntroComplete] = useState(!showIntro || variant === "small");

  // Default sizes based on variant
  const defaultSize = variant === "large" ? 200 : 32;
  const actualSize = size ?? defaultSize;

  /**
   * Set the frame rate on the intro animation when it loads.
   */
  useEffect(() => {
    if (introRef.current) {
      introRef.current.setSpeed(TARGET_FRAME_RATE / 30); // Lottie default is 30fps
    }
  }, []);

  /**
   * Set the frame rate on the idle animation when it becomes active.
   */
  useEffect(() => {
    if (isIntroComplete && idleRef.current) {
      idleRef.current.setSpeed(TARGET_FRAME_RATE / 30);
    }
  }, [isIntroComplete]);

  /**
   * Handle the intro animation completing.
   * Switches to the idle animation which loops indefinitely.
   */
  const handleIntroComplete = () => {
    setIsIntroComplete(true);
  };

  /**
   * Get the appropriate idle animation data based on variant.
   */
  const getIdleAnimationData = () => {
    return variant === "small" ? animationSmallIdle : animationIdle;
  };

  return (
    <div
      className={cn("inline-block transition-[filter] duration-300", className)}
      style={{
        width: actualSize,
        filter: isDarkMode ? "none" : "invert(1)",
      }}
    >
      {/* Show intro animation for large variant with showIntro enabled */}
      {variant === "large" && showIntro && !isIntroComplete ? (
        <Lottie
          lottieRef={introRef}
          animationData={animationIntro}
          loop={false}
          autoplay={true}
          onComplete={handleIntroComplete}
          style={{ width: "100%", height: "auto" }}
        />
      ) : (
        <Lottie
          lottieRef={idleRef}
          animationData={getIdleAnimationData()}
          loop={true}
          autoplay={true}
          style={{ width: "100%", height: "auto" }}
        />
      )}
    </div>
  );
};

export default Animations;
