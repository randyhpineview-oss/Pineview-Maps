import { jsPDF } from 'jspdf';

// Cache the logo so we only fetch once
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

/**
 * Default office lines pre-seeded when a new ticket is opened.
 * Office types QTY and Rate per row; Sub Total/GST/Total computed here.
 */
export const DEFAULT_OFFICE_LINES = [
  { label: 'Truck Unit (/hr)', qty: '', rate: '' },
  { label: 'Lead Applicator (/hr)', qty: '', rate: '' },
  { label: 'Assistant Applicator (/hr)', qty: '', rate: '' },
  { label: 'UTV Unit (/day)', qty: '', rate: '' },
  { label: 'Backpack (/day)', qty: '', rate: '' },
  { label: 'H2S Monitors', qty: '', rate: '' },
  { label: '1 Herbicide (m²)', qty: '', rate: '' },
  { label: '2 Herbicides (m²)', qty: '', rate: '' },
  { label: '3 Herbicides (m²)', qty: '', rate: '' },
  { label: 'Roadside/Access Rd Liters Applied', qty: '', rate: '' },
  { label: 'Travel Km', qty: '', rate: '' },
];

/**
 * Auto-populated office line labels whose QTY comes from Sites Treated rows,
 * not from user input. Used by the detail sheet to render these as read-only
 * (unless the user explicitly overrides).
 */
export const AUTO_LINE_LABELS = [
  '1 Herbicide (m²)',
  '2 Herbicides (m²)',
  '3 Herbicides (m²)',
  'Roadside/Access Rd Liters Applied',
];

/**
 * Labels that a worker role can edit QTY on (never Rate). All other office
 * lines are office/admin-only for QTY edits.
 */
export const WORKER_EDITABLE_LINE_LABELS = [
  'Truck Unit (/hr)',
  'Lead Applicator (/hr)',
  'Assistant Applicator (/hr)',
  'UTV Unit (/day)',
  'Backpack (/day)',
  'H2S Monitors',
  'Travel Km',
];

/**
 * Map legacy labels (from previously-saved office_data) to their current name.
 * Keeps older tickets rendering correctly after we rename a pre-seeded line.
 */
const LEGACY_LABEL_MIGRATIONS = {
  'Roadside/Access Rd Kms Sprayed': 'Roadside/Access Rd Liters Applied',
};

export function migrateOfficeLineLabel(label) {
  return LEGACY_LABEL_MIGRATIONS[label] || label;
}

export function computeOfficeTotals(officeData) {
  const lines = officeData?.lines || [];
  const gstPercent = Number(officeData?.gst_percent ?? 5) || 0;
  const subTotal = lines.reduce((sum, line) => {
    const qty = parseFloat(line.qty) || 0;
    const rate = parseFloat(line.rate) || 0;
    return sum + qty * rate;
  }, 0);
  const gst = subTotal * (gstPercent / 100);
  const total = subTotal + gst;
  return { subTotal, gst, total, gstPercent };
}

function formatMoney(n) {
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toFixed(2);
}

/**
 * Generate a Time & Materials Ticket PDF.
 *
 * @param {object} ticket - TimeMaterialsTicket with { ticket_number, spray_date, client, area,
 *                          description_of_work, po_approval_number, rows, office_data, approved_signature,
 *                          approved_by_name }
 * @param {object} [options] - { includeOfficeData=false, signaturePng=null }
 * Returns { blob, base64 }
 */
