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

// ── Per-product unit catalog ────────────────────────────────────────────────
//
// Office can charge mulch / seed / fertilizer in either their kg total or
// their packaging unit (bales for mulch, bags for seed + fertilizer). The
// detail-sheet dropdown reads OFFICE_UNIT_OPTIONS to render the <select>,
// and the PDF schedule + the office-line sync use it to convert qty
// to/from kg as the office user flips billing units. The actual mulch /
// seed / fertilizer used always lives in kg on the daily aggregation — the
// office line just expresses it in whatever unit the customer is billed in,
// and the schedule annotates the alternate-unit total beside the label so
// the office can sanity-check the conversion.
//
// Other product rows (Aqua Gel, Tackifier, Crew Truck, etc.) keep a free-
// form unit text input — they're either single-unit billing (always kg /
// always hours) or office-typed custom items.
export const OFFICE_UNIT_OPTIONS = {
  mulch: [
    { value: 'kg',    kgPerUnit: 1 },
    { value: 'bales', kgPerUnit: 22.7 },
  ],
  seed: [
    { value: 'kg',        kgPerUnit: 1 },
    { value: '25 kg bag', kgPerUnit: 25 },
  ],
  fertilizer: [
    { value: 'kg',        kgPerUnit: 1 },
    { value: '25 kg bag', kgPerUnit: 25 },
    { value: '18 kg bag', kgPerUnit: 18 },
  ],
};

// Detect which product family a line belongs to so the dropdown + the
// schedule renderer know which unit options apply. Match is by label,
// case-insensitive, exact for Mulch / Fertilizer and prefix for Seed:<name>
// (each declared seed type gets its own line).
export function getOfficeLineProductCategory(label) {
  const lc = String(label || '').toLowerCase().trim();
  if (lc === 'mulch') return 'mulch';
  if (lc.startsWith('seed:')) return 'seed';
  if (lc === 'fertilizer') return 'fertilizer';
  return null;
}

// kg per `unit` for a given product family. Falls back to 1 (no
// conversion) for unknown/free-form units so non-product lines pass
// through the sync untouched.
export function getOfficeLineKgPerUnit(category, unit) {
  if (!category) return 1;
  const opts = OFFICE_UNIT_OPTIONS[category] || [];
  const u = String(unit || '').toLowerCase().trim();
  const match = opts.find(o => o.value.toLowerCase() === u);
  return match?.kgPerUnit || 1;
}

// Aggregator-emitted rolled-up labels we no longer auto-seed as office
// lines. The kg/bales toggle on the Mulch line replaces the separate
// 'Mulch (bales)' line, and the per-seed-type 'Seed: <name>' lines
// replace the rolled-up 'Seed' total (each seed can be priced
// independently).
const LEGACY_AUTO_SEEDED_LABELS = new Set(['mulch (bales)', 'seed']);

export function isLegacyAutoSeededLabel(label) {
  return LEGACY_AUTO_SEEDED_LABELS.has(String(label || '').toLowerCase().trim());
}

/**
 * Auto-seeded office lines when an HT is first opened in the detail sheet
 * and `office_data.lines` is still null/empty. We add one row per existing
 * ticket.row (qty/unit pre-filled from the rolled-up daily aggregation,
 * rate blank for office to enter). Office can also append extra custom
 * lines (mobilization, day-rate top-ups, etc.) — they live alongside the
 * auto-seeded ones in the same array.
 *
 * Skips the rolled-up 'Mulch (bales)' / 'Seed' rows since the per-product
 * dropdown + per-seed-type rows now cover those cases.
 *
 * Returns [{ label, qty, unit, rate: '' }, ...]
 */
