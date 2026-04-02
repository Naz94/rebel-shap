// ============================================================
// REBEL SHAP — Document Generator (lib/documents.js)
//
// Generates branded quote and invoice PDFs using pdf-lib.
// Stores them in Vercel Blob and returns a public URL.
//
// Changes from v1:
//   - Pulls real prices from the tenant's price catalogue
//   - Supports multiple line items on one quote
//   - Shows price ranges on quotes (e.g. R800 – R2500)
//   - Total reflects actual catalogue pricing
// ============================================================

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { put }                              from "@vercel/blob";
import { getCatalogue, matchServices }      from "./priceCatalogue.js";

// ─────────────────────────────────────────────────────────────
// COLOURS
// ─────────────────────────────────────────────────────────────

const BLACK      = rgb(0.031, 0.031, 0.031);
const RED        = rgb(1, 0.176, 0.176);
const WHITE      = rgb(1, 1, 1);
const LIGHT_GREY = rgb(0.95, 0.95, 0.95);
const MID_GREY   = rgb(0.6, 0.6, 0.6);

// ─────────────────────────────────────────────────────────────
// RESOLVE LINE ITEMS
// Takes the job details (with services array) and the tenant's
// catalogue, returns an array of line items ready for the PDF.
//
// Each line item:
//   { description, location, displayPrice, numericPrice, isRange }
// ─────────────────────────────────────────────────────────────

async function resolveLineItems(jobDetails, tenant) {
  const currency = tenant.currency ?? "ZAR";
  const catalogue = await getCatalogue(tenant.phone);

  // Build the list of requested service names from jobDetails
  let requestedNames = [];

  if (Array.isArray(jobDetails.services) && jobDetails.services.length > 0) {
    // New format: services array from updated qualifier
    requestedNames = jobDetails.services.map(s => s.matchedName ?? s.name).filter(Boolean);
  } else if (jobDetails.matchedService) {
    // Legacy format fallback
    requestedNames = [jobDetails.matchedService];
  } else if (jobDetails.service) {
    requestedNames = [jobDetails.service];
  }

  // Match against the catalogue
  const matched = catalogue ? matchServices(requestedNames, catalogue) : [];

  if (matched.length > 0) {
    return matched.map(s => {
      let displayPrice, numericPrice, isRange;

      if (s.flatRate !== null) {
        displayPrice = formatCurrency(s.flatRate);
        numericPrice = s.flatRate;
        isRange      = false;
      } else if (s.minPrice !== null && s.maxPrice !== null) {
        displayPrice = `${formatCurrency(s.minPrice)} – ${formatCurrency(s.maxPrice)}`;
        numericPrice = s.minPrice; // use min for deposit calc
        isRange      = true;
      } else if (s.minPrice !== null) {
        displayPrice = `from ${formatCurrency(s.minPrice)}`;
        numericPrice = s.minPrice;
        isRange      = true;
      } else {
        displayPrice = "TBC";
        numericPrice = 0;
        isRange      = false;
      }

      return {
        description:  s.name,
        subdescription: s.description || null,
        location:     jobDetails.location ?? "",
        displayPrice,
        numericPrice,
        isRange,
        currency,
      };
    });
  }

  // Fallback: no catalogue match — use job description with TBC price
  // This is much better than guessing R1200
  return [{
    description:   jobDetails.service ?? jobDetails.matchedService ?? "Service",
    subdescription: jobDetails.description ?? null,
    location:      jobDetails.location ?? "",
    displayPrice:  "To be confirmed",
    numericPrice:  0,
    isRange:       false,
    currency,
    noMatch:       true,
  }];
}

// ─────────────────────────────────────────────────────────────
// GENERATE QUOTE PDF
// ─────────────────────────────────────────────────────────────

