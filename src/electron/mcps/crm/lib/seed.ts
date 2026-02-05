/**
 * Seed Data Generator
 *
 * Generates realistic demo data for the CRM template.
 * Creates ~50 customers with ~500 total orders and line items.
 */

import type { Customer, Order, LineItem, CustomerStatus, OrderStatus } from "./types.js";
import {
  generateCustomerId,
  generateOrderId,
  generateLineItemId,
  generateOrderNumber,
  type CrmStores,
} from "./utils.js";

// =============================================================================
// Sample Data
// =============================================================================

const FIRST_NAMES = [
  "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda",
  "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
  "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Nancy", "Daniel", "Lisa",
  "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley",
  "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Joshua", "Michelle",
  "Kenneth", "Dorothy", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa",
  "Timothy", "Deborah",
];

const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson",
  "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson",
  "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker",
  "Young", "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
  "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
  "Carter", "Roberts",
];

const COMPANIES = [
  "Acme Corp", "TechFlow Inc", "Quantum Systems", "DataPrime", "CloudNine Solutions",
  "Stellar Dynamics", "Apex Industries", "Nova Enterprises", "Vertex Labs", "Pulse Digital",
  "Fusion Media", "Summit Group", "Nexus Technologies", "Infinity Software", "Pinnacle Solutions",
  "Horizon Partners", "Atlas Holdings", "Core Analytics", "Prime Ventures", "Echo Networks",
  "Metro Systems", "Global Innovations", "Swift Solutions", "Delta Force Tech", "Omega Labs",
  "Alpha Dynamics", "Beta Systems", "Gamma Industries", "Sigma Corp", "Theta Solutions",
];

const PRODUCTS = [
  { sku: "WIDGET-001", title: "Basic Widget", priceRange: [999, 2999] },
  { sku: "WIDGET-002", title: "Premium Widget", priceRange: [4999, 9999] },
  { sku: "GADGET-001", title: "Smart Gadget", priceRange: [14999, 29999] },
  { sku: "GADGET-002", title: "Pro Gadget", priceRange: [39999, 59999] },
  { sku: "SERVICE-001", title: "Basic Support", priceRange: [9999, 19999] },
  { sku: "SERVICE-002", title: "Premium Support", priceRange: [29999, 49999] },
  { sku: "LICENSE-001", title: "Standard License", priceRange: [19999, 39999] },
  { sku: "LICENSE-002", title: "Enterprise License", priceRange: [99999, 199999] },
  { sku: "ADDON-001", title: "Feature Pack A", priceRange: [4999, 9999] },
  { sku: "ADDON-002", title: "Feature Pack B", priceRange: [7999, 14999] },
];

const CUSTOMER_STATUSES: CustomerStatus[] = ["active", "inactive", "lead"];
const ORDER_STATUSES: OrderStatus[] = ["pending", "processing", "shipped", "delivered", "cancelled"];

// =============================================================================
// Random Helpers
// =============================================================================

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysAgo: number): string {
  const now = Date.now();
  const offset = Math.random() * daysAgo * 24 * 60 * 60 * 1000;
  return new Date(now - offset).toISOString();
}

function weightedRandom<T>(options: { value: T; weight: number }[]): T {
  const total = options.reduce((sum, opt) => sum + opt.weight, 0);
  let rand = Math.random() * total;
  for (const opt of options) {
    rand -= opt.weight;
    if (rand <= 0) return opt.value;
  }
  return options[options.length - 1].value;
}

// =============================================================================
// Generators
// =============================================================================

function generateCustomer(): Customer {
  const firstName = randomItem(FIRST_NAMES);
  const lastName = randomItem(LAST_NAMES);
  const createdAt = randomDate(365); // Up to 1 year ago

  return {
    id: generateCustomerId(),
    name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${randomItem(["gmail.com", "yahoo.com", "outlook.com", "company.com"])}`,
    company: randomItem(COMPANIES),
    status: weightedRandom([
      { value: "active" as const, weight: 60 },
      { value: "inactive" as const, weight: 20 },
      { value: "lead" as const, weight: 20 },
    ]),
    createdAt,
    updatedAt: createdAt,
  };
}

function generateOrder(customerId: string, orderIndex: number): { order: Order; items: LineItem[] } {
  const orderId = generateOrderId();
  const createdAt = randomDate(180); // Up to 6 months ago
  
  // Generate 1-5 line items per order
  const numItems = randomInt(1, 5);
  const items: LineItem[] = [];
  let totalCents = 0;

  for (let i = 0; i < numItems; i++) {
    const product = randomItem(PRODUCTS);
    const qty = randomInt(1, 3);
    const unitPriceCents = randomInt(product.priceRange[0], product.priceRange[1]);
    const itemTotal = qty * unitPriceCents;
    totalCents += itemTotal;

    items.push({
      id: generateLineItemId(),
      orderId,
      sku: product.sku,
      title: product.title,
      qty,
      unitPriceCents,
    });
  }

  const order: Order = {
    id: orderId,
    customerId,
    number: generateOrderNumber(orderIndex),
    status: weightedRandom([
      { value: "delivered" as const, weight: 40 },
      { value: "shipped" as const, weight: 20 },
      { value: "processing" as const, weight: 15 },
      { value: "pending" as const, weight: 15 },
      { value: "cancelled" as const, weight: 10 },
    ]),
    totalCents,
    createdAt,
    updatedAt: createdAt,
  };

  return { order, items };
}

// =============================================================================
// Main Seed Function
// =============================================================================

export interface SeedResult {
  customers: number;
  orders: number;
  lineItems: number;
}

/**
 * Generate and store demo data.
 * Creates ~25 customers with ~75 total orders to keep storage operations manageable.
 */
export async function seedDemoData(stores: CrmStores): Promise<SeedResult> {
  const numCustomers = 25;
  let totalOrders = 0;
  let totalLineItems = 0;
  let orderIndex = 1;

  for (let i = 0; i < numCustomers; i++) {
    const customer = generateCustomer();
    
    // Generate 2-5 orders per customer (avg ~3)
    const numOrders = randomInt(2, 5);
    let customerTotalSpent = 0;
    
    for (let j = 0; j < numOrders; j++) {
      const { order, items } = generateOrder(customer.id, orderIndex++);
      await stores.orders.set(order.id, order);
      customerTotalSpent += order.totalCents;
      
      // Store line items (limit to 2 per order to reduce storage calls)
      const limitedItems = items.slice(0, 2);
      for (const item of limitedItems) {
        await stores.lineItems.set(item.id, item);
      }

      totalOrders++;
      totalLineItems += limitedItems.length;
    }
    
    // Store customer with pre-computed stats to avoid loading all orders later
    const customerWithStats = {
      ...customer,
      orderCount: numOrders,
      totalSpentCents: customerTotalSpent,
    };
    await stores.customers.set(customer.id, customerWithStats);
  }

  return {
    customers: numCustomers,
    orders: totalOrders,
    lineItems: totalLineItems,
  };
}

/**
 * Clear all CRM data.
 */
export async function clearAllData(stores: CrmStores): Promise<void> {
  await stores.customers.clear();
  await stores.orders.clear();
  await stores.lineItems.clear();
}
