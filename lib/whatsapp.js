// ============================================================
// REBEL SHAP — WhatsApp Sender (lib/whatsapp.js)
//
// Sends messages and documents via Meta Graph API.
// Each tenant has their own access token and phone number ID
// stored in their tenant config.
//
// Two send types:
//   sendWhatsAppMessage  — plain text message
//   sendWhatsAppDocument — PDF file via URL
//
// Meta requires a phone_number_id (not the display number)
// to send messages. This is stored on the tenant as phoneNumberId.
// ============================================================

const FB_API = "https://graph.facebook.com/v19.0";

// ─────────────────────────────────────────────────────────────
// SEND TEXT MESSAGE
// ─────────────────────────────────────────────────────────────

export async function sendWhatsAppMessage(tenantPhone, toPhone, message, tenant) {
  const token         = getToken(tenant);
  const phoneNumberId = getPhoneNumberId(tenant);

  const body = {
    messaging_product: "whatsapp",
    recipient_type:    "individual",
    to:                toPhone,
    type:              "text",
    text: {
      preview_url: false,
      body:        message,
    },
  };

  const res  = await fetch(`${FB_API}/${phoneNumberId}/messages`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    console.error("[whatsapp] Send message failed:", JSON.stringify(data.error ?? data));
    throw new Error(`WhatsApp send failed: ${JSON.stringify(data.error ?? data)}`);
  }

  console.log(`[whatsapp] Message sent to ${toPhone}: "${message.slice(0, 50)}..."`);
  return data;
}

// ─────────────────────────────────────────────────────────────
// SEND DOCUMENT (PDF)
// Meta requires the PDF to be at a publicly accessible URL.
// Vercel Blob URLs are public — this works out of the box.
// ─────────────────────────────────────────────────────────────

export async function sendWhatsAppDocument(tenantPhone, toPhone, documentUrl, filename, tenant) {
  const token         = getToken(tenant);
  const phoneNumberId = getPhoneNumberId(tenant);

  const body = {
    messaging_product: "whatsapp",
    recipient_type:    "individual",
    to:                toPhone,
    type:              "document",
    document: {
      link:     documentUrl,
      filename: filename,
      caption:  `Your document from ${tenant.businessName}`,
    },
  };

  const res  = await fetch(`${FB_API}/${phoneNumberId}/messages`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    console.error("[whatsapp] Send document failed:", JSON.stringify(data.error ?? data));
    throw new Error(`WhatsApp document send failed: ${JSON.stringify(data.error ?? data)}`);
  }

  console.log(`[whatsapp] Document sent to ${toPhone}: ${filename}`);
  return data;
}

// ─────────────────────────────────────────────────────────────
// TOKEN RESOLVER
// Each tenant can have their own Meta access token.
// Falls back to the global META_TOKEN env var for the first
// client while you're getting set up.
// ─────────────────────────────────────────────────────────────

function getToken(tenant) {
  const token = tenant?.metaToken ?? process.env.META_TOKEN;
  if (!token) throw new Error(`No Meta token available for tenant ${tenant?.businessName}`);
  return token;
}

// ─────────────────────────────────────────────────────────────
// PHONE NUMBER ID RESOLVER
// The Meta phone_number_id is different from the display number.
// Stored on the tenant config when you onboard them.
// Falls back to META_PHONE_NUMBER_ID env var for first client.
// ─────────────────────────────────────────────────────────────

function getPhoneNumberId(tenant) {
  const id = tenant?.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID;
  if (!id) throw new Error(`No phone number ID for tenant ${tenant?.businessName}`);
  return id;
}
