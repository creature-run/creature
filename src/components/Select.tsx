import * as React from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "../lib/utils";

/**
 * Select Component Props
 */
interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  value?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}

/**
 * Select Component
 *
 * A styled native select element with a custom chevron icon.
 * Simple, accessible, and consistent with the design system.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, value, onValueChange, children, ...props }, ref) => (
    <div className="relative w-full">
      <select
        ref={ref}
        value={value}
        onChange={(e) => onValueChange?.(e.target.value)}
        className={cn(
          "flex h-9 w-full items-center rounded-md border border-border-primary bg-background-primary px-3 py-2 text-xs text-text-primary transition-colors",
          "focus:outline-none focus:ring-1 focus:ring-ring-primary focus:border-ring-primary",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "appearance-none pr-9",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <CaretDown 
        size={14} 
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        weight="bold"
      />
    </div>
  )
);
Select.displayName = "Select";

/**
 * SelectTrigger Component (compatibility wrapper)
 *
 * For API compatibility with Radix-style Select.
 * Just passes through to the parent Select.
 */
const SelectTrigger = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { id?: string }
>(({ className, children, ...props }, ref) => (
  <div ref={ref} className={cn("relative", className)} {...props}>
    {children}
  </div>
));
SelectTrigger.displayName = "SelectTrigger";

/**
 * SelectValue Component (compatibility wrapper)
 */
const SelectValue = ({ placeholder }: { placeholder?: string }) => (
  <span className="text-text-tertiary">{placeholder}</span>
);
SelectValue.displayName = "SelectValue";

/**
 * SelectContent Component (compatibility wrapper)
 */
const SelectContent = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
SelectContent.displayName = "SelectContent";

/**
 * SelectItem Component
 *
 * An option within the select.
 */
const SelectItem = ({
  value,
  children,
}: {
  value: string;
  children?: React.ReactNode;
}) => (
  <option value={value} className="bg-background-primary text-text-primary">
    {children}
  </option>
);
SelectItem.displayName = "SelectItem";

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
};
