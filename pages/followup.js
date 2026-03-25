// ============================================================
// REBEL SHAP — Quote Follow-up Cron (pages/api/followup.js)
//
// Called every 6 hours by GitHub Actions.
// Scans all open conversations in the `quoted` stage.
//
// Rules:
//   48h no response → send one follow-up message
//   72h no response → mark expired, notify tenant owner
//
// Auth: x-admin-secret header must match ADMIN_SECRET env var.
// ============================================================

import { getOpenConversations, advanceStage } from "../../lib/conversations.js";
import { sendWhatsAppMessage }                 from "../../lib/whatsapp.js";
import { getTenant }                           from "../../lib/tenants.js";

export const maxDuration = 30;

const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const EXPIRE_WINDOW_MS    = 72 * 60 * 60 * 1000; // 72 hours

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  // ── Auth ──────────────────────────────────────────────────
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  try {
    const now   = Date.now();
    const convs = await getOpenConversations();

    // Only care about conversations waiting on a quote response
    const quoted = convs.filter(c => c.stage === "quoted");

    let followed  = 0;
    let expired   = 0;
    let skipped   = 0;

    for (const conv of quoted) {
      const lastActivity = new Date(conv.lastMessageAt).getTime();
      const silentMs     = now - lastActivity;

      // Need the tenant for tokens + business name on every branch
      const tenant = await getTenant(conv.tenantPhone).catch(() => null);
      if (!tenant) {
        console.warn(`[followup] No tenant found for ${conv.tenantPhone} — skipping`);
        skipped++;
        continue;
      }

      // ── 72h+ → expire ──────────────────────────────────
      if (silentMs >= EXPIRE_WINDOW_MS) {
        await advanceStage(conv.tenantPhone, conv.customerPhone, "expired");

        // Notify tenant owner that this lead went cold
        if (tenant.ownerPhone) {
          const customerLabel = conv.customerName ?? conv.customerPhone;
          await sendWhatsAppMessage(
            conv.tenantPhone,
            tenant.ownerPhone,
            `Lead expired: ${customerLabel} did not respond to the quote within 72 hours. Conversation closed.`,
            tenant
          ).catch(err => console.error("[followup] Owner notify failed:", err.message));
        }

        console.log(`[followup] Expired: ${conv.tenantPhone} ↔ ${conv.customerPhone}`);
        expired++;
        continue;
      }

      // ── 48h–72h → follow up once ───────────────────────
      if (silentMs >= FOLLOW_UP_WINDOW_MS) {
        // Only send the follow-up once — flag prevents repeat on next cron run
        if (conv.followUpSent) {
          skipped++;
          continue;
        }

        const greeting = conv.customerName ? ` ${conv.customerName}` : "";

        await sendWhatsAppMessage(
          conv.tenantPhone,
          conv.customerPhone,
          `Hi${greeting} 👋 Just checking in — did you get a chance to look at the quote we sent? Reply *yes* to confirm or *no* if you'd like to adjust anything. Happy to help.`,
          tenant
        );

        // Mark follow-up sent — next cron run will skip to expire check
        await advanceStage(conv.tenantPhone, conv.customerPhone, "quoted", {
          followUpSent:   true,
          followUpSentAt: new Date().toISOString(),
        });

        console.log(`[followup] Follow-up sent: ${conv.tenantPhone} ↔ ${conv.customerPhone}`);
        followed++;
        continue;
      }

      // ── Under 48h → nothing to do yet ──────────────────
      skipped++;
    }

    return res.status(200).json({
      success:  true,
      scanned:  quoted.length,
      followed,
      expired,
      skipped,
    });

  } catch (err) {
    console.error("[followup] Fatal:", err);
    return res.status(500).json({ error: err.message });
  }
}
