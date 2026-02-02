import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { cn } from "../lib/utils";

const HoverCard = HoverCardPrimitive.Root;

const HoverCardTrigger = HoverCardPrimitive.Trigger;

/**
 * HoverCard Content Component
 * 
 * Displays content in a popover when hovering over a trigger element.
 * Uses Radix UI's HoverCard primitive with custom styling.
 */
const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = "center", sideOffset = 9, ...props }, ref) => (
  <HoverCardPrimitive.Content
    ref={ref}
    align={align}
    sideOffset={sideOffset}
    className={cn(
      "z-50 w-64 rounded-md border border-border-primary bg-background-primary p-6 text-xs text-text-primary outline-none",
      "shadow-[0_4px_12px_rgba(0,0,0,0.15)]",
      "data-[state=open]:animate-[hover-card-in_200ms_ease-out]",
      "data-[state=closed]:animate-[hover-card-out_150ms_ease-in]",
      className
    )}
    {...props}
  />
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };

