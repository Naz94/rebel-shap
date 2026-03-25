// ============================================================
// REBEL SHAP — Tenant Seeder (pages/api/seed.js)
// ONE-TIME USE: Creates a test tenant in Redis.
// Call: POST /api/seed (with x-admin-secret header)
// Delete this file after seeding.
// ============================================================

import { createTenant, getTenant } from "../../lib/tenants.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorised" });
  }

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

  if (!TEST_TENANT.phone) {
    return res.status(400).json({ error: "phone required — pass in body or set META_TEST_PHONE env var" });
  }
  if (!TEST_TENANT.ownerPhone) {
    return res.status(400).json({ error: "ownerPhone required — pass in body or set META_OWNER_PHONE env var" });
  }

  const existing = await getTenant(TEST_TENANT.phone);
  if (existing) {
    return res.status(200).json({ message: "Tenant already exists — no changes made", tenant: existing });
  }

  const tenant = await createTenant(TEST_TENANT);
  return res.status(200).json({
    success: true,
    message: `Tenant "${tenant.businessName}" created for number ${tenant.phone}`,
    tenant,
  });
}
