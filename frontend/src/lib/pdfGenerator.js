import { jsPDF } from 'jspdf';

/**
 * Generate a Herbicide Application Ticket PDF matching the Pineview reference layout.
 * Returns { blob, base64 } for preview and upload respectively.
 */
export function generateLeaseSheetPdf(data) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();   // 612
  const pageH = doc.internal.pageSize.getHeight();  // 792
  const marginL = 36;
  const marginR = 36;
  const contentW = pageW - marginL - marginR;
  let y = 40;

  // ── Helpers ──
  const drawLine = (x1, yy, x2) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.line(x1, yy, x2, yy);
  };
  const drawRect = (x, yy, w, h) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.rect(x, yy, w, h);
  };
  const midX = pageW / 2;

  // ── Header: Company name + title + ticket no ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('PINEVIEW', marginL, y);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  y += 12;
  doc.text('VEGETATION MANAGEMENT', marginL, y);

  // Title (centered-right area)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Herbicide Application Ticket', midX - 20, y - 4, { align: 'center' });

  // Ticket No (top-right)
  doc.setFontSize(11);
  doc.text(`No: ${data.ticket_number || ''}`, pageW - marginR, 40, { align: 'right' });

  // Address line
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('7077 – 252Rd., Pineview, BC, V1J 8E3 | Tel: 250.261.9544 | www.pineviewvegetation.com', marginL, y);
  y += 14;

  // ── Customer / Area / LSD ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Customer/Area/LSD:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.customer || ''} / ${data.area || ''} / ${data.lsdOrPipeline || ''}`, marginL + 120, y);
  y += 16;

  // Date
  doc.setFont('helvetica', 'bold');
  doc.text('Date:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.date || '', marginL + 35, y);

  // Time (right side)
  doc.setFont('helvetica', 'bold');
  doc.text('Time:', midX, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.time || '', midX + 35, y);
  y += 16;

  // Applicators
  doc.setFont('helvetica', 'bold');
  doc.text('Applicators:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text((data.applicators || []).join(', '), marginL + 72, y);
  y += 16;

  // ── Table: Wind Direction/Speed | Location Type ──
  const tableTop = y;
  const halfW = contentW / 2;
  const rowH = 40;

  // Row 1: Wind Direction/Speed | Location Type
  drawRect(marginL, tableTop, halfW, rowH);
  drawRect(marginL + halfW, tableTop, halfW, rowH);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Wind Direction/Speed:', marginL + 4, tableTop + 12);
  doc.text('Location Type:', marginL + halfW + 4, tableTop + 12);

  doc.setFont('helvetica', 'normal');
  const windText = `${(data.windDirection || []).join(', ')} ${data.windSpeed ? data.windSpeed + ' km/h' : ''}`.trim();
  doc.text(windText, marginL + 4, tableTop + 28);
  doc.text((data.locationTypes || []).join(', '), marginL + halfW + 4, tableTop + 28);
  y = tableTop + rowH;

  // Temp row
  drawRect(marginL, y, halfW, 20);
  drawRect(marginL + halfW, y, halfW, 20);
  doc.setFont('helvetica', 'bold');
  doc.text('Temp:', marginL + 4, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.text(data.temperature ? `${data.temperature}°C` : '', marginL + 38, y + 14);
  y += 20;

  // ── Noxious Weeds (two-column, left filled, right blank) ──
  const noxH = 50;
  drawRect(marginL, y, halfW, noxH);
  drawRect(marginL + halfW, y, halfW, noxH);
  doc.setFont('helvetica', 'bold');
  doc.text('Noxious Weeds:', marginL + 4, y + 12);
  doc.setFont('helvetica', 'normal');
  const noxText = (data.noxiousWeedsSelected || []).join(', ');
  // Word-wrap noxious weeds
  const noxLines = doc.splitTextToSize(noxText, halfW - 10);
  doc.text(noxLines, marginL + 4, y + 26);
  y += noxH;

  // ── Products Applied ──
  const prodH = 60;
  drawRect(marginL, y, contentW, prodH);
  doc.setFont('helvetica', 'bold');
  doc.text('Products Applied:', marginL + 4, y + 12);
  doc.setFont('helvetica', 'normal');
  const herbText = (data.herbicidesUsed || []).join(', ');
  const herbLines = doc.splitTextToSize(herbText, contentW - 10);
  doc.text(herbLines, marginL + 4, y + 26);
  y += prodH;

  // ── Area Treated / Total Product / Water Volume ──
  const areaRowH = 36;
  drawRect(marginL, y, contentW, areaRowH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Area Treated:', marginL + 4, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.areaTreated || '___'} ha`, marginL + 75, y + 14);

  doc.setFont('helvetica', 'bold');
  doc.text('Total Product:', marginL + 180, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.text(`${data.totalLiters || '___'} L`, marginL + 260, y + 14);

  doc.setFont('helvetica', 'normal');
  doc.text('Water Volume 200L/Ha', marginL + 4, y + 28);
  y += areaRowH;

  // ── Spray Type / Spray Method ──
  const sprayRowH = 50;
  drawRect(marginL, y, halfW, sprayRowH);
  drawRect(marginL + halfW, y, halfW, sprayRowH);
  doc.setFont('helvetica', 'bold');
  doc.text('Spray Type:', marginL + 4, y + 12);
  doc.text('Spray Method:', marginL + halfW + 4, y + 12);
  doc.setFont('helvetica', 'normal');
  doc.text((data.sprayType || []).join(', '), marginL + 4, y + 28);
  doc.text((data.sprayMethod || []).join(', '), marginL + halfW + 4, y + 28);
  y += sprayRowH;

  // ── Access Road section (if applicable) ──
  if (data.isAccessRoad || (data.locationTypes || []).some(t => ['Access Road', 'Roadside'].includes(t))) {
    const roadH = 50;
    drawRect(marginL, y, contentW, roadH);
    doc.setFont('helvetica', 'bold');
    doc.text('Roadside Details:', marginL + 4, y + 12);
    doc.setFont('helvetica', 'normal');
    doc.text(`Distance: ${data.roadsideKm || '___'} km`, marginL + 4, y + 26);
    doc.text(`Herbicides: ${(data.roadsideHerbicides || []).join(', ')}`, marginL + 160, y + 26);
    doc.text(`Liters: ${data.roadsideLiters || '___'} L`, marginL + 4, y + 40);
    doc.text(`Area: ${data.roadsideAreaTreated || '___'} ha`, marginL + 160, y + 40);
    y += roadH;
  }

  // ── Comments ──
  const commH = 80;
  drawRect(marginL, y, contentW, commH);
  doc.setFont('helvetica', 'bold');
  doc.text('Comments:', marginL + 4, y + 12);
  doc.setFont('helvetica', 'normal');
  const commLines = doc.splitTextToSize(data.comments || '', contentW - 10);
  doc.text(commLines, marginL + 4, y + 26);
  y += commH;

  // ── Photos indicator ──
  if (data.photoCount && data.photoCount > 0) {
    y += 10;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.text(`${data.photoCount} photo(s) attached`, marginL, y);
    y += 14;
  }

  // ── Signature lines ──
  y = Math.max(y + 30, pageH - 80);
  drawLine(marginL, y, marginL + 200);
  drawLine(pageW - marginR - 200, y, pageW - marginR);
  y += 12;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Applicator Signature', marginL + 40, y);
  doc.text('Date', pageW - marginR - 140, y);

  // ── Output ──
  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1]; // strip prefix
  return { blob, base64 };
}
