/**
 * CRM Tools
 *
 * Tools for managing customers, orders, and data.
 * All tools route to the same UI and support:
 * - Listing with pagination, sorting, and filtering
 * - Detail views with related data
 * - Data seeding and reset
 *
 * Tools:
 * - crm_list: List customers with sorting, filtering, pagination
 * - crm_customer_get: Get customer details with orders
 * - crm_customer_create: Create a new customer
 * - crm_order_create: Create an order for a customer
 * - crm_seed: Generate demo data
 * - crm_reset: Clear all data
 * - crm_storage_pagination_validate: Validate cursor pagination behavior in KV storage
 */

import { z } from "zod";
import { exp, type App } from "open-mcp-app/server";
import {
  CRM_UI_URI,
  type Customer,
  type CustomerWithStats,
  type Order,
  type OrderWithItems,
  type CustomerSortField,
  type SortDirection,
  type ToolContext,
  type ToolResult,
} from "../lib/types.js";
import {
  createCrmStores,
  sortCustomers,
  sortOrders,
  filterCustomersByStatus,
  filterCustomersByQuery,
  paginate,
  enrichCustomersWithStats,
  enrichOrderWithItems,
  getOrdersForCustomer,
  generateCustomerId,
  generateOrderId,
  generateLineItemId,
  generateOrderNumber,
  formatCents,
  withStores,
  type CrmStores,
} from "../lib/utils.js";
import { seedDemoData, clearAllData } from "../lib/seed.js";

// =============================================================================
// Input Schemas
// =============================================================================

const CrmListSchema = z.object({
  query: z.string().optional().describe("Search query for name, email, or company"),
  status: z.enum(["active", "inactive", "lead"]).optional().describe("Filter by customer status"),
  sortField: z.enum(["name", "email", "company", "status", "createdAt"]).optional().describe("Field to sort by"),
  sortDirection: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
  cursor: z.string().optional().describe("Cursor token from a previous crm_list response"),
  page: z.number().int().min(1).default(1).describe("Current page number (UI state)"),
  pageSize: z.number().min(1).max(100).default(20).describe("Items per page"),
});

const CrmCustomerGetSchema = z.object({
  customerId: z.string().describe("The customer ID to retrieve"),
});

const CrmCustomerCreateSchema = z.object({
  name: z.string().describe("Customer name"),
  email: z.string().email().describe("Customer email"),
  company: z.string().describe("Company name"),
  status: z.enum(["active", "inactive", "lead"]).default("lead").describe("Customer status"),
});

const CrmOrderCreateSchema = z.object({
  customerId: z.string().describe("The customer ID for the order"),
  items: z.array(z.object({
    sku: z.string().describe("Product SKU"),
    title: z.string().describe("Product title"),
    qty: z.number().min(1).describe("Quantity"),
    unitPriceCents: z.number().min(0).describe("Unit price in cents"),
  })).min(1).describe("Order line items"),
});

const CrmSeedSchema = z.object({});

const CrmResetSchema = z.object({
  confirm: z.boolean().describe("Must be true to confirm data deletion"),
});

const CrmStoragePaginationValidateSchema = z.object({
  collection: z
    .enum(["customers", "orders", "lineItems", "all"])
    .default("all")
    .describe("Which CRM collection prefix to validate"),
  limit: z.number().int().min(1).max(200).default(25).describe("Page size for cursor pagination checks"),
});

// =============================================================================
// Tool Handlers
// =============================================================================

/**
 * List customers with pagination, sorting, and filtering.
 */
