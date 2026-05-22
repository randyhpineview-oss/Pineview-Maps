import { jsPDF } from 'jspdf';

// Shared logo cache — same pattern as pdfGenerator.js / tmTicketPdfGenerator.js.
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

// One bale of mulch = 22.7 kg. Used in totals + per-load Mulch (kg) column.
export const KG_PER_BALE = 22.7;

// Same `decode()`-over-`onload` story as the existing pdfGenerator. iOS Safari
// can paint a blank canvas if drawImage is called before decode finishes.
function fixPhotoOrientation(dataUrl) {
  const drawAndResolve = (img, resolve) => {
    try {
      const canvas = document.createElement('canvas');
      const maxDim = 1000;
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    } catch {
      resolve(dataUrl);
    }
  };
  return new Promise((resolve) => {
    const img = new Image();
    img.src = dataUrl;
    if (typeof img.decode === 'function') {
      img.decode().then(() => drawAndResolve(img, resolve)).catch(() => resolve(dataUrl));
    } else {
      img.onload = () => drawAndResolve(img, resolve);
      img.onerror = () => resolve(dataUrl);
    }
  });
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtNum(v, decimals = 2) {
  const n = toNum(v);
  if (!n) return '';
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/**
 * Generate a Hydroseed Daily Application Record PDF.
 *
 * @param {object} data - full form snapshot. Shape:
 *   {
 *     record_number, date, client, area, site_name, description_of_work,
 *     crew: string[],
 *     equipment: [{ label, hours }],
 *     mulch_type, soil_amendment, seed_types: [{ name, description }], fertilizer,
 *     loads: [{ id, load_number, area_m2, mulch_bales, soil_amendment_kg,
 *               seed_kgs: { [seedName]: kg }, aqua_gel_kg, tackifier_kg,
 *               fertilizer_kg, notes }],
 *     comments
 *   }
 * @param {string[]} photoDataUrls - annotated map / canvas / photo images.
 * @param {string[]} seedTagDataUrls - seed bag tag photos.
 * Returns { blob, base64 }.
 */
export async function generateHydroseedDailyPdf(data, photoDataUrls = [], seedTagDataUrls = []) {
  // Orient + downscale every photo up front so the rest of the layout code
  // can lay them out in a simple grid without worrying about EXIF/rotation.
  const [fixedPhotos, fixedSeedTags] = await Promise.all([
    Promise.all((photoDataUrls || []).map(u => u ? fixPhotoOrientation(u) : null)),
    Promise.all((seedTagDataUrls || []).map(u => u ? fixPhotoOrientation(u) : null)),
  ]);
  const photos = fixedPhotos.filter(Boolean);
  const seedTags = fixedSeedTags.filter(Boolean);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();   // 612
  const pageH = doc.internal.pageSize.getHeight();  // 792
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

  const ensureSpace = (needed, continuationHeader = null) => {
    if (y + needed > pageH - marginB) {
      doc.addPage();
      y = 36;
      if (continuationHeader) continuationHeader();
    }
  };

  // ── Logo + title (same identity as Lease Sheet + T&M) ────────────────────
  // Logo + masthead deliberately compact (70 pt tall, not 100) so the rest
  // of the form has more vertical room — the goal is one-page output on a
  // typical daily with a single load.
  const logoData = await loadLogo();
  if (logoData) doc.addImage(logoData, 'PNG', marginL, y, 70, 70);

  const titleY = y + 30;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(50, 80, 50);
  doc.text('Hydroseed Daily Application Record', marginL + 80, titleY);
  doc.setTextColor(0);

  doc.setFontSize(11);
  doc.text(`No: ${data.record_number || ''}`, pageW - marginR, titleY, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100);
  doc.text('7077 252 Road, Pineview, BC, Canada, V1J 8E3', marginL + 80, titleY + 11);
  doc.text('Tel: 250.261.9544 | office@pineviewmanagement.com', marginL + 80, titleY + 20);
  doc.setTextColor(0);

  y += 78;

  // ── Header: Customer / Site / Date ───────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Customer:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.client || '', marginL + 60, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Date:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(String(data.date || ''), marginL + 345, y);
  y += 13;

  doc.setFont('helvetica', 'bold');
  doc.text('Area:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.area || '', marginL + 60, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Site:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.site_name || '', marginL + 345, y);
  y += 13;

  // Customer rep — only printed when filled in so we don't waste a line
  // on jobs where the office doesn't track the on-site contact.
  if (data.customer_rep || data.customer_rep_phone) {
    doc.setFont('helvetica', 'bold');
    doc.text('Cust. Rep:', marginL, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(data.customer_rep || ''), marginL + 60, y);
    if (data.customer_rep_phone) {
      doc.setFont('helvetica', 'bold');
      doc.text('Contact:', marginL + 310, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(data.customer_rep_phone), marginL + 345, y);
    }
    y += 13;
  }

  // Crew block — supervisor + lead + workers are billed at different
  // rates, so we render them on their own lines when present. Falls back
  // to the legacy flat `crew[]` join for records created before the
  // role split.
  const hasRoles = Boolean(data.supervisor || data.lead || (data.workers && data.workers.length));
  if (hasRoles) {
    if (data.supervisor) {
      doc.setFont('helvetica', 'bold');
      doc.text('Supervisor:', marginL, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(data.supervisor), marginL + 60, y);
      y += 12;
    }
    if (data.lead) {
      doc.setFont('helvetica', 'bold');
      doc.text('Lead:', marginL, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(data.lead), marginL + 60, y);
      y += 12;
    }
    if (data.workers && data.workers.length) {
      doc.setFont('helvetica', 'bold');
      doc.text('Workers:', marginL, y);
      doc.setFont('helvetica', 'normal');
      doc.text(data.workers.join(', '), marginL + 60, y);
      y += 12;
    }
    y += 2;
  } else {
    doc.setFont('helvetica', 'bold');
    doc.text('Crew:', marginL, y);
    doc.setFont('helvetica', 'normal');
    doc.text((data.crew || []).join(', '), marginL + 60, y);
    y += 14;
  }

  doc.setFont('helvetica', 'bold');
  doc.text('Description of Work:', marginL, y);
  doc.setFont('helvetica', 'normal');
  const descLines = doc.splitTextToSize(data.description_of_work || '', contentW - 125);
  doc.text(descLines, marginL + 115, y);
  y += Math.max(14, descLines.length * 12);

  // ── Ingredients declaration block ────────────────────────────────────────
  // Extra gap above the section heading so "Materials" doesn't crash into
  // the Description-of-Work text. The heading itself is followed by an
  // 8-pt breathing-room gap before the underline, matching the rest of
  // the document's section rhythm.
  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Materials', marginL, y);
  y += 6;
  drawRect(marginL, y, contentW, 1);
  y += 12;  // breathing room between underline and first row

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('Mulch Type:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.mulch_type || '', marginL + 70, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Fertilizer:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.fertilizer || '', marginL + 360, y);
  y += 14;

  doc.setFont('helvetica', 'bold');
  doc.text('Soil Amendment:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.soil_amendment || '', marginL + 95, y);
  y += 14;

  const seedTypes = data.seed_types || [];
  if (seedTypes.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.text('Seed Types:', marginL, y);
    y += 12;
    doc.setFont('helvetica', 'normal');
    for (const st of seedTypes) {
      const line = `  • ${st.name || ''}${st.description ? `: ${st.description}` : ''}`;
      const wrapped = doc.splitTextToSize(line, contentW - 8);
      doc.text(wrapped, marginL + 4, y);
      y += wrapped.length * 11;
    }
  }
  y += 4;

  // ── Loads table ──────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Loads', pageW / 2, y, { align: 'center' });
  y += 6;

  // Dynamic columns: #, Area (m²), Mulch (kg), Soil Amend (kg), then one per
  // declared seed type, then Aqua Gel, Tackifier, Fertilizer. Notes is shown
  // only if any load has a non-empty `notes` string (saves horizontal space
  // on common daily PDFs).
  const loads = (data.loads || []).slice();
  const hasNotes = loads.some(l => (l?.notes || '').trim() !== '');
  const seedNames = seedTypes.map(s => s.name).filter(Boolean);

  // Fixed widths for the first columns, then divide what's left among seed
  // columns + Aqua/Tackifier/Fertilizer. Bales is its own column now —
  // workers wanted to see bale count separated from the kg total in the
  // loads table for at-a-glance verification.
  const fixedColW = {
    num: 22,
    area: 50,
    bales: 34,
    mulch: 48,
    soilAmend: 50,
  };
  const tailCols = ['Aqua Gel', 'Tackifier', 'Fertilizer'];
  const notesW = hasNotes ? 80 : 0;
  const tailW = 44 * tailCols.length;
  const fixedTotal = fixedColW.num + fixedColW.area + fixedColW.bales + fixedColW.mulch + fixedColW.soilAmend + tailW + notesW;
  const seedColTotalW = contentW - fixedTotal;
  const perSeedW = seedNames.length > 0 ? Math.max(34, Math.min(60, seedColTotalW / seedNames.length)) : 0;

  // Header cells in order: # | Area | Bales | Mulch (kg) | Soil Amend (kg) | seeds… | Aqua Gel | Tackifier | Fertilizer | (Notes)
  const headerCells = [
    { label: '#', w: fixedColW.num },
    { label: 'Area (m²)', w: fixedColW.area },
    { label: 'Bales', w: fixedColW.bales },
    { label: 'Mulch (kg)', w: fixedColW.mulch },
    { label: 'Soil Amend (kg)', w: fixedColW.soilAmend },
    ...seedNames.map(n => ({ label: `${n} (kg)`, w: perSeedW })),
    ...tailCols.map(t => ({ label: `${t} (kg)`, w: 44 })),
    ...(hasNotes ? [{ label: 'Notes', w: notesW }] : []),
  ];
  // Resize so total exactly equals contentW (rounding fudge).
  const headerSum = headerCells.reduce((a, c) => a + c.w, 0);
  if (headerSum > 0 && headerSum !== contentW) {
    const scale = contentW / headerSum;
    headerCells.forEach(c => { c.w *= scale; });
  }
  const rowH = 16;

  const drawLoadsHeader = (continuation = false) => {
    if (continuation) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Loads (continued)', pageW / 2, y, { align: 'center' });
      y += 6;
    }
    let hx = marginL;
    doc.setFillColor(240, 240, 240);
    doc.rect(marginL, y, contentW, rowH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    for (const c of headerCells) {
      drawRect(hx, y, c.w, rowH);
      const lines = doc.splitTextToSize(c.label, c.w - 4);
      doc.text(lines[0] || '', hx + 3, y + 10);
      hx += c.w;
    }
    y += rowH;
    doc.setFont('helvetica', 'normal');
  };

  drawLoadsHeader(false);

  // Running totals for the TOTALS row at the bottom of the table.
  const totals = {
    area_m2: 0,
    bales: 0,
    mulch_kg: 0,
    soil_amend: 0,
    seed: Object.fromEntries(seedNames.map(n => [n, 0])),
    aqua_gel: 0,
    tackifier: 0,
    fertilizer: 0,
  };

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  for (let r = 0; r < loads.length; r++) {
    if (y + rowH > pageH - marginB) {
      doc.addPage();
      y = 36;
      drawLoadsHeader(true);
    }
    const load = loads[r] || {};
    const bales = toNum(load.mulch_bales);
    const mulchKg = bales * KG_PER_BALE;
    totals.area_m2 += toNum(load.area_m2);
    totals.bales += bales;
    totals.mulch_kg += mulchKg;
    totals.soil_amend += toNum(load.soil_amendment_kg);
    for (const n of seedNames) {
      totals.seed[n] += toNum((load.seed_kgs || {})[n]);
    }
    totals.aqua_gel += toNum(load.aqua_gel_kg);
    totals.tackifier += toNum(load.tackifier_kg);
    totals.fertilizer += toNum(load.fertilizer_kg);

    const cells = [
      String(load.load_number || (r + 1)),
      fmtNum(load.area_m2, 0),
      // Bales and Mulch (kg) are now separate columns so the values
      // line up cleanly under their own headers (previously "681 (30)"
      // crowded into one cell, which workers flagged as confusing).
      bales ? fmtNum(bales, 0) : '',
      mulchKg ? fmtNum(mulchKg, 0) : '',
      fmtNum(load.soil_amendment_kg),
      ...seedNames.map(n => fmtNum((load.seed_kgs || {})[n])),
      fmtNum(load.aqua_gel_kg),
      fmtNum(load.tackifier_kg),
      fmtNum(load.fertilizer_kg),
      ...(hasNotes ? [String(load.notes || '')] : []),
    ];
    let cx = marginL;
    for (let i = 0; i < headerCells.length; i++) {
      const w = headerCells[i].w;
      drawRect(cx, y, w, rowH);
      const text = String(cells[i] || '');
      const truncated = doc.splitTextToSize(text, w - 4)[0] || '';
      doc.text(truncated, cx + 3, y + 11);
      cx += w;
    }
    y += rowH;
  }

  // TOTALS row
  if (loads.length > 0) {
    if (y + rowH > pageH - marginB) {
      doc.addPage();
      y = 36;
      drawLoadsHeader(true);
    }
    let cx = marginL;
    doc.setFillColor(220, 230, 220);
    doc.rect(marginL, y, contentW, rowH, 'F');
    doc.setFont('helvetica', 'bold');
    const totalCells = [
      'Total',
      fmtNum(totals.area_m2, 0),
      fmtNum(totals.bales, 0),
      fmtNum(totals.mulch_kg, 0),
      fmtNum(totals.soil_amend),
      ...seedNames.map(n => fmtNum(totals.seed[n])),
      fmtNum(totals.aqua_gel),
      fmtNum(totals.tackifier),
      fmtNum(totals.fertilizer),
      ...(hasNotes ? [''] : []),
    ];
    for (let i = 0; i < headerCells.length; i++) {
      const w = headerCells[i].w;
      drawRect(cx, y, w, rowH);
      doc.text(String(totalCells[i] || ''), cx + 3, y + 11);
      cx += w;
    }
    y += rowH;
    doc.setFont('helvetica', 'normal');
  }

  // ── Equipment Used ───────────────────────────────────────────────────────
  const equipment = data.equipment || [];
  if (equipment.length > 0) {
    y += 8;
    ensureSpace(40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Equipment Used', marginL, y);
    y += 6;

    const eqColW = [contentW * 0.65, contentW * 0.35];
    const eqRowH = 14;
    let hx = marginL;
    doc.setFillColor(240, 240, 240);
    doc.rect(marginL, y, contentW, eqRowH, 'F');
    doc.setFontSize(8);
    drawRect(hx, y, eqColW[0], eqRowH);
    doc.text('Equipment', hx + 3, y + 10);
    drawRect(hx + eqColW[0], y, eqColW[1], eqRowH);
    doc.text('Hours', hx + eqColW[0] + 3, y + 10);
    y += eqRowH;
    doc.setFont('helvetica', 'normal');

    for (const eq of equipment) {
      ensureSpace(eqRowH);
      let cx = marginL;
      drawRect(cx, y, eqColW[0], eqRowH);
      doc.text(String(eq?.label || ''), cx + 3, y + 10);
      cx += eqColW[0];
      drawRect(cx, y, eqColW[1], eqRowH);
      doc.text(fmtNum(eq?.hours), cx + 3, y + 10);
      y += eqRowH;
    }
  }

  // ── Comments ─────────────────────────────────────────────────────────────
  if (data.comments) {
    y += 8;
    const commH = 50;
    ensureSpace(commH + 12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Comments:', marginL, y);
    y += 4;
    drawRect(marginL, y, contentW, commH);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(data.comments, contentW - 8);
    doc.text(lines, marginL + 3, y + 12);
    y += commH;
  }

  // ── Seed Tag Photos ──────────────────────────────────────────────────────
  // Inline on the current page if there's room — workers asked for the
  // PDF to fit on one page on simple dailies. We only force a new page
  // when the section header + at least one minimum-sized photo row
  // wouldn't fit below the current y. The photo grid below shrinks to
  // fit the remaining vertical space automatically.
  const SECTION_MIN_H = 150;  // header (~24) + one small photo cell + label
  if (seedTags.length > 0) {
    y += 10;
    if (y + SECTION_MIN_H > pageH - marginB) {
      doc.addPage();
      y = 36;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Seed Tag Photos', pageW / 2, y, { align: 'center' });
    y += 14;
    await drawPhotoGrid(doc, seedTags, {
      labelPrefix: 'Seed Tag',
      marginL,
      marginB,
      contentW,
      pageW,
      pageH,
      yRef: { value: y },
    }).then(yEnd => { y = yEnd; });
  }

  // ── Annotated Map / Photos ───────────────────────────────────────────────
  if (photos.length > 0) {
    y += 10;
    if (y + SECTION_MIN_H > pageH - marginB) {
      doc.addPage();
      y = 36;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Map / Photo Annotations', pageW / 2, y, { align: 'center' });
    y += 14;
    await drawPhotoGrid(doc, photos, {
      labelPrefix: 'Map / Photo',
      marginL,
      marginB,
      contentW,
      pageW,
      pageH,
      yRef: { value: y },
    }).then(yEnd => { y = yEnd; });
  }

  const blob = doc.output('blob');
  const base64 = doc.output('datauristring').split(',')[1];
  return { blob, base64 };
}

// 2-up grid of photos that ADAPTS to the remaining vertical space —
// small photos squeeze in next to the form so the daily fits on one page
// when possible, while still expanding to a comfortable size when the
// photos section gets its own page (e.g. many photos or a tall loads
// table). Each photo keeps its aspect ratio; nothing is cropped.
async function drawPhotoGrid(doc, images, opts) {
  const { labelPrefix, marginL, marginB, contentW, pageW, pageH, yRef } = opts;
  let y = yRef.value;
  const cellW = (contentW - 12) / 2;
  // Per-row cell height — computed from the space left on the current
  // page. Anywhere between 110 (squeezed onto a busy page) and 280
  // (when the photos are on a fresh page). The bottom clamp avoids
  // postage-stamp photos; the top clamp avoids "drone shot eats a third
  // of the next page" situations.
  const MIN_CELL_H = 110;
  const MAX_CELL_H = 280;
  const LABEL_H = 12;

  // Pre-read dimensions for aspect-ratio math.
  const dims = await Promise.all(images.map(src => new Promise((resolve) => {
    const img = new Image();
    img.src = src;
    const done = () => resolve({
      w: img.naturalWidth || img.width || 1,
      h: img.naturalHeight || img.height || 1,
    });
    if (typeof img.decode === 'function') {
      img.decode().then(done).catch(() => resolve({ w: 1, h: 1 }));
    } else {
      img.onload = done;
      img.onerror = () => resolve({ w: 1, h: 1 });
    }
  })));

  for (let i = 0; i < images.length; i += 2) {
    const a = i;
    const b = i + 1;
    // Available vertical room for THIS row of photos (incl. label).
    const remaining = pageH - marginB - y;
    let cellH;
    if (remaining < MIN_CELL_H + LABEL_H) {
      // No room left on this page — push to a new page with full size.
      doc.addPage();
      y = 36;
      cellH = MAX_CELL_H;
    } else {
      cellH = Math.min(MAX_CELL_H, remaining - LABEL_H - 4);
    }
    const drawCell = (idx, x) => {
      if (idx >= images.length) return;
      const d = dims[idx];
      const ratio = d.h / d.w;
      let drawW = cellW;
      let drawH = cellW * ratio;
      if (drawH > cellH) {
        drawH = cellH;
        drawW = cellH / ratio;
      }
      try {
        doc.addImage(images[idx], 'JPEG', x, y, drawW, drawH);
      } catch {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.text(`[${labelPrefix} ${idx + 1}]`, x + 4, y + 12);
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(`${labelPrefix} ${idx + 1}`, x, y + drawH + 10);
    };
    drawCell(a, marginL);
    drawCell(b, marginL + cellW + 12);
    y += cellH + LABEL_H + 6;
    if (y + MIN_CELL_H + LABEL_H > pageH - marginB && i + 2 < images.length) {
      doc.addPage();
      y = 36;
    }
  }

  yRef.value = y;
  return y;
}
