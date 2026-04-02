// ============================================================
// REBEL SHAP — Webhook Receiver (pages/api/webhook.js)
// GET  — Meta webhook verification
// POST — Incoming WhatsApp messages
// ============================================================

import { getTenant }                                                      from "../../lib/tenants.js";
import { getConversation, createConversation, addMessage, advanceStage }  from "../../lib/conversations.js";
import { continueConversation, generateConfirmationMessage, detectIntent } from "../../lib/qualifier.js";
import { generateQuotePDF, generateInvoicePDF, generateQuoteRef, generateInvoiceRef } from "../../lib/documents.js";
import { sendWhatsAppMessage, sendWhatsAppDocument }                      from "../../lib/whatsapp.js";

export const maxDuration = 60;
export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  // ── GET — Meta webhook verification ─────────────────────
  if (req.method === "GET") {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
      console.log("[webhook] Verified");
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") {
      return res.status(200).json({ status: "ok" });
    }

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.[0]) {
      return res.status(200).json({ status: "ok" });
    }

    const message       = value.messages[0];
    const tenantPhone   = value.metadata?.display_phone_number?.replace(/\D/g, "");
    const customerPhone = message.from;
    const messageText   = message.text?.body ?? "";
    const customerName  = value.contacts?.[0]?.profile?.name ?? null;

    if (!tenantPhone || !customerPhone || !messageText) {
      return res.status(200).json({ status: "ok" });
    }

    console.log(`[webhook] Message from ${customerPhone} to ${tenantPhone}: "${messageText}"`);

    const tenant = await getTenant(tenantPhone);
    if (!tenant || !tenant.active) {
      console.warn(`[webhook] No active tenant for ${tenantPhone}`);
      return res.status(200).json({ status: "ok" });
    }

    let conv = await getConversation(tenantPhone, customerPhone);

    if (!conv) {
      conv = await createConversation(tenantPhone, customerPhone, customerName);
      await sendWhatsAppMessage(tenantPhone, customerPhone, tenant.greeting, tenant);
      await addMessage(tenantPhone, customerPhone, "assistant", tenant.greeting);
    }

    await addMessage(tenantPhone, customerPhone, "user", messageText);
    conv = await getConversation(tenantPhone, customerPhone);

    // ── Stage: quoted ─────────────────────────────────────
    if (conv.stage === "quoted") {
      const intent = await detectIntent(messageText);
      if (intent === "confirm") {
        await handleQuoteAccepted({ conv, tenant, tenantPhone, customerPhone });
      } else if (intent === "reject") {
        await handleQuoteRejected({ conv, tenant, tenantPhone, customerPhone });
      } else {
        const { reply } = await continueConversation(conv, tenant);
        await sendWhatsAppMessage(tenantPhone, customerPhone, reply, tenant);
        await addMessage(tenantPhone, customerPhone, "assistant", reply);
      }
      return res.status(200).json({ status: "ok" });
    }

    // ── Stage: confirming ─────────────────────────────────
    if (conv.stage === "confirming") {
      const intent = await detectIntent(messageText);
      if (intent === "confirm") {
        await handleSendQuote({ conv, tenant, tenantPhone, customerPhone });
      } else {
        await advanceStage(tenantPhone, customerPhone, "qualifying");
        conv = await getConversation(tenantPhone, customerPhone);
        const { reply } = await continueConversation(conv, tenant);
        await sendWhatsAppMessage(tenantPhone, customerPhone, reply, tenant);
        await addMessage(tenantPhone, customerPhone, "assistant", reply);
      }
      return res.status(200).json({ status: "ok" });
    }

    // ── Stage: greeting / qualifying ──────────────────────
    const { reply, readyToQuote, jobDetails } = await continueConversation(conv, tenant);

    if (readyToQuote) {
      await advanceStage(tenantPhone, customerPhone, "confirming", {
        jobDetails: { ...jobDetails, customerName },
      });
      conv = await getConversation(tenantPhone, customerPhone);
      const confirmMsg = await generateConfirmationMessage(jobDetails, tenant);
      await sendWhatsAppMessage(tenantPhone, customerPhone, confirmMsg, tenant);
      await addMessage(tenantPhone, customerPhone, "assistant", confirmMsg);
    } else {
      await advanceStage(tenantPhone, customerPhone, "qualifying");
      await sendWhatsAppMessage(tenantPhone, customerPhone, reply, tenant);
      await addMessage(tenantPhone, customerPhone, "assistant", reply);
    }

    return res.status(200).json({ status: "ok" });

  } catch (err) {
    console.error("[webhook] Error:", err.message, err.stack);
    return res.status(200).json({ status: "ok" });
  }
}

