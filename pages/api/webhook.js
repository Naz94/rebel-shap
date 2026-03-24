// ============================================================
// REBEL SHAP — Webhook Receiver (api/webhook.js)
//
// Entry point for all incoming WhatsApp messages via Meta Graph API.
//
// Two request types:
//   GET  — webhook verification (Meta sends this once when you register)
//   POST — incoming message events
//
// Flow:
//   1. Identify which tenant the message was sent to
//   2. Load or create the conversation
//   3. Run the qualifier (GPT-4o)
//   4. If ready — generate PDF quote and send it
//   5. If quoted — detect intent (yes/no) and generate invoice
// ============================================================

import { getTenant }                           from "../../lib/tenants.js";
import { getConversation, createConversation,
         addMessage, advanceStage }            from "../../lib/conversations.js";
import { continueConversation,
         generateConfirmationMessage,
         detectIntent }                        from "../../lib/qualifier.js";
import { generateQuotePDF, generateInvoicePDF,
         generateQuoteRef, generateInvoiceRef } from "../../lib/documents.js";
import { sendWhatsAppMessage, sendWhatsAppDocument } from "../../lib/whatsapp.js";

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

  // ── POST — incoming message ──────────────────────────────
  if (req.method !== "POST") return res.status(405).end();

  // Always return 200 immediately — Meta will retry if you don't
  res.status(200).json({ status: "ok" });

  try {
    const body = req.body;

    // Validate it's a WhatsApp message event
    if (body.object !== "whatsapp_business_account") return;

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (!value?.messages?.[0]) return;

    const message      = value.messages[0];
    const tenantPhone  = value.metadata?.display_phone_number?.replace(/\D/g, "");
    const customerPhone = message.from;
    const messageText  = message.text?.body ?? "";
    const customerName = value.contacts?.[0]?.profile?.name ?? null;

    if (!tenantPhone || !customerPhone || !messageText) return;

    console.log(`[webhook] Message from ${customerPhone} to ${tenantPhone}: "${messageText}"`);

    // ── Load tenant ────────────────────────────────────────
    const tenant = await getTenant(tenantPhone);
    if (!tenant || !tenant.active) {
      console.warn(`[webhook] No active tenant for ${tenantPhone}`);
      return;
    }

    // ── Load or create conversation ────────────────────────
    let conv = await getConversation(tenantPhone, customerPhone);
    if (!conv) {
      conv = await createConversation(tenantPhone, customerPhone, customerName);
      // Send greeting first
      await sendWhatsAppMessage(tenantPhone, customerPhone, tenant.greeting, tenant);
      await addMessage(tenantPhone, customerPhone, "assistant", tenant.greeting);
    }

    // ── Add customer message to history ───────────────────
    await addMessage(tenantPhone, customerPhone, "user", messageText);
    // Reload conv with updated messages
    conv = await getConversation(tenantPhone, customerPhone);

    // ── Route by stage ─────────────────────────────────────

    // Stage: quoted — customer is responding to a quote
    if (conv.stage === "quoted") {
      const intent = await detectIntent(messageText);

      if (intent === "confirm") {
        await handleQuoteAccepted({ conv, tenant, tenantPhone, customerPhone });
      } else if (intent === "reject") {
        await handleQuoteRejected({ conv, tenant, tenantPhone, customerPhone });
      } else {
        // Question or unclear — re-engage the qualifier
        const { reply } = await continueConversation(conv, tenant);
        await sendWhatsAppMessage(tenantPhone, customerPhone, reply, tenant);
        await addMessage(tenantPhone, customerPhone, "assistant", reply);
      }
      return;
    }

    // Stage: confirming — customer is confirming job details
    if (conv.stage === "confirming") {
      const intent = await detectIntent(messageText);

      if (intent === "confirm") {
        await handleSendQuote({ conv, tenant, tenantPhone, customerPhone });
      } else {
        // They want to change something — go back to qualifying
        await advanceStage(tenantPhone, customerPhone, "qualifying");
        conv = await getConversation(tenantPhone, customerPhone);
        const { reply } = await continueConversation(conv, tenant);
        await sendWhatsAppMessage(tenantPhone, customerPhone, reply, tenant);
        await addMessage(tenantPhone, customerPhone, "assistant", reply);
      }
      return;
    }

    // Stage: greeting or qualifying — continue the conversation
    const { reply, readyToQuote, jobDetails } = await continueConversation(conv, tenant);

    if (readyToQuote) {
      // Update job details and move to confirming
      await advanceStage(tenantPhone, customerPhone, "confirming", { jobDetails: { ...jobDetails, customerName } });
      conv = await getConversation(tenantPhone, customerPhone);

      // Send confirmation summary
      const confirmMsg = await generateConfirmationMessage(jobDetails, tenant);
      await sendWhatsAppMessage(tenantPhone, customerPhone, confirmMsg, tenant);
      await addMessage(tenantPhone, customerPhone, "assistant", confirmMsg);
    } else {
      // Still qualifying — send next question
      await advanceStage(tenantPhone, customerPhone, "qualifying");
      await sendWhatsAppMessage(tenantPhone, customerPhone, reply, tenant);
      await addMessage(tenantPhone, customerPhone, "assistant", reply);
    }

  } catch (err) {
    console.error("[webhook] Error:", err);
  }
}

