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
 *               fertilizer_kg, micronutrients_l, notes }],
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

  y += 72;

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
  y += 12;

  doc.setFont('helvetica', 'bold');
  doc.text('Area:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.area || '', marginL + 60, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Site:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.site_name || '', marginL + 345, y);
  y += 12;

  // Customer rep — only printed when filled in so we don't waste a line
  // on jobs where the office doesn't track the on-site contact.
  if (data.customer_rep || data.customer_rep_phone) {
    doc.setFont('helvetica', 'bold');
    doc.text('Cust. Rep:', marginL, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(data.customer_rep || ''), marginL + 60, y);
    if (data.customer_rep_phone) {
      doc.setFont('helvetica', 'bold');
      doc.text('Contact #:', marginL + 310, y);
      doc.setFont('helvetica', 'normal');
      // 'Contact #:' is wider than 'Date:' / 'Site:', so the same 35pt offset
      // those short labels use butts the phone number against the colon.
      // Bump to 60pt for breathing room.
      doc.text(String(data.customer_rep_phone), marginL + 360, y);
    }
    y += 12;
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
      y += 11;
    }
    if (data.lead) {
      doc.setFont('helvetica', 'bold');
      doc.text('Lead:', marginL, y);
      doc.setFont('helvetica', 'normal');
      doc.text(String(data.lead), marginL + 60, y);
      y += 11;
    }
    if (data.workers && data.workers.length) {
      doc.setFont('helvetica', 'bold');
      doc.text('Workers:', marginL, y);
      doc.setFont('helvetica', 'normal');
      doc.text(data.workers.join(', '), marginL + 60, y);
      y += 11;
    }
    y += 1;
  } else {
    doc.setFont('helvetica', 'bold');
    doc.text('Crew:', marginL, y);
    doc.setFont('helvetica', 'normal');
    doc.text((data.crew || []).join(', '), marginL + 60, y);
    y += 12;
  }

  doc.setFont('helvetica', 'bold');
  doc.text('Description of Work:', marginL, y);
  doc.setFont('helvetica', 'normal');
  const descLines = doc.splitTextToSize(data.description_of_work || '', contentW - 125);
  doc.text(descLines, marginL + 115, y);
  y += Math.max(12, descLines.length * 11);

  // ── Payroll Hours + Crew Truck + Travel + Water Truck ────────────────────
  // Compact two-column block so the worker can verify what they entered
  // before submit (and so the office's HT auto-rollup is traceable back to
  // each daily). Each line is suppressed when both its values are blank
  // so an empty section doesn't waste vertical space on quick dailies.
  const supHrs = toNum(data.supervisor_hours);
  const leadHrs = toNum(data.lead_hours);
  const labourPer = toNum(data.labour_hours_per_person);
  const workersCount = (data.workers || []).length;
  const labourTotal = labourPer * workersCount;
  const ctCount = toNum(data.crew_truck_count);
  const ctHours = toNum(data.crew_truck_hours);
  const ctTotal = ctCount * ctHours;
  const travelKm = toNum(data.travel_km);
  const waterLoads = toNum(data.water_truck_loads);

  const hoursLines = [];
  if (supHrs)    hoursLines.push(['Supervisor:', `${fmtNum(supHrs)} hrs`]);
  if (leadHrs)   hoursLines.push(['Lead:',       `${fmtNum(leadHrs)} hrs`]);
  if (labourTotal) hoursLines.push([
    'Labour:',
    `${fmtNum(labourPer)} hrs/person × ${workersCount} = ${fmtNum(labourTotal)} hrs total`,
  ]);
  if (ctTotal)   hoursLines.push([
    'Crew Trucks:',
    `${fmtNum(ctCount, 0)} × ${fmtNum(ctHours)} hrs = ${fmtNum(ctTotal)} truck-hrs`,
  ]);
  if (travelKm)  hoursLines.push(['Travel (Mob/Demob):', `${fmtNum(travelKm)} kms`]);
  if (waterLoads) hoursLines.push(['Water Truck:',       `${fmtNum(waterLoads, 0)} loads`]);

  if (hoursLines.length > 0) {
    y += 4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text('Hours & Logistics', marginL, y);
    y += 3;
    drawRect(marginL, y, contentW, 0.5);
    y += 8;
    // Two-column grid for tighter packing on dailies with many fields.
    const colW = contentW / 2;
    for (let i = 0; i < hoursLines.length; i += 2) {
      const left = hoursLines[i];
      const right = hoursLines[i + 1];
      doc.setFont('helvetica', 'bold');
      doc.text(left[0], marginL, y);
      doc.setFont('helvetica', 'normal');
      doc.text(left[1], marginL + 90, y);
      if (right) {
        doc.setFont('helvetica', 'bold');
        doc.text(right[0], marginL + colW, y);
        doc.setFont('helvetica', 'normal');
        doc.text(right[1], marginL + colW + 90, y);
      }
      y += 11;
    }
  }

  // ── Materials ────────────────────────────────────────────────────────────
  // Compact section so multi-seed-type dailies still leave room for photos
  // on page 1. Tight gaps + inline seed-types list save ~25pt vs. v1.
  y += 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Materials', marginL, y);
  y += 4;
  drawRect(marginL, y, contentW, 1);
  y += 9;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text('Mulch Type:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.mulch_type || '', marginL + 70, y);
  doc.setFont('helvetica', 'bold');
  doc.text('Fertilizer:', marginL + 310, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.fertilizer || '', marginL + 360, y);
  y += 11;

  doc.setFont('helvetica', 'bold');
  doc.text('Soil Amendment:', marginL, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.soil_amendment || '', marginL + 95, y);
  y += 11;

  const seedTypes = data.seed_types || [];
  if (seedTypes.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.text('Seed Types:', marginL, y);
    doc.setFont('helvetica', 'normal');
    // First seed renders inline next to the label; additional seeds wrap
    // underneath aligned to the same indent. Saves one line vs. the old
    // "label on its own line + bullets below" layout.
    for (let si = 0; si < seedTypes.length; si++) {
      const st = seedTypes[si];
      const line = `${st.name || ''}${st.description ? `: ${st.description}` : ''}`;
      const wrapped = doc.splitTextToSize(line, contentW - 64);
      doc.text(wrapped, marginL + 64, y);
      y += wrapped.length * 10;
    }
  }
  y += 2;

  // ── Loads table ──────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Loads', pageW / 2, y, { align: 'center' });
  y += 6;

  // Dynamic columns: #, Area (m²), Bales, Mulch (kg) are always present.
  // Each additive (Soil Amend / Aqua Gel / Tackifier / Fertilizer / Micro
  // Nutrients) only renders if at least one load actually used it — a
  // typical day uses ~2 additives, so this keeps the table from running
  // off the page on common dailies (and stops Micro Nutrients getting
  // truncated in the last column on busy days). Notes column follows
  // the same any-non-empty rule it always did.
  const loads = (data.loads || []).slice();
  const hasNotes = loads.some(l => (l?.notes || '').trim() !== '');
  const seedNames = seedTypes.map(s => s.name).filter(Boolean);

  // Additive column definitions — `key` is the load field the value
  // comes from. The filtered list `additiveCols` keeps only the
  // additives that have data on this daily.
  const ALL_ADDITIVE_COLS = [
    { key: 'soil_amendment_kg', label: 'Soil Amend', unit: 'kg' },
    { key: 'aqua_gel_kg',       label: 'Aqua Gel',   unit: 'kg' },
    { key: 'tackifier_kg',      label: 'Tackifier',  unit: 'kg' },
    { key: 'fertilizer_kg',     label: 'Fertilizer', unit: 'kg' },
    { key: 'micronutrients_l',  label: 'Micro Nutrients', unit: 'L' },
  ];
  const additiveCols = ALL_ADDITIVE_COLS.filter(c =>
    loads.some(l => toNum(l?.[c.key]) > 0)
  );

  // Fixed widths for the first columns, then divide what's left between
  // seed columns and the additive tail. Bales is its own column now —
  // workers wanted to see bale count separated from the kg total in the
  // loads table for at-a-glance verification.
  const fixedColW = {
    num: 22,
    area: 50,
    bales: 34,
    mulch: 48,
  };
  const notesW = hasNotes ? 80 : 0;
  // Additive columns get a touch more width than before since the table
  // is usually narrower now (fewer cols means more room per col).
  const additiveW = 52;
  const tailW = additiveW * additiveCols.length;
  const fixedTotal = fixedColW.num + fixedColW.area + fixedColW.bales + fixedColW.mulch + tailW + notesW;
  const seedColTotalW = contentW - fixedTotal;
  const perSeedW = seedNames.length > 0 ? Math.max(34, Math.min(60, seedColTotalW / seedNames.length)) : 0;

  // Header cells in order: # | Area | Bales | Mulch (kg) | seeds… | additives… | (Notes)
  const headerCells = [
    { label: '#', w: fixedColW.num },
    { label: 'Area (m²)', w: fixedColW.area },
    { label: 'Bales', w: fixedColW.bales },
    { label: 'Mulch (kg)', w: fixedColW.mulch },
    ...seedNames.map(n => ({ label: `${n} (kg)`, w: perSeedW })),
    ...additiveCols.map(c => ({ label: `${c.label} (${c.unit})`, w: additiveW })),
    ...(hasNotes ? [{ label: 'Notes', w: notesW }] : []),
  ];
  // Resize so total exactly equals contentW (rounding fudge).
  const headerSum = headerCells.reduce((a, c) => a + c.w, 0);
  if (headerSum > 0 && headerSum !== contentW) {
    const scale = contentW / headerSum;
    headerCells.forEach(c => { c.w *= scale; });
  }
  const rowH = 14;

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
  // `additives` is keyed by load-field name (same key used in the col
  // definition) so the row + totals loops can read it positionally.
  const totals = {
    area_m2: 0,
    bales: 0,
    mulch_kg: 0,
    seed: Object.fromEntries(seedNames.map(n => [n, 0])),
    additives: Object.fromEntries(additiveCols.map(c => [c.key, 0])),
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
    for (const n of seedNames) {
      totals.seed[n] += toNum((load.seed_kgs || {})[n]);
    }
    for (const c of additiveCols) {
      totals.additives[c.key] += toNum(load[c.key]);
    }

    const cells = [
      String(load.load_number || (r + 1)),
      fmtNum(load.area_m2, 0),
      // Bales and Mulch (kg) are now separate columns so the values
      // line up cleanly under their own headers (previously "681 (30)"
      // crowded into one cell, which workers flagged as confusing).
      bales ? fmtNum(bales, 0) : '',
      mulchKg ? fmtNum(mulchKg, 0) : '',
      ...seedNames.map(n => fmtNum((load.seed_kgs || {})[n])),
      ...additiveCols.map(c => fmtNum(load[c.key])),
      ...(hasNotes ? [String(load.notes || '')] : []),
    ];
    let cx = marginL;
    for (let i = 0; i < headerCells.length; i++) {
      const w = headerCells[i].w;
      drawRect(cx, y, w, rowH);
      const text = String(cells[i] || '');
      const truncated = doc.splitTextToSize(text, w - 4)[0] || '';
      doc.text(truncated, cx + 3, y + 10);
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
      ...seedNames.map(n => fmtNum(totals.seed[n])),
      ...additiveCols.map(c => fmtNum(totals.additives[c.key])),
      ...(hasNotes ? [''] : []),
    ];
    for (let i = 0; i < headerCells.length; i++) {
      const w = headerCells[i].w;
      drawRect(cx, y, w, rowH);
      doc.text(String(totalCells[i] || ''), cx + 3, y + 10);
      cx += w;
    }
    y += rowH;
    doc.setFont('helvetica', 'normal');
  }

  // Equipment-used is intentionally NOT rendered on the daily PDF. Workers
  // still log equipment hours on the form so the office HT ticket can
  // aggregate hours across all linked dailies for billing, but the daily
  // sheet stays focused on what was actually applied to the ground —
  // materials, loads, and photos. Keeps the PDF to one page on typical
  // 1–2 load jobs.

  // ── Comments ─────────────────────────────────────────────────────────────
  // Box height grows with the actual comment text (one line per ~10pt) so
  // a short one-liner doesn't eat 50pt of page-1 real estate.
  if (data.comments) {
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Comments:', marginL, y);
    y += 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(data.comments, contentW - 8);
    const commH = Math.min(50, Math.max(18, lines.length * 10 + 8));
    ensureSpace(commH + 10);
    drawRect(marginL, y, contentW, commH);
    doc.text(lines, marginL + 3, y + 11);
    y += commH;
  }

  // Section min-height threshold — header + one small photo row + label.
  // Used by both photo blocks below to decide whether to page-break before
  // starting the section.
  const SECTION_MIN_H = 110;

  // ── Annotated Map / Photos ───────────────────────────────────────────────
  // Map annotations render FIRST and at 2-up so each one is roughly double
  // the area of the previous 3-up layout — workers need to see boundary
  // lines and pin locations clearly to verify where they sprayed.
  if (photos.length > 0) {
    // Bigger top-gap (was 6) so the bold section header doesn't overlap
    // the bottom edge of the preceding loads-totals row when there are no
    // comments to act as a spacer.
    y += 14;
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
      cols: 2,        // 2-up doubles cell area vs. the previous 3-up grid
      maxCellH: 320,  // taller cap so map detail stays readable
      marginL,
      marginB,
      contentW,
      pageW,
      pageH,
      yRef: { value: y },
    }).then(yEnd => { y = yEnd; });
  }

  // ── Seed Tag Photos ──────────────────────────────────────────────────────
  // Render BELOW the map at 4-up so each tag is small but the batch number
  // / lot is still legible. Workers don't need to study these in detail —
  // they just need to confirm which seed went down.
  if (seedTags.length > 0) {
    y += 14;
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
      cols: 4,        // 4-up keeps tags compact under the bigger map cells
      maxCellH: 100,  // hard cap — tags don't need to dominate the page
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

// 3-up grid of photos that ADAPTS to the remaining vertical space —
// small photos squeeze in next to the form so the daily fits on one page
// when possible, while still expanding to a comfortable size when the
// photos section gets its own page (e.g. many photos or a tall loads
// table). Each photo keeps its aspect ratio; nothing is cropped. Row
// height is the tallest scaled photo in the row, NOT the cell cap, so
// wide seed-tag photos no longer reserve 200pt of empty whitespace.
async function drawPhotoGrid(doc, images, opts) {
  const { labelPrefix, marginL, marginB, contentW, pageW, pageH, yRef } = opts;
  let y = yRef.value;
  // Caller picks the column count + max cell height per section. Defaults
  // (3-up, 220pt cap) match the original behavior so other callers don't
  // need to change. Map / seed-tag sections override these to size each
  // group of photos appropriately for what workers actually need to see.
  const COLS = opts.cols ?? 3;
  const MAX_CELL_H = opts.maxCellH ?? 220;
  const GUTTER = 10;
  const cellW = (contentW - GUTTER * (COLS - 1)) / COLS;
  // Per-row height bounds. MIN is the threshold below which we page-break
  // (otherwise photos become postage stamps); MAX (above) caps a single
  // tall portrait from eating a third of the next page.
  const MIN_CELL_H = 80;
  const LABEL_H = 10;

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

  for (let i = 0; i < images.length; i += COLS) {
    // Available vertical room for THIS row of photos (incl. label).
    const remaining = pageH - marginB - y;
    let cellHCap;
    if (remaining < MIN_CELL_H + LABEL_H) {
      // No room left on this page — push to a new page with full size.
      doc.addPage();
      y = 36;
      cellHCap = MAX_CELL_H;
    } else {
      cellHCap = Math.min(MAX_CELL_H, remaining - LABEL_H - 4);
    }
    // Actual row height = tallest scaled photo in the row. Bounded by
    // cellHCap so a tall portrait can't break out of the page.
    let rowH = 0;
    for (let k = 0; k < COLS; k++) {
      const idx = i + k;
      if (idx >= images.length) break;
      const d = dims[idx];
      const ratio = d.h / d.w;
      let drawH = cellW * ratio;
      if (drawH > cellHCap) drawH = cellHCap;
      if (drawH > rowH) rowH = drawH;
    }
    if (rowH === 0) rowH = MIN_CELL_H;

    const drawCell = (idx, x) => {
      if (idx >= images.length) return;
      const d = dims[idx];
      const ratio = d.h / d.w;
      let drawW = cellW;
      let drawH = cellW * ratio;
      if (drawH > rowH) {
        drawH = rowH;
        drawW = rowH / ratio;
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
      doc.text(`${labelPrefix} ${idx + 1}`, x, y + drawH + 8);
    };
    for (let k = 0; k < COLS; k++) {
      drawCell(i + k, marginL + (cellW + GUTTER) * k);
    }
    y += rowH + LABEL_H + 4;
    if (y + MIN_CELL_H + LABEL_H > pageH - marginB && i + COLS < images.length) {
      doc.addPage();
      y = 36;
    }
  }

  yRef.value = y;
  return y;
}
