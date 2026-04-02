// ============================================================
// REBEL SHAP — Catalogue Upload (pages/api/catalogue.js)
//
// Allows each tenant (or you on their behalf) to upload
// their price list as a CSV.
//
// POST /api/catalogue
//   Header: x-admin-secret: <ADMIN_SECRET>
//   Body (JSON):
//     { "tenantPhone": "27821234567", "csv": "<raw csv text>" }
//
// GET /api/catalogue?tenantPhone=27821234567
//   Header: x-admin-secret: <ADMIN_SECRET>
//   Returns current catalogue for that tenant
//
// GET /api/catalogue?template=1
//   Returns a blank CSV template for tenants to fill in
// ============================================================

import { parseCatalogueCSV, saveCatalogue, getCatalogue, generateCSVTemplate } from "../../lib/priceCatalogue.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-secret");

  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Template download — no auth needed ───────────────────
  if (req.method === "GET" && req.query.template) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=rebel-shap-price-template.csv");
    return res.status(200).send(generateCSVTemplate());
  }

  // ── Auth ─────────────────────────────────────────────────
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  // ── GET — fetch current catalogue ────────────────────────
  if (req.method === "GET") {
    const { tenantPhone } = req.query;
    if (!tenantPhone) return res.status(400).json({ error: "tenantPhone required" });

    const catalogue = await getCatalogue(tenantPhone);
    if (!catalogue) {
      return res.status(404).json({ error: "No catalogue found for this tenant. Upload a CSV first." });
    }
    return res.status(200).json(catalogue);
  }

  // ── POST — upload new CSV ─────────────────────────────────
  if (req.method === "POST") {
    const { tenantPhone, csv } = req.body ?? {};

    if (!tenantPhone) return res.status(400).json({ error: "tenantPhone is required" });
    if (!csv)         return res.status(400).json({ error: "csv is required — paste the raw CSV text" });

    try {
      const services  = parseCatalogueCSV(csv);
      const catalogue = await saveCatalogue(tenantPhone, services);

      return res.status(200).json({
        success:  true,
        message:  `Catalogue saved — ${services.length} services loaded for ${tenantPhone}`,
        services: catalogue.services,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