// ─────────────────────────────────────────────────────────────
// HANDLE: Send Quote PDF
// ─────────────────────────────────────────────────────────────

async function handleSendQuote({ conv, tenant, tenantPhone, customerPhone }) {
  const quoteRef = generateQuoteRef(tenant);

  const { url, price } = await generateQuotePDF({
    tenant,
    jobDetails: conv.jobDetails,
    quoteRef,
  });

  // Send the PDF
  await sendWhatsAppDocument(tenantPhone, customerPhone, url, `${quoteRef}.pdf`, tenant);

  // Send a short follow-up message
  const followUp = `Your quote is attached. It's valid for ${tenant.validityDays} days. Reply YES to accept or let me know if you have any questions.`;
  await sendWhatsAppMessage(tenantPhone, customerPhone, followUp, tenant);

  // Advance stage
  await advanceStage(tenantPhone, customerPhone, "quoted", {
    quoteId: quoteRef,
    quoteUrl: url,
    quotedPrice: price,
    quotedAt: new Date().toISOString(),
  });

  // Notify owner
  await notifyOwner(tenant, conv, `New quote sent to ${conv.jobDetails.customerName ?? customerPhone}. Job: ${conv.jobDetails.service} — ${tenant.currency} ${price}`);

  console.log(`[webhook] Quote sent: ${quoteRef} to ${customerPhone}`);
}

// ─────────────────────────────────────────────────────────────
// HANDLE: Quote Accepted — Generate Invoice
// ─────────────────────────────────────────────────────────────

async function handleQuoteAccepted({ conv, tenant, tenantPhone, customerPhone }) {
  const invoiceRef = generateInvoiceRef(tenant);

  const { url, price } = await generateInvoicePDF({
    tenant,
    jobDetails:  conv.jobDetails,
    invoiceRef,
    quoteRef:    conv.quoteId,
    price:       conv.quotedPrice,
  });

  // Send acceptance message + invoice
  const acceptMsg = `Fantastic! Here's your invoice. A 50% deposit of ${tenant.currency} ${(conv.quotedPrice / 2).toLocaleString("en-ZA", { minimumFractionDigits: 2 })} is required to confirm your booking.`;
  await sendWhatsAppMessage(tenantPhone, customerPhone, acceptMsg, tenant);
  await sendWhatsAppDocument(tenantPhone, customerPhone, url, `${invoiceRef}.pdf`, tenant);

  // Advance stage
  await advanceStage(tenantPhone, customerPhone, "accepted", {
    invoiceId:  invoiceRef,
    invoiceUrl: url,
    acceptedAt: new Date().toISOString(),
  });

  // Notify owner
  await notifyOwner(tenant, conv, `Quote ACCEPTED by ${conv.jobDetails.customerName ?? customerPhone}. Job: ${conv.jobDetails.service}. Invoice ${invoiceRef} sent. Amount: ${tenant.currency} ${conv.quotedPrice}`);

  console.log(`[webhook] Invoice sent: ${invoiceRef} to ${customerPhone}`);
}

// ─────────────────────────────────────────────────────────────
// HANDLE: Quote Rejected
// ─────────────────────────────────────────────────────────────

async function handleQuoteRejected({ conv, tenant, tenantPhone, customerPhone }) {
  const msg = `No problem at all. If you'd like a quote in the future, just message us anytime.`;
  await sendWhatsAppMessage(tenantPhone, customerPhone, msg, tenant);
  await advanceStage(tenantPhone, customerPhone, "rejected", {
    rejectedAt: new Date().toISOString(),
  });
  await notifyOwner(tenant, conv, `Quote declined by ${conv.jobDetails.customerName ?? customerPhone}. Job: ${conv.jobDetails.service}`);
}

// ─────────────────────────────────────────────────────────────
// NOTIFY OWNER
// Sends a WhatsApp summary to the business owner.
// ─────────────────────────────────────────────────────────────

async function notifyOwner(tenant, conv, summary) {
  try {
    const msg = `Rebel Shap update:\n${summary}`;
    await sendWhatsAppMessage(tenant.ownerPhone, tenant.ownerPhone, msg, tenant);
  } catch (err) {
    console.warn("[webhook] Owner notification failed:", err.message);
  }
}
