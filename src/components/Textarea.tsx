import * as React from "react"

import { cn } from "../lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-border-primary bg-background-primary px-3 py-2 text-xs text-text-primary resize-y transition-colors placeholder:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring-primary focus-visible:border-ring-primary read-only:focus-visible:ring-0 read-only:focus-visible:border-border-primary disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
