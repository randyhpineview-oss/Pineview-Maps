import { jsPDF } from 'jspdf';

// Cache the logo so we only fetch once across multiple PDF generations.
let _logoDataUrl = null;

async function loadLogo() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    const resp = await fetch('/logo.png');
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        _logoDataUrl = reader.result;
        resolve(_logoDataUrl);
      };
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ── Money / number formatting helpers ─────────────────────────────────────
function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(n, max = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  // Trim trailing zeros so 1.0 → "1" and 0.025 → "0.025"
  return v.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: max });
}

/**
 * Compute the priced subtotal for a single line. Note rows always 0.
 * Catalog / custom rows: qty × rate, optionally × (1 + markup/100).
 */
export function computeLineSubtotal(line) {
  if (!line || line.kind === 'note') return 0;
  const qty = Number(line.qty);
  const rate = Number(line.rate);
  if (!Number.isFinite(qty) || !Number.isFinite(rate)) return 0;
  let base = qty * rate;
  if (line.markup_enabled) {
    const pct = Number(line.markup_pct);
    if (Number.isFinite(pct) && pct > 0) {
      base = base * (1 + pct / 100);
    }
  }
  return Math.round(base * 100) / 100;
}

/**
 * Compute aggregate totals for the whole quote. Mirrors the server-side
 * `_compute_totals` in app/quotes_routes.py so client and server agree.
 */