const handleList = async (
  input: z.infer<typeof CrmListSchema>,
  stores: CrmStores
): Promise<ToolResult> => {
  const sort = input.sortField
    ? { field: input.sortField, direction: input.sortDirection || "asc" as SortDirection }
    : { field: "createdAt" as CustomerSortField, direction: "asc" as SortDirection };

  const canUseCursorPagination =
    !input.query &&
    !input.status &&
    sort.field === "createdAt" &&
    sort.direction === "asc";

  if (canUseCursorPagination) {
    if (input.page > 1 && !input.cursor) {
      return {
        isError: true,
        text: "Cursor is required for page > 1 when using cursor pagination.",
        data: {
          customers: [],
          pagination: {
            mode: "cursor",
            page: input.page,
            pageSize: input.pageSize,
            total: null,
            totalPages: null,
            cursor: null,
            nextCursor: null,
          },
          filters: {
            query: input.query,
            status: input.status,
          },
          sort,
          summary: {
            totalCustomers: null,
            totalOrders: null,
          },
        },
      };
    }

    const page = await stores.customers.listPage({
      cursor: input.cursor,
      limit: input.pageSize,
    });
    const customers = await enrichCustomersWithStats(page.items, stores.orders);

    return {
      data: {
        customers,
        pagination: {
          mode: "cursor",
          page: input.page,
          pageSize: input.pageSize,
          total: null,
          totalPages: null,
          cursor: input.cursor ?? null,
          nextCursor: page.nextCursor,
        },
        filters: {
          query: input.query,
          status: input.status,
        },
        sort,
        summary: {
          totalCustomers: null,
          totalOrders: null,
        },
      },
      title: "CRM",
      text: customers.length === 0
        ? "No customers found. Use crm_seed to generate demo data."
        : page.nextCursor
          ? `Showing ${customers.length} customers (page ${input.page}, more available)`
          : `Showing ${customers.length} customers (page ${input.page}, end reached)`,
    };
  }

  let customers = await stores.customers.list();
  customers = filterCustomersByQuery(customers, input.query);
  customers = filterCustomersByStatus(customers, input.status);
  customers = sortCustomers(customers, sort);

  const enriched = await enrichCustomersWithStats(customers, stores.orders);
  const result = paginate(enriched, {
    page: input.page,
    pageSize: input.pageSize,
  });
  const totalOrders = enriched.reduce((sum, c) => sum + (c.orderCount ?? 0), 0);

  return {
    data: {
      customers: result.items,
      pagination: {
        mode: "offset",
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
        cursor: null,
        nextCursor: null,
      },
      filters: {
        query: input.query,
        status: input.status,
      },
      sort,
      summary: {
        totalCustomers: enriched.length,
        totalOrders,
      },
    },
    title: `CRM (${result.total} customers)`,
    text: result.total === 0
      ? "No customers found. Use crm_seed to generate demo data."
      : `Showing ${result.items.length} of ${result.total} customers (page ${result.page}/${result.totalPages})`,
  };
};

/**
 * Get customer details with orders.
 */
const handleCustomerGet = async (
  input: z.infer<typeof CrmCustomerGetSchema>,
  stores: CrmStores
): Promise<ToolResult> => {
  const customer = await stores.customers.get(input.customerId);
  if (!customer) {
    return {
      data: { error: "Customer not found" },
      text: `Customer ${input.customerId} not found`,
      isError: true,
    };
  }

  // Get customer's orders
  const orders = await getOrdersForCustomer(customer.id, stores.orders);
  const sortedOrders = sortOrders(orders);

  // Enrich orders with items
  const ordersWithItems: OrderWithItems[] = [];
  for (const order of sortedOrders) {
    const enriched = await enrichOrderWithItems(order, stores.lineItems);
    ordersWithItems.push(enriched);
  }

  // Calculate stats
  const totalSpentCents = orders.reduce((sum, o) => sum + o.totalCents, 0);

  return {
    data: {
      customer,
      orders: ordersWithItems,
      stats: {
        orderCount: orders.length,
        totalSpentCents,
        totalSpent: formatCents(totalSpentCents),
      },
    },
    title: customer.name,
    text: `${customer.name} - ${orders.length} orders, ${formatCents(totalSpentCents)} total`,
  };
};

/**
 * Create a new customer.
 */
const handleCustomerCreate = async (
  input: z.infer<typeof CrmCustomerCreateSchema>,
  stores: CrmStores
): Promise<ToolResult> => {
  const now = new Date().toISOString();
  const customer: Customer = {
    id: generateCustomerId(),
    name: input.name,
    email: input.email,
    company: input.company,
    status: input.status,
    createdAt: now,
    updatedAt: now,
    // Initialize cached stats
    orderCount: 0,
    totalSpentCents: 0,
  };

  await stores.customers.set(customer.id, customer);

  // Get updated list
  const allCustomers = await stores.customers.list();

  return {
    data: {
      customer,
      totalCustomers: allCustomers.length,
    },
    title: `CRM (${allCustomers.length} customers)`,
    text: `Created customer: ${customer.name} (${customer.email})`,
  };
};

