import * as React from "react";
import { useState, useEffect, useCallback } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/**
 * Toast Component
 *
 * A ShadCN-style toast notification component.
 * Supports multiple variants (info, success, warning, error) with
 * auto-dismiss and manual dismiss functionality.
 */

export interface ToastMessage {
  id: string;
  type: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
  data?: unknown;
  timestamp: number;
}

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border p-4 shadow-lg",
  {
    variants: {
      variant: {
        info: "border-border-primary bg-background-secondary text-text-primary",
        success: "border-green-500/30 bg-green-500/10 text-green-400",
        warning: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400",
        error: "border-border-danger/30 bg-background-danger/10 text-text-danger",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
);

interface ToastIconProps {
  type: ToastMessage["type"];
}

function ToastIcon({ type }: ToastIconProps) {
  const iconClass = "h-5 w-5 shrink-0";

  switch (type) {
    case "success":
      return (
        <svg className={cn(iconClass, "text-green-400")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      );
    case "error":
      return (
        <svg className={cn(iconClass, "text-text-danger")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case "warning":
      return (
        <svg className={cn(iconClass, "text-yellow-400")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      );
    default:
      return (
        <svg className={cn(iconClass, "text-text-secondary")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
}

interface ToastProps extends VariantProps<typeof toastVariants> {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}

function Toast({ toast, onDismiss }: ToastProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(() => onDismiss(toast.id), 300);
    }, 5000);

    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => onDismiss(toast.id), 300);
  }, [toast.id, onDismiss]);

  return (
    <div
      className={cn(
        toastVariants({ variant: toast.type }),
        isExiting ? "toast-exit" : "toast-enter"
      )}
    >
      <ToastIcon type={toast.type} />
      <div className="flex-1 space-y-1">
        <p className="text-sm font-medium leading-none">{toast.title}</p>
        {toast.message && (
          <p className="text-sm text-text-secondary">{toast.message}</p>
        )}
        {toast.data && (
          <pre className="mt-2 max-h-24 overflow-auto rounded bg-background-tertiary/50 p-2 text-sm text-text-secondary">
            {JSON.stringify(toast.data, null, 2)}
          </pre>
        )}
      </div>
      <button
        onClick={handleDismiss}
        className="absolute right-2 top-2 rounded-md p-1 text-text-primary/50 opacity-0 transition-opacity hover:text-text-primary focus:opacity-100 focus:outline-none group-hover:opacity-100"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        <span className="sr-only">Close</span>
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-screen w-full max-w-sm flex-col-reverse gap-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: Omit<ToastMessage, "id" | "timestamp">) => {
    const newToast: ToastMessage = {
      ...toast,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
    };
    setToasts((prev) => [...prev, newToast]);
    return newToast.id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
