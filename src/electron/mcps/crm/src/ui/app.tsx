/**
 * MCP CRM UI
 *
 * A data-intensive CRM explorer demonstrating:
 * - Data tables with sortable columns
 * - Search and filtering
 * - Pagination
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
  MagnifyingGlass,
  CaretUp,
  CaretDown,
  CaretLeft,
  CaretRight,
  Funnel,
  Database,
  Trash,
  User,
  Package,
  X,
} from "@phosphor-icons/react";
// Tailwind 4 integration - imports SDK theme mapping for host-provided variables
import "open-mcp-app/styles/tailwind.css";
import "./styles.css";

// =============================================================================
// Types
// =============================================================================

type CustomerStatus = "active" | "inactive" | "lead";
type OrderStatus = "pending" | "processing" | "shipped" | "delivered" | "cancelled";
type SortDirection = "asc" | "desc";
type CustomerSortField = "name" | "email" | "company" | "status" | "createdAt";

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
  field: CustomerSortField;
  direction: SortDirection;
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

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getStatusColor(status: CustomerStatus | OrderStatus): string {
  const colors: Record<string, string> = {
    active: "var(--color-text-success, #22c55e)",
    inactive: "var(--color-text-secondary)",
    lead: "var(--color-text-warning, #f59e0b)",
    pending: "var(--color-text-warning, #f59e0b)",
    processing: "var(--color-ring-primary)",
    shipped: "var(--color-text-info, #3b82f6)",
    delivered: "var(--color-text-success, #22c55e)",
    cancelled: "var(--color-text-danger, #ef4444)",
  };
  return colors[status] || "var(--color-text-secondary)";
}

// =============================================================================
// Components
// =============================================================================

/**
 * Search input with debouncing.
 */