/**
 * Create an order for a customer.
 */
const handleOrderCreate = async (
  input: z.infer<typeof CrmOrderCreateSchema>,
  stores: CrmStores
): Promise<ToolResult> => {
  // Verify customer exists
  const customer = await stores.customers.get(input.customerId);
  if (!customer) {
    return {
      data: { error: "Customer not found" },
      text: `Customer ${input.customerId} not found`,
      isError: true,
    };
  }

  const now = new Date().toISOString();
  const orderId = generateOrderId();

  // Calculate total
  let totalCents = 0;
  for (const item of input.items) {
    totalCents += item.qty * item.unitPriceCents;
  }

  // Create order
  const order: Order = {
    id: orderId,
    customerId: input.customerId,
    number: generateOrderNumber(),
    status: "pending",
    totalCents,
    createdAt: now,
    updatedAt: now,
  };

  await stores.orders.set(order.id, order);

  // Create line items
  for (const item of input.items) {
    const lineItem = {
      id: generateLineItemId(),
      orderId,
      sku: item.sku,
      title: item.title,
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
    };
    await stores.lineItems.set(lineItem.id, lineItem);
  }

  // Update customer's cached stats
  const updatedCustomer: Customer = {
    ...customer,
    orderCount: (customer.orderCount ?? 0) + 1,
    totalSpentCents: (customer.totalSpentCents ?? 0) + totalCents,
    updatedAt: now,
  };
  await stores.customers.set(customer.id, updatedCustomer);

  return {
    data: {
      order,
      customer: updatedCustomer,
    },
    title: `Order ${order.number}`,
    text: `Created order ${order.number} for ${customer.name} - ${formatCents(totalCents)}`,
  };
};

/**
 * Seed demo data.
 */
const handleSeed = async (stores: CrmStores): Promise<ToolResult> => {
  // Check if data already exists
  const existingCustomers = await stores.customers.list();
  if (existingCustomers.length > 0) {
    return {
      data: { 
        error: "Data already exists",
        existingCustomers: existingCustomers.length,
      },
      text: `Data already exists (${existingCustomers.length} customers). Use crm_reset first to clear.`,
      isError: true,
    };
  }

  const result = await seedDemoData(stores);

  return {
    data: {
      seeded: result,
    },
    title: `CRM (${result.customers} customers)`,
    text: `Seeded ${result.customers} customers, ${result.orders} orders, ${result.lineItems} line items`,
  };
};

/**
 * Clear all data.
 */
const handleReset = async (
  input: z.infer<typeof CrmResetSchema>,
  stores: CrmStores
): Promise<ToolResult> => {
  if (!input.confirm) {
    return {
      data: { error: "Must set confirm: true to delete all data" },
      text: "Must set confirm: true to delete all data",
      isError: true,
    };
  }

  // Get counts before clearing
  const customerCount = (await stores.customers.list()).length;
  const orderCount = (await stores.orders.list()).length;
  const itemCount = (await stores.lineItems.list()).length;

  await clearAllData(stores);

  return {
    data: {
      deleted: {
        customers: customerCount,
        orders: orderCount,
        lineItems: itemCount,
      },
    },
    title: "CRM (0 customers)",
    text: `Deleted ${customerCount} customers, ${orderCount} orders, ${itemCount} line items`,
  };
};

const strictAscending = (values: string[]): boolean => {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] >= values[i]) {
      return false;
    }
  }
  return true;
};

const hasNoDuplicates = (values: string[]): boolean => {
  return new Set(values).size === values.length;
};

const collectKeys = async (prefix: string, limit: number): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await exp.kvList({ prefix, cursor, limit });
    if (!page) {
      throw new Error("KV storage unavailable");
    }

    keys.push(...page.keys);

    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  return keys;
};

const collectEntryKeys = async (prefix: string, limit: number): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await exp.kvListWithValues({ prefix, cursor, limit });
    if (!page) {
      throw new Error("KV storage unavailable");
    }

    for (const entry of page.entries) {
      keys.push(entry.key);
    }

    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  return keys;
};

const handleStoragePaginationValidate = async (
  input: z.infer<typeof CrmStoragePaginationValidateSchema>
): Promise<ToolResult> => {
  if (!exp.kvIsAvailable()) {
    return {
      isError: true,
      text: "KV storage is unavailable for CRM pagination validation.",
      data: { ok: false },
    };
  }

  const prefixes =
    input.collection === "all"
      ? [
          { collection: "customers", prefix: "customers:global:" },
          { collection: "orders", prefix: "orders:global:" },
          { collection: "lineItems", prefix: "lineItems:global:" },
        ]
      : [{ collection: input.collection, prefix: `${input.collection}:global:` }];

  const checks: Array<{
    collection: string;
    totalKeys: number;
    strictAscending: boolean;
    noDuplicates: boolean;
    listMatchesListWithValues: boolean;
  }> = [];

  for (const target of prefixes) {
    const keys = await collectKeys(target.prefix, input.limit);
    const entryKeys = await collectEntryKeys(target.prefix, input.limit);
    checks.push({
      collection: target.collection,
      totalKeys: keys.length,
      strictAscending: strictAscending(keys),
      noDuplicates: hasNoDuplicates(keys),
      listMatchesListWithValues:
        keys.length === entryKeys.length &&
        keys.every((key, index) => key === entryKeys[index]),
    });
  }

  const ok = checks.every(
    (check) =>
      check.strictAscending &&
      check.noDuplicates &&
      check.listMatchesListWithValues
  );

  return {
    data: {
      ok,
      limit: input.limit,
      checks,
    },
    text: ok
      ? `CRM storage cursor pagination passed (${checks.length} collection checks).`
      : "CRM storage cursor pagination validation failed.",
    isError: !ok,
  };
};

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Register all CRM tools.
 */
export const registerCrmTools = (app: App) => {
  // List customers
  app.tool(
    "crm_list",
    {
      description: "List customers with filtering and pagination. Uses cursor pagination by default and falls back to offset pagination when filters or non-default sorting are applied.",
      input: CrmListSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof CrmListSchema>, context: ToolContext) => {
      return withStores(context, async (stores) => handleList(input, stores));
    }
  );

  // Get customer details
  app.tool(
    "crm_customer_get",
    {
      description: "Get customer details including their order history",
      input: CrmCustomerGetSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof CrmCustomerGetSchema>, context: ToolContext) => {
      return withStores(context, async (stores) => handleCustomerGet(input, stores));
    }
  );

  // Create customer
  app.tool(
    "crm_customer_create",
    {
      description: "Create a new customer record",
      input: CrmCustomerCreateSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof CrmCustomerCreateSchema>, context: ToolContext) => {
      return withStores(context, async (stores) => handleCustomerCreate(input, stores));
    }
  );

  // Create order
  app.tool(
    "crm_order_create",
    {
      description: "Create a new order for a customer with line items",
      input: CrmOrderCreateSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof CrmOrderCreateSchema>, context: ToolContext) => {
      return withStores(context, async (stores) => handleOrderCreate(input, stores));
    }
  );

  // Seed demo data
  app.tool(
    "crm_seed",
    {
      description: "Generate demo data with ~25 customers and ~75 orders. Use this to populate the CRM with sample data.",
      input: CrmSeedSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (_input: z.infer<typeof CrmSeedSchema>, context: ToolContext) => {
      return withStores(context, async (stores) => handleSeed(stores));
    }
  );

  // Reset all data
  app.tool(
    "crm_reset",
    {
      description: "Delete all CRM data. Requires confirm: true to execute.",
      input: CrmResetSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof CrmResetSchema>, context: ToolContext) => {
      return withStores(context, async (stores) => handleReset(input, stores));
    }
  );

  app.tool(
    "crm_storage_pagination_validate",
    {
      description:
        "Validate CRM KV cursor pagination by checking key ordering, deduplication, and kvList/kvListWithValues parity.",
      input: CrmStoragePaginationValidateSchema,
      ui: CRM_UI_URI,
      visibility: ["model", "app"],
      displayModes: ["pip", "inline"],
      experimental: {
        defaultDisplayMode: "pip",
      },
    },
    async (input: z.infer<typeof CrmStoragePaginationValidateSchema>) => {
      return handleStoragePaginationValidate(input);
    }
  );
};
