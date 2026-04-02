// ============================================================
// REBEL SHAP — Qualifier Engine (lib/qualifier.js)
//
// GPT-4o brain for the conversation flow.
// Responsibilities:
//   1. Continue the qualification conversation naturally
//   2. Extract structured job details from natural language
//   3. Signal when enough info exists to generate a quote
//   4. Generate the quote summary for customer confirmation
//
// The qualifier uses the tenant's real price catalogue so GPT
// knows the actual service names and prices, and can match
// customer requests accurately. It also supports multiple
// line items on a single quote (e.g. repair + replacement).
// ============================================================

import OpenAI from "openai";
import { buildMessagesForGPT } from "./conversations.js";
import { getCatalogue, formatCatalogueForPrompt } from "./priceCatalogue.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// Built fresh per message so it always reflects current
// tenant config and conversation stage.
// ─────────────────────────────────────────────────────────────

async function buildSystemPrompt(tenant, conv) {
  // Load the tenant's price catalogue from Redis
  const catalogue = await getCatalogue(tenant.phone);
  const priceList = formatCatalogueForPrompt(catalogue, tenant.currency ?? "ZAR");

  return `You are a friendly WhatsApp assistant for ${tenant.businessName}, a South African business.
Your job is to help customers get a quote quickly and professionally.
You are speaking to ${conv.customerName ?? "a customer"} via WhatsApp.

SERVICES AND PRICING:
${priceList}

YOUR GOAL:
Collect the following through natural conversation:
1. What service(s) do they need? Match to the service list above as closely as possible.
2. Where is the job? (area or address)
3. Any detail that affects which price tier applies (e.g. complexity, size, urgency)

IMPORTANT — MULTIPLE SERVICES:
If a customer asks for more than one thing (e.g. "quote for repair and replacement"), that is fine.
List both as separate line items — do NOT pick just one.

RULES:
- Be friendly, warm, and professional. This is WhatsApp — keep messages short.
- Ask ONE question at a time. Never fire multiple questions in one message.
- Use plain South African English. No corporate language.
- If a service is listed as a range (e.g. R800 – R2500), ask one qualifying question to narrow it down if needed. But don't over-interrogate — one question max.
- Never make up services that aren't in the list above.
- If a customer asks for something not in the list, apologise and tell them to contact the business directly.
- Once you have service(s), location, and enough detail — stop asking and confirm.
- When you have enough info, end your response with the exact token: [READY_TO_QUOTE]

CURRENT STAGE: ${conv.stage}

JOB DETAILS COLLECTED SO FAR:
${JSON.stringify(conv.jobDetails, null, 2)}

IMPORTANT:
- If the customer's request is unclear, ask for clarification politely.
- If they ask about pricing, tell them you'll include all pricing in the quote PDF.
- If they seem frustrated, apologise briefly and move forward.
- Never use em-dashes. Short sentences. Warm tone.`;
}

// ─────────────────────────────────────────────────────────────
// CONTINUE CONVERSATION
// Main function called on every incoming customer message.
// Returns:
//   { reply, readyToQuote, jobDetails }
// ─────────────────────────────────────────────────────────────

export async function continueConversation(conv, tenant) {
  const systemPrompt = await buildSystemPrompt(tenant, conv);
  const messages     = buildMessagesForGPT(conv, tenant, systemPrompt);

  const response = await openai.chat.completions.create({
    model:       "gpt-4o",
    max_tokens:  300,
    temperature: 0.7,
    messages,
  });

  const raw          = response.choices[0].message.content?.trim() ?? "";
  const readyToQuote = raw.includes("[READY_TO_QUOTE]");
  const reply        = raw.replace("[READY_TO_QUOTE]", "").trim();

  // Extract structured job details from the conversation so far
  const jobDetails = readyToQuote
    ? await extractJobDetails(conv, tenant)
    : conv.jobDetails;

  return { reply, readyToQuote, jobDetails };
}

// ─────────────────────────────────────────────────────────────
// EXTRACT JOB DETAILS
// Called when GPT signals it has enough info.
// Extracts structured data including multiple services.
//
// Returns:
//   {
//     services: [{ name, matchedName, quantity }],  ← NEW: array
//     location: string,
//     description: string,
//     // Legacy single-service fields kept for backwards compat:
//     service: string,
//     matchedService: string,
//   }
// ─────────────────────────────────────────────────────────────

