import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import type { VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";
import { buttonVariants } from "../contexts/ThemeContext";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * When true, renders the component as its child element
   * using Radix UI's Slot primitive. Useful for composition.
   */
  asChild?: boolean;
}

/**
 * Button Component
 * 
 * A versatile button component with multiple variants and sizes.
 * Supports polymorphic rendering via Radix UI's Slot when asChild is true.
 * Variants are defined in ThemeContext for centralized theme management.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };

