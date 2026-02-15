/**
 * MCP CRM UI
 *
 * A data-intensive CRM explorer demonstrating:
 * - DataTable with sortable columns, filtering, pagination
 * - Detail panels with related data
 *
 * Cross-Platform Compatibility:
 * - Works in Creature (MCP Apps host)
 * - Works in ChatGPT Apps
 * - Works in any generic MCP Apps host
 *
 * SDK hooks used:
 * - HostProvider: Provides host client to child components via context
 * - useHost: Access callTool, isReady, log, exp_widgetState from context
 */

import { useEffect, useCallback, useState, useRef, useMemo } from "react";
import { HostProvider, useHost, type Environment } from "open-mcp-app/react";
import {
  Database,
  Trash,
  User,
  Package,
  X,
} from "@phosphor-icons/react";
import {
  AppLayout,
  Heading,
  Text,
  Button,
  Badge,
  Card,
} from "open-mcp-app-ui";
import { DataTable, type ColumnDef } from "open-mcp-app-ui/table";
import "open-mcp-app-ui/styles.css";
import "./styles.css";

// =============================================================================
// Types
// =============================================================================

type CustomerStatus = "active" | "inactive" | "lead";
type OrderStatus = "pending" | "processing" | "shipped" | "delivered" | "cancelled";

interface Customer {
  id: string;
  name: string;
  email: string;
  company: string;
  status: CustomerStatus;
  createdAt: string;
  updatedAt: string;
  orderCount?: number;
  totalSpentCents?: number;
}

interface Order {
  id: string;
  customerId: string;
  number: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
  items?: LineItem[];
}

interface LineItem {
  id: string;
  orderId: string;
  sku: string;
  title: string;
  qty: number;
  unitPriceCents: number;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface SortConfig {
  field: string;
  direction: "asc" | "desc";
}

interface Filters {
  query?: string;
  status?: CustomerStatus;
}

interface ListData {
  customers: Customer[];
  pagination: Pagination;
  filters: Filters;
  sort: SortConfig;
  summary: {
    totalCustomers: number;
    totalOrders: number;
  };
}

interface CustomerDetailData {
  customer: Customer;
  orders: Order[];
  stats: {
    orderCount: number;
    totalSpentCents: number;
    totalSpent: string;
  };
}

interface WidgetState {
  modelContent: {
    totalCustomers: number;
    totalOrders: number;
    selectedCustomerId?: string;
  };
  privateContent: {
    listData?: ListData;
    customerDetail?: CustomerDetailData;
    filters: Filters;
    sort: SortConfig;
    page: number;
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format cent values to dollar string.
 */
const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/**
 * Format ISO date string to human-readable short date.
 */
const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

/**
 * Map status values to Badge component variants.
 * Uses the semantic variant system from open-mcp-app-ui.
 */
const getStatusBadgeVariant = (status: CustomerStatus | OrderStatus): "success" | "warning" | "danger" | "info" | "secondary" => {
  const variants: Record<string, "success" | "warning" | "danger" | "info" | "secondary"> = {
    active: "success",
    inactive: "secondary",
    lead: "warning",
    pending: "warning",
    processing: "info",
    shipped: "info",
    delivered: "success",
    cancelled: "danger",
  };
  return variants[status] || "secondary";
};

// =============================================================================
// Column Definitions
// =============================================================================

/**
 * DataTable column definitions for the customer list.
 * Each column uses an accessor key and optional custom cell renderer.
 */
const customerColumns: ColumnDef<Customer, unknown>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ getValue }) => (
      <span className="font-medium">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "email",
    header: "Email",
    cell: ({ getValue }) => (
      <span className="text-txt-secondary">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "company",
    header: "Company",
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }) => {
      const status = getValue() as CustomerStatus;
      return <Badge variant={getStatusBadgeVariant(status)}>{status}</Badge>;
    },
  },
  {
    accessorKey: "orderCount",
    header: "Orders",
    cell: ({ getValue }) => (getValue() as number) ?? 0,
  },
  {
    accessorKey: "totalSpentCents",
    header: "Total",
    cell: ({ getValue }) => formatCents((getValue() as number) ?? 0),
  },
];

// =============================================================================
// Components
// =============================================================================

/**
 * Customer detail panel.
 * Displays customer info, order stats, and order history.
 */