export function seedOfficeLinesFromTicketRows(rows) {
  return (rows || [])
    .filter(r => !isLegacyAutoSeededLabel(r?.label))
    .map(r => ({
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
 *
 * For mulch / seed / fertilizer lines the qty is converted from the
 * aggregator's kg total into whatever billing unit the office picked
 * (bales / 25-kg bag / etc.). Legacy 'Mulch (bales)' / 'Seed' lines
 * already saved on a ticket are preserved untouched so any rate the
 * office may have entered before this rollout isn't silently wiped.
 *
 * @param {Array}    existingLines  - office_data.lines from the server.
 * @param {Array}    rows           - ticket.rows (aggregated daily data).
 * @param {Set|null} [removedLabels] - labels the office intentionally
 *   deleted. When present, the append phase skips any label in this set
 *   so deleted lines don't silently reappear after a save round-trip.
 */
export function syncOfficeLineQtysFromRows(existingLines, rows, removedLabels) {
  const rowByLabel = new Map();
  for (const r of rows || []) {
    if (!r?.label) continue;
    if (isLegacyAutoSeededLabel(r.label)) continue;
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
    // Don't auto-touch legacy lines — the office may still have a rate
    // entered on the old 'Mulch (bales)' / 'Seed' total lines and the
    // detail sheet decides at render time whether to hide them.
    if (isLegacyAutoSeededLabel(l.label)) return { ...l };
    if (l.isQtyOverridden) {
      if (rowByLabel.has(l.label)) {
        seen.add(l.label);
      }
      return { ...l };
    }
    const match = rowByLabel.get(l.label);
    if (match) {
      seen.add(l.label);
      // Convert the aggregator's kg total into the office line's chosen
      // billing unit so the qty cell reflects how the office is charging
      // (kg vs bales for mulch, kg vs 25-kg bag for seed, etc.). Falls
      // back to factor 1 for non-product lines.
      const category = getOfficeLineProductCategory(l.label);
      const factor = getOfficeLineKgPerUnit(category, l.unit) || 1;
      const qtyInOfficeUnit = match.qty / factor;
      // Round to 2 decimals so 1000 / 22.7 = 44.05 (not 44.05286...).
      const rounded = Math.round(qtyInOfficeUnit * 100) / 100;
      return { ...l, qty: rounded, unit: l.unit || match.unit };
    }
    // Custom line — leave it alone.
    return { ...l };
  });

  // Append any newly-aggregated labels that weren't on the office_data yet.
  // Skip labels the office intentionally removed so they don't reappear.
  const removedLc = new Set();
  if (removedLabels) {
    for (const rl of removedLabels) removedLc.add(String(rl).toLowerCase().trim());
  }
  for (const [label, info] of rowByLabel.entries()) {
    if (seen.has(label)) continue;
    if (removedLc.has(label.toLowerCase().trim())) continue;
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

// Sum the qty of all `ticket.rows[]` whose label matches (case-insensitive
// exact). Returns 0 when no row matches. Used by the paper-form schedule
// to roll the per-daily contributions into one total per slot at PDF time.
function sumRowsByLabel(rows, label) {
  const target = (label || '').toLowerCase();
  let total = 0;
  for (const r of rows || []) {
    if ((r?.label || '').toLowerCase() === target) {
      total += Number(r.qty) || 0;
    }
  }
  return total;
}

// Like sumRowsByLabel but matches by label substring (case-insensitive).
function sumRowsByLabelIncludes(rows, needle) {
  const target = (needle || '').toLowerCase();
  let total = 0;
  for (const r of rows || []) {
    if ((r?.label || '').toLowerCase().includes(target)) {
      total += Number(r.qty) || 0;
    }
  }
  return total;
}

// Parse `cost_code` strings emitted by the backend aggregator, e.g.
// "per_person=8;count=3" or "per_unit=12;count=2". Returns a plain object.
function parseCostCode(cc) {
  if (!cc || typeof cc !== 'string') return {};
  const out = {};
  for (const part of cc.split(';')) {
    const [k, v] = part.split('=');
    if (k && v != null) out[k.trim()] = v.trim();
  }
  return out;
}

// Find the maximum `count` across all rows that match `label` exactly.
// Used for the "# of Labourers on site" / "# trucks on site" annotations
// where the paper-form shows the max count across linked dailies.
function maxCountFromRowsByLabel(rows, label) {
  const target = (label || '').toLowerCase();
  let maxN = 0;
  for (const r of rows || []) {
    if ((r?.label || '').toLowerCase() !== target) continue;
    const cc = parseCostCode(r.cost_code);
    const n = Number(cc.count) || 0;
    if (n > maxN) maxN = n;
  }
  return maxN;
}

// Aggregate per-seed-type rows ("Seed: <name>") in declared order. Returns
// an array of { name, qty } sorted by the `seed_idx` from cost_code (when
// present) so #1 Seed / #2 Seed slots fill in declaration order.
function collectSeedTypes(rows) {
  const byName = new Map();   // name -> { name, qty, idx }
  for (const r of rows || []) {
    const label = r?.label || '';
    if (!label.toLowerCase().startsWith('seed:')) continue;
    const name = label.slice(label.indexOf(':') + 1).trim();
    if (!name) continue;
    const cc = parseCostCode(r.cost_code);
    const idx = cc.seed_idx != null ? Number(cc.seed_idx) : null;
    const prior = byName.get(name);
    byName.set(name, {
      name,
      qty: (prior?.qty || 0) + (Number(r.qty) || 0),
      idx: prior?.idx ?? idx,
    });
  }
  // Sort: known idx first (ascending), then alphabetical fallback.
  return [...byName.values()].sort((a, b) => {
    const ai = a.idx == null ? Infinity : a.idx;
    const bi = b.idx == null ? Infinity : b.idx;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

// Collect distinct hydroseeder equipment rows (label preserved). One row
// per unique label across all linked dailies, hours summed within each
// label. So if the worker entered "T400 Hydroseeder" 12hr on one daily and
// 8hr on another, the PDF shows ONE "T400 Hydroseeder" row with 20 hrs.
// Different machines (e.g. T400 + T330) stay as separate rows.
// (Exported for test suites).
export function collectHydroseederRows(rows) {
  const byLabel = new Map();
  for (const r of rows || []) {
    const label = r?.label || '';
    if (!label.toLowerCase().includes('hydroseeder')) continue;
    if (r.kind && r.kind !== 'equipment') continue;
    const prior = byLabel.get(label) || 0;
    byLabel.set(label, prior + (Number(r.qty) || 0));
  }
  return [...byLabel.entries()].map(([label, hours]) => ({ label, hours }));
}

// Look up a rate from the office_data.lines[] by matching label
// (case-insensitive). Returns 0 if not found or office data is hidden.
function findRate(officeLines, label) {
  const target = (label || '').toLowerCase().trim();
  for (const l of officeLines || []) {
    if ((l?.label || '').toLowerCase().trim() === target) {
      const r = parseFloat(l.rate);
      if (Number.isFinite(r)) return r;
    }
  }
  return 0;
}

// Look up a quantity from the office_data.lines[] by matching label
// (case-insensitive). Returns null if not found.
function findQty(officeLines, label) {
  const target = (label || '').toLowerCase().trim();
  for (const l of officeLines || []) {
    if ((l?.label || '').toLowerCase().trim() === target) {
      const q = parseFloat(l.qty);
      if (Number.isFinite(q)) return q;
      // Explicitly return 0 if qty is 0 (not null) so the ?? fallback
      // doesn't trigger — office-set 0 means "hide this line".
      if (l.qty === 0 || l.qty === '0') return 0;
    }
  }
  return null;
}

// Best-effort fuzzy quantity lookup: matches by label *word boundary*.
function findQtyFuzzy(officeLines, needles) {
  for (const needle of needles) {
    const target = (needle || '').toLowerCase().trim();
    if (!target) continue;
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    for (const l of officeLines || []) {
      if (re.test(l?.label || '')) {
        const q = parseFloat(l.qty);
        if (Number.isFinite(q)) return q;
        // Explicitly return 0 if qty is 0 (not null) so the ?? fallback
        // doesn't trigger — office-set 0 means "hide this line".
        if (l.qty === 0 || l.qty === '0') return 0;
      }
    }
  }
  return null;
}

// Best-effort fuzzy rate lookup: matches by label *word boundary*. Used
// when the schedule slot name (e.g. "#1 Seed") doesn't exactly match the
// office-seeded label (e.g. "Seed: Native Mix"). Pass an array of needle
// strings in priority order; returns the first match.
//
// Whole-word matching is critical: a raw String.includes() call would
// let the short needle 'seed' match the substring inside "hydroSEEDer",
// which silently pulled the office's hydroseeder rate onto every #N
// Seed schedule row whenever those rows had no exact label match. Same
// trap with 'lead' inside "misled" / "leader", 'mob' inside "mobile",
// 'labour' inside "Labourer", etc. Word boundaries avoid all of them
// without us having to whitelist needles individually.
function findRateFuzzy(officeLines, needles) {
  for (const needle of needles) {
    const target = (needle || '').toLowerCase().trim();
    if (!target) continue;
    // Escape regex metacharacters so needles like 'seed: <name>' (colon)
    // or 'mob/demob' (slash) are matched literally inside the regex.
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    for (const l of officeLines || []) {
      if (re.test(l?.label || '')) {
        const r = parseFloat(l.rate);
        if (Number.isFinite(r)) return r;
      }
    }
  }
  return 0;
}

// Aggregate header fields across linked dailies. Returns `null` for the
// scalar fields if no daily has a value, or the first non-empty value.
// Crew names are deduped (preserving first-seen order, supervisor → lead
// → workers across all dailies). Used by the bordered info box and the
// "Personal On Site" line on the paper-form layout.
function aggregateLinkedDailyHeader(linkedDailies) {
  const list = (linkedDailies || []).filter(Boolean);
  const firstNonEmpty = (key) => {
    for (const d of list) {
      const v = d?.[key];
      if (v != null && String(v).trim() !== '') return v;
    }
    return null;
  };
  const namesSeen = new Set();
  const personalOnSite = [];
  const pushName = (n) => {
    const v = (n || '').trim();
    if (!v || namesSeen.has(v)) return;
    namesSeen.add(v);
    personalOnSite.push(v);
  };
  for (const d of list) {
    if (d?.supervisor) pushName(d.supervisor);
    if (d?.lead) pushName(d.lead);
    for (const w of d?.workers || []) pushName(w);
    // Legacy fallback when role-split fields are missing.
    if (!d?.supervisor && !d?.lead && !(d?.workers?.length)) {
      for (const c of d?.crew || []) pushName(c);
    }
  }
  return {
    customerRep: firstNonEmpty('customer_rep'),
    customerRepPhone: firstNonEmpty('customer_rep_phone'),
    supervisor: firstNonEmpty('supervisor'),
    lead: firstNonEmpty('lead'),
    personalOnSite,
    recordNumbers: list.map(d => d?.record_number).filter(Boolean),
  };
}

/**
 * Generate a Hydroseed Ticket PDF.
 *
 * Layout matches the printed paper field ticket: a single combined
 * Materials/Installation table with a fixed schedule of rows, a bordered
 * info box header, "Personal On Site" + "Job Description" lines, and a
 * GST# / WCB# + Comments + Approved footer block. Workers see all rows
 * but not rates/totals (those are blanked out).
 *
 * @param {object} ticket - HydroseedTicket {
 *     ticket_number, work_date, client, area,
 *     description_of_work, po_approval_number,
 *     rows: [{ kind, label, qty, unit, cost_code }],
 *     office_data: { lines, gst_percent, gst_enabled,
 *                    comments, other_products[] },
 *     approved_signature, daily_records: [HydroseedLinkedDaily]
 *   }
 * @param {object} [options] - { includeOfficeData=false, signaturePng=null,
 *                               linkedRecordNumbers=[] }
 *   - `includeOfficeData=false` mirrors the T&M ticket convention: workers
 *     see QTY but never $ rates/totals. Office PDF generation flips to true.
 *   - `linkedRecordNumbers` overrides `ticket.daily_records[].record_number`
 *     when explicitly passed (used by the detail sheet to keep preview
 *     in sync before save).
 *
 * Returns { blob, base64 }.
 */
export async function generateHydroseedTicketPdf(ticket, options = {}) {
  const {
    includeOfficeData = false,
    signaturePng = null,
    linkedRecordNumbers = null,
  } = options;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginL = 36;
  const marginR = 36;
  const marginB = 36;
  const contentW = pageW - marginL - marginR;
  // Visual content width — matches the materials table total (sum of
  // tableColW below). Used for the info box, signature line, comments
  // wrap, etc. so every framed/aligned element shares the same right
  // edge instead of some using contentW (540pt) and some using 525pt.
  const boxW = 525;
  let y = 36;

  const drawRect = (x, yy, w, h) => {
    doc.setDrawColor(0);
    doc.setLineWidth(0.5);
    doc.rect(x, yy, w, h);
  };

  // ── Pull aggregated header fields out of the linked daily summaries ──
  const linked = ticket.daily_records || [];
  const header = aggregateLinkedDailyHeader(linked);
  // Allow caller to override the HD list (detail-sheet preview path).
  const dailyNumbers = linkedRecordNumbers != null
    ? linkedRecordNumbers
    : header.recordNumbers;

  // ── Office-line lookups for rates ──
  const officeLines = (includeOfficeData && ticket.office_data?.lines) || [];
  const otherProducts = (ticket.office_data?.other_products || []).slice(0, 2);
  const comments = ticket.office_data?.comments || '';
  const gstPercent = Number(ticket.office_data?.gst_percent ?? 5) || 0;
  const gstEnabled = ticket.office_data?.gst_enabled !== false;
  const removedLabels = ticket.office_data?.removed_labels || [];
  const removedLc = new Set(removedLabels.map(l => String(l).toLowerCase().trim()));
  const isLabelRemoved = (label) => {
    return removedLc.has(String(label).toLowerCase().trim());
  };

  // ── Logo + Title (paper-style: title + No. on a single right-aligned line) ──
  const logoData = await loadLogo();
  if (logoData) {
    doc.addImage(logoData, 'PNG', marginL, y, 110, 110);
  }

  // Title vertically centered with the logo (~y+45 for a 110pt logo) and
  // horizontally centered on the page so it reads as the main letterhead.
  // Ticket number is rendered separately, smaller + right-aligned to the
  // boxW right edge so it lines up with the info box / materials table.
  const titleY = y + 45;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(50, 80, 50);
  doc.text('Hydroseed Time and Materials Ticket', pageW / 2, titleY, { align: 'center' });

  // Ticket number — smaller, right-aligned, same baseline as the title.
  doc.setFontSize(11);
  doc.text(
    `No. ${ticket.ticket_number || ''}`,
    marginL + boxW,
    titleY,
    { align: 'right' },
  );
  doc.setTextColor(0);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(60, 100, 60);
  doc.text('www.pineviewvegetation.com', pageW / 2, titleY + 14, { align: 'center' });
  doc.setTextColor(0);

  // Address line — centered under the URL (was anchored to the left under
  // the logo). All three letterhead lines are now horizontally centered.
  doc.setFontSize(8);
  doc.setTextColor(80);
  doc.text(
    '7077 252 Road    Pineview BC V1J 8E3    250.261.9544',
    pageW / 2,
    titleY + 28,
    { align: 'center' },
  );
  doc.setTextColor(0);

  // Tightened gap between the letterhead and the info box (was 120pt, the
  // logo is only 110pt tall so the extra 10pt was wasted whitespace).
  y += 112;

  // ── Bordered info box (Customer / Date / Customer Rep / Contact # / etc.) ──
  // Two columns × four rows. Right column's last row is intentionally blank
  // because the paper has the HD list spanning the full width.
  const infoRowH = 16;
  const infoBoxRows = 4;
  const infoBoxH = infoRowH * infoBoxRows;
  const infoColW = boxW / 2;

  drawRect(marginL, y, boxW, infoBoxH);
  // Vertical divider between the two columns.
  doc.line(marginL + infoColW, y, marginL + infoColW, y + infoBoxH);

  const drawInfoCell = (col, row, label, value, opts = {}) => {
    const cellX = marginL + (col === 0 ? 0 : infoColW);
    const cellY = y + row * infoRowH;
    if (row > 0) {
      doc.line(cellX, cellY, cellX + infoColW, cellY);
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text(label, cellX + 4, cellY + 11);
    doc.setFont('helvetica', 'normal');
    const valueX = cellX + (opts.labelW || 80);
    const valueWidth = infoColW - (opts.labelW || 80) - 6;
    const txt = doc.splitTextToSize(String(value || ''), valueWidth)[0] || '';
    doc.text(txt, valueX, cellY + 11);
  };

  // Row order (left column / right column):
  //   row 0: Customer / Date
  //   row 1: Customer Rep / P.O.#       ← P.O.# moved up to pair with Date
  //   row 2: Contact # / Lead           ← Contact # moved down to pair with Rep
  //   row 3: Daily HD# (spans visually; right cell intentionally blank)
  drawInfoCell(0, 0, 'Customer:',                        ticket.client || '', { labelW: 60 });
  drawInfoCell(1, 0, 'Date:',                            String(ticket.work_date || ''), { labelW: 35 });
  drawInfoCell(0, 1, 'Customer Rep:',                    header.customerRep || '', { labelW: 78 });
  drawInfoCell(1, 1, 'P.O.#',                            ticket.po_approval_number || '', { labelW: 40 });
  drawInfoCell(0, 2, 'Contact #:',                       header.customerRepPhone || '', { labelW: 60 });
  drawInfoCell(1, 2, 'Lead:',                            header.lead || '', { labelW: 35 });
  drawInfoCell(0, 3, 'Daily Hydroseed App. Record #:',   (dailyNumbers || []).join(', '), { labelW: 160 });

  // 16pt gap (was 6) so the Personal On Site / Job Description labels
  // don't crash into the bottom border of the info box.
  y += infoBoxH + 16;

  // ── Personal On Site ──
  if (header.personalOnSite.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Personal On Site:', marginL, y);
    doc.setFont('helvetica', 'normal');
    const namesText = header.personalOnSite.join(', ');
    const namesLines = doc.splitTextToSize(namesText, boxW - 100);
    doc.text(namesLines, marginL + 95, y);
    y += Math.max(12, namesLines.length * 11);
  }

  // ── Job Description ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Job Description:', marginL, y);
  doc.setFont('helvetica', 'normal');
  const descText = ticket.description_of_work || '';
  const descLines = doc.splitTextToSize(descText, boxW - 95);
  doc.text(descLines, marginL + 90, y);
  y += Math.max(12, descLines.length * 11);

  // "See attached daily records." — printed only when there's at least one
  // linked HD so it doesn't lie about non-existent attachments.
  if ((dailyNumbers || []).length > 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(80);
    doc.text('See attached daily records.', marginL, y);
    doc.setTextColor(0);
    doc.setFont('helvetica', 'normal');
    y += 12;
  }

  // ── Combined Materials/Installation table ──
  // Columns: Materials/Installation | Kgs Used | Hours | Rate | Sub Total
  const tableColW = [255, 70, 60, 70, 70];   // total = 525pt < contentW (540)
  const tableTotalW = tableColW.reduce((a, b) => a + b, 0);
  const tableRowH = 16;
  const tableHeaders = ['Materials/Installation', 'Kgs Used', 'Hours', 'Rate', 'Sub Total'];

  const drawTableHeader = (continuation = false) => {
    if (continuation) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Materials / Installation (continued)', pageW / 2, y, { align: 'center' });
      y += 6;
    }
    let hx = marginL;
    doc.setFillColor(240, 240, 240);
    doc.rect(marginL, y, tableTotalW, tableRowH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    for (let i = 0; i < tableColW.length; i++) {
      drawRect(hx, y, tableColW[i], tableRowH);
      const align = i === 0 ? 'left' : (i === 1 || i === 2 ? 'center' : 'right');
      const tx = align === 'left'   ? hx + 4
              : align === 'center' ? hx + tableColW[i] / 2
                                   : hx + tableColW[i] - 4;
      doc.text(tableHeaders[i], tx, y + 11, { align });
      hx += tableColW[i];
    }
    y += tableRowH;
    doc.setFont('helvetica', 'normal');
  };

  y += 4;
  drawTableHeader(false);

  // Aggregations from ticket.rows[]
  const rows = ticket.rows || [];
  const seedTypes = collectSeedTypes(rows);
  const hydroseederRows = collectHydroseederRows(rows);

  const mulchKg          = sumRowsByLabel(rows, 'Mulch');
  const mulchBales       = sumRowsByLabel(rows, 'Mulch (bales)');
  // Accept both spellings so any rows persisted under the original
  // one-word 'Micronutrients' label still sum into the same total as
  // the post-rename 'Micro Nutrients' rows.
  const micronutrientsL  = sumRowsByLabel(rows, 'Micro Nutrients')
                         + sumRowsByLabel(rows, 'Micronutrients');
  const fertilizerKg= sumRowsByLabel(rows, 'Fertilizer');
  const tackifierKg = sumRowsByLabel(rows, 'Tackifier');
  const aquagelKg   = sumRowsByLabel(rows, 'Aqua Gel');
  const bioticKg    = sumRowsByLabel(rows, 'Soil Amendment');
  const skidSteerHrs= sumRowsByLabelIncludes(rows, 'skid steer');
  const crewTruckHrs= sumRowsByLabel(rows, 'Crew Truck');
  const crewTruckMaxN = maxCountFromRowsByLabel(rows, 'Crew Truck');
  const supervisorHrs = sumRowsByLabel(rows, 'Supervisor');
  const leadHandHrs   = sumRowsByLabel(rows, 'Lead Hand');
  const labourHrs     = sumRowsByLabel(rows, 'Total General Labour');
  const labourMaxN    = maxCountFromRowsByLabel(rows, 'Total General Labour');
  const travelKm      = sumRowsByLabel(rows, 'Travel (Mob/Demob)');
  const waterLoads    = sumRowsByLabel(rows, 'Water Truck');
  const totalAreaM2   = sumRowsByLabel(rows, 'Area covered');

  // Cell renderer for one schedule row. `kgsUsed`, `hours`, `rate`, `sub`
  // accept null/undefined/0 to render blank (sparse rendering).
  let runningSubTotal = 0;
  const drawScheduleRow = ({ label, kgsUsed, hours, rate, hideRow = false }) => {
    if (hideRow) return;
    if (y + tableRowH > pageH - marginB) {
      doc.addPage();
      y = 36;
      drawTableHeader(true);
    }
    // Extract the numeric part of `kgsUsed` for sub-total math: callers
    // can pass either a raw number (legacy: kgs / hours / m²) or a string
    // like '44.05 bales' / '100 kms' / '500 m²' when the row needs to
    // print a unit suffix beside the qty. Without this fallback the
    // qty×rate computation silently dropped to 0 for any string-typed
    // qty (so Travel + Water Truck rows showed a rate but no subtotal).
    const numericKgsUsed = (() => {
      if (kgsUsed == null || kgsUsed === '') return 0;
      const direct = Number(kgsUsed);
      if (Number.isFinite(direct)) return direct;
      const m = String(kgsUsed).match(/[-+]?\d*\.?\d+/);
      return m ? Number(m[0]) || 0 : 0;
    })();
    const qtyForSub = numericKgsUsed || Number(hours) || 0;
    const rateNum = Number(rate) || 0;
    const sub = qtyForSub * rateNum;
    if (includeOfficeData && sub > 0) runningSubTotal += sub;

    // Display rule: if `kgsUsed` is already a string (e.g. '44.05 bales'),
    // print it verbatim; if it's a number, format it via formatQty so it
    // renders the same as before. Same for `hours`.
    const renderQtyCell = (v) => {
      if (v == null || v === '') return '';
      if (typeof v === 'string') return v;
      return Number(v) !== 0 ? formatQty(v) : '';
    };
    const cells = [
      String(label || ''),
      renderQtyCell(kgsUsed),
      renderQtyCell(hours),
      includeOfficeData && rateNum !== 0 ? `$ ${formatMoney(rateNum)}` : (includeOfficeData ? '' : ''),
      includeOfficeData && sub > 0 ? `$ ${formatMoney(sub)}` : '',
    ];
    let cx = marginL;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    for (let i = 0; i < tableColW.length; i++) {
      drawRect(cx, y, tableColW[i], tableRowH);
      const align = i === 0 ? 'left' : (i === 1 || i === 2 ? 'center' : 'right');
      const tx = align === 'left'   ? cx + 4
              : align === 'center' ? cx + tableColW[i] / 2
                                   : cx + tableColW[i] - 4;
      const txt = doc.splitTextToSize(cells[i], tableColW[i] - 6)[0] || '';
      doc.text(txt, tx, y + 11, { align });
      cx += tableColW[i];
    }
    y += tableRowH;
  };

  // Helper to skip a row when none of its data columns have a value (so a
  // 0-kg Tackifier doesn't print, matching the user's "only rows with data"
  // requirement). Rate alone never carries a row — there has to be a qty
  // for it to be a real line item.
  const hasData = (kgs, hrs) => (
    (Number(kgs) || 0) !== 0 ||
    (Number(hrs) || 0) !== 0
  );

  // Helper: find the office line for a product (by exact label match,
  // case-insensitive) so the schedule renderer can read its chosen
  // billing unit and convert qty into that unit. Returns null if the
  // line doesn't exist yet (no office_data has been entered).
  const findOfficeLineByLabel = (label) => {
    const target = String(label || '').toLowerCase().trim();
    return (officeLines || []).find(l => (l?.label || '').toLowerCase().trim() === target) || null;
  };

  // Render a product row in the office line's chosen billing unit.
  // Annotates the alternate-unit total beside the label so the office
  // can sanity-check the conversion (e.g. when billing in bales the
  // label reads 'Mulch (1000 kg)', and when billing in kg it reads
  // 'Mulch (44.05 bales)'). `category` is one of the OFFICE_UNIT_OPTIONS
  // keys; the kg total comes from the daily aggregator.
  const renderProductRow = ({
    productLabel,    // exact label as auto-seeded (e.g. 'Mulch', 'Fertilizer', 'Seed: ESC Mixture')
    displayLabel,    // the schedule-side prefix (e.g. '#1 Seed: ESC Mixture')
    kgTotal,         // kg aggregated from the daily(ies)
    category,        // 'mulch' | 'seed' | 'fertilizer'
    rateNeedles,     // priority-ordered fuzzy fallbacks if the exact-label match misses
  }) => {
    const line = findOfficeLineByLabel(productLabel);
    const unit = line?.unit || 'kg';
    const factor = getOfficeLineKgPerUnit(category, unit) || 1;
    // Use manual office line qty if it exists and is filled; otherwise use aggregated total.
    const qtyInUnit = (line && line.qty !== '' && line.qty != null && Number.isFinite(Number(line.qty)))
      ? Number(line.qty)
      : (kgTotal / factor);
    // Format qty + suffix for the qty cell. kg keeps the legacy raw-
    // number rendering (the column header already says 'Kgs Used'); any
    // non-kg unit prints '<qty> <unit>' so the office sees what they're
    // billing.
    const qtyCell = (unit === 'kg')
      ? qtyInUnit
      : `${formatQty(qtyInUnit)} ${unit}`;
    // Alternate-unit annotation. When billing in non-kg, always show
    // the kg total (it's the universal denominator). When billing in
    // kg, show the primary alternate for products that have exactly
    // one (mulch → bales, seed → 25 kg bag); skip for fertilizer in kg
    // since it has two bag sizes and showing one would mislead.
    let altText = '';
    if (unit !== 'kg') {
      altText = ` (${formatQty(kgTotal)} kg)`;
    } else if (category === 'mulch') {
      // Mulch in kg → show bale count from the aggregator's separate
      // 'Mulch (bales)' total (which we hide from the office UI).
      if (mulchBales > 0) altText = ` (${formatQty(mulchBales)} bales)`;
    } else if (category === 'seed') {
      const bags = kgTotal / 25;
      if (bags > 0) altText = ` (${formatQty(bags)} × 25 kg bags)`;
    }
    drawScheduleRow({
      label: `${displayLabel}${altText}`,
      kgsUsed: qtyCell,
      hours: null,
      rate: findRate(officeLines, productLabel) || findRateFuzzy(officeLines, rateNeedles),
    });
  };

  // ── Materials rows ──────────────────────────────────────────────────
  const mulchQtyVal = findQty(officeLines, 'Mulch') ?? mulchKg;
  if (hasData(mulchQtyVal, 0) && !isLabelRemoved('Mulch')) {
    renderProductRow({
      productLabel: 'Mulch',
      displayLabel: 'Mulch',
      kgTotal: mulchKg,
      category: 'mulch',
      rateNeedles: ['mulch'],
    });
  }
  const fertilizerQtyVal = findQty(officeLines, 'Fertilizer') ?? fertilizerKg;
  if (hasData(fertilizerQtyVal, 0) && !isLabelRemoved('Fertilizer')) {
    renderProductRow({
      productLabel: 'Fertilizer',
      displayLabel: 'Fertilizer',
      kgTotal: fertilizerKg,
      category: 'fertilizer',
      rateNeedles: ['fertilizer'],
    });
  }
  // Per-seed-type rows (declaration-order from cost_code). Each seed
  // type has its own office line, its own rate, and — thanks to the
  // unit dropdown — its own billing unit (kg or 25 kg bag).
  for (let i = 0; i < seedTypes.length; i++) {
    const seedKg = Number(seedTypes[i]?.qty) || 0;
    const name = seedTypes[i]?.name || '';
    const productLabel = `Seed: ${name}`;
    const resolvedSeedKg = findQty(officeLines, productLabel) ?? seedKg;
    if (resolvedSeedKg === 0) continue;
    
    if (isLabelRemoved(productLabel)) continue;
    const displayLabel = `#${i + 1} Seed${name ? `: ${name}` : ''}`;
    renderProductRow({
      productLabel,
      displayLabel,
      kgTotal: seedKg,
      category: 'seed',
      // No bare 'seed' fallback here — word-boundary regex would also
      // match 'Seed: <other-name>' lines and pull the wrong rate. The
      // exact-label findRate above is the primary path; '#N seed' is
      // the only fuzzy fallback for office-renamed labels.
      rateNeedles: [`#${i + 1} seed`],
    });
  }
  const tackifierQty = findQtyFuzzy(officeLines, ['tackifier']) ?? tackifierKg;
  if (hasData(tackifierQty, 0) && !isLabelRemoved('Tackifier')) {
    drawScheduleRow({
      label: 'Tackifier',
      kgsUsed: tackifierQty,
      hours: null,
      rate: findRateFuzzy(officeLines, ['tackifier']),
    });
  }
  const aquagelQty = findQtyFuzzy(officeLines, ['aqua gel', 'aquagel']) ?? aquagelKg;
  if (hasData(aquagelQty, 0) && !isLabelRemoved('Aquagel')) {
    drawScheduleRow({
      label: 'Aquagel',
      kgsUsed: aquagelQty,
      hours: null,
      rate: findRateFuzzy(officeLines, ['aqua gel', 'aquagel']),
    });
  }
  // Micronutrients: liquid additive, summed in litres across all loads.
  // Rendered in the 'Kgs Used' column with an explicit ' L' suffix
  // (paper convention — same trick we use for Travel km / Water Truck
  // loads) so the office can see units at a glance without adding a
  // dedicated column to the schedule.
  const micronutrientsQty = findQtyFuzzy(officeLines, ['micro nutrients', 'micronutrients', 'micronutrient']) ?? micronutrientsL;
  if ((Number(micronutrientsQty) || 0) !== 0 && !isLabelRemoved('Micro Nutrients')) {
    drawScheduleRow({
      label: 'Micro Nutrients',
      kgsUsed: `${formatQty(micronutrientsQty)} L`,
      hours: null,
      // Rate lookup tries the two-word form first, then the legacy
      // one-word spelling so office lines saved before the rename
      // still match.
      rate: findRateFuzzy(officeLines, ['micro nutrients', 'micronutrients', 'micronutrient']),
    });
  }
  const bioticQty = findQtyFuzzy(officeLines, ['biotic', 'soil amendment', 'soil media']) ?? bioticKg;
  if (hasData(bioticQty, 0) && !isLabelRemoved('Biotic Soil Media')) {
    drawScheduleRow({
      label: 'Biotic Soil Media',
      kgsUsed: bioticQty,
      hours: null,
      rate: findRateFuzzy(officeLines, ['biotic', 'soil amendment', 'soil media']),
    });
  }
  // Office-typed Other Product rows (paper has up to 2).
  for (let i = 0; i < otherProducts.length; i++) {
    const op = otherProducts[i];
    if (!op?.label && (Number(op?.qty) || 0) === 0) continue;
    if (op?.label && isLabelRemoved(op.label)) continue;
    const isHours = (op?.unit || '').toLowerCase().startsWith('hr');
    drawScheduleRow({
      label: op.label || `Other Product ${i + 1}`,
      kgsUsed: !isHours ? op.qty : null,
      hours: isHours ? op.qty : null,
      rate: includeOfficeData ? Number(op.rate) || 0 : 0,
    });
  }

  // ── Equipment rows ──────────────────────────────────────────────────
  const crewTruckQtyVal = findQtyFuzzy(officeLines, ['crew truck', 'truck/trailer']) ?? crewTruckHrs;
  if (hasData(0, crewTruckQtyVal) && !isLabelRemoved('Crew Truck')) {
    const countAnnotation = crewTruckMaxN > 0 ? `   ${formatQty(crewTruckMaxN)} # trucks on site` : '';
    drawScheduleRow({
      label: `Crew Truck Truck/Trailer${countAnnotation}`,
      kgsUsed: null,
      hours: crewTruckQtyVal,
      rate: findRateFuzzy(officeLines, ['crew truck', 'truck/trailer']),
    });
  }
  const skidSteerQtyVal = findQtyFuzzy(officeLines, ['skid steer']) ?? skidSteerHrs;
  if (hasData(0, skidSteerQtyVal) && !isLabelRemoved('Skid Steer')) {
    drawScheduleRow({
      label: 'Skid Steer',
      kgsUsed: null,
      hours: skidSteerQtyVal,
      rate: findRateFuzzy(officeLines, ['skid steer']),
    });
  }
  // Hydroseeder rows — one per machine (T400 / T330 / etc.) so the client
  // sees each unit as its own line item, matching the user's preference.
  for (const h of hydroseederRows) {
    const hQty = findQty(officeLines, h.label) ?? h.hours;
    if ((Number(hQty) || 0) === 0) continue;
    if (isLabelRemoved(h.label)) continue;
    drawScheduleRow({
      label: h.label,
      kgsUsed: null,
      hours: hQty,
      rate: findRate(officeLines, h.label) || findRateFuzzy(officeLines, ['hydroseeder']),
    });
  }

  // ── Labour rows ─────────────────────────────────────────────────────
  const supervisorQtyVal = findQtyFuzzy(officeLines, ['supervisor']) ?? supervisorHrs;
  if (hasData(0, supervisorQtyVal) && !isLabelRemoved('Supervisor')) {
    drawScheduleRow({
      label: 'Supervisor',
      kgsUsed: null,
      hours: supervisorQtyVal,
      rate: findRateFuzzy(officeLines, ['supervisor']),
    });
  }
  const leadHandQtyVal = findQtyFuzzy(officeLines, ['lead hand', 'lead']) ?? leadHandHrs;
  if (hasData(0, leadHandQtyVal) && !isLabelRemoved('Lead Hand')) {
    drawScheduleRow({
      label: 'Lead Hand',
      kgsUsed: null,
      hours: leadHandQtyVal,
      rate: findRateFuzzy(officeLines, ['lead hand', 'lead']),
    });
  }
  const labourQtyVal = findQtyFuzzy(officeLines, ['total general labour', 'general labour', 'labour', 'labourer']) ?? labourHrs;
  if (hasData(0, labourQtyVal) && !isLabelRemoved('Total General Labour')) {
    const countAnnotation = labourMaxN > 0 ? `   ${formatQty(labourMaxN)} # of Labourers on site` : '';
    drawScheduleRow({
      label: `Total General Labour${countAnnotation}`,
      kgsUsed: null,
      hours: labourQtyVal,
      rate: findRateFuzzy(officeLines, ['total general labour', 'general labour', 'labour', 'labourer']),
    });
  }

  // ── Travel + Water Truck + Total Area ───────────────────────────────
  const travelQtyVal = findQtyFuzzy(officeLines, ['travel', 'mob/demob', 'mob']) ?? travelKm;
  if ((Number(travelQtyVal) || 0) !== 0 && !isLabelRemoved('Travel (Mob/Demob)')) {
    // Travel uses the kgs column to display the km figure (paper convention)
    // but the rate is per-km so the sub-total math is qty×rate as usual.
    drawScheduleRow({
      label: 'Travel (Mob/Demob)',
      kgsUsed: `${formatQty(travelQtyVal)} kms`,
      hours: null,
      rate: findRateFuzzy(officeLines, ['travel', 'mob/demob', 'mob']),
    });
  }
  const waterQtyVal = findQtyFuzzy(officeLines, ['water truck']) ?? waterLoads;
  if ((Number(waterQtyVal) || 0) !== 0 && !isLabelRemoved('Water Truck')) {
    drawScheduleRow({
      label: 'Water Truck',
      kgsUsed: `${formatQty(waterQtyVal)} Loads`,
      hours: null,
      rate: findRateFuzzy(officeLines, ['water truck']),
    });
  }
  const totalAreaM2QtyVal = findQtyFuzzy(officeLines, ['total area covered (m²)', 'area covered']) ?? totalAreaM2;
  if ((Number(totalAreaM2QtyVal) || 0) !== 0 && !isLabelRemoved('Total Area Covered (m²)')) {
    drawScheduleRow({
      label: 'Total Area Covered (m²)',
      kgsUsed: `${formatQty(totalAreaM2QtyVal)} m²`,
      hours: null,
      rate: 0,
    });
  }

  // ── Catch-all for unrecognized rolled-up rows ───────────────────────
  // Anything in ticket.rows[] whose label didn't match a schedule slot
  // (e.g. legacy "Labourer" / "Supervisor with Truck" / "Lead" equipment
  // rows from dailies created before per-role payroll fields existed,
  // or unusual office-typed labels like "UTV / SXS") is rendered here so
  // nothing is silently lost when an old daily is linked to a new HT.
  // Same `label` rows are summed; rate looked up by exact label match.
  const handledLabels = new Set([
    'mulch', 'mulch (bales)', 'fertilizer', 'tackifier', 'aqua gel',
    'soil amendment', 'seed', 'crew truck', 'supervisor', 'lead hand',
    'total general labour', 'travel (mob/demob)', 'water truck',
    'area covered',
  ]);
  const seenSeedLabels = new Set(seedTypes.map(s => `seed: ${s.name}`.toLowerCase().trim()));
  const seenHydroseederLabels = new Set(hydroseederRows.map(h => h.label.toLowerCase().trim()));

  const otherByLabel = new Map();
  for (const r of rows) {
    const label = r?.label || '';
    if (!label) continue;
    const lc = label.toLowerCase().trim();
    if (handledLabels.has(lc)) continue;
    if (seenSeedLabels.has(lc)) continue;
    if (seenHydroseederLabels.has(lc)) continue;
    if (lc.includes('skid steer')) continue;
    const prior = otherByLabel.get(label) || { qty: 0, unit: r.unit || '' };
    otherByLabel.set(label, {
      qty: prior.qty + (Number(r.qty) || 0),
      unit: r.unit || prior.unit,
    });
  }

  // Also catch any custom lines manually added by the office that aren't in daily records
  for (const line of officeLines) {
    const label = line.label || '';
    if (!label) continue;
    const lc = label.toLowerCase().trim();
    if (handledLabels.has(lc)) continue;
    if (seenSeedLabels.has(lc)) continue;
    if (seenHydroseederLabels.has(lc)) continue;
    if (lc.includes('skid steer')) continue;
    
    if (!otherByLabel.has(label)) {
      otherByLabel.set(label, {
        qty: 0, // `findQty` will grab the correct office line quantity in the next loop
        unit: line.unit || '',
      });
    }
  }
  for (const [label, info] of otherByLabel.entries()) {
    const infoQty = findQty(officeLines, label) ?? info.qty;
    if (!infoQty) continue;
    if (isLabelRemoved(label)) continue;
    const unitLc = (info.unit || '').toLowerCase();
    const isHours = unitLc.startsWith('hr');
    drawScheduleRow({
      label,
      kgsUsed: !isHours ? infoQty : null,
      hours: isHours ? infoQty : null,
      rate: findRate(officeLines, label),
    });
  }

  // ── Sub Total / GST / Total ─────────────────────────────────────────
  const summaryLabel = (label, value) => {
    if (y + tableRowH > pageH - marginB) {
      doc.addPage();
      y = 36;
      drawTableHeader(true);
    }
    let cx = marginL;
    // Span first 4 cells for the label (right-aligned in the 4th cell).
    drawRect(cx, y, tableColW[0], tableRowH); cx += tableColW[0];
    drawRect(cx, y, tableColW[1], tableRowH); cx += tableColW[1];
    drawRect(cx, y, tableColW[2], tableRowH); cx += tableColW[2];
    drawRect(cx, y, tableColW[3], tableRowH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(label, cx + tableColW[3] - 4, y + 11, { align: 'right' });
    cx += tableColW[3];
    drawRect(cx, y, tableColW[4], tableRowH);
    doc.setFont('helvetica', 'normal');
    doc.text(value, cx + tableColW[4] - 4, y + 11, { align: 'right' });
    y += tableRowH;
  };

  const gstVal = gstEnabled ? runningSubTotal * (gstPercent / 100) : 0;
  const totalVal = runningSubTotal + gstVal;
  summaryLabel('Sub Total', includeOfficeData && runningSubTotal > 0 ? `$ ${formatMoney(runningSubTotal)}` : '');
  if (gstEnabled) {
    summaryLabel('GST', includeOfficeData && gstVal > 0 ? `$ ${formatMoney(gstVal)}` : '');
  }
  summaryLabel('Total', includeOfficeData && totalVal > 0 ? `$ ${formatMoney(totalVal)}` : '');

  // ── Footer: GST# + WCB# + Comments + Approved ───────────────────────
  if (y + 90 > pageH - marginB) {
    doc.addPage();
    y = 36;
  }
  y += 10;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('GST# 103512087.   WCB# 909 048', marginL, y);
  y += 14;

  if (comments && comments.trim()) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Comments:', marginL, y);
    y += 11;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    const commentLines = doc.splitTextToSize(comments, boxW);
    for (const line of commentLines) {
      if (y + 11 > pageH - marginB) {
        doc.addPage();
        y = 36;
      }
      doc.text(line, marginL, y);
      y += 11;
    }
    y += 4;
  }

  // Approved signature line.
  if (y + 40 > pageH - marginB) {
    doc.addPage();
    y = 36;
  }
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Approved:', marginL, y + 14);

  // Signature line ends at the boxW right edge (same as info box +
  // materials table) so the 'Approved:' line visually lines up with
  // the right edge of the other framed elements above it.
  const sigLineX1 = marginL + 70;
  const sigLineX2 = marginL + boxW;
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
