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
// The qualifier never generates prices — that comes from the
// tenant's service config. It just extracts what the job is.
// ============================================================

import OpenAI from "openai";
import { buildMessagesForGPT } from "./conversations.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// Built fresh per message so it always reflects current
// tenant config and conversation stage.
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt(tenant, conv) {
  const serviceList = tenant.services
    .map((s, i) => `${i + 1}. ${s.name} — ${tenant.currency} ${s.basePrice}`)
    .join("\n");

  return `You are a friendly WhatsApp assistant for ${tenant.businessName}, a South African business.
Your job is to help customers get a quote quickly and professionally.
You are speaking to ${conv.customerName ?? "a customer"} via WhatsApp.

BUSINESS SERVICES AND BASE PRICING:
${serviceList || "General services — ask the customer to describe what they need."}

YOUR GOAL:
Collect the following information through natural conversation:
1. What service do they need? (match to the service list above if possible)
2. Where is the job? (area or address)
3. Any additional details that affect the price (size, urgency, complexity)

RULES:
- Be friendly, warm, and professional. This is WhatsApp — keep messages short.
- Ask ONE question at a time. Never fire multiple questions in one message.
- Use plain South African English. No corporate language.
- Never mention prices yourself — the quote PDF handles that.
- Never make up services that aren't in the list above.
- Once you have service type, location, and a basic description — stop asking and confirm.
- When you have enough info, end your response with the exact token: [READY_TO_QUOTE]

CURRENT STAGE: ${conv.stage}

JOB DETAILS COLLECTED SO FAR:
${JSON.stringify(conv.jobDetails, null, 2)}

IMPORTANT:
- If the customer's request is unclear, ask for clarification politely.
- If they ask about pricing, tell them you'll send a detailed quote PDF shortly.
- If they seem frustrated, apologise briefly and move forward.
- Never use em-dashes. Short sentences. Warm tone.`;
}

// ─────────────────────────────────────────────────────────────
// CONTINUE CONVERSATION
// Main function called on every incoming customer message.
// Returns:
//   { reply: string, readyToQuote: boolean, jobDetails: object }
// ─────────────────────────────────────────────────────────────

export async function continueConversation(conv, tenant) {
  const systemPrompt = buildSystemPrompt(tenant, conv);
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
// Pulls structured data out of the conversation history.
// Returns: { service, location, description, matchedService }
// ─────────────────────────────────────────────────────────────

async function extractJobDetails(conv, tenant) {
  const history = conv.messages
    .map(m => `${m.role === "user" ? "Customer" : "Bot"}: ${m.content}`)
    .join("\n");

  const serviceNames = tenant.services.map(s => s.name).join(", ");

  const response = await openai.chat.completions.create({
    model:       "gpt-4o",
    max_tokens:  200,
    temperature: 0,
    messages: [{
      role:    "user",
      content: `Extract job details from this WhatsApp conversation.

AVAILABLE SERVICES: ${serviceNames || "General"}

CONVERSATION:
${history}

Return JSON only — no preamble, no markdown:
{
  "service": "the service they need — match exactly to available services if possible",
  "location": "area or address they mentioned",
  "description": "brief description of the job in plain English",
  "matchedService": "exact service name from available services, or null if no match"
}`,
    }],
  });

  try {
    const raw    = response.choices[0].message.content?.trim() ?? "{}";
    const clean  = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return conv.jobDetails;
  }
}

// ─────────────────────────────────────────────────────────────
// GENERATE CONFIRMATION MESSAGE
// Sends a summary to the customer before generating the PDF.
// "Here's what I've got — does this look right?"
// ─────────────────────────────────────────────────────────────

export async function generateConfirmationMessage(jobDetails, tenant) {
  const response = await openai.chat.completions.create({
    model:       "gpt-4o",
    max_tokens:  150,
    temperature: 0.5,
    messages: [{
      role:    "user",
      content: `Write a short WhatsApp message confirming the job details before sending a quote PDF.
Keep it warm, brief, and end by asking them to reply YES to confirm.

Business: ${tenant.businessName}
Service: ${jobDetails.service}
Location: ${jobDetails.location}
Description: ${jobDetails.description}

Rules:
- Max 3 sentences
- End with: Reply YES to get your quote, or let me know if anything needs to change.
- No em-dashes
- Warm, friendly South African tone`,
    }],
  });

  return response.choices[0].message.content?.trim() ?? 
    `Thanks! Just to confirm — ${jobDetails.service} at ${jobDetails.location}. ${jobDetails.description}. Reply YES to get your quote, or let me know if anything needs to change.`;
}

// ─────────────────────────────────────────────────────────────
// DETECT INTENT
// Classifies a short customer reply.
// Returns: "confirm" | "reject" | "question" | "unclear"
// Used after the quote is sent to detect acceptance.
// ─────────────────────────────────────────────────────────────

export async function detectIntent(message) {
  const lower = message.toLowerCase().trim();

  // Fast path — common SA confirmations
  const confirmPatterns = ["yes", "yep", "ja", "yebo", "confirmed", "confirm", "ok", "okay", "sure", "👍", "✅"];
  const rejectPatterns  = ["no", "nope", "nee", "cancel", "forget it", "nevermind", "never mind"];

  if (confirmPatterns.some(p => lower.includes(p))) return "confirm";
  if (rejectPatterns.some(p => lower.includes(p)))  return "reject";

  // GPT fallback for ambiguous replies
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
