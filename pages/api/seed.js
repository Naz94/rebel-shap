// ============================================================
// REBEL SHAP — Tenant Seeder (pages/api/seed.js)
//
// ONE-TIME USE: Creates a test tenant in Redis so you can
// test the full webhook flow end to end.
//
// Call: POST /api/seed (with x-admin-secret header)
//
// Delete or disable this file after seeding.
// ============================================================

import { createTenant, getTenant } from "../../lib/tenants.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  // ── Auth ──────────────────────────────────────────────────
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  // ── Config — update these before running ─────────────────
  // tenantPhone:  the Meta test number assigned to your app
  //               Find it at: WhatsApp → API Setup → Phone Number
  //               Format: digits only, no + (e.g. "27821234567")
  // ownerPhone:   your personal WhatsApp number — where owner
  //               notifications will be sent during testing
  //               Format: digits only, no + (e.g. "27829876543")

  const TEST_TENANT = {
    phone:        process.env.META_TEST_PHONE ?? req.body?.phone,
    businessName: "Rebel Shap Test Business",
    ownerPhone:   process.env.META_OWNER_PHONE ?? req.body?.ownerPhone,
    ownerName:    "Naz",
    currency:     "ZAR",
    validityDays: 7,
    greeting:     "Hi! Thanks for reaching out. I'm here to help you get a quick quote. What service do you need today?",
    services: [
      { name: "Plumbing — General",      basePrice: 650  },
      { name: "Geyser Repair",           basePrice: 1200 },
      { name: "Geyser Replacement",      basePrice: 3500 },
      { name: "Drain Unblocking",        basePrice: 450  },
      { name: "Leak Detection & Repair", basePrice: 850  },
    ],
  };

  // ── Validate ──────────────────────────────────────────────
  if (!TEST_TENANT.phone) {
    return res.status(400).json({
      error: "tenantPhone is required. Set META_TEST_PHONE in env vars or pass { phone } in request body.",
    });
  }
  if (!TEST_TENANT.ownerPhone) {
    return res.status(400).json({
      error: "ownerPhone is required. Set META_OWNER_PHONE in env vars or pass { ownerPhone } in request body.",
    });
  }

  // ── Check if already exists ───────────────────────────────
  const existing = await getTenant(TEST_TENANT.phone);
  if (existing) {
    return res.status(200).json({
      message:  "Tenant already exists — no changes made",
      tenant:   existing,
    });
  }

  // ── Create ────────────────────────────────────────────────
  const tenant = await createTenant(TEST_TENANT);

  return res.status(200).json({
    success: true,
    message: `Tenant "${tenant.businessName}" created for number ${tenant.phone}`,
    tenant,
  });
}
