// ============================================================
// REBEL SHAP — Document Generator (lib/documents.js)
//
// Generates branded quote and invoice PDFs using pdf-lib.
// Stores them in Vercel Blob and returns a public URL.
//
// Two document types:
//   quote   — sent after qualification, valid for N days
//   invoice — sent after customer accepts the quote
//
// Each document gets a unique reference number:
//   QUO-{tenantPrefix}-{timestamp}
//   INV-{tenantPrefix}-{timestamp}
// ============================================================

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { put }                              from "@vercel/blob";

// ─────────────────────────────────────────────────────────────
// COLOURS
// ─────────────────────────────────────────────────────────────

const BLACK      = rgb(0.031, 0.031, 0.031);  // #080808
const RED        = rgb(1, 0.176, 0.176);       // #FF2D2D
const WHITE      = rgb(1, 1, 1);
const LIGHT_GREY = rgb(0.95, 0.95, 0.95);
const MID_GREY   = rgb(0.6, 0.6, 0.6);

// ─────────────────────────────────────────────────────────────
// GENERATE QUOTE PDF
// ─────────────────────────────────────────────────────────────

export async function generateQuotePDF({ tenant, jobDetails, quoteRef }) {
  const pdfDoc  = await PDFDocument.create();
  const page    = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── Header bar ──────────────────────────────────────────
  page.drawRectangle({
    x: 0, y: height - 80,
    width, height: 80,
    color: BLACK,
  });

  // Business name
  page.drawText(tenant.businessName.toUpperCase(), {
    x: 40, y: height - 48,
    size: 18, font: fontBold, color: WHITE,
  });

  // Document type
  page.drawText("QUOTE", {
    x: width - 100, y: height - 48,
    size: 18, font: fontBold, color: RED,
  });

  // ── Quote details block ──────────────────────────────────
  const detailsY = height - 130;

  page.drawText(`Quote Ref:`, { x: 40, y: detailsY,      size: 9,  font: fontBold,    color: MID_GREY });
  page.drawText(quoteRef,     { x: 120, y: detailsY,     size: 9,  font: fontRegular, color: BLACK });

  page.drawText(`Date:`,      { x: 40, y: detailsY - 18, size: 9,  font: fontBold,    color: MID_GREY });
  page.drawText(formatDate(new Date()), { x: 120, y: detailsY - 18, size: 9, font: fontRegular, color: BLACK });

  page.drawText(`Valid for:`, { x: 40, y: detailsY - 36, size: 9,  font: fontBold,    color: MID_GREY });
  page.drawText(`${tenant.validityDays} days`, { x: 120, y: detailsY - 36, size: 9, font: fontRegular, color: BLACK });

  // ── Prepared for block ───────────────────────────────────
  page.drawText("PREPARED FOR", {
    x: width - 220, y: detailsY,
    size: 9, font: fontBold, color: MID_GREY,
  });
  page.drawText(jobDetails.customerName ?? "Valued Customer", {
    x: width - 220, y: detailsY - 18,
    size: 11, font: fontBold, color: BLACK,
  });
  if (jobDetails.location) {
    page.drawText(jobDetails.location, {
      x: width - 220, y: detailsY - 36,
      size: 9, font: fontRegular, color: BLACK,
    });
  }

  // ── Divider ──────────────────────────────────────────────
  page.drawRectangle({
    x: 40, y: detailsY - 60,
    width: width - 80, height: 1,
    color: LIGHT_GREY,
  });

  // ── Services table header ────────────────────────────────
  const tableY = detailsY - 90;

  page.drawRectangle({
    x: 40, y: tableY - 4,
    width: width - 80, height: 24,
    color: BLACK,
  });

  page.drawText("DESCRIPTION",       { x: 50,          y: tableY + 4, size: 9, font: fontBold, color: WHITE });
  page.drawText("LOCATION",          { x: 280,         y: tableY + 4, size: 9, font: fontBold, color: WHITE });
  page.drawText(`AMOUNT (${tenant.currency})`, { x: width - 120, y: tableY + 4, size: 9, font: fontBold, color: WHITE });

  // ── Service row ──────────────────────────────────────────
  const rowY = tableY - 30;

  // Alternate row background
  page.drawRectangle({
    x: 40, y: rowY - 8,
    width: width - 80, height: 28,
    color: LIGHT_GREY,
  });

  const matchedService = tenant.services.find(
    s => s.name === jobDetails.matchedService
  );
  const price    = matchedService?.basePrice ?? 0;
  const service  = jobDetails.service ?? jobDetails.matchedService ?? "Service";
  const location = jobDetails.location ?? "";

  // Truncate long text to fit columns
  const truncate = (str, max) => str.length > max ? str.slice(0, max) + "…" : str;

  page.drawText(truncate(service, 35),  { x: 50,          y: rowY + 4, size: 9, font: fontRegular, color: BLACK });
  page.drawText(truncate(location, 25), { x: 280,         y: rowY + 4, size: 9, font: fontRegular, color: BLACK });
  page.drawText(formatCurrency(price),  { x: width - 120, y: rowY + 4, size: 9, font: fontBold,    color: BLACK });

  // ── Total block ──────────────────────────────────────────
  const totalY = rowY - 50;

  page.drawRectangle({
    x: width - 200, y: totalY - 8,
    width: 160, height: 30,
    color: BLACK,
  });

  page.drawText("TOTAL",                { x: width - 190, y: totalY + 6, size: 10, font: fontBold, color: WHITE });
  page.drawText(`${tenant.currency} ${formatCurrency(price)}`, {
    x: width - 110, y: totalY + 6,
    size: 10, font: fontBold, color: RED,
  });

  // ── Notes ────────────────────────────────────────────────
  const notesY = totalY - 60;

  page.drawText("JOB DESCRIPTION", { x: 40, y: notesY, size: 9, font: fontBold, color: MID_GREY });
  page.drawText(truncate(jobDetails.description ?? "As discussed", 80), {
    x: 40, y: notesY - 18,
    size: 9, font: fontRegular, color: BLACK,
  });

  // ── Terms ────────────────────────────────────────────────
  const termsY = notesY - 60;

  page.drawText("TERMS", { x: 40, y: termsY, size: 9, font: fontBold, color: MID_GREY });
  const terms = [
    `This quote is valid for ${tenant.validityDays} days from the date of issue.`,
    "Prices exclude VAT unless otherwise stated.",
    "A 50% deposit is required before work commences.",
  ];
  terms.forEach((line, i) => {
    page.drawText(`• ${line}`, {
      x: 40, y: termsY - 18 - (i * 14),
      size: 8, font: fontRegular, color: MID_GREY,
    });
  });

  // ── Footer ───────────────────────────────────────────────
  page.drawRectangle({
    x: 0, y: 0,
    width, height: 40,
    color: BLACK,
  });

  page.drawText("Powered by Rebel Shap — rebeldesigns.co.za", {
    x: 40, y: 14,
    size: 8, font: fontRegular, color: MID_GREY,
  });

  page.drawText(`To accept this quote, reply YES on WhatsApp.`, {
    x: width - 260, y: 14,
    size: 8, font: fontRegular, color: MID_GREY,
  });

  // ── Save and upload ──────────────────────────────────────
  const pdfBytes = await pdfDoc.save();
  const blob     = await put(`quotes/${quoteRef}.pdf`, pdfBytes, {
    access:      "public",
    contentType: "application/pdf",
  });

  return { url: blob.url, ref: quoteRef, price };
}