export async function generateQuotePDF({ tenant, jobDetails, quoteRef }) {
  const lineItems = await resolveLineItems(jobDetails, tenant);
  const currency  = tenant.currency ?? "ZAR";

  // Calculate totals
  const hasRanges  = lineItems.some(l => l.isRange);
  const totalMin   = lineItems.reduce((sum, l) => sum + (l.numericPrice ?? 0), 0);
  const totalMax   = lineItems.reduce((sum, l) => {
    if (l.isRange) {
      // Find the max price from the matched service
      return sum + (l.numericMax ?? l.numericPrice ?? 0);
    }
    return sum + (l.numericPrice ?? 0);
  }, 0);

  const pdfDoc  = await PDFDocument.create();
  const page    = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── Header bar ──────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: BLACK });
  page.drawText(tenant.businessName.toUpperCase(), {
    x: 40, y: height - 48, size: 18, font: fontBold, color: WHITE,
  });
  page.drawText("QUOTE", {
    x: width - 100, y: height - 48, size: 18, font: fontBold, color: RED,
  });

  // ── Quote details block ──────────────────────────────────
  const detailsY = height - 130;

  drawLabelValue(page, "Quote Ref:", quoteRef,                  40, detailsY,      fontBold, fontRegular);
  drawLabelValue(page, "Date:",      formatDate(new Date()),    40, detailsY - 18, fontBold, fontRegular);
  drawLabelValue(page, "Valid for:", `${tenant.validityDays} days`, 40, detailsY - 36, fontBold, fontRegular);

  // ── Prepared for block ───────────────────────────────────
  page.drawText("PREPARED FOR", { x: width - 220, y: detailsY,      size: 9, font: fontBold,    color: MID_GREY });
  page.drawText(jobDetails.customerName ?? "Valued Customer",
                                  { x: width - 220, y: detailsY - 18, size: 11, font: fontBold,   color: BLACK });
  if (jobDetails.location) {
    page.drawText(truncate(jobDetails.location, 28),
                                  { x: width - 220, y: detailsY - 36, size: 9,  font: fontRegular, color: BLACK });
  }

  // ── Divider ──────────────────────────────────────────────
  page.drawRectangle({ x: 40, y: detailsY - 60, width: width - 80, height: 1, color: LIGHT_GREY });

  // ── Table header ─────────────────────────────────────────
  const tableY = detailsY - 90;
  page.drawRectangle({ x: 40, y: tableY - 4, width: width - 80, height: 24, color: BLACK });
  page.drawText("SERVICE",                    { x: 50,          y: tableY + 4, size: 9, font: fontBold, color: WHITE });
  page.drawText("LOCATION",                   { x: 290,         y: tableY + 4, size: 9, font: fontBold, color: WHITE });
  page.drawText(`AMOUNT (${currency})`,       { x: width - 130, y: tableY + 4, size: 9, font: fontBold, color: WHITE });

  // ── Line items ───────────────────────────────────────────
  let rowY = tableY - 30;
  let rowIndex = 0;

  for (const item of lineItems) {
    const rowHeight = item.subdescription ? 38 : 26;

    // Alternate row shading
    if (rowIndex % 2 === 0) {
      page.drawRectangle({ x: 40, y: rowY - 10, width: width - 80, height: rowHeight, color: LIGHT_GREY });
    }

    page.drawText(truncate(item.description, 34),   { x: 50,          y: rowY + 4, size: 9,  font: fontBold,    color: BLACK });
    page.drawText(truncate(item.location, 20),       { x: 290,         y: rowY + 4, size: 9,  font: fontRegular, color: BLACK });
    page.drawText(item.displayPrice,                 { x: width - 130, y: rowY + 4, size: 9,  font: fontBold,    color: item.noMatch ? MID_GREY : BLACK });

    if (item.subdescription) {
      page.drawText(truncate(item.subdescription, 45), { x: 50, y: rowY - 10, size: 8, font: fontRegular, color: MID_GREY });
    }

    rowY    -= (rowHeight + 6);
    rowIndex++;
  }

  // ── No-match warning ──────────────────────────────────────
  if (lineItems.some(l => l.noMatch)) {
    page.drawText("* Pricing not configured — business will confirm final amount.", {
      x: 50, y: rowY - 4, size: 8, font: fontRegular, color: MID_GREY,
    });
    rowY -= 18;
  }

  // ── Total block ───────────────────────────────────────────
  const totalY = rowY - 20;
  page.drawRectangle({ x: width - 210, y: totalY - 8, width: 170, height: 30, color: BLACK });
  page.drawText("TOTAL", { x: width - 200, y: totalY + 6, size: 10, font: fontBold, color: WHITE });

  let totalDisplay;
  if (lineItems.every(l => l.noMatch)) {
    totalDisplay = "TBC";
  } else if (hasRanges) {
    totalDisplay = `${currency} ${formatCurrency(totalMin)} – ${formatCurrency(totalMax)}`;
  } else {
    totalDisplay = `${currency} ${formatCurrency(totalMin)}`;
  }
  page.drawText(totalDisplay, { x: width - 155, y: totalY + 6, size: 10, font: fontBold, color: RED });

  // ── Range note ────────────────────────────────────────────
  if (hasRanges) {
    page.drawText("Final price confirmed on site visit depending on scope of work.", {
      x: 40, y: totalY - 22, size: 8, font: fontRegular, color: MID_GREY,
    });
  }

  // ── Job description ───────────────────────────────────────
  const notesY = totalY - (hasRanges ? 55 : 40);
  page.drawText("JOB DESCRIPTION", { x: 40, y: notesY, size: 9, font: fontBold, color: MID_GREY });
  page.drawText(truncate(jobDetails.description ?? "As discussed", 90), {
    x: 40, y: notesY - 16, size: 9, font: fontRegular, color: BLACK,
  });

  // ── Terms ─────────────────────────────────────────────────
  const termsY = notesY - 50;
  page.drawText("TERMS", { x: 40, y: termsY, size: 9, font: fontBold, color: MID_GREY });
  const terms = [
    `This quote is valid for ${tenant.validityDays} days from the date of issue.`,
    "Prices exclude VAT unless otherwise stated.",
    "A 50% deposit is required before work commences.",
  ];
  terms.forEach((line, i) => {
    page.drawText(`• ${line}`, { x: 40, y: termsY - 16 - (i * 14), size: 8, font: fontRegular, color: MID_GREY });
  });

  // ── Footer ────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width, height: 40, color: BLACK });
  page.drawText("Powered by Rebel Shap — rebeldesigns.co.za", { x: 40, y: 14, size: 8, font: fontRegular, color: MID_GREY });
  page.drawText("To accept this quote, reply YES on WhatsApp.", { x: width - 260, y: 14, size: 8, font: fontRegular, color: MID_GREY });

  // ── Save ──────────────────────────────────────────────────
  const pdfBytes = await pdfDoc.save();
  const blob     = await put(`quotes/${quoteRef}.pdf`, pdfBytes, { access: "public", contentType: "application/pdf" });

  return { url: blob.url, ref: quoteRef, price: totalMin, lineItems };
}

// ─────────────────────────────────────────────────────────────
// GENERATE INVOICE PDF
// ─────────────────────────────────────────────────────────────

export async function generateInvoicePDF({ tenant, jobDetails, invoiceRef, quoteRef, price, lineItems }) {
  const currency = tenant.currency ?? "ZAR";

  // If lineItems not passed in, resolve them fresh
  const items = lineItems ?? await resolveLineItems(jobDetails, tenant);

  const pdfDoc  = await PDFDocument.create();
  const page    = pdfDoc.addPage([595, 842]);
  const { width, height } = page.getSize();

  const fontBold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // ── Header ────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: BLACK });
  page.drawText(tenant.businessName.toUpperCase(), { x: 40, y: height - 48, size: 18, font: fontBold, color: WHITE });
  page.drawText("INVOICE", { x: width - 120, y: height - 48, size: 18, font: fontBold, color: RED });

  // ── Invoice details ───────────────────────────────────────
  const detailsY = height - 130;
  drawLabelValue(page, "Invoice Ref:", invoiceRef,               40, detailsY,      fontBold, fontRegular);
  drawLabelValue(page, "Quote Ref:",   quoteRef,                 40, detailsY - 18, fontBold, fontRegular);
  drawLabelValue(page, "Date:",        formatDate(new Date()),   40, detailsY - 36, fontBold, fontRegular);
  drawLabelValue(page, "Due:",         formatDate(addDays(new Date(), 7)), 40, detailsY - 54, fontBold, fontRegular);

  page.drawText("BILLED TO",                          { x: width - 220, y: detailsY,      size: 9,  font: fontBold,    color: MID_GREY });
  page.drawText(jobDetails.customerName ?? "Valued Customer", { x: width - 220, y: detailsY - 18, size: 11, font: fontBold,   color: BLACK });

  // ── Divider ───────────────────────────────────────────────
  page.drawRectangle({ x: 40, y: detailsY - 80, width: width - 80, height: 1, color: LIGHT_GREY });

  // ── Table header ──────────────────────────────────────────
  const tableY = detailsY - 110;
  page.drawRectangle({ x: 40, y: tableY - 4, width: width - 80, height: 24, color: BLACK });
  page.drawText("SERVICE",              { x: 50,          y: tableY + 4, size: 9, font: fontBold, color: WHITE });
  page.drawText(`AMOUNT (${currency})`, { x: width - 130, y: tableY + 4, size: 9, font: fontBold, color: WHITE });

  // ── Line items ────────────────────────────────────────────
  let rowY = tableY - 30;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i % 2 === 0) {
      page.drawRectangle({ x: 40, y: rowY - 8, width: width - 80, height: 26, color: LIGHT_GREY });
    }
    page.drawText(truncate(item.description, 55), { x: 50,          y: rowY + 4, size: 9, font: fontRegular, color: BLACK });
    page.drawText(item.displayPrice,               { x: width - 130, y: rowY + 4, size: 9, font: fontBold,    color: BLACK });
    rowY -= 32;
  }

  // ── Total ─────────────────────────────────────────────────
  const totalY = rowY - 20;
  page.drawRectangle({ x: width - 210, y: totalY - 8, width: 170, height: 30, color: BLACK });
  page.drawText("TOTAL DUE",                { x: width - 200, y: totalY + 6, size: 10, font: fontBold, color: WHITE });
  page.drawText(`${currency} ${formatCurrency(price)}`, { x: width - 120, y: totalY + 6, size: 10, font: fontBold, color: RED });

  // ── Payment ───────────────────────────────────────────────
  const payY = totalY - 50;
  page.drawText("PAYMENT", { x: 40, y: payY, size: 9, font: fontBold, color: MID_GREY });
  page.drawText("Please use your Invoice Reference as the payment reference.", { x: 40, y: payY - 16, size: 9, font: fontRegular, color: BLACK });
  page.drawText("Send proof of payment to confirm your booking.", { x: 40, y: payY - 30, size: 9, font: fontRegular, color: BLACK });

  // ── Footer ────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width, height: 40, color: BLACK });
  page.drawText("Powered by Rebel Shap — rebeldesigns.co.za", { x: 40, y: 14, size: 8, font: fontRegular, color: MID_GREY });
  page.drawText("Thank you for your business.", { x: width - 180, y: 14, size: 8, font: fontRegular, color: MID_GREY });

  const pdfBytes = await pdfDoc.save();
  const blob     = await put(`invoices/${invoiceRef}.pdf`, pdfBytes, { access: "public", contentType: "application/pdf" });

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

function drawLabelValue(page, label, value, x, y, fontBold, fontRegular) {
  page.drawText(label, { x,       y, size: 9, font: fontBold,    color: MID_GREY });
  page.drawText(value, { x: x+90, y, size: 9, font: fontRegular, color: BLACK });
}

function formatDate(date) {
  return date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
}

function formatCurrency(amount) {
  return Number(amount).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}
