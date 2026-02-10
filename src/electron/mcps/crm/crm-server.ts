#!/usr/bin/env node
/**
 * CRM MCP Server
 *
 * Main entry point for the CRM MCP. Wires together:
 * - App configuration
 * - UI resources
 * - Tools (registered from /tools)
 *
 * The app runs as an Express server at /mcp endpoint.
 */

import { createApp } from "open-mcp-app/server";
import { registerCrmTools } from "./tools/crm.js";
import { MCP_NAME, CRM_UI_URI } from "./lib/types.js";
import { ICON_SVG, ICON_ALT } from "./icon.js";

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
- crm_list { query?, status?, sortField?, sortDirection?, cursor?, page, pageSize }: List customers. Uses cursor pagination for default browsing (createdAt asc) and offset pagination for filtered/sorted views.
- crm_customer_get { customerId }: Get customer details with order history
- crm_customer_create { name, email, company, status? }: Create a new customer
- crm_order_create { customerId, items: [{ sku, title, qty, unitPriceCents }] }: Create an order
- crm_seed: Generate ~25 customers with ~75 orders of demo data
- crm_reset { confirm: true }: Clear all CRM data
- crm_storage_pagination_validate { collection?, limit? }: Validate KV cursor pagination across CRM collections

Use crm_seed first to populate with demo data. The UI shows a sortable customer table with search, filters, and a detail panel for viewing orders.

Response style: The user can see the CRM table UI, so keep responses brief with status updates like "Found 25 customers matching 'tech'" or "Created customer John Smith".`,
});

// =============================================================================
// UI Resources
// =============================================================================

app.resource({
  name: "CRM",
  uri: CRM_UI_URI,
  description: "Interactive CRM with customer tables, search, filters, and order details",
  displayModes: ["pip", "inline"],
  html: "crm/ui/index.html",
  icon: { svg: ICON_SVG, alt: ICON_ALT },
});

// =============================================================================
// Tools
// =============================================================================

registerCrmTools(app);

// =============================================================================
// Server Lifecycle
// =============================================================================

const main = async () => {
  console.log("[CRM] Starting MCP server");
  await app.start();
  console.log("[CRM] MCP server ready on port", PORT);
};

process.on("SIGTERM", () => {
  console.log("[CRM] Received SIGTERM, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[CRM] Received SIGINT, shutting down...");
  process.exit(0);
});

main().catch((error) => {
  console.error("[CRM] Failed to start server", error);
  process.exit(1);
});
