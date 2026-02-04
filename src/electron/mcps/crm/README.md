# CRM Template

A data-intensive MCP App template demonstrating:

- **Data tables** with sortable columns
- **Search and filtering** across records
- **Relational data** (customers, orders, line items)
- **Pagination** for handling ~500+ rows
- **Detail panels** for viewing related records

## Features

### Server
- CRM data model with customers, orders, and line items
- Server-side sorting, filtering, and pagination
- Full-text search using KV storage
- Demo data seeding (~500 rows)

### UI
- Two-pane layout: customers list + detail view
- Interactive data tables with sort indicators
- Search bar with debounced queries
- Status filters
- Pagination controls
- Widget state persistence

## Development

```bash
# Install dependencies
npm install

# Start development server (hot reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Tools

| Tool | Description |
|------|-------------|
| `crm_list` | List customers with sorting, filtering, pagination |
| `crm_customer_get` | Get customer details with their orders |
| `crm_customer_create` | Create a new customer |
| `crm_order_create` | Create an order for a customer |
| `crm_seed` | Generate demo data (~25 customers, ~75 orders) |
| `crm_reset` | Clear all CRM data |

## Data Model

```
Customer
├── id: string
├── name: string
├── email: string
├── company: string
├── status: "active" | "inactive" | "lead"
├── createdAt: string
└── updatedAt: string

Order
├── id: string
├── customerId: string
├── number: string (e.g., "ORD-001")
├── status: "pending" | "processing" | "shipped" | "delivered" | "cancelled"
├── totalCents: number
├── createdAt: string
└── updatedAt: string

LineItem
├── id: string
├── orderId: string
├── sku: string
├── title: string
├── qty: number
└── unitPriceCents: number
```