const CustomerDetail = ({
  data,
  onClose,
}: {
  data: CustomerDetailData;
  onClose: () => void;
}) => {
  const { customer, orders, stats } = data;

  return (
    <div className="w-[40%] min-w-[300px] border-l border-bdr-secondary bg-bg-secondary flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-bdr-secondary shrink-0">
        <Heading level={3} size="sm">{customer.name}</Heading>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={16} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto pb-10">
        <div className="p-4 border-b border-bdr-secondary">
          <div className="flex justify-between items-center py-1.5">
            <Text size="sm" variant="secondary">Email</Text>
            <Text size="sm">{customer.email}</Text>
          </div>
          <div className="flex justify-between items-center py-1.5">
            <Text size="sm" variant="secondary">Company</Text>
            <Text size="sm">{customer.company}</Text>
          </div>
          <div className="flex justify-between items-center py-1.5">
            <Text size="sm" variant="secondary">Status</Text>
            <Badge variant={getStatusBadgeVariant(customer.status)}>{customer.status}</Badge>
          </div>
          <div className="flex justify-between items-center py-1.5">
            <Text size="sm" variant="secondary">Customer Since</Text>
            <Text size="sm">{formatDate(customer.createdAt)}</Text>
          </div>
        </div>

        <div className="flex gap-4 p-4 border-b border-bdr-secondary">
          <div className="flex-1 text-center">
            <Text as="span" className="block text-lg font-medium mb-1">{stats.orderCount}</Text>
            <Text size="sm" variant="secondary">Orders</Text>
          </div>
          <div className="flex-1 text-center">
            <Text as="span" className="block text-lg font-medium mb-1">{stats.totalSpent}</Text>
            <Text size="sm" variant="secondary">Total Spent</Text>
          </div>
        </div>

        <Heading level={4} size="sm" className="py-4 px-4 pb-3" variant="secondary">Order History</Heading>
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-4 gap-2">
            <Package size={32} className="text-txt-tertiary opacity-50" />
            <Text size="sm" variant="secondary">No orders yet</Text>
          </div>
        ) : (
          <div className="px-4 pb-4">
            {orders.map((order) => (
              <Card key={order.id} variant="secondary" padding="sm" className="mb-2">
                <div className="flex justify-between items-center mb-2">
                  <Text as="span" size="sm" className="font-medium">{order.number}</Text>
                  <Badge variant={getStatusBadgeVariant(order.status)}>{order.status}</Badge>
                </div>
                <div className="flex justify-between">
                  <Text size="sm" variant="secondary">{formatDate(order.createdAt)}</Text>
                  <Text size="sm" className="font-medium">{formatCents(order.totalCents)}</Text>
                </div>
                {order.items && order.items.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-bdr-secondary">
                    {order.items.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 py-1">
                        <Text as="span" size="sm" variant="secondary" className="flex-1">{item.title}</Text>
                        <Text as="span" size="sm" variant="secondary">&times;{item.qty}</Text>
                        <Text as="span" size="sm">{formatCents(item.unitPriceCents * item.qty)}</Text>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export default function App() {
  return (
    <HostProvider name="crm" version="0.1.0">
      <CrmApp />
    </HostProvider>
  );
}

function CrmApp() {
  const [listData, setListData] = useState<ListData | null>(null);
  const [customerDetail, setCustomerDetail] = useState<CustomerDetailData | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>();
  const [isSeeding, setIsSeeding] = useState(false);
  const hasInitiallyFetched = useRef(false);

  const { callTool, isReady, log, exp_widgetState, onToolResult, hostContext } = useHost();

  // Widget state
  const [widgetState, setWidgetState] = exp_widgetState<WidgetState>();

  // Tool callers
  const [listCustomers, listState] = callTool<ListData>("crm_list");
  const [getCustomer, getState] = callTool<CustomerDetailData>("crm_customer_get");
  const [seedData, seedState] = callTool<{ seeded: { customers: number } }>("crm_seed");
  const [resetData, resetState] = callTool<{ deleted: { customers: number } }>("crm_reset");

  // Restore state from widget state
  useEffect(() => {
    if (widgetState?.privateContent) {
      const { listData: savedList, customerDetail: savedDetail } = widgetState.privateContent;
      if (savedList) setListData(savedList);
      if (savedDetail) setCustomerDetail(savedDetail);
    }
  }, []);

  /**
   * Fetch all customers from the server.
   * Uses the maximum allowed pageSize (100) so DataTable can handle
   * sorting/filtering client-side. Sufficient for demo data (~25 customers).
   */
  const fetchCustomers = useCallback(async () => {
    await listCustomers({
      sortField: "createdAt",
      sortDirection: "desc",
      page: 1,
      pageSize: 100,
    });
  }, [listCustomers]);

  // Initial fetch
  useEffect(() => {
    if (isReady && !hasInitiallyFetched.current) {
      hasInitiallyFetched.current = true;
      fetchCustomers();
    }
  }, [isReady, fetchCustomers]);

  // Handle list data updates
  useEffect(() => {
    if (listState.data) {
      setListData(listState.data);

      setWidgetState({
        modelContent: {
          totalCustomers: listState.data.summary.totalCustomers,
          totalOrders: listState.data.summary.totalOrders,
          selectedCustomerId,
        },
        privateContent: {
          listData: listState.data,
          customerDetail: customerDetail ?? undefined,
          filters: {},
          sort: { field: "createdAt", direction: "desc" },
          page: 1,
        },
      });
    }
  }, [listState.data]);

  // Handle customer detail updates
  useEffect(() => {
    if (getState.data) {
      setCustomerDetail(getState.data);
    }
  }, [getState.data]);

  // Handle seed completion
  useEffect(() => {
    if (seedState.data) {
      setIsSeeding(false);
      fetchCustomers();
    }
    if (seedState.error) {
      setIsSeeding(false);
    }
  }, [seedState.data, seedState.error, fetchCustomers]);

  // Handle reset completion
  useEffect(() => {
    if (resetState.data) {
      setListData(null);
      setCustomerDetail(null);
      setSelectedCustomerId(undefined);
      fetchCustomers();
    }
  }, [resetState.data, fetchCustomers]);

  // Subscribe to agent-initiated tool calls
  useEffect(() => {
    return onToolResult((result) => {
      if (result.source === "agent") {
        const data = result.structuredContent as any;
        if (data?.customers && data?.pagination) {
          setListData(data);
        } else if (data?.customer && data?.orders) {
          setCustomerDetail(data);
          setSelectedCustomerId(data.customer.id);
        } else if (data?.seeded) {
          fetchCustomers();
        } else if (data?.deleted) {
          setListData(null);
          setCustomerDetail(null);
          setSelectedCustomerId(undefined);
          fetchCustomers();
        }
      }
    });
  }, [onToolResult, fetchCustomers]);

  /**
   * Handle customer row click — fetch detail data.
   */
  const handleRowClick = useCallback(
    async ({ original }: { original: Customer; index: number }) => {
      setSelectedCustomerId(original.id);
      await getCustomer({ customerId: original.id });
    },
    [getCustomer]
  );

  /**
   * Seed demo data into the CRM.
   */
  const handleSeed = useCallback(async () => {
    setIsSeeding(true);
    await seedData({});
  }, [seedData]);

  /**
   * Reset all CRM data.
   */
  const handleReset = useCallback(async () => {
    await resetData({ confirm: true });
  }, [resetData]);

  /**
   * Close the detail panel.
   */
  const handleCloseDetail = useCallback(() => {
    setSelectedCustomerId(undefined);
    setCustomerDetail(null);
  }, []);

  const customers = listData?.customers ?? [];
  const hasData = (listData?.summary.totalCustomers ?? 0) > 0;

  /**
   * Empty state shown when there are no customers.
   * Includes a seed button for populating demo data.
   */
  const emptyState = (
    <div className="flex flex-col items-center gap-3 py-8">
      <User size={48} className="text-txt-tertiary opacity-50" />
      <Text variant="secondary">No customers found</Text>
      <Button
        variant="primary"
        size="md"
        onClick={handleSeed}
        disabled={isSeeding}
        loading={isSeeding}
      >
        <Database size={16} />
        {isSeeding ? "Seeding..." : "Seed Demo Data"}
      </Button>
    </div>
  );

  return (
    <AppLayout displayMode={hostContext?.displayMode} noPadding className="h-full">
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header toolbar */}
        <header className="flex items-center justify-between py-3 px-4 border-b border-bdr-secondary shrink-0">
          <div className="flex items-center gap-3">
            <Heading level={2} size="sm">CRM</Heading>
            {listData && (
              <Text size="sm" variant="secondary">
                {listData.summary.totalCustomers} customers &middot; {listData.summary.totalOrders} orders
              </Text>
            )}
          </div>
          {hasData && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="text-txt-secondary hover:text-txt-danger"
            >
              <Trash size={16} />
              Reset
            </Button>
          )}
        </header>

        {/* Main content area */}
        <div className="flex flex-1 overflow-hidden">
          <div className={`flex-1 flex flex-col overflow-hidden min-w-0 transition-opacity ${customerDetail ? "max-w-[60%] opacity-30" : ""}`}>
            <div className="px-4 py-3 flex-1 flex flex-col overflow-hidden">
            <DataTable<Customer>
              columns={customerColumns}
              data={customers}
              sortable
              filterable
              filterPlaceholder="Search customers..."
              pageSize={20}
              onRowClick={handleRowClick}
              loading={listState.status === "loading" && !listData}
              emptyMessage={emptyState}
              stickyHeader
              borderVariant="secondary"
            />
            </div>
          </div>

          {customerDetail && (
            <CustomerDetail data={customerDetail} onClose={handleCloseDetail} />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
