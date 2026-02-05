/**
 * CRM Utilities
 *
 * Shared helper functions for CRM tools.
 * Handles ID generation, store creation, sorting, filtering, and pagination.
 */

import { createDataStore, type DataStore } from "./data.js";
import type {
  Customer,
  CustomerWithStats,
  Order,
  OrderWithItems,
  LineItem,
  CustomerSortField,
  OrderSortField,
  SortConfig,
  SortDirection,
  PaginationParams,
  PaginatedResult,
  ToolContext,
  ToolResult,
} from "./types.js";

// =============================================================================
// ID Generation
// =============================================================================

export const generateCustomerId = () =>
  `cust_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

export const generateOrderId = () =>
  `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

export const generateLineItemId = () =>
  `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

// =============================================================================
// Store Creation
// =============================================================================

export const createCustomerStore = (localId: string): DataStore<Customer> =>
  createDataStore<Customer>({ collection: "customers", localId });

export const createOrderStore = (localId: string): DataStore<Order> =>
  createDataStore<Order>({ collection: "orders", localId });

export const createLineItemStore = (localId: string): DataStore<LineItem> =>
  createDataStore<LineItem>({ collection: "lineItems", localId });

// =============================================================================
// Sorting Utilities
// =============================================================================

/**
 * Sort an array of items by a given field and direction.
 */
export function sortItems<T, K extends keyof T>(
  items: T[],
  field: K,
  direction: SortDirection
): T[] {
  return [...items].sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];

    let cmp = 0;
    if (typeof aVal === "string" && typeof bVal === "string") {
      cmp = aVal.localeCompare(bVal);
    } else if (typeof aVal === "number" && typeof bVal === "number") {
      cmp = aVal - bVal;
    } else {
      cmp = String(aVal).localeCompare(String(bVal));
    }

    return direction === "asc" ? cmp : -cmp;
  });
}

/**
 * Sort customers by field.
 */
export function sortCustomers(
  customers: Customer[],
  sort?: SortConfig<CustomerSortField>
): Customer[] {
  if (!sort) {
    // Default: newest first
    return sortItems(customers, "createdAt", "desc");
  }
  return sortItems(customers, sort.field, sort.direction);
}

/**
 * Sort orders by field.
 */
export function sortOrders(
  orders: Order[],
  sort?: SortConfig<OrderSortField>
): Order[] {
  if (!sort) {
    // Default: newest first
    return sortItems(orders, "createdAt", "desc");
  }
  return sortItems(orders, sort.field, sort.direction);
}

// =============================================================================
// Filtering Utilities
// =============================================================================

/**
 * Filter customers by status.
 */
export function filterCustomersByStatus(
  customers: Customer[],
  status?: string
): Customer[] {
  if (!status) return customers;
  return customers.filter((c) => c.status === status);
}

/**
 * Filter customers by search query (name, email, company).
 */
export function filterCustomersByQuery(
  customers: Customer[],
  query?: string
): Customer[] {
  if (!query) return customers;
  const q = query.toLowerCase();
  return customers.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      c.company.toLowerCase().includes(q)
  );
}

/**
 * Filter orders by status.
 */
export function filterOrdersByStatus(
  orders: Order[],
  status?: string
): Order[] {
  if (!status) return orders;
  return orders.filter((o) => o.status === status);
}

// =============================================================================
// Pagination Utilities
// =============================================================================

/**
 * Paginate an array of items.
 */
export function paginate<T>(
  items: T[],
  params: PaginationParams
): PaginatedResult<T> {
  const { page, pageSize } = params;
  const total = items.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const end = start + pageSize;

  return {
    items: items.slice(start, end),
    total,
    page,
    pageSize,
    totalPages,
  };
}

// =============================================================================
// Data Aggregation
// =============================================================================

/**
 * Enrich customers with order statistics.
 * 
 * If customers already have cached stats (orderCount, totalSpentCents),
 * we use those to avoid expensive order lookups.
 */
export async function enrichCustomersWithStats(
  customers: Customer[],
  orderStore: DataStore<Order>
): Promise<CustomerWithStats[]> {
  // Check if customers already have cached stats
  const hasCachedStats = customers.length > 0 && 
    customers[0].orderCount !== undefined && 
    customers[0].totalSpentCents !== undefined;

  if (hasCachedStats) {
    // Use cached stats from customer records
    return customers.map((customer) => ({
      ...customer,
      orderCount: (customer as any).orderCount ?? 0,
      totalSpentCents: (customer as any).totalSpentCents ?? 0,
    }));
  }

  // Fall back to computing stats (for customers created without stats)
  // Note: This can be slow with many orders
  const allOrders = await orderStore.list();

  return customers.map((customer) => {
    const customerOrders = allOrders.filter((o) => o.customerId === customer.id);
    const orderCount = customerOrders.length;
    const totalSpentCents = customerOrders.reduce((sum, o) => sum + o.totalCents, 0);

    return {
      ...customer,
      orderCount,
      totalSpentCents,
    };
  });
}

/**
 * Enrich an order with its line items.
 */
export async function enrichOrderWithItems(
  order: Order,
  lineItemStore: DataStore<LineItem>
): Promise<OrderWithItems> {
  const allItems = await lineItemStore.list();
  const items = allItems.filter((item) => item.orderId === order.id);

  return {
    ...order,
    items,
  };
}

/**
 * Get orders for a customer.
 */
export async function getOrdersForCustomer(
  customerId: string,
  orderStore: DataStore<Order>
): Promise<Order[]> {
  const allOrders = await orderStore.list();
  return allOrders.filter((o) => o.customerId === customerId);
}

// =============================================================================
// Store Wrapper
// =============================================================================

export interface CrmStores {
  customers: DataStore<Customer>;
  orders: DataStore<Order>;
  lineItems: DataStore<LineItem>;
}

/**
 * Create all CRM stores for a given context.
 * Uses "global" as localId for project-wide data.
 */
export function createCrmStores(): CrmStores {
  const localId = "global";
  return {
    customers: createCustomerStore(localId),
    orders: createOrderStore(localId),
    lineItems: createLineItemStore(localId),
  };
}

/**
 * Wrap tool handlers with store creation.
 */
export const withStores = async (
  context: ToolContext,
  handler: (stores: CrmStores) => Promise<ToolResult>
): Promise<ToolResult> => {
  const stores = createCrmStores();
  return handler(stores);
};

// =============================================================================
// Formatting Utilities
// =============================================================================

/**
 * Format cents as a dollar string.
 */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Generate an order number.
 * Uses timestamp + random suffix for uniqueness without needing to count existing orders.
 */
export function generateOrderNumber(index?: number): string {
  if (index !== undefined) {
    // Used by seed function with sequential numbers
    return `ORD-${String(index).padStart(4, "0")}`;
  }
  // For runtime creation, use timestamp-based number
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 4).toUpperCase();
  return `ORD-${timestamp}${random}`;
}