// ─────────────────────────────────────────────────────────────
// GENERATE INVOICE PDF
// Same structure as quote but with INVOICE header + payment details.
// ─────────────────────────────────────────────────────────────

export async function generateInvoicePDF({ tenant, jobDetails, invoiceRef, quoteRef, price }) {
  const pdfDoc  = await PDFDocument.create();
  const page    = pdfDoc.addPage([595, 842]);
  const { width, height } = page.getSize();

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── Header ───────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: BLACK });

  page.drawText(tenant.businessName.toUpperCase(), {
    x: 40, y: height - 48, size: 18, font: fontBold, color: WHITE,
  });
  page.drawText("INVOICE", {
    x: width - 120, y: height - 48, size: 18, font: fontBold, color: RED,
  });

  // ── Invoice details ──────────────────────────────────────
  const detailsY = height - 130;

  const details = [
    ["Invoice Ref:", invoiceRef],
    ["Quote Ref:",   quoteRef],
    ["Date:",        formatDate(new Date())],
    ["Due:",         formatDate(addDays(new Date(), 7))],
  ];

  details.forEach(([label, value], i) => {
    page.drawText(label, { x: 40,  y: detailsY - (i * 18), size: 9, font: fontBold,    color: MID_GREY });
    page.drawText(value, { x: 130, y: detailsY - (i * 18), size: 9, font: fontRegular, color: BLACK });
  });

  // ── Billed to ────────────────────────────────────────────
  page.drawText("BILLED TO", {
    x: width - 220, y: detailsY, size: 9, font: fontBold, color: MID_GREY,
  });
  page.drawText(jobDetails.customerName ?? "Valued Customer", {
    x: width - 220, y: detailsY - 18, size: 11, font: fontBold, color: BLACK,
  });

  // ── Divider ──────────────────────────────────────────────
  page.drawRectangle({
    x: 40, y: detailsY - 85, width: width - 80, height: 1, color: LIGHT_GREY,
  });

  // ── Table ────────────────────────────────────────────────
  const tableY = detailsY - 115;

  page.drawRectangle({ x: 40, y: tableY - 4, width: width - 80, height: 24, color: BLACK });
  page.drawText("DESCRIPTION",       { x: 50,          y: tableY + 4, size: 9, font: fontBold, color: WHITE });
  page.drawText(`AMOUNT (${tenant.currency})`, { x: width - 120, y: tableY + 4, size: 9, font: fontBold, color: WHITE });

  const rowY = tableY - 30;
  page.drawRectangle({ x: 40, y: rowY - 8, width: width - 80, height: 28, color: LIGHT_GREY });

  const truncate = (str, max) => str.length > max ? str.slice(0, max) + "…" : str;
  page.drawText(truncate(jobDetails.service ?? "Service", 55), { x: 50, y: rowY + 4, size: 9, font: fontRegular, color: BLACK });
  page.drawText(formatCurrency(price), { x: width - 120, y: rowY + 4, size: 9, font: fontBold, color: BLACK });

  // ── Total ────────────────────────────────────────────────
  const totalY = rowY - 50;
  page.drawRectangle({ x: width - 200, y: totalY - 8, width: 160, height: 30, color: BLACK });
  page.drawText("TOTAL DUE", { x: width - 190, y: totalY + 6, size: 10, font: fontBold, color: WHITE });
  page.drawText(`${tenant.currency} ${formatCurrency(price)}`, {
    x: width - 110, y: totalY + 6, size: 10, font: fontBold, color: RED,
  });

  // ── Payment instructions ─────────────────────────────────
  const payY = totalY - 60;
  page.drawText("PAYMENT", { x: 40, y: payY, size: 9, font: fontBold, color: MID_GREY });
  page.drawText("Please use your Invoice Reference as the payment reference.", {
    x: 40, y: payY - 18, size: 9, font: fontRegular, color: BLACK,
  });
  page.drawText("Send proof of payment to confirm your booking.", {
    x: 40, y: payY - 32, size: 9, font: fontRegular, color: BLACK,
  });

  // ── Footer ───────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width, height: 40, color: BLACK });
  page.drawText("Powered by Rebel Shap — rebeldesigns.co.za", {
    x: 40, y: 14, size: 8, font: fontRegular, color: MID_GREY,
  });
  page.drawText("Thank you for your business.", {
    x: width - 180, y: 14, size: 8, font: fontRegular, color: MID_GREY,
  });

  const pdfBytes = await pdfDoc.save();
  const blob     = await put(`invoices/${invoiceRef}.pdf`, pdfBytes, {
    access:      "public",
    contentType: "application/pdf",
  });

  return { url: blob.url, ref: invoiceRef, price };
}

// ─────────────────────────────────────────────────────────────
// REFERENCE NUMBER GENERATORS
// ─────────────────────────────────────────────────────────────

export function generateQuoteRef(tenant) {
  const prefix = tenant.businessName.slice(0, 3).toUpperCase().replace(/\s/g, "");
  return `QUO-${prefix}-${Date.now()}`;
}

export function generateInvoiceRef(tenant) {
  const prefix = tenant.businessName.slice(0, 3).toUpperCase().replace(/\s/g, "");
  return `INV-${prefix}-${Date.now()}`;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function formatDate(date) {
  return date.toLocaleDateString("en-ZA", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function formatCurrency(amount) {
  return Number(amount).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