export async function generateTMTicketPdf(ticket, options = {}) {
  const {
    includeOfficeData = false,
    signaturePng = null,
  } = options;

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

  // ── Logo ──
  const logoData = await loadLogo();
  if (logoData) {
    doc.addImage(logoData, 'PNG', marginL, y, 100, 100);
  }

  // ── Title + Ticket No (aligned on same baseline as Lease Sheet) ──
  const titleY = y + 45;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(50, 80, 50);
  doc.text('Time and Materials Herbicide Ticket', marginL + 120, titleY);
  doc.setTextColor(0);

  // Ticket No (same baseline as title)
  doc.setFontSize(12);
  doc.text(`No: ${ticket.ticket_number || ''}`, pageW - marginR, titleY, { align: 'right' });

  // Address line
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100);
  doc.text('7077 252 Road, Pineview, BC, Canada, V1J 8E3', marginL + 120, titleY + 14);
  doc.text('Tel: 250.261.9544 | www.pineviewvegetation.com', marginL + 120, titleY + 24);
  doc.setTextColor(0);

  y += 110;

  // ── Customer / Area / Date / PO block ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Customer:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(ticket.client || '', marginL + 60, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Date:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(String(ticket.spray_date || ''), marginL + 345, y);
  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.text('Area:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(ticket.area || '', marginL + 60, y);
  doc.setFont('helvetica', 'bold');
  doc.text('PO/Approval #:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(ticket.po_approval_number || '', marginL + 395, y);
  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.text('Description of Work:', marginL, y);
  doc.setFont('helvetica', 'normal');
  const descLines = doc.splitTextToSize(ticket.description_of_work || '', contentW - 130);
  doc.text(descLines, marginL + 115, y);
  y += Math.max(14, descLines.length * 12);

  // ── Sites Treated table ──
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Sites Treated', pageW / 2, y, { align: 'center' });
  y += 6;

  // Columns: Location | (site type) | Herbicides | (L) Used | Area (ha / km) | Cost Code
  // Roadside rows show the area as km; everything else as ha. The unit is
  // inferred from row.site_type === 'Roadside' at render time.
  const colWidths = [110, 70, 85, 60, 60, 155];  // sums to ~540
  const rowH = 16;
  const totalTableW = colWidths.reduce((a, b) => a + b, 0);
  const headers = ['Location', ' ', 'Herbicides', '(L) Used', 'Area', 'Cost Code'];

  // Header row
  let cx = marginL;
  doc.setFillColor(240, 240, 240);
  doc.rect(marginL, y, totalTableW, rowH, 'F');
  doc.setFontSize(8);
  for (let i = 0; i < colWidths.length; i++) {
    drawRect(cx, y, colWidths[i], rowH);
    if (headers[i].trim()) {
      doc.text(headers[i], cx + 4, y + 11);
    }
    cx += colWidths[i];
  }
  y += rowH;

  // Data rows — ensure at least 18 rows for manual addenda
  const rows = ticket.rows || [];
  const minRows = 18;
  const rowCount = Math.max(rows.length, minRows);

  doc.setFont('helvetica', 'normal');
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r] || {};
    cx = marginL;
    const isRoadside = row.site_type === 'Roadside';
    const areaValue = row.area_ha != null && row.area_ha !== '' ? Number(row.area_ha).toFixed(2) : '';
    const areaText = areaValue ? `${areaValue} ${isRoadside ? 'km' : 'ha'}` : '';
    const cells = [
      row.location || '',
      row.site_type || '',
      row.herbicides || '',
      row.liters_used != null && row.liters_used !== '' ? Number(row.liters_used).toFixed(2) : '',
      areaText,
      row.cost_code || '',
    ];
    for (let i = 0; i < colWidths.length; i++) {
      drawRect(cx, y, colWidths[i], rowH);
      const text = String(cells[i] || '');
      const truncated = doc.splitTextToSize(text, colWidths[i] - 6)[0] || '';
      doc.text(truncated, cx + 4, y + 11);
      cx += colWidths[i];
    }
    y += rowH;
    if (y > pageH - 260) break; // reserve space for Office Use ONLY
  }

  // ── Office Use ONLY section ──
  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Office Use ONLY', marginL, y);
  y += 6;

  // Always use office_data.lines if present (so worker-entered QTY shows up
  // in the PDF). Rate + Sub Total + Totals are gated separately by
  // includeOfficeData so workers never see pricing.
  let displayLines = DEFAULT_OFFICE_LINES.map(l => ({ ...l }));
  let gstPercent = 5;
  if (ticket.office_data) {
    displayLines = (ticket.office_data.lines || DEFAULT_OFFICE_LINES).map((l) => ({
      ...l,
      label: migrateOfficeLineLabel(l.label || ''),
    }));
    gstPercent = Number(ticket.office_data.gst_percent ?? 5) || 5;
  }

  const officeColW = [270, 70, 90, 110];  // Label | QTY | Rate | Sub Total
  const totalOfficeW = officeColW.reduce((a, b) => a + b, 0);
  const officeRowH = 14;
  const officeHeaders = [' ', 'QTY', 'Rate', 'Sub Total'];

  // Header row
  cx = marginL;
  doc.setFillColor(240, 240, 240);
  doc.rect(marginL, y, totalOfficeW, officeRowH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  for (let i = 0; i < officeColW.length; i++) {
    drawRect(cx, y, officeColW[i], officeRowH);
    if (officeHeaders[i].trim()) {
      doc.text(officeHeaders[i], cx + 4, y + 10);
    }
    cx += officeColW[i];
  }
  y += officeRowH;

  // Office line rows
  // QTY is always shown when present (so workers can verify their entered data).
  // Rate + Sub Total are only rendered when includeOfficeData is true.
  doc.setFont('helvetica', 'normal');
  let runningSubTotal = 0;
  for (const line of displayLines) {
    cx = marginL;
    const qty = parseFloat(line.qty);
    const rate = parseFloat(line.rate);
    const sub = (Number.isFinite(qty) ? qty : 0) * (Number.isFinite(rate) ? rate : 0);
    if (includeOfficeData && sub > 0) runningSubTotal += sub;
    const qtyText = Number.isFinite(qty) && qty !== 0
      ? qty.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : '';
    const cells = [
      line.label || '',
      qtyText,
      includeOfficeData && Number.isFinite(rate) && rate !== 0 ? `$ ${formatMoney(rate)}` : includeOfficeData ? '$' : '',
      includeOfficeData && sub > 0 ? `$ ${formatMoney(sub)}` : (includeOfficeData ? '$' : ''),
    ];
    for (let i = 0; i < officeColW.length; i++) {
      drawRect(cx, y, officeColW[i], officeRowH);
      doc.text(String(cells[i]), cx + 4, y + 10);
      cx += officeColW[i];
    }
    y += officeRowH;
  }

  // Sub Total / GST / Total rows
  const gstVal = runningSubTotal * (gstPercent / 100);
  const totalVal = runningSubTotal + gstVal;
  const summaryLabels = [
    ['Sub Total', includeOfficeData && runningSubTotal > 0 ? `$ ${formatMoney(runningSubTotal)}` : '$'],
    [`GST (${gstPercent}%)`, includeOfficeData && gstVal > 0 ? `$ ${formatMoney(gstVal)}` : '$'],
    ['Total', includeOfficeData && totalVal > 0 ? `$ ${formatMoney(totalVal)}` : '$'],
  ];
  for (const [label, value] of summaryLabels) {
    cx = marginL;
    // Empty label cell, QTY cell
    drawRect(cx, y, officeColW[0], officeRowH);
    cx += officeColW[0];
    drawRect(cx, y, officeColW[1], officeRowH);
    cx += officeColW[1];
    // Rate cell as label for the summary
    drawRect(cx, y, officeColW[2], officeRowH);
    doc.setFont('helvetica', 'bold');
    doc.text(label, cx + 4, y + 10);
    cx += officeColW[2];
    drawRect(cx, y, officeColW[3], officeRowH);
    doc.setFont('helvetica', 'normal');
    doc.text(value, cx + 4, y + 10);
    y += officeRowH;
  }

  // ── Footer: GST/WCB + Approval ──
  y += 10;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text('GST# 103512687.   WCB# 909 048', pageW - marginR, y, { align: 'right' });

  y += 18;
  // One-line approval: "Approved: ____[signature]____". No name printed —
  // if a printed copy needs a name, the signer can hand-write it beside the
  // signature. Signature image is stretched across most of the line for
  // readability on desktop PDFs.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Approved:', marginL, y + 14);

  // Signature baseline runs from just after "Approved:" label to the right margin.
  const sigLineX1 = marginL + 60;
  const sigLineX2 = pageW - marginR;
  const sigLineY = y + 16;
  doc.setDrawColor(0);
  doc.setLineWidth(0.5);
  doc.line(sigLineX1, sigLineY, sigLineX2, sigLineY);

  // Embed signature image if provided — stretched to fill the line.
  const sig = signaturePng || ticket.approved_signature || null;
  if (sig) {
    try {
      const sigW = Math.min(280, sigLineX2 - sigLineX1 - 4);
      const sigH = 32;
      doc.addImage(sig, 'PNG', sigLineX1 + 4, sigLineY - sigH + 4, sigW, sigH);
    } catch (e) {
      console.warn('[TM_PDF] Could not embed signature:', e.message);
    }
  }

  // ── Output ──
  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1];
  return { blob, base64 };
}
