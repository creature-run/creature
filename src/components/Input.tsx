import * as React from "react"

import { cn } from "../lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-[34px] w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-xs text-text-primary transition-colors file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-text-primary placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring-primary focus-visible:border-ring-primary read-only:focus-visible:ring-0 read-only:focus-visible:border-border-primary disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