export function computeQuoteTotals({ lineItems = [], taxEnabled = false, taxRate = null }) {
  let subtotal = 0;
  for (const li of lineItems) {
    if (!li || li.kind === 'note') continue;
    subtotal += Number(li.subtotal ?? computeLineSubtotal(li)) || 0;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  let taxAmount = 0;
  if (taxEnabled && taxRate != null && Number(taxRate) > 0) {
    taxAmount = Math.round(subtotal * (Number(taxRate) / 100) * 100) / 100;
  }
  const grandTotal = Math.round((subtotal + taxAmount) * 100) / 100;
  return { subtotal, taxAmount, grandTotal };
}

/**
 * Generate a Quote PDF.
 *
 * @param {object} quote - { quote_number, quote_date, client, area, project_description,
 *                            mix_categories, tax_enabled, tax_label, tax_rate, notes,
 *                            line_items: [{ kind, category_name?, description, unit,
 *                                           qty, rate, markup_enabled, markup_pct,
 *                                           markup_label, subtotal }] }
 * Returns { blob, base64 }.
 */
export async function generateQuotePdf(quote) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();   // 612
  const pageH = doc.internal.pageSize.getHeight();  // 792
  const marginL = 36;
  const marginR = 36;
  const contentW = pageW - marginL - marginR;
  let y = 36;

  const drawRect = (x, yy, w, h) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.rect(x, yy, w, h);
  };

  // ── Header: logo + title + Quote # (mirrors HerbicideLeaseSheet PDF) ──
  const logoData = await loadLogo();
  if (logoData) {
    doc.addImage(logoData, 'PNG', marginL, y, 100, 100);
  }
  const titleY = y + 45;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(50, 80, 50);
  doc.text('Quote', marginL + 120, titleY);
  doc.setTextColor(0);

  doc.setFontSize(12);
  doc.text(`No: ${quote.quote_number || 'Q###### (pending)'}`, pageW - marginR, titleY, { align: 'right' });

  // Address strip below title
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100);
  doc.text('7077 252 Road, Pineview, BC, Canada, V1J 8E3', marginL + 120, titleY + 14);
  doc.text('Tel: 250.261.9544 | office@pineviewmanagement.com', marginL + 120, titleY + 24);
  doc.text('www.pineviewvegetation.com', marginL + 120, titleY + 34);
  doc.setTextColor(0);

  y += 110;

  // ── Bill-To block ──
  const labelW = 110;
  const drawField = (label, value) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(label, marginL, y);
    doc.setFont('helvetica', 'normal');
    const text = String(value ?? '');
    const lines = doc.splitTextToSize(text, contentW - labelW);
    doc.text(lines, marginL + labelW, y);
    y += 14 * Math.max(1, lines.length);
  };

  drawField('Client:', quote.client || '');
  if (quote.area) drawField('Area:', quote.area);
  drawField('Quote Date:', formatQuoteDate(quote.quote_date));
  if (quote.project_description) drawField('Project:', quote.project_description);

  y += 6;

  // ── Line items table ──
  // Columns: Description (flex) | Qty (right) | Unit (left) | Rate (right) | Subtotal (right)
  // When `mix_categories`, we also surface the Category as a sub-line under
  // the description. Note rows render as a single full-width italic row.
  const colSubW = 80;
  const colRateW = 70;
  const colUnitW = 60;
  const colQtyW = 50;
  const colDescW = contentW - colQtyW - colUnitW - colRateW - colSubW;
  const headerH = 20;

  // Header row
  doc.setDrawColor(80);
  doc.setFillColor(235, 240, 250);
  doc.rect(marginL, y, contentW, headerH, 'F');
  doc.setLineWidth(0.5);
  doc.rect(marginL, y, contentW, headerH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  let cx = marginL + 4;
  doc.text('Description', cx, y + 13);
  cx += colDescW;
  doc.text('Qty', cx + colQtyW - 4, y + 13, { align: 'right' });
  cx += colQtyW;
  doc.text('Unit', cx + 4, y + 13);
  cx += colUnitW;
  doc.text('Rate', cx + colRateW - 4, y + 13, { align: 'right' });
  cx += colRateW;
  doc.text('Subtotal', cx + colSubW - 4, y + 13, { align: 'right' });
  y += headerH;

  const items = Array.isArray(quote.line_items) ? quote.line_items : [];
  const newPageIfNeeded = (needed) => {
    if (y + needed > pageH - 80) {
      doc.addPage();
      y = 36;
    }
  };

  // Reset draw color/font for body rows.
  doc.setDrawColor(180);
  doc.setLineWidth(0.3);

  for (const line of items) {
    if (!line) continue;
    const kind = line.kind || 'catalog';

    if (kind === 'note') {
      const noteText = String(line.description || '').trim();
      if (!noteText) continue;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      const lines = doc.splitTextToSize(noteText, contentW - 8);
      const rowH = Math.max(18, lines.length * 12 + 6);
      newPageIfNeeded(rowH);
      doc.rect(marginL, y, contentW, rowH);
      doc.text(lines, marginL + 4, y + 13);
      y += rowH;
      continue;
    }

    // Priced row (catalog or custom).
    const descBase = line.description || '';
    const descLines = [];
    if (descBase) descLines.push(descBase);
    if (line.markup_enabled && Number(line.markup_pct) > 0) {
      const mkLabel = line.markup_label ? `${line.markup_label} ` : '';
      descLines.push(`(${mkLabel}+${formatNumber(line.markup_pct, 2)}%)`);
    }
    if (quote.mix_categories && line.category_name) {
      descLines.push(`— ${line.category_name}`);
    }
    const wrappedDesc = doc.splitTextToSize(descLines.join('  '), colDescW - 8);
    const rowH = Math.max(18, wrappedDesc.length * 11 + 6);
    newPageIfNeeded(rowH);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    // Cell outlines (single rect spanning all columns + verticals for grid feel)
    doc.rect(marginL, y, contentW, rowH);
    let vx = marginL + colDescW;
    doc.line(vx, y, vx, y + rowH); vx += colQtyW;
    doc.line(vx, y, vx, y + rowH); vx += colUnitW;
    doc.line(vx, y, vx, y + rowH); vx += colRateW;
    doc.line(vx, y, vx, y + rowH);

    // Description (multi-line)
    doc.text(wrappedDesc, marginL + 4, y + 12);

    // Right side numbers (vertically centered on first line)
    const numY = y + 13;
    const qtyText = line.qty != null && line.qty !== '' ? formatNumber(line.qty, 4) : '';
    const unitText = String(line.unit || '');
    const rateText = line.rate != null && line.rate !== '' ? formatMoney(line.rate) : '';
    const subText = formatMoney(line.subtotal ?? computeLineSubtotal(line));

    cx = marginL + colDescW;
    doc.text(qtyText, cx + colQtyW - 4, numY, { align: 'right' });
    cx += colQtyW;
    doc.text(unitText, cx + 4, numY);
    cx += colUnitW;
    doc.text(rateText, cx + colRateW - 4, numY, { align: 'right' });
    cx += colRateW;
    doc.setFont('helvetica', 'bold');
    doc.text(subText, cx + colSubW - 4, numY, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    y += rowH;
  }

  // ── Totals block (right-aligned, similar to TM ticket footer) ──
  const totals = computeQuoteTotals({
    lineItems: items,
    taxEnabled: !!quote.tax_enabled,
    taxRate: quote.tax_rate,
  });

  y += 8;
  newPageIfNeeded(70);
  const totalsLabelX = pageW - marginR - 180;
  const totalsValueX = pageW - marginR - 4;
  const drawTotalRow = (label, value, { bold = false } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(bold ? 11 : 10);
    doc.text(label, totalsLabelX, y);
    doc.text(formatMoney(value), totalsValueX, y, { align: 'right' });
    y += bold ? 18 : 14;
  };

  drawTotalRow('Subtotal', totals.subtotal);
  if (quote.tax_enabled) {
    const taxLabel = `${quote.tax_label || 'Tax'} (${formatNumber(quote.tax_rate, 3)}%)`;
    drawTotalRow(taxLabel, totals.taxAmount);
  }
  // Divider
  doc.setDrawColor(60);
  doc.setLineWidth(0.5);
  doc.line(totalsLabelX, y - 4, pageW - marginR, y - 4);
  y += 2;
  drawTotalRow('Grand Total', totals.grandTotal, { bold: true });

  // ── Quote-level notes ──
  if (quote.notes && String(quote.notes).trim()) {
    y += 8;
    newPageIfNeeded(60);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Notes:', marginL, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    const noteLines = doc.splitTextToSize(String(quote.notes), contentW);
    doc.text(noteLines, marginL, y);
    y += 12 * noteLines.length;
  }

  // ── Footer (last page) ──
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  doc.setTextColor(120);
  doc.text(
    'Quote valid for 30 days. Final billing on a Time & Materials basis unless otherwise noted.',
    marginL,
    pageH - 36,
  );
  doc.setTextColor(0);

  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1];
  return { blob, base64 };
}

function formatQuoteDate(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    // ISO YYYY-MM-DD — render as Mon DD, YYYY for the PDF without timezone drift.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) {
      const [, y, mm, dd] = m;
      const d = new Date(Number(y), Number(mm) - 1, Number(dd));
      return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    return value;
  }
  if (value instanceof Date) {
    return value.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return String(value);
}
