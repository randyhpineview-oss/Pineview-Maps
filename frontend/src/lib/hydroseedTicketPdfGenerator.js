import { jsPDF } from 'jspdf';

// Logo cache (same pattern as the other generators).
let _logoDataUrl = null;
async function loadLogo() {
  if (_logoDataUrl) return _logoDataUrl;
  try {
    const resp = await fetch('/logo.png');
    const blob = await resp.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => { _logoDataUrl = reader.result; resolve(_logoDataUrl); };
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

/**
 * Auto-seeded office lines when an HT is first opened in the detail sheet
 * and `office_data.lines` is still null/empty. We add one row per existing
 * ticket.row (qty/unit pre-filled from the rolled-up daily aggregation,
 * rate blank for office to enter). Office can also append extra custom
 * lines (mobilization, day-rate top-ups, etc.) — they live alongside the
 * auto-seeded ones in the same array.
 *
 * Returns [{ label, qty, unit, rate: '' }, ...]
 */
export function seedOfficeLinesFromTicketRows(rows) {
  return (rows || []).map(r => ({
    label: r.label || '',
    qty: r.qty != null ? Number(r.qty) : '',
    unit: r.unit || '',
    rate: '',
  }));
}

/**
 * Recompute QTY on existing office lines from the latest aggregated rows.
 * Preserves rate + any custom (non-aggregated) lines. Called by the detail
 * sheet whenever fresh ticket data arrives via realtime/delta sync so the
 * office sees up-to-date totals as workers add more dailies.
 */
export function syncOfficeLineQtysFromRows(existingLines, rows) {
  const rowByLabel = new Map();
  for (const r of rows || []) {
    if (!r?.label) continue;
    // If two rows happen to share a label (e.g. same equipment label on two
    // dailies didn't get pre-deduped on the server), sum them so the office
    // ticket reflects the true total.
    const prior = rowByLabel.get(r.label);
    const qty = Number(r.qty) || 0;
    rowByLabel.set(r.label, {
      label: r.label,
      qty: (prior?.qty || 0) + qty,
      unit: r.unit || prior?.unit || '',
    });
  }

  const seen = new Set();
  const out = (existingLines || []).map(l => {
    const match = rowByLabel.get(l.label);
    if (match) {
      seen.add(l.label);
      return { ...l, qty: match.qty, unit: l.unit || match.unit };
    }
    // Custom line — leave it alone.
    return { ...l };
  });

  // Append any newly-aggregated labels that weren't on the office_data yet.
  for (const [label, info] of rowByLabel.entries()) {
    if (seen.has(label)) continue;
    out.push({ label: info.label, qty: info.qty, unit: info.unit, rate: '' });
  }
  return out;
}

export function computeOfficeTotals(officeData) {
  const lines = officeData?.lines || [];
  const gstPercent = Number(officeData?.gst_percent ?? 5) || 0;
  const gstEnabled = officeData?.gst_enabled !== false;
  const subTotal = lines.reduce((sum, line) => {
    const qty = parseFloat(line.qty) || 0;
    const rate = parseFloat(line.rate) || 0;
    return sum + qty * rate;
  }, 0);
  const gst = gstEnabled ? subTotal * (gstPercent / 100) : 0;
  const total = subTotal + gst;
  return { subTotal, gst, total, gstPercent, gstEnabled };
}

function formatMoney(n) {
  if (!Number.isFinite(n) || n === 0) return '';
  return n.toFixed(2);
}

function formatQty(n) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Generate a Hydroseed Ticket PDF.
 *
 * @param {object} ticket - HydroseedTicket {
 *     ticket_number, work_date, client, area,
 *     description_of_work, po_approval_number,
 *     rows: [{ kind, label, qty, unit }],
 *     office_data: { lines, gst_percent, gst_enabled },
 *     approved_signature
 *   }
 * @param {object} [options] - { includeOfficeData=false, signaturePng=null,
 *                               linkedRecordNumbers=[] }
 *   - `includeOfficeData=false` mirrors the T&M ticket convention: workers
 *     see QTY but never $ rates/totals. Office PDF generation flips to true.
 *   - `linkedRecordNumbers` is shown at the top so the office knows which
 *     dailies (HD######) rolled up into this ticket.
 *
 * Returns { blob, base64 }.
 */
export async function generateHydroseedTicketPdf(ticket, options = {}) {
  const {
    includeOfficeData = false,
    signaturePng = null,
    linkedRecordNumbers = [],
  } = options;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginL = 36;
  const marginR = 36;
  const marginB = 36;
  const contentW = pageW - marginL - marginR;
  let y = 36;

  const drawRect = (x, yy, w, h) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.rect(x, yy, w, h);
  };

  // ── Logo + Title block (matches T&M header for brand consistency) ──
  const logoData = await loadLogo();
  if (logoData) {
    doc.addImage(logoData, 'PNG', marginL, y, 100, 100);
  }

  const titleY = y + 45;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(50, 80, 50);
  doc.text('Hydroseed Time and Materials Ticket', marginL + 120, titleY);
  doc.setTextColor(0);

  doc.setFontSize(12);
  doc.text(`No: ${ticket.ticket_number || ''}`, pageW - marginR, titleY, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100);
  doc.text('7077 252 Road, Pineview, BC, Canada, V1J 8E3', marginL + 120, titleY + 14);
  doc.text('Tel: 250.261.9544 | www.pineviewvegetation.com', marginL + 120, titleY + 24);
  doc.setTextColor(0);

  y += 110;

  // ── Customer / Area / Date / PO ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Customer:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(ticket.client || '', marginL + 60, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Date:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(String(ticket.work_date || ''), marginL + 345, y);
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

  if (linkedRecordNumbers && linkedRecordNumbers.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.text('Linked Dailies:', marginL, y);
    doc.setFont('helvetica', 'normal');
    const linkedStr = linkedRecordNumbers.join(', ');
    const linkedLines = doc.splitTextToSize(linkedStr, contentW - 130);
    doc.text(linkedLines, marginL + 90, y);
    y += Math.max(14, linkedLines.length * 12);
  }

  // ── Materials & Equipment (aggregated from linked dailies) ──
  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Materials & Equipment Used', pageW / 2, y, { align: 'center' });
  y += 6;

  const rowColW = [320, 130, 90];  // Item | Quantity | Unit
  const rowH = 16;
  const rowTotalW = rowColW.reduce((a, b) => a + b, 0);
  const rowHeaders = ['Item', 'Quantity', 'Unit'];

  const drawRowsHeader = (continuation = false) => {
    if (continuation) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Materials & Equipment (continued)', pageW / 2, y, { align: 'center' });
      y += 6;
    }
    let hx = marginL;
    doc.setFillColor(240, 240, 240);
    doc.rect(marginL, y, rowTotalW, rowH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    for (let i = 0; i < rowColW.length; i++) {
      drawRect(hx, y, rowColW[i], rowH);
      doc.text(rowHeaders[i], hx + 4, y + 11);
      hx += rowColW[i];
    }
    y += rowH;
    doc.setFont('helvetica', 'normal');
  };
  drawRowsHeader(false);

  const rows = ticket.rows || [];
  for (const row of rows) {
    if (y + rowH > pageH - marginB) {
      doc.addPage();
      y = 36;
      drawRowsHeader(true);
    }
    let cx = marginL;
    const cells = [
      row.label || '',
      formatQty(row.qty),
      row.unit || '',
    ];
    for (let i = 0; i < rowColW.length; i++) {
      drawRect(cx, y, rowColW[i], rowH);
      const truncated = doc.splitTextToSize(String(cells[i] || ''), rowColW[i] - 6)[0] || '';
      doc.text(truncated, cx + 4, y + 11);
      cx += rowColW[i];
    }
    y += rowH;
  }

  // ── Office Use ONLY ──
  const displayLines = (ticket.office_data?.lines || []).map(l => ({ ...l }));
  const gstPercent = Number(ticket.office_data?.gst_percent ?? 5) || 0;
  const gstEnabled = ticket.office_data?.gst_enabled !== false;

  const officeColW = [220, 70, 50, 80, 120];   // Label | QTY | Unit | Rate | Sub Total
  const officeRowH = 14;
  const officeTotalW = officeColW.reduce((a, b) => a + b, 0);
  const officeHeaders = [' ', 'QTY', 'Unit', 'Rate', 'Sub Total'];

  const summaryRowCount = gstEnabled ? 3 : 2;
  const officeBlockHeight = 28 + (displayLines.length + summaryRowCount) * officeRowH + 90;
  if (y + officeBlockHeight > pageH - marginB) {
    doc.addPage();
    y = 36;
  }

  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Office Use ONLY', marginL, y);
  y += 6;

  // Header row
  let cx = marginL;
  doc.setFillColor(240, 240, 240);
  doc.rect(marginL, y, officeTotalW, officeRowH, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  for (let i = 0; i < officeColW.length; i++) {
    drawRect(cx, y, officeColW[i], officeRowH);
    if (officeHeaders[i].trim()) doc.text(officeHeaders[i], cx + 4, y + 10);
    cx += officeColW[i];
  }
  y += officeRowH;

  // Body rows
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
      line.unit || '',
      includeOfficeData && Number.isFinite(rate) && rate !== 0 ? `$ ${formatMoney(rate)}` : (includeOfficeData ? '$' : ''),
      includeOfficeData && sub > 0 ? `$ ${formatMoney(sub)}` : (includeOfficeData ? '$' : ''),
    ];
    for (let i = 0; i < officeColW.length; i++) {
      drawRect(cx, y, officeColW[i], officeRowH);
      const txt = doc.splitTextToSize(String(cells[i] || ''), officeColW[i] - 6)[0] || '';
      doc.text(txt, cx + 4, y + 10);
      cx += officeColW[i];
    }
    y += officeRowH;
  }

  // Summary rows
  const gstVal = gstEnabled ? runningSubTotal * (gstPercent / 100) : 0;
  const totalVal = runningSubTotal + gstVal;
  const summaryLabels = [
    ['Sub Total', includeOfficeData && runningSubTotal > 0 ? `$ ${formatMoney(runningSubTotal)}` : '$'],
    ...(gstEnabled
      ? [[`GST (${gstPercent}%)`, includeOfficeData && gstVal > 0 ? `$ ${formatMoney(gstVal)}` : '$']]
      : []),
    ['Total', includeOfficeData && totalVal > 0 ? `$ ${formatMoney(totalVal)}` : '$'],
  ];
  for (const [label, value] of summaryLabels) {
    cx = marginL;
    drawRect(cx, y, officeColW[0], officeRowH); cx += officeColW[0];
    drawRect(cx, y, officeColW[1], officeRowH); cx += officeColW[1];
    drawRect(cx, y, officeColW[2], officeRowH); cx += officeColW[2];
    drawRect(cx, y, officeColW[3], officeRowH);
    doc.setFont('helvetica', 'bold');
    doc.text(label, cx + 4, y + 10);
    cx += officeColW[3];
    drawRect(cx, y, officeColW[4], officeRowH);
    doc.setFont('helvetica', 'normal');
    doc.text(value, cx + 4, y + 10);
    y += officeRowH;
  }

  // Footer + signature
  if (y + 60 > pageH - marginB) {
    doc.addPage();
    y = 36;
  }
  y += 10;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.text('GST# 103512687.   WCB# 909 048', pageW - marginR, y, { align: 'right' });

  y += 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Approved:', marginL, y + 14);

  const sigLineX1 = marginL + 60;
  const sigLineX2 = pageW - marginR;
  const sigLineY = y + 16;
  doc.setDrawColor(0);
  doc.setLineWidth(0.5);
  doc.line(sigLineX1, sigLineY, sigLineX2, sigLineY);

  const sig = signaturePng || ticket.approved_signature || null;
  if (sig) {
    try {
      const sigW = Math.min(280, sigLineX2 - sigLineX1 - 4);
      const sigH = 32;
      doc.addImage(sig, 'PNG', sigLineX1 + 4, sigLineY - sigH + 4, sigW, sigH);
    } catch (e) {
      console.warn('[HT_PDF] Could not embed signature:', e.message);
    }
  }

  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1];
  return { blob, base64 };
}