function SearchInput({
  value,
  onChange,
  placeholder = "Search...",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [localValue, setLocalValue] = useState(value);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = useCallback(
    (newValue: string) => {
      setLocalValue(newValue);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onChange(newValue), 300);
    },
    [onChange]
  );

  return (
    <div className="search-input flex items-center gap-2 bg-bg-secondary border border-bdr-primary rounded-md py-1.5 px-2.5 flex-1 max-w-[280px] focus-within:border-ring-primary">
      <MagnifyingGlass size={16} className="text-txt-secondary shrink-0" />
      <input
        type="text"
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent border-none text-txt-primary text-sm outline-none min-w-0 placeholder:text-txt-secondary"
      />
      {localValue && (
        <button
          className="flex items-center justify-center bg-transparent border-none text-txt-secondary cursor-pointer p-0.5 rounded-sm hover:bg-bg-tertiary hover:text-txt-primary"
          onClick={() => handleChange("")}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * Status filter dropdown.
 */
function StatusFilter({
  value,
  onChange,
}: {
  value?: CustomerStatus;
  onChange: (value?: CustomerStatus) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-txt-secondary">
      <Funnel size={16} />
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value as CustomerStatus || undefined)}
        className="bg-bg-secondary border border-bdr-primary rounded-md text-txt-primary text-sm py-1.5 px-2 cursor-pointer focus:border-ring-primary focus:outline-none"
      >
        <option value="">All Status</option>
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
        <option value="lead">Lead</option>
      </select>
    </div>
  );
}

/**
 * Sortable column header.
 */
function SortableHeader({
  label,
  field,
  currentSort,
  onSort,
}: {
  label: string;
  field: CustomerSortField;
  currentSort: SortConfig;
  onSort: (field: CustomerSortField) => void;
}) {
  const isActive = currentSort.field === field;
  const Icon = isActive && currentSort.direction === "asc" ? CaretUp : CaretDown;

  return (
    <th
      className="text-left py-2.5 px-3 font-medium text-txt-secondary border-b border-bdr-primary whitespace-nowrap cursor-pointer select-none hover:text-txt-primary"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <Icon
          size={12}
          weight={isActive ? "bold" : "regular"}
          className={isActive ? "opacity-100 text-ring-primary" : "opacity-40"}
        />
      </span>
    </th>
  );
}

/**
 * Pagination controls.
 */
function PaginationControls({
  pagination,
  onPageChange,
}: {
  pagination: Pagination;
  onPageChange: (page: number) => void;
}) {
  const { page, totalPages, total } = pagination;

  return (
    <div className="flex items-center justify-between py-2.5 px-4 border-t border-bdr-primary bg-bg-secondary shrink-0">
      <span className="text-txt-secondary text-sm">
        {total} total
      </span>
      <div className="flex items-center gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          title="Previous page"
          className="flex items-center justify-center w-7 h-7 bg-bg-primary border border-bdr-primary rounded-sm text-txt-primary cursor-pointer hover:border-ring-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CaretLeft size={16} />
        </button>
        <span className="text-sm text-txt-secondary min-w-[60px] text-center">
          {page} / {totalPages}
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          title="Next page"
          className="flex items-center justify-center w-7 h-7 bg-bg-primary border border-bdr-primary rounded-sm text-txt-primary cursor-pointer hover:border-ring-primary disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CaretRight size={16} />
        </button>
      </div>
    </div>
  );
}

/**
 * Status badge.
 */
function StatusBadge({ status }: { status: CustomerStatus | OrderStatus }) {
  return (
    <span className="text-xs font-medium capitalize" style={{ color: getStatusColor(status) }}>
      {status}
    </span>
  );
}

/**
 * Customer table.
 */
function CustomerTable({
  customers,
  sort,
  selectedId,
  onSort,
  onSelect,
}: {
  customers: Customer[];
  sort: SortConfig;
  selectedId?: string;
  onSort: (field: CustomerSortField) => void;
  onSelect: (customer: Customer) => void;
}) {
  if (customers.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-txt-secondary p-8 gap-2">
        <User size={48} className="opacity-50" />
        <p className="text-sm">No customers found</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 bg-bg-secondary z-[1]">
          <tr>
            <SortableHeader label="Name" field="name" currentSort={sort} onSort={onSort} />
            <SortableHeader label="Email" field="email" currentSort={sort} onSort={onSort} />
            <SortableHeader label="Company" field="company" currentSort={sort} onSort={onSort} />
            <SortableHeader label="Status" field="status" currentSort={sort} onSort={onSort} />
            <th className="text-left py-2.5 px-3 font-medium text-txt-secondary border-b border-bdr-primary whitespace-nowrap">Orders</th>
            <th className="text-left py-2.5 px-3 font-medium text-txt-secondary border-b border-bdr-primary whitespace-nowrap">Total</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((customer) => (
            <tr
              key={customer.id}
              className={`cursor-pointer transition-colors hover:bg-bg-tertiary ${selectedId === customer.id ? "bg-bg-secondary" : ""}`}
              onClick={() => onSelect(customer)}
            >
              <td className="py-2.5 px-3 border-b border-bdr-secondary max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap font-medium">{customer.name}</td>
              <td className="py-2.5 px-3 border-b border-bdr-secondary max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap text-txt-secondary">{customer.email}</td>
              <td className="py-2.5 px-3 border-b border-bdr-secondary max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap">{customer.company}</td>
              <td className="py-2.5 px-3 border-b border-bdr-secondary"><StatusBadge status={customer.status} /></td>
              <td className="py-2.5 px-3 border-b border-bdr-secondary">{customer.orderCount ?? 0}</td>
              <td className="py-2.5 px-3 border-b border-bdr-secondary">{formatCents(customer.totalSpentCents ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Customer detail panel.
 */
function CustomerDetail({
  data,
  onClose,
}: {
  data: CustomerDetailData;
  onClose: () => void;
}) {
  const { customer, orders, stats } = data;

  return (
    <div className="w-[40%] min-w-[300px] border-l border-bdr-primary bg-bg-secondary overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-bdr-primary">
        <h2 className="text-lg font-medium">{customer.name}</h2>
        <button
          className="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-sm text-txt-secondary cursor-pointer hover:bg-bg-tertiary hover:text-txt-primary"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-4 border-b border-bdr-primary">
        <div className="flex justify-between items-center py-1.5">
          <span className="text-txt-secondary text-sm">Email</span>
          <span className="text-sm">{customer.email}</span>
        </div>
        <div className="flex justify-between items-center py-1.5">
          <span className="text-txt-secondary text-sm">Company</span>
          <span className="text-sm">{customer.company}</span>
        </div>
        <div className="flex justify-between items-center py-1.5">
          <span className="text-txt-secondary text-sm">Status</span>
          <StatusBadge status={customer.status} />
        </div>
        <div className="flex justify-between items-center py-1.5">
          <span className="text-txt-secondary text-sm">Customer Since</span>
          <span className="text-sm">{formatDate(customer.createdAt)}</span>
        </div>
      </div>

      <div className="flex gap-4 p-4 border-b border-bdr-primary">
        <div className="flex-1 text-center">
          <span className="block text-lg font-medium mb-1">{stats.orderCount}</span>
          <span className="text-xs text-txt-secondary">Orders</span>
        </div>
        <div className="flex-1 text-center">
          <span className="block text-lg font-medium mb-1">{stats.totalSpent}</span>
          <span className="text-xs text-txt-secondary">Total Spent</span>
        </div>
      </div>

      <h3 className="py-4 px-4 pb-3 text-base font-medium text-txt-secondary">Order History</h3>
      {orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-txt-secondary p-4 gap-2">
          <Package size={32} className="opacity-50" />
          <p className="text-sm">No orders yet</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {orders.map((order) => (
            <div key={order.id} className="bg-bg-primary border border-bdr-primary rounded-md p-3 mb-2">
              <div className="flex justify-between items-center mb-2">
                <span className="font-medium text-sm">{order.number}</span>
                <StatusBadge status={order.status} />
              </div>
              <div className="flex justify-between text-xs text-txt-secondary">
                <span>{formatDate(order.createdAt)}</span>
                <span className="font-medium text-txt-primary">{formatCents(order.totalCents)}</span>
              </div>
              {order.items && order.items.length > 0 && (
                <div className="mt-2 pt-2 border-t border-bdr-secondary">
                  {order.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 text-xs py-1">
                      <span className="flex-1 text-txt-secondary">{item.title}</span>
                      <span className="text-txt-secondary">×{item.qty}</span>
                      <span className="text-txt-primary">{formatCents(item.unitPriceCents * item.qty)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Top toolbar with search, filters, and actions.
 */
function Toolbar({
  filters,
  onFilterChange,
  onSeed,
  onReset,
  isSeeding,
  hasData,
}: {
  filters: Filters;
  onFilterChange: (filters: Filters) => void;
  onSeed: () => void;
  onReset: () => void;
  isSeeding: boolean;
  hasData: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 px-4 border-b border-bdr-primary shrink-0">
      <div className="flex items-center gap-2 flex-1">
        <SearchInput
          value={filters.query || ""}
          onChange={(query) => onFilterChange({ ...filters, query: query || undefined })}
          placeholder="Search customers..."
        />
        <StatusFilter
          value={filters.status}
          onChange={(status) => onFilterChange({ ...filters, status })}
        />
      </div>
      <div className="flex items-center gap-2">
        {!hasData && (
          <button
            className="flex items-center gap-1.5 py-1.5 px-3 rounded-md text-sm font-medium cursor-pointer transition-opacity bg-bg-inverse border-none text-txt-inverse hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={onSeed}
            disabled={isSeeding}
          >
            <Database size={16} />
            {isSeeding ? "Seeding..." : "Seed Demo Data"}
          </button>
        )}
        {hasData && (
          <button
            className="flex items-center gap-1.5 py-1.5 px-3 rounded-md text-sm font-medium cursor-pointer transition-opacity bg-transparent border border-bdr-primary text-txt-secondary hover:border-bdr-danger hover:text-txt-danger"
            onClick={onReset}
          >
            <Trash size={16} />
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

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
  const [filters, setFilters] = useState<Filters>({});
  const [sort, setSort] = useState<SortConfig>({ field: "createdAt", direction: "desc" });
  const [page, setPage] = useState(1);
  const [isSeeding, setIsSeeding] = useState(false);
  const hasInitiallyFetched = useRef(false);

  const { callTool, isReady, log, exp_widgetState, onToolResult } = useHost();

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
      const { listData: savedList, customerDetail: savedDetail, filters: savedFilters, sort: savedSort, page: savedPage } = widgetState.privateContent;
      if (savedList) setListData(savedList);
      if (savedDetail) setCustomerDetail(savedDetail);
      if (savedFilters) setFilters(savedFilters);
      if (savedSort) setSort(savedSort);
      if (savedPage) setPage(savedPage);
    }
  }, []);

  // Fetch customers when ready or when filters/sort/page change
  const fetchCustomers = useCallback(async () => {
    await listCustomers({
      query: filters.query,
      status: filters.status,
      sortField: sort.field,
      sortDirection: sort.direction,
      page,
      pageSize: 20,
    });
  }, [listCustomers, filters, sort, page]);

  // Initial fetch
  useEffect(() => {
    if (isReady && !hasInitiallyFetched.current) {
      hasInitiallyFetched.current = true;
      fetchCustomers();
    }
  }, [isReady, fetchCustomers]);

  // Refetch when filters/sort/page change
  useEffect(() => {
    if (hasInitiallyFetched.current) {
      fetchCustomers();
    }
  }, [filters, sort, page]);

  // Handle list data updates
  useEffect(() => {
    if (listState.data) {
      setListData(listState.data);

      // Save to widget state
      setWidgetState({
        modelContent: {
          totalCustomers: listState.data.summary.totalCustomers,
          totalOrders: listState.data.summary.totalOrders,
          selectedCustomerId,
        },
        privateContent: {
          listData: listState.data,
          customerDetail: customerDetail ?? undefined,
          filters,
          sort,
          page,
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
  }, [seedState.data, seedState.error]);

  // Handle reset completion
  useEffect(() => {
    if (resetState.data) {
      setListData(null);
      setCustomerDetail(null);
      setSelectedCustomerId(undefined);
      fetchCustomers();
    }
  }, [resetState.data]);

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

  // Handle customer selection
  const handleSelectCustomer = useCallback(
    async (customer: Customer) => {
      setSelectedCustomerId(customer.id);
      await getCustomer({ customerId: customer.id });
    },
    [getCustomer]
  );

  // Handle sort
  const handleSort = useCallback((field: CustomerSortField) => {
    setSort((prev) => ({
      field,
      direction: prev.field === field && prev.direction === "asc" ? "desc" : "asc",
    }));
    setPage(1);
  }, []);

  // Handle filter change
  const handleFilterChange = useCallback((newFilters: Filters) => {
    setFilters(newFilters);
    setPage(1);
  }, []);

  // Handle seed
  const handleSeed = useCallback(async () => {
    setIsSeeding(true);
    await seedData({});
  }, [seedData]);

  // Handle reset
  const handleReset = useCallback(async () => {
    if (window.confirm("Are you sure you want to delete all CRM data?")) {
      await resetData({ confirm: true });
    }
  }, [resetData]);

  // Handle close detail
  const handleCloseDetail = useCallback(() => {
    setSelectedCustomerId(undefined);
    setCustomerDetail(null);
  }, []);

  const hasData = (listData?.summary.totalCustomers ?? 0) > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary text-txt-primary">
      <header className="flex items-center justify-between py-3 px-4 border-b border-bdr-primary shrink-0">
        <h1 className="text-lg font-medium">CRM Explorer</h1>
        {listData && (
          <span className="text-txt-secondary text-sm">
            {listData.summary.totalCustomers} customers · {listData.summary.totalOrders} orders
          </span>
        )}
      </header>

      <Toolbar
        filters={filters}
        onFilterChange={handleFilterChange}
        onSeed={handleSeed}
        onReset={handleReset}
        isSeeding={isSeeding}
        hasData={hasData}
      />

      <div className="flex flex-1 overflow-hidden">
        <div className={`flex-1 flex flex-col overflow-hidden min-w-0 ${customerDetail ? "max-w-[60%]" : ""}`}>
          {listState.status === "loading" && !listData ? (
            <div className="flex-1 flex items-center justify-center text-txt-secondary">Loading...</div>
          ) : listData ? (
            <>
              <CustomerTable
                customers={listData.customers}
                sort={sort}
                selectedId={selectedCustomerId}
                onSort={handleSort}
                onSelect={handleSelectCustomer}
              />
              <PaginationControls
                pagination={listData.pagination}
                onPageChange={setPage}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-txt-secondary p-8 gap-2">
              <Database size={48} className="opacity-50" />
              <p className="text-sm">No data yet</p>
              <p className="text-xs opacity-70">Click "Seed Demo Data" to get started</p>
            </div>
          )}
        </div>

        {customerDetail && (
          <CustomerDetail data={customerDetail} onClose={handleCloseDetail} />
        )}
      </div>
    </div>
  );
}
