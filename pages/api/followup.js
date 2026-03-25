// ============================================================
// REBEL SHAP — Quote Follow-up Cron (pages/api/followup.js)
// Called every 6 hours by GitHub Actions.
// 48h no response → send follow-up
// 72h no response → mark expired, notify owner
// ============================================================

import { getOpenConversations, advanceStage } from "../../lib/conversations.js";
import { sendWhatsAppMessage }                 from "../../lib/whatsapp.js";
import { getTenant }                           from "../../lib/tenants.js";

export const maxDuration = 30;

const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
const EXPIRE_WINDOW_MS    = 72 * 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorised" });
  }

  try {
    const now    = Date.now();
    const convs  = await getOpenConversations();
    const quoted = convs.filter(c => c.stage === "quoted");

    let followed = 0;
    let expired  = 0;
    let skipped  = 0;

    for (const conv of quoted) {
      const silentMs = now - new Date(conv.lastMessageAt).getTime();

      const tenant = await getTenant(conv.tenantPhone).catch(() => null);
      if (!tenant) {
        console.warn(`[followup] No tenant found for ${conv.tenantPhone} — skipping`);
        skipped++;
        continue;
      }

      if (silentMs >= EXPIRE_WINDOW_MS) {
        await advanceStage(conv.tenantPhone, conv.customerPhone, "expired");
        if (tenant.ownerPhone) {
          const label = conv.customerName ?? conv.customerPhone;
          await sendWhatsAppMessage(
            conv.tenantPhone,
            tenant.ownerPhone,
            `Lead expired: ${label} did not respond to the quote within 72 hours. Conversation closed.`,
            tenant
          ).catch(err => console.error("[followup] Owner notify failed:", err.message));
        }
        console.log(`[followup] Expired: ${conv.tenantPhone} ↔ ${conv.customerPhone}`);
        expired++;
        continue;
      }

      if (silentMs >= FOLLOW_UP_WINDOW_MS) {
        if (conv.followUpSent) { skipped++; continue; }

        const greeting = conv.customerName ? ` ${conv.customerName}` : "";
        await sendWhatsAppMessage(
          conv.tenantPhone,
          conv.customerPhone,
          `Hi${greeting} 👋 Just checking in — did you get a chance to look at the quote we sent? Reply *yes* to confirm or *no* if you'd like to adjust anything. Happy to help.`,
          tenant
        );

        await advanceStage(conv.tenantPhone, conv.customerPhone, "quoted", {
          followUpSent:   true,
          followUpSentAt: new Date().toISOString(),
        });

        console.log(`[followup] Follow-up sent: ${conv.tenantPhone} ↔ ${conv.customerPhone}`);
        followed++;
        continue;
      }

      skipped++;
    }

    return res.status(200).json({ success: true, scanned: quoted.length, followed, expired, skipped });

  } catch (err) {
    console.error("[followup] Fatal:", err);
    return res.status(500).json({ error: err.message });
  }
}
