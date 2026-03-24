// ============================================================
// REBEL SHAP — Tenant Layer (lib/tenants.js)
//
// A tenant is a business on the Rebel Shap platform.
// Each tenant has their own WhatsApp number, business profile,
// service types, and pricing.
//
// Keys:
//   rebelshap:tenant:{phoneNumber}  — tenant config
//   rebelshap:tenants               — list of all tenant phone numbers
// ============================================================

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TENANT_KEY  = (phone) => `rebelshap:tenant:${phone}`;
const TENANTS_KEY = "rebelshap:tenants";

// ─────────────────────────────────────────────────────────────
// CREATE TENANT
// Called manually when you onboard a new client.
// phone: the WhatsApp Business number assigned to this client
//        e.g. "27821234567" (no + prefix, no spaces)
// ─────────────────────────────────────────────────────────────

export async function createTenant({
  phone,          // "27821234567" — their WhatsApp Business number
  businessName,   // "Sipho's Plumbing"
  ownerPhone,     // "27829876543" — where to notify the owner
  ownerName,      // "Sipho"
  services,       // [{ name: "Geyser repair", basePrice: 850 }, ...]
  currency,       // "ZAR"
  greeting,       // Custom first message — optional
  validityDays,   // How many days a quote is valid — default 7
}) {
  const tenant = {
    phone,
    businessName,
    ownerPhone,
    ownerName,
    services:     services     ?? [],
    currency:     currency     ?? "ZAR",
    greeting:     greeting     ?? `Hi! Thanks for reaching out to ${businessName}. Let me help you get a quote sorted quickly.`,
    validityDays: validityDays ?? 7,
    active:       true,
    createdAt:    new Date().toISOString(),
  };

  await redis.set(TENANT_KEY(phone), JSON.stringify(tenant));
  await redis.sadd(TENANTS_KEY, phone);

  console.log(`[tenants] Created tenant: ${businessName} (${phone})`);
  return tenant;
}

// ─────────────────────────────────────────────────────────────
// GET TENANT
// Called on every incoming WhatsApp message to identify
// which business the message was sent to.
// ─────────────────────────────────────────────────────────────

export async function getTenant(phone) {
  const raw = await redis.get(TENANT_KEY(phone));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// UPDATE TENANT
// ─────────────────────────────────────────────────────────────

export async function updateTenant(phone, updates) {
  const existing = await getTenant(phone);
  if (!existing) return null;
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await redis.set(TENANT_KEY(phone), JSON.stringify(updated));
  return updated;
}

// ─────────────────────────────────────────────────────────────
// LIST ALL TENANTS
// ─────────────────────────────────────────────────────────────

export async function getAllTenants() {
  const phones  = await redis.smembers(TENANTS_KEY);
  if (!phones || phones.length === 0) return [];
  const tenants = await Promise.all(phones.map(p => getTenant(p)));
  return tenants.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// DEACTIVATE TENANT
// Soft delete — keeps data, stops processing messages.
// ─────────────────────────────────────────────────────────────

export async function deactivateTenant(phone) {
  return updateTenant(phone, { active: false, deactivatedAt: new Date().toISOString() });
}
