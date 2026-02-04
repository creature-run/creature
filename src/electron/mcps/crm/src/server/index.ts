/**
 * CRM MCP App
 *
 * Main app definition. Wires together:
 * - App configuration
 * - UI resources
 * - Tools (registered from /tools)
 *
 * The app runs as an Express server at /mcp endpoint.
 */

import { createApp } from "open-mcp-app/server";
import { registerCrmTools } from "./tools/crm.js";
import { MCP_NAME, CRM_UI_URI } from "./lib/types.js";
import { ICON_SVG, ICON_ALT } from "./lib/icon.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.MCP_PORT || process.env.PORT || "3006", 10);

// =============================================================================
// App Definition
// =============================================================================

const app = createApp({
  name: MCP_NAME,
  version: "0.1.0",
  port: PORT,
  instructions: `CRM data explorer with customers, orders, and line items.

Tools:
- crm_list { query?, status?, sortField?, sortDirection?, page, pageSize }: List customers with filtering and pagination
- crm_customer_get { customerId }: Get customer details with order history
- crm_customer_create { name, email, company, status? }: Create a new customer
- crm_order_create { customerId, items: [{ sku, title, qty, unitPriceCents }] }: Create an order
- crm_seed: Generate ~25 customers with ~75 orders of demo data
- crm_reset { confirm: true }: Clear all CRM data

Use crm_seed first to populate with demo data. The UI shows a sortable customer table with search, filters, and a detail panel for viewing orders.

Response style: The user can see the CRM table UI, so keep responses brief with status updates like "Found 25 customers matching 'tech'" or "Created customer John Smith".`,
});

// =============================================================================
// UI Resources
// =============================================================================

app.resource({
  name: "CRM Explorer",
  uri: CRM_UI_URI,
  description: "Interactive CRM with customer tables, search, filters, and order details",
  displayModes: ["pip", "inline"],
  html: "../../dist/ui/main.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
});

// =============================================================================
// Tools
// =============================================================================

registerCrmTools(app);

// =============================================================================
// Start Server
// =============================================================================

app.start();
