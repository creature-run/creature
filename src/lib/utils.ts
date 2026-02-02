import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility function for merging Tailwind CSS classes.
 * 
 * Combines clsx for conditional classes with tailwind-merge
 * to properly handle conflicting Tailwind utility classes.
 * This is the standard utility used by ShadCN UI components.
 * 
 * @param inputs - Class values to merge (strings, arrays, objects)
 * @returns Merged class string with conflicts resolved
 */
export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs));
};

/**
 * Truncates a file path from the left side at path boundaries.
 * Ensures truncation happens at directory separators for clean display.
 * 
 * Examples:
 * - "/Users/a/Projects/serverless/svg" → ".../Projects/serverless/svg"
 * - "/short/path" → "/short/path" (no truncation)
 * 
 * @param path - The file path to truncate
 * @param maxLength - Maximum length of the resulting string
 * @returns Truncated path with "..." prefix if needed
 */
export const truncatePathLeft = (path: string, maxLength: number): string => {
  if (path.length <= maxLength) return path;
  
  const segments = path.split('/').filter(s => s.length > 0); // Remove empty segments
  const ellipsis = '...';
  
  // Always try to show at least the last segment
  let result = segments[segments.length - 1];
  
  // Work backwards, adding segments until we exceed maxLength
  for (let i = segments.length - 2; i >= 0; i--) {
    const newResult = segments[i] + '/' + result;
    const withEllipsis = ellipsis + '/' + newResult;
    
    if (withEllipsis.length >= maxLength) {
      // Adding this segment would meet or exceed limit, use what we have
      return ellipsis + '/' + result;
    }
    
    result = newResult;
  }
  
  // All segments fit, but was truncated, so add ellipsis
  return ellipsis + '/' + result;
};

/**
 * Formats a price value to USD currency, rounded to the nearest cent.
 * 
 * Handles floating point precision issues by rounding to 2 decimal places
 * before formatting. Returns a formatted string like "$17.89".
 * 
 * @param amount - The price amount to format
 * @returns Formatted currency string (e.g., "$17.89")
 */
export const formatPrice = (amount: number): string => {
  // Round to nearest cent to avoid floating point issues
  const rounded = Math.round(amount * 100) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rounded);
};

/**
 * Initiates the upgrade to Starter plan flow.
 * Opens Stripe Checkout in the user's browser.
 * 
 * This is the single source of truth for all upgrade actions.
 * Use this function from any component that needs to trigger an upgrade.
 * 
 * @returns Promise with success status and optional error message
 */
export const startUpgrade = async (): Promise<{ success: boolean; error?: string }> => {
  try {
    const result = await window.electronAPI.billing.checkout();
    if (result.error) {
      console.error("[Billing] Checkout error:", result.error);
      return { success: false, error: result.error };
    }
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to start checkout";
    console.error("[Billing] Checkout exception:", errorMessage);
    return { success: false, error: errorMessage };
  }
};

/**
 * Opens the Stripe Customer Portal for subscription management.
 * Use this for managing existing subscriptions (cancel, update payment, etc).
 * 
 * @returns Promise with success status and optional error message
 */
export const openSubscriptionPortal = async (): Promise<{ success: boolean; error?: string }> => {
  try {
    const result = await window.electronAPI.billing.portal();
    if (result.error) {
      console.error("[Billing] Portal error:", result.error);
      return { success: false, error: result.error };
    }
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Failed to open portal";
    console.error("[Billing] Portal exception:", errorMessage);
    return { success: false, error: errorMessage };
  }
};
