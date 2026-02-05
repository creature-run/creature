/**
 * Type Definitions
 *
 * All shared types for the CRM MCP.
 */

// =============================================================================
// Constants
// =============================================================================

export const MCP_NAME = "crm";
export const CRM_UI_URI = `ui://${MCP_NAME}/crm`;

// =============================================================================
// Data Types
// =============================================================================

/**
 * Customer status.
 */
export type CustomerStatus = "active" | "inactive" | "lead";

/**
 * Order status.
 */
export type OrderStatus = "pending" | "processing" | "shipped" | "delivered" | "cancelled";

/**
 * A customer record.
 * 
 * orderCount and totalSpentCents are cached stats that get updated
 * when orders are created. This avoids expensive order lookups.
 */
export interface Customer {
  id: string;
  name: string;
  email: string;
  company: string;
  status: CustomerStatus;
  createdAt: string;
  updatedAt: string;
  // Cached stats (optional for backwards compatibility)
  orderCount?: number;
  totalSpentCents?: number;
}

/**
 * An order record.
 */
export interface Order {
  id: string;
  customerId: string;
  number: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A line item within an order.
 */
export interface LineItem {
  id: string;
  orderId: string;
  sku: string;
  title: string;
  qty: number;
  unitPriceCents: number;
}

/**
 * Customer with aggregated order stats.
 */
export interface CustomerWithStats extends Customer {
  orderCount: number;
  totalSpentCents: number;
}

/**
 * Order with line items.
 */
export interface OrderWithItems extends Order {
  items: LineItem[];
}

// =============================================================================
// Sort Types
// =============================================================================

export type CustomerSortField = "name" | "email" | "company" | "status" | "createdAt";
export type OrderSortField = "number" | "status" | "totalCents" | "createdAt";
export type SortDirection = "asc" | "desc";

export interface SortConfig<T extends string = string> {
  field: T;
  direction: SortDirection;
}

// =============================================================================
// Pagination Types
// =============================================================================

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// =============================================================================
// Tool Types
// =============================================================================

// Re-export ToolContext from SDK - includes instanceId, setState, getState, etc.
export type { ToolContext, ToolResult } from "open-mcp-app/server";
