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
  // Columns: Description (flex, left) | Qty (center) | Unit (center) | Rate (center) | Subtotal (center)
  // When `mix_categories`, we also surface the Category as a sub-line under
  // the description. Note rows render as a single full-width italic row.
  // Subtotal widened from 80 → 90 to keep dollar amounts off the right edge.
  const colSubW = 90;
  const colRateW = 70;
  const colUnitW = 60;
  const colQtyW = 50;
  const colDescW = contentW - colQtyW - colUnitW - colRateW - colSubW;
  const headerH = 20;

  // X-coordinate of the *center* of each non-description column. Used by
  // both the header and the body so the column heading sits directly
  // above its data.
  const qtyCenterX = marginL + colDescW + colQtyW / 2;
  const unitCenterX = marginL + colDescW + colQtyW + colUnitW / 2;
  const rateCenterX = marginL + colDescW + colQtyW + colUnitW + colRateW / 2;
  const subCenterX = marginL + colDescW + colQtyW + colUnitW + colRateW + colSubW / 2;

  // Drawing the table header is wrapped in a closure so we can call it
  // again after a page break — otherwise rows on page 2+ would float
  // without any column labels.
  const drawTableHeader = () => {
    doc.setDrawColor(80);
    doc.setFillColor(235, 240, 250);
    doc.rect(marginL, y, contentW, headerH, 'F');
    doc.setLineWidth(0.5);
    doc.rect(marginL, y, contentW, headerH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Description', marginL + 4, y + 13);
    doc.text('Qty',      qtyCenterX,  y + 13, { align: 'center' });
    doc.text('Unit',     unitCenterX, y + 13, { align: 'center' });
    doc.text('Rate',     rateCenterX, y + 13, { align: 'center' });
    doc.text('Subtotal', subCenterX,  y + 13, { align: 'center' });
    y += headerH;
    // Reset draw color/font for body rows.
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.setFont('helvetica', 'normal');
  };

  drawTableHeader();

  const items = Array.isArray(quote.line_items) ? quote.line_items : [];
  // `redrawHeader` flag controls whether the table column header gets
  // repeated on the new page. Inside the row loop we want it; for the
  // totals block / quote notes we don't (they aren't tabular).
  // Bottom reserve = 80pt: the footer text is at pageH-36, so this
  // leaves ~44pt clearance for tall multi-line rows + the footer caps
  // (avoids the overlap risk we'd have at e.g. pageH-60).
  const newPageIfNeeded = (needed, { redrawHeader = false } = {}) => {
    if (y + needed > pageH - 80) {
      doc.addPage();
      y = 36;
      if (redrawHeader) drawTableHeader();
    }
  };

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
      newPageIfNeeded(rowH, { redrawHeader: true });
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
    newPageIfNeeded(rowH, { redrawHeader: true });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    // Cell outlines (single rect spanning all columns + verticals for grid feel)
    doc.rect(marginL, y, contentW, rowH);
    let vx = marginL + colDescW;
    doc.line(vx, y, vx, y + rowH); vx += colQtyW;
    doc.line(vx, y, vx, y + rowH); vx += colUnitW;
    doc.line(vx, y, vx, y + rowH); vx += colRateW;
    doc.line(vx, y, vx, y + rowH);

    // Description (multi-line, left-aligned)
    doc.text(wrappedDesc, marginL + 4, y + 12);

    // Numeric / unit cells — all centered so the value sits directly
    // beneath its centered column heading. Decimal-alignment on currency
    // is sacrificed for visual cleanliness; the per-line subtotals are
    // bold so they still scan vertically.
    const numY = y + 13;
    const qtyText = line.qty != null && line.qty !== '' ? formatNumber(line.qty, 4) : '';
    const unitText = String(line.unit || '');
    const rateText = line.rate != null && line.rate !== '' ? formatMoney(line.rate) : '';
    const subText = formatMoney(line.subtotal ?? computeLineSubtotal(line));

    doc.text(qtyText,  qtyCenterX,  numY, { align: 'center' });
    doc.text(unitText, unitCenterX, numY, { align: 'center' });
    doc.text(rateText, rateCenterX, numY, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.text(subText,  subCenterX,  numY, { align: 'center' });
    doc.setFont('helvetica', 'normal');

    y += rowH;
  }

  // ── Totals block (right-aligned, similar to TM ticket footer) ──
  const totals = computeQuoteTotals({
    lineItems: items,
    taxEnabled: !!quote.tax_enabled,
    taxRate: quote.tax_rate,
  });

  // Breathing room between the last table row and the totals block.
  // Was 8pt — looked cramped against the row stroke. 28pt ≈ 0.4" gives
  // the totals their own visual zone.
  y += 28;
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
  // Divider with proper clearance.
  // After the last regular row, `y` is one line-height past the previous
  // baseline. We add 4pt padding before the divider, then 14pt before the
  // Grand Total baseline so the 11pt bold caps don't overlap the line
  // (was: line at y-4 → 6pt above GT caps → visible overlap on the descender).
  y += 4;
  doc.setDrawColor(60);
  doc.setLineWidth(0.5);
  doc.line(totalsLabelX, y, pageW - marginR, y);
  y += 14;
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

  // ── Footer (every page, including page 1 when content overflows) ──
  // Loop over every page added by jsPDF and stamp the footer + page
  // number. Drawing in a single pass at the end means we know the final
  // page count so "Page X of Y" can be accurate.
  const totalPages = doc.internal.getNumberOfPages();
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  doc.setTextColor(120);
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.text(
      'Quote valid for 30 days. Final billing on a Time & Materials basis unless otherwise noted.',
      marginL,
      pageH - 36,
    );
    if (totalPages > 1) {
      doc.text(`Page ${p} of ${totalPages}`, pageW - marginR, pageH - 36, { align: 'right' });
    }
  }
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
