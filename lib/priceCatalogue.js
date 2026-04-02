// ============================================================
// REBEL SHAP — Price Catalogue (lib/priceCatalogue.js)
//
// Each tenant uploads a CSV with their own services and prices.
// This module handles parsing, storing, and retrieving it.
//
// CSV format (tenants fill this in themselves):
//   service_name,description,flat_rate,min_price,max_price,unit,notes
//
// Examples:
//   Geyser Repair,Replace element/thermostat,,,800,2500,per job,Excludes parts if needed
//   Drain Unblocking,Clear blocked drain,450,,,per job,
//   Electrical Certificate,COC for single phase,1200,,,per certificate,
//
// Rules:
//   - flat_rate: use when the price is fixed (leave min/max empty)
//   - min_price + max_price: use when price depends on complexity
//   - Either flat_rate OR min+max must be filled — not both
//
// Redis key:
//   rebelshap:catalogue:{tenantPhone}
// ============================================================

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CATALOGUE_KEY = (phone) => `rebelshap:catalogue:${phone}`;

// ─────────────────────────────────────────────────────────────
// PARSE CSV
// Accepts the raw CSV string uploaded by the tenant.
// Returns an array of cleaned service objects.
// Skips blank rows and the header row.
// ─────────────────────────────────────────────────────────────

export function parseCatalogueCSV(csvText) {
  const lines = csvText
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one service row.");
  }

  // Normalise header — lowercase, strip spaces
  const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/\s+/g, "_"));

  const required = ["service_name"];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(`CSV is missing required column: "${col}". Headers found: ${header.join(", ")}`);
    }
  }

  const services = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 2) continue; // skip nearly empty rows

    const row = {};
    header.forEach((h, idx) => {
      row[h] = cols[idx]?.trim() ?? "";
    });

    const serviceName = row["service_name"];
    if (!serviceName) continue;

    const flatRate = parseNum(row["flat_rate"]);
    const minPrice = parseNum(row["min_price"]);
    const maxPrice = parseNum(row["max_price"]);

    // Validation: must have at least a flat rate OR a min price
    if (flatRate === null && minPrice === null) {
      console.warn(`[catalogue] Row ${i}: "${serviceName}" has no pricing — skipped`);
      continue;
    }

    // If only min provided with no max, treat as flat rate
    const resolvedFlat = flatRate ?? (minPrice !== null && maxPrice === null ? minPrice : null);
    const resolvedMin  = flatRate !== null ? null : minPrice;
    const resolvedMax  = flatRate !== null ? null : maxPrice;

    services.push({
      name:        serviceName,
      description: row["description"] ?? "",
      flatRate:    resolvedFlat,
      minPrice:    resolvedMin,
      maxPrice:    resolvedMax,
      unit:        row["unit"] ?? "per job",
      notes:       row["notes"] ?? "",
    });
  }

  if (services.length === 0) {
    throw new Error("No valid services found in CSV. Check your pricing columns.");
  }

  return services;
}

// ─────────────────────────────────────────────────────────────
// SAVE CATALOGUE
// Stores parsed services in Redis for this tenant.
// Overwrites any previous catalogue.
// ─────────────────────────────────────────────────────────────

export async function saveCatalogue(tenantPhone, services) {
  const catalogue = {
    tenantPhone,
    services,
    updatedAt: new Date().toISOString(),
    count:     services.length,
  };
  await redis.set(CATALOGUE_KEY(tenantPhone), JSON.stringify(catalogue));
  console.log(`[catalogue] Saved ${services.length} services for ${tenantPhone}`);
  return catalogue;
}

// ─────────────────────────────────────────────────────────────
// GET CATALOGUE
// Returns the tenant's current catalogue, or null if none uploaded.
// ─────────────────────────────────────────────────────────────

export async function getCatalogue(tenantPhone) {
  const raw = await redis.get(CATALOGUE_KEY(tenantPhone));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// MATCH SERVICE
// Given a service name from GPT, find the best matching
// service(s) in the catalogue.
// Returns array of matched services (can be multiple if customer
// asked for more than one thing).
// ─────────────────────────────────────────────────────────────

export function matchServices(requestedNames, catalogue) {
  if (!catalogue?.services?.length) return [];
  if (!requestedNames?.length) return [];

  const results = [];

  for (const requested of requestedNames) {
    const lower = requested.toLowerCase().trim();

    // 1. Exact match
    let match = catalogue.services.find(
      s => s.name.toLowerCase() === lower
    );

    // 2. Contains match (e.g. "geyser repair" matches "Geyser Repair Service")
    if (!match) {
      match = catalogue.services.find(
        s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase())
      );
    }

    // 3. Keyword overlap (at least 2 words in common)
    if (!match) {
      const words = lower.split(/\s+/).filter(w => w.length > 3);
      match = catalogue.services.find(s => {
        const sWords = s.name.toLowerCase().split(/\s+/);
        return words.filter(w => sWords.some(sw => sw.includes(w))).length >= 1;
      });
    }

    if (match) results.push(match);
  }

  // Deduplicate
  return results.filter((s, i, arr) => arr.findIndex(x => x.name === s.name) === i);
}

// ─────────────────────────────────────────────────────────────
// FORMAT PRICE FOR GPT SYSTEM PROMPT
// Human-readable list the AI can use when chatting
// ─────────────────────────────────────────────────────────────

export function formatCatalogueForPrompt(catalogue, currency = "ZAR") {
  if (!catalogue?.services?.length) return "No services configured yet.";

  return catalogue.services
    .map(s => {
      let priceStr;
      if (s.flatRate !== null) {
        priceStr = `${currency} ${s.flatRate.toLocaleString("en-ZA")} (fixed)`;
      } else if (s.minPrice !== null && s.maxPrice !== null) {
        priceStr = `${currency} ${s.minPrice.toLocaleString("en-ZA")} – ${s.maxPrice.toLocaleString("en-ZA")} (range)`;
      } else if (s.minPrice !== null) {
        priceStr = `from ${currency} ${s.minPrice.toLocaleString("en-ZA")}`;
      } else {
        priceStr = "Price on request";
      }

      const desc = s.description ? ` — ${s.description}` : "";
      const notes = s.notes ? ` [${s.notes}]` : "";
      return `• ${s.name}${desc}: ${priceStr}${notes}`;
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────
// GENERATE BLANK CSV TEMPLATE
// Returned to tenants so they know the exact format to fill in.
// ─────────────────────────────────────────────────────────────

export function generateCSVTemplate() {
  const header = "service_name,description,flat_rate,min_price,max_price,unit,notes";
  const examples = [
    "Geyser Repair,Replace element or thermostat,,800,2500,per job,Price depends on parts needed",
    "Geyser Replacement,Supply and install new geyser,,3500,6000,per job,Excludes disposal of old unit",
    "Drain Unblocking,Clear blocked drain or pipe,450,,,per job,",
    "Leak Detection & Repair,Find and fix water leak,,650,1800,per job,",
    "Plumbing Inspection,Full property inspection,850,,,per inspection,Includes written report",
  ];
  return [header, ...examples].join("\n");
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function parseNum(val) {
  if (!val || val.trim() === "") return null;
  const n = parseFloat(val.replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n;
}

// Handles quoted CSV fields that may contain commas
function splitCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
