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
 * @param {object} quote - { quote_number, quote_date, client, area, location,
 *                            project_description,
 *                            tax_enabled, tax_label, tax_rate, notes,
 *                            sections: [{ uid, categoryId, categoryName, locationLabel }],
 *                            line_items: [{ kind, category_id, category_name,
 *                                           section_uid, section_location,
 *                                           description, unit, qty, rate,
 *                                           markup_enabled, markup_pct, markup_label,
 *                                           subtotal }] }
 *
 *   Lines are grouped by section_uid (when present) or category_id (legacy).
 *   Each group gets a category header (+ location label if set) and a
 *   per-section subtotal. The `sections` array (if supplied) controls render
 *   order; otherwise first-appearance order is used.
 *
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
  if (quote.location) drawField('Location:', quote.location);
  drawField('Quote Date:', formatQuoteDate(quote.quote_date));
  if (quote.project_description) drawField('Project:', quote.project_description);

  y += 6;

  // ── Line items, grouped by section ──
  // Priority: group by section_uid (new multi-section quotes) with fallback
  // to category_id (legacy single-section quotes saved before this update).
  // The `sections` array on the payload controls render order when present.
  const colSubW = 90;
  const colRateW = 70;
  const colUnitW = 60;
  const colQtyW = 50;
  const colDescW = contentW - colQtyW - colUnitW - colRateW - colSubW;
  const headerH = 20;
  const sectionHeaderH = 22;

  const qtyCenterX = marginL + colDescW + colQtyW / 2;
  const unitCenterX = marginL + colDescW + colQtyW + colUnitW / 2;
  const rateCenterX = marginL + colDescW + colQtyW + colUnitW + colRateW / 2;
  const subCenterX = marginL + colDescW + colQtyW + colUnitW + colRateW + colSubW / 2;

  const reserveY = pageH - 80;

  const drawCategoryHeader = (name, locationLabel) => {
    // Compact band: "Category Name — Location Label" (if location set)
    const headerText = locationLabel ? `${name} \u2014 ${locationLabel}` : (name || 'Category');
    doc.setDrawColor(80);
    doc.setFillColor(218, 230, 246);
    doc.rect(marginL, y, contentW, sectionHeaderH, 'F');
    doc.setLineWidth(0.5);
    doc.rect(marginL, y, contentW, sectionHeaderH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(30, 60, 100);
    doc.text(headerText, marginL + 6, y + 15);
    doc.setTextColor(0);
    y += sectionHeaderH;
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.setFont('helvetica', 'normal');
  };

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
    doc.setDrawColor(180);
    doc.setLineWidth(0.3);
    doc.setFont('helvetica', 'normal');
  };

  let currentCategoryName = '';
  let currentLocationLabel = '';
  const newPageIfNeeded = (needed, { redrawHeader = false } = {}) => {
    if (y + needed > reserveY) {
      doc.addPage();
      y = 36;
      if (redrawHeader) {
        if (currentCategoryName) drawCategoryHeader(currentCategoryName, currentLocationLabel);
        drawTableHeader();
      }
    }
  };

  const items = Array.isArray(quote.line_items) ? quote.line_items : [];

  // Build ordered groups. Strategy:
  // 1. If a `sections` array is passed (new format), use it to define order +
  //    metadata (name, locationLabel). Each section = one group keyed by uid.
  // 2. Otherwise fall back to first-appearance of category_id (legacy).
  const groupOrder = [];   // keys in render order
  const groupMap = new Map(); // key → { name, locationLabel, lines[] }

  const sectionsArray = Array.isArray(quote.sections) ? quote.sections : [];

  if (sectionsArray.length > 0) {
    // New format: sections array controls order and provides location labels.
    for (const sec of sectionsArray) {
      const key = sec.uid || sec.categoryId;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          name: sec.categoryName || sec.category_name || '',
          locationLabel: sec.locationLabel || sec.location_label || '',
          lines: [],
        });
        groupOrder.push(key);
      }
    }
    // Place each line into its section bucket.
    for (const li of items) {
      if (!li) continue;
      // Prefer section_uid match first, then fallback to category_id match.
      let placed = false;
      if (li.section_uid) {
        if (groupMap.has(li.section_uid)) {
          groupMap.get(li.section_uid).lines.push(li);
          placed = true;
        }
      }
      if (!placed) {
        // Try matching by category_id against the sections array (partial legacy).
        const catKey = li.category_id != null ? String(li.category_id) : '';
        for (const [key, grp] of groupMap.entries()) {
          const sec = sectionsArray.find((s) => (s.uid || s.categoryId) === key);
          if (sec && String(sec.categoryId || sec.category_id) === catKey) {
            grp.lines.push(li);
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        // Orphan — put into a catch-all group.
        const orphanKey = '__orphan__';
        if (!groupMap.has(orphanKey)) {
          groupMap.set(orphanKey, { name: 'Other', locationLabel: '', lines: [] });
          groupOrder.push(orphanKey);
        }
        groupMap.get(orphanKey).lines.push(li);
      }
    }
  } else {
    // Legacy format: group by category_id, first-appearance order.
    for (const li of items) {
      if (!li) continue;
      const key = li.category_id != null ? String(li.category_id) : '';
      if (!groupMap.has(key)) {
        const name = li.category_name || (key === '' ? 'Other' : '');
        // Per-line section_location used for legacy lines that carry it.
        const locationLabel = li.section_location || '';
        groupMap.set(key, { name, locationLabel, lines: [] });
        groupOrder.push(key);
      }
      groupMap.get(key).lines.push(li);
    }
  }

  for (const key of groupOrder) {
    const group = groupMap.get(key);
    if (!group || group.lines.length === 0) continue;

    newPageIfNeeded(sectionHeaderH + headerH + 24);
    currentCategoryName = group.name;
    currentLocationLabel = group.locationLabel;
    drawCategoryHeader(group.name, group.locationLabel);
    drawTableHeader();

    let groupSubtotal = 0;

    for (const line of group.lines) {
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

      const descBase = line.description || '';
      const wrappedDesc = doc.splitTextToSize(descBase || '', colDescW - 8);
      const rowH = Math.max(18, wrappedDesc.length * 11 + 6);
      newPageIfNeeded(rowH, { redrawHeader: true });

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.rect(marginL, y, contentW, rowH);
      let vx = marginL + colDescW;
      doc.line(vx, y, vx, y + rowH); vx += colQtyW;
      doc.line(vx, y, vx, y + rowH); vx += colUnitW;
      doc.line(vx, y, vx, y + rowH); vx += colRateW;
      doc.line(vx, y, vx, y + rowH);

      doc.text(wrappedDesc, marginL + 4, y + 12);

      const numY = y + 13;
      const qtyText = line.qty != null && line.qty !== '' ? formatNumber(line.qty, 4) : '';
      const unitText = String(line.unit || '');
      const rateText = line.rate != null && line.rate !== '' ? formatMoney(line.rate) : '';
      const lineSub = Number(line.subtotal ?? computeLineSubtotal(line)) || 0;
      groupSubtotal += lineSub;
      const subText = formatMoney(lineSub);

      doc.text(qtyText,  qtyCenterX,  numY, { align: 'center' });
      doc.text(unitText, unitCenterX, numY, { align: 'center' });
      doc.text(rateText, rateCenterX, numY, { align: 'center' });
      doc.setFont('helvetica', 'bold');
      doc.text(subText,  subCenterX,  numY, { align: 'center' });
      doc.setFont('helvetica', 'normal');

      y += rowH;
    }

    // Per-section subtotal — label includes location if set.
    newPageIfNeeded(22);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    const subLabel = group.locationLabel
      ? `${group.name || 'Section'} (${group.locationLabel}) subtotal`
      : `${group.name || 'Category'} subtotal`;
    doc.text(subLabel, subCenterX - colSubW / 2 - 4, y + 12, { align: 'right' });
    doc.text(formatMoney(Math.round(groupSubtotal * 100) / 100), pageW - marginR - 4, y + 12, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    y += 18;
    y += 6;
  }

  // ── Totals block ──
  currentCategoryName = '';
  currentLocationLabel = '';
  const totals = computeQuoteTotals({
    lineItems: items,
    taxEnabled: !!quote.tax_enabled,
    taxRate: quote.tax_rate,
  });

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

  // ── Footer (every page) ──
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
