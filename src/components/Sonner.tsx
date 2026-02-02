import { Toaster as Sonner } from "sonner";

/**
 * Sonner Toast Component
 * 
 * Shadcn's recommended toast component using Sonner.
 * Configured to use default theme styles without colored variants.
 */

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "group w-full rounded-lg border border-border-primary bg-background-primary p-4 shadow-lg flex items-start gap-3",
          title: "text-sm font-normal text-text-primary",
          description: "text-sm text-text-secondary",
          actionButton: "bg-background-inverse text-text-inverse hover:bg-background-inverse/90 px-3 py-2 rounded-md text-xs font-medium",
          cancelButton: "bg-background-secondary text-text-primary hover:bg-background-secondary/80 px-3 py-2 rounded-md text-xs font-medium",
          closeButton: "absolute right-2 top-2 rounded-md p-1 text-text-primary/50 opacity-0 transition-opacity hover:text-text-primary focus:opacity-100 focus:outline-none group-hover:opacity-100",
        },
      }}
    />
  );
}