// ─────────────────────────────────────────────────────────────
// HANDLE: Send Quote PDF
// ─────────────────────────────────────────────────────────────

async function handleSendQuote({ conv, tenant, tenantPhone, customerPhone }) {
  const quoteRef = generateQuoteRef(tenant);

  // generateQuotePDF now returns lineItems so we can reuse them on the invoice
  const { url, price, lineItems } = await generateQuotePDF({
    tenant,
    jobDetails: conv.jobDetails,
    quoteRef,
  });

  await sendWhatsAppDocument(tenantPhone, customerPhone, url, `${quoteRef}.pdf`, tenant);
  await sendWhatsAppMessage(
    tenantPhone, customerPhone,
    `Your quote is attached. It's valid for ${tenant.validityDays} days. Reply YES to accept or let me know if you have any questions.`,
    tenant
  );

  await advanceStage(tenantPhone, customerPhone, "quoted", {
    quoteId:     quoteRef,
    quoteUrl:    url,
    quotedPrice: price,
    lineItems,                // ← stored so invoice can reuse the same line items
    quotedAt:    new Date().toISOString(),
  });

  const priceDisplay = price > 0
    ? `${tenant.currency} ${price.toLocaleString("en-ZA")}`
    : "TBC";

  await notifyOwner(tenant,
    `New quote sent to ${conv.jobDetails.customerName ?? customerPhone}. ` +
    `Job: ${conv.jobDetails.description ?? conv.jobDetails.service} — ${priceDisplay}`
  );
}

// ─────────────────────────────────────────────────────────────
// HANDLE: Quote Accepted → generate invoice
// ─────────────────────────────────────────────────────────────

async function handleQuoteAccepted({ conv, tenant, tenantPhone, customerPhone }) {
  const invoiceRef = generateInvoiceRef(tenant);

  const { url } = await generateInvoicePDF({
    tenant,
    jobDetails:  conv.jobDetails,
    invoiceRef,
    quoteRef:    conv.quoteId,
    price:       conv.quotedPrice,
    lineItems:   conv.lineItems,   // ← reuse line items from quote
  });

  const deposit = conv.quotedPrice > 0
    ? (conv.quotedPrice / 2).toLocaleString("en-ZA", { minimumFractionDigits: 2 })
    : null;

  const depositMsg = deposit
    ? `A 50% deposit of ${tenant.currency} ${deposit} is required to confirm your booking.`
    : `The business will be in touch to confirm the final amount and deposit.`;

  await sendWhatsAppMessage(tenantPhone, customerPhone,
    `Fantastic! Here's your invoice. ${depositMsg}`, tenant);
  await sendWhatsAppDocument(tenantPhone, customerPhone, url, `${invoiceRef}.pdf`, tenant);

  await advanceStage(tenantPhone, customerPhone, "accepted", {
    invoiceId:  invoiceRef,
    invoiceUrl: url,
    acceptedAt: new Date().toISOString(),
  });

  await notifyOwner(tenant,
    `Quote ACCEPTED by ${conv.jobDetails.customerName ?? customerPhone}. ` +
    `Job: ${conv.jobDetails.service}. Invoice ${invoiceRef} sent. Amount: ${tenant.currency} ${conv.quotedPrice}`
  );
}

// ─────────────────────────────────────────────────────────────
// HANDLE: Quote Rejected
// ─────────────────────────────────────────────────────────────

async function handleQuoteRejected({ conv, tenant, tenantPhone, customerPhone }) {
  await sendWhatsAppMessage(tenantPhone, customerPhone,
    `No problem at all. If you'd like a quote in the future, just message us anytime.`, tenant);
  await advanceStage(tenantPhone, customerPhone, "rejected", { rejectedAt: new Date().toISOString() });
  await notifyOwner(tenant, `Quote declined by ${conv.jobDetails.customerName ?? customerPhone}. Job: ${conv.jobDetails.service}`);
}

// ─────────────────────────────────────────────────────────────
// NOTIFY OWNER
// ─────────────────────────────────────────────────────────────

async function notifyOwner(tenant, summary) {
  try {
    await sendWhatsAppMessage(tenant.phone, tenant.ownerPhone,
      `Rebel Shap update:\n${summary}`, tenant);
  } catch (err) {
    console.warn("[webhook] Owner notification failed:", err.message);
  }
}
