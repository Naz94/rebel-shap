// ============================================================
// REBEL SHAP — Conversation Engine (lib/conversations.js)
//
// Manages stateful WhatsApp conversations per customer.
// Each conversation belongs to a tenant + customer phone pair.
//
// Stages:
//   greeting     — first message received, bot introduces itself
//   qualifying   — GPT-4o asking questions to understand the job
//   confirming   — summary sent, waiting for customer to confirm
//   quoted       — PDF quote sent, waiting for response
//   accepted     — customer accepted, invoice generated
//   rejected     — customer declined
//   expired      — no response after follow-up window
//
// Keys:
//   rebelshap:conv:{tenantPhone}:{customerPhone} — conversation state
//   rebelshap:open_convs                         — set of active conv keys
// ============================================================

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CONV_KEY      = (tenantPhone, customerPhone) =>
  `rebelshap:conv:${tenantPhone}:${customerPhone}`;
const OPEN_CONVS_KEY = "rebelshap:open_convs";

// ─────────────────────────────────────────────────────────────
// GET CONVERSATION
// Returns null if no conversation exists yet.
// ─────────────────────────────────────────────────────────────

export async function getConversation(tenantPhone, customerPhone) {
  const raw = await redis.get(CONV_KEY(tenantPhone, customerPhone));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// CREATE CONVERSATION
// Called when a customer messages a tenant for the first time.
// ─────────────────────────────────────────────────────────────

export async function createConversation(tenantPhone, customerPhone, customerName = null) {
  const conv = {
    tenantPhone,
    customerPhone,
    customerName,
    stage:      "greeting",
    messages:   [],           // full message history for GPT-4o context
    jobDetails: {},           // extracted job info: service, location, description
    quoteId:    null,         // set when quote is generated
    invoiceId:  null,         // set when invoice is generated
    createdAt:  new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
  };

  await saveConversation(conv);
  await redis.sadd(OPEN_CONVS_KEY, CONV_KEY(tenantPhone, customerPhone));
  console.log(`[conversations] Created: ${tenantPhone} ↔ ${customerPhone}`);
  return conv;
}

// ─────────────────────────────────────────────────────────────
// SAVE CONVERSATION
// ─────────────────────────────────────────────────────────────

export async function saveConversation(conv) {
  const updated = { ...conv, updatedAt: new Date().toISOString() };
  await redis.set(
    CONV_KEY(conv.tenantPhone, conv.customerPhone),
    JSON.stringify(updated),
    { ex: 60 * 60 * 24 * 30 } // expire after 30 days of inactivity
  );
  return updated;
}

// ─────────────────────────────────────────────────────────────
// ADD MESSAGE
// Appends a message to the conversation history.
// role: "user" (customer) or "assistant" (bot)
// ─────────────────────────────────────────────────────────────

export async function addMessage(tenantPhone, customerPhone, role, content) {
  const conv = await getConversation(tenantPhone, customerPhone);
  if (!conv) return null;

  conv.messages.push({ role, content, timestamp: new Date().toISOString() });
  conv.lastMessageAt = new Date().toISOString();

  // Keep last 20 messages only — enough context for GPT-4o without bloating Redis
  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }

  return saveConversation(conv);
}

// ─────────────────────────────────────────────────────────────
// ADVANCE STAGE
// Moves the conversation to the next stage.
// ─────────────────────────────────────────────────────────────

export async function advanceStage(tenantPhone, customerPhone, stage, extras = {}) {
  const conv = await getConversation(tenantPhone, customerPhone);
  if (!conv) return null;

  const updated = { ...conv, stage, ...extras };
  console.log(`[conversations] Stage: ${conv.stage} → ${stage} (${tenantPhone} ↔ ${customerPhone})`);

  // Remove from open convs if terminal stage
  if (["accepted", "rejected", "expired"].includes(stage)) {
    await redis.srem(OPEN_CONVS_KEY, CONV_KEY(tenantPhone, customerPhone));
  }

  return saveConversation(updated);
}

// ─────────────────────────────────────────────────────────────
// GET ALL OPEN CONVERSATIONS
// Used by the follow-up cron to find unanswered quotes.
// ─────────────────────────────────────────────────────────────

export async function getOpenConversations() {
  const keys = await redis.smembers(OPEN_CONVS_KEY);
  if (!keys || keys.length === 0) return [];

  const convs = await Promise.all(
    keys.map(async (key) => {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    })
  );

  return convs.filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// BUILD GPT-4O MESSAGES ARRAY
// Formats conversation history for the OpenAI API.
// Prepends the system prompt so GPT-4o has full context.
// ─────────────────────────────────────────────────────────────

export function buildMessagesForGPT(conv, tenant, systemPrompt) {
  return [
    { role: "system", content: systemPrompt },
    ...conv.messages.map(m => ({ role: m.role, content: m.content })),
  ];
}
