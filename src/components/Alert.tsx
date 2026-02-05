import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/**
 * Alert variants using class-variance-authority.
 * Provides consistent styling across different alert types.
 */
const alertVariants = cva(
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-background-tertiary border-border-secondary text-text-primary",
        destructive: "bg-background-danger border-border-danger text-text-danger",
        warning: "bg-background-warning border-border-warning text-text-warning",
        info: "bg-background-info border-border-info text-text-info",
        success: "bg-background-success border-border-success text-text-success",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/**
 * Alert Component
 *
 * Displays a callout for important information or feedback.
 * Supports multiple variants for different semantic meanings.
 */
const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = "Alert";

/**
 * AlertTitle Component
 *
 * The title/heading for an alert. Should be a brief summary.
 */
const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight text-sm", className)}
    {...props}
  />
));
AlertTitle.displayName = "AlertTitle";

/**
 * AlertDescription Component
 *
 * The body text for an alert. Provides additional context.
 */
const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

/**
 * AlertAction Component
 *
 * Container for action buttons within an alert.
 */
const AlertAction = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("mt-3 flex items-center gap-2", className)}
    {...props}
  />
));
AlertAction.displayName = "AlertAction";

export { Alert, AlertTitle, AlertDescription, AlertAction, alertVariants };