async function extractJobDetails(conv, tenant) {
  const history = conv.messages
    .map(m => `${m.role === "user" ? "Customer" : "Bot"}: ${m.content}`)
    .join("\n");

  // Load catalogue so GPT has the exact service names to match against
  const catalogue    = await getCatalogue(tenant.phone);
  const serviceNames = catalogue?.services?.map(s => s.name).join(", ")
    || tenant.services?.map(s => s.name).join(", ")
    || "General";

  const response = await openai.chat.completions.create({
    model:       "gpt-4o",
    max_tokens:  300,
    temperature: 0,
    messages: [{
      role:    "user",
      content: `Extract job details from this WhatsApp conversation.

AVAILABLE SERVICES (use exact names): ${serviceNames}

CONVERSATION:
${history}

Return JSON only — no preamble, no markdown, no code fences:
{
  "services": [
    {
      "name": "what the customer called it",
      "matchedName": "exact match from AVAILABLE SERVICES list, or null if no match",
      "quantity": 1
    }
  ],
  "location": "area or address they mentioned",
  "description": "brief plain-English summary of the full job",
  "service": "primary service name (first item in services array)",
  "matchedService": "primary matched service name (first matchedName)"
}

RULES:
- If the customer asked for more than one service, include ALL of them in the services array.
- Match each service as closely as possible to the AVAILABLE SERVICES list.
- If there is genuinely no match for a service, set matchedName to null.
- Do not invent services that were not in the conversation.`,
    }],
  });

  try {
    const raw   = response.choices[0].message.content?.trim() ?? "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return conv.jobDetails;
  }
}

// ─────────────────────────────────────────────────────────────
// GENERATE CONFIRMATION MESSAGE
// Sends a summary to the customer before generating the PDF.
// Lists all services so the customer can confirm everything.
// ─────────────────────────────────────────────────────────────

export async function generateConfirmationMessage(jobDetails, tenant) {
  // Build a services list for the message
  const servicesSummary = Array.isArray(jobDetails.services) && jobDetails.services.length > 1
    ? jobDetails.services.map(s => `• ${s.name}`).join("\n")
    : (jobDetails.service ?? jobDetails.matchedService ?? "your service");

  const response = await openai.chat.completions.create({
    model:       "gpt-4o",
    max_tokens:  150,
    temperature: 0.5,
    messages: [{
      role:    "user",
      content: `Write a short WhatsApp message confirming the job details before sending a quote PDF.
Keep it warm, brief, and end by asking them to reply YES to confirm.

Business: ${tenant.businessName}
Services requested: ${servicesSummary}
Location: ${jobDetails.location}
Description: ${jobDetails.description}

Rules:
- Max 4 sentences
- If there are multiple services, mention them all
- End with: Reply YES to get your quote, or let me know if anything needs to change.
- No em-dashes
- Warm, friendly South African tone`,
    }],
  });

  return response.choices[0].message.content?.trim() ??
    `Thanks! Just to confirm — ${servicesSummary} at ${jobDetails.location}. ${jobDetails.description}. Reply YES to get your quote, or let me know if anything needs to change.`;
}

// ─────────────────────────────────────────────────────────────
// DETECT INTENT
// Classifies a short customer reply.
// Returns: "confirm" | "reject" | "question" | "unclear"
// ─────────────────────────────────────────────────────────────

export async function detectIntent(message) {
  const lower = message.toLowerCase().trim();

  const confirmPatterns = ["yes", "yep", "ja", "yebo", "confirmed", "confirm", "ok", "okay", "sure", "👍", "✅"];
  const rejectPatterns  = ["no", "nope", "nee", "cancel", "forget it", "nevermind", "never mind"];

  if (confirmPatterns.some(p => lower.includes(p))) return "confirm";
  if (rejectPatterns.some(p => lower.includes(p)))  return "reject";

  const response = await openai.chat.completions.create({
    model:       "gpt-4o-mini",
    max_tokens:  10,
    temperature: 0,
    messages: [{
      role:    "user",
      content: `Classify this WhatsApp reply as one word: confirm, reject, question, or unclear.
Reply: "${message}"
Output one word only.`,
    }],
  });

  const intent = response.choices[0].message.content?.trim().toLowerCase() ?? "unclear";
  return ["confirm", "reject", "question", "unclear"].includes(intent) ? intent : "unclear";
}
