import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useDialog } from './DialogProvider';
import PdfPreviewViewer from './PdfPreviewViewer';
import { computeLineSubtotal, computeQuoteTotals, generateQuotePdf } from '../lib/quotePdfGenerator';

/**
 * Quote Builder — admin/office-only full-screen overlay.
 *
 * z-index 90 (matches ReportsDashboard). The PDF view sub-modal sits at
 * z-index 95 so it stacks above the builder but below DialogProvider
 * confirmations (z-index 2000). Critically we DO NOT use the full-screen
 * `PdfPreviewOverlay` here because that one is z-index 50 and would render
 * underneath the builder.
 *
 * Lazy-imported from App.jsx — no chunk is fetched until the user clicks
 * "Open Quotes" from AdminPanel. All network activity (catalog fetch,
 * submit, Recent list) is driven by explicit user actions; nothing here
 * polls.
 */

// ── Constants ─────────────────────────────────────────────────────────────
const TAB_NEW = 'new';
const TAB_RECENT = 'recent';
const TAB_SETTINGS = 'settings';

const LINE_KIND_CATALOG = 'catalog';
const LINE_KIND_CUSTOM = 'custom';
const LINE_KIND_NOTE = 'note';

const DEFAULT_TAX_LABEL = 'GST';
const DEFAULT_TAX_RATE = 5;

// ── Helpers ───────────────────────────────────────────────────────────────
function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function makeUid() {
  // Per-row React key. Date+random is fine here — never persisted server-side.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyLine(kind = LINE_KIND_CATALOG, overrides = {}) {
  return {
    _uid: makeUid(),
    kind,
    category_id: null,
    category_name: null,
    item_id: null,
    description: '',
    unit: '',
    qty: kind === LINE_KIND_NOTE ? null : '',
    rate: kind === LINE_KIND_NOTE ? null : '',
    markup_enabled: false,
    markup_pct: null,
    markup_label: null,
    subtotal: 0,
    ...overrides,
  };
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(n, max = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-CA', { minimumFractionDigits: 0, maximumFractionDigits: max });
}

function formatDate(value) {
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
  return String(value);
}

// ── Styles (inline so we don't pollute index.css for a rarely-open page) ──
const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 90, background: '#0b1220',
    display: 'flex', flexDirection: 'column', color: '#e5eefb',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: '4px', padding: '10px 14px',
    background: '#111c33', borderBottom: '1px solid rgba(143,182,255,0.12)',
    flexWrap: 'wrap',
  },
  headerTitle: { margin: 0, fontSize: '1.05rem', marginRight: '12px' },
  tabBtn: {
    background: 'rgba(30,41,59,1)', color: '#d7e4fa',
    border: '1px solid rgba(143,182,255,0.18)',
    borderRadius: '8px', padding: '6px 14px',
    fontSize: '0.85rem', cursor: 'pointer',
  },
  tabBtnActive: {
    background: 'linear-gradient(135deg,#3b82f6,#2563eb)',
    color: '#fff', borderColor: 'transparent',
  },
  closeBtn: {
    marginLeft: 'auto', background: 'rgba(30,41,59,1)', color: '#d7e4fa',
    border: '1px solid rgba(143,182,255,0.18)', borderRadius: '8px',
    padding: '6px 14px', fontSize: '0.85rem', cursor: 'pointer',
  },
  body: { flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' },
  card: {
    background: 'rgba(14,23,43,0.9)',
    border: '1px solid rgba(143,182,255,0.12)',
    borderRadius: '12px', padding: '14px',
  },
  sectionTitle: { margin: 0, marginBottom: '10px', fontSize: '0.95rem', fontWeight: 700 },
  label: { display: 'block', fontSize: '0.75rem', color: '#9ab1d6', marginBottom: '4px' },
  input: {
    width: '100%', boxSizing: 'border-box',
    borderRadius: '8px', border: '1px solid rgba(143,182,255,0.16)',
    background: 'rgba(9,17,31,0.75)', color: '#e5eefb',
    padding: '8px 10px', fontSize: '0.85rem',
  },
  inputSm: {
    width: '100%', boxSizing: 'border-box',
    borderRadius: '6px', border: '1px solid rgba(143,182,255,0.16)',
    background: 'rgba(9,17,31,0.75)', color: '#e5eefb',
    padding: '5px 7px', fontSize: '0.8rem',
  },
  banner: {
    background: '#78350f', color: '#fcd34d', padding: '10px 14px',
    borderRadius: '8px', fontSize: '0.85rem',
  },
  errorBanner: { background: '#7f1d1d', color: '#fca5a5' },
  successBanner: { background: '#14532d', color: '#86efac' },
  primary: {
    background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff',
    border: 'none', padding: '9px 16px', borderRadius: '10px',
    fontWeight: 600, cursor: 'pointer', fontSize: '0.88rem',
  },
  secondary: {
    background: 'rgba(30,41,59,1)', color: '#d7e4fa',
    border: '1px solid rgba(143,182,255,0.18)',
    padding: '9px 16px', borderRadius: '10px', fontWeight: 500,
    cursor: 'pointer', fontSize: '0.88rem',
  },
  danger: {
    background: 'rgba(127,29,29,0.6)', color: '#fca5a5',
    border: '1px solid rgba(220,38,38,0.6)',
    padding: '9px 16px', borderRadius: '10px', fontWeight: 500,
    cursor: 'pointer', fontSize: '0.88rem',
  },
  iconBtn: {
    background: 'rgba(30,41,59,1)', color: '#d7e4fa',
    border: '1px solid rgba(143,182,255,0.18)',
    borderRadius: '6px', padding: '4px 8px',
    fontSize: '0.75rem', cursor: 'pointer',
  },
  footer: {
    position: 'sticky', bottom: 0, zIndex: 1,
    background: '#111c33', borderTop: '1px solid rgba(143,182,255,0.12)',
    padding: '10px 14px',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', flexWrap: 'wrap',
  },
  // Sub-modal (PDF preview from Recent Quotes + post-submit preview).
  // Local zIndex 95 so it stacks above the QuoteBuilder body (z-index 90)
  // and any toolbar above it. DialogProvider confirmations at z-index 2000
  // still appear on top, which is intentional.
  subModal: {
    position: 'fixed', inset: 0, zIndex: 95,
    background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column',
  },
  subModalHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px', background: '#111c33',
    borderBottom: '1px solid rgba(143,182,255,0.12)',
  },
  // Line item grid columns (catalog / custom rows). Note rows use a single
  // full-width description input instead.
  lineRowGrid: {
    display: 'grid',
    // Trailing 78px column holds the ↑ ↓ ✕ stack (one inline flex of 3
    // small icon buttons, ~22px each + gaps).
    gridTemplateColumns: 'minmax(160px, 2fr) 70px 100px 90px 90px 78px',
    gap: '6px', alignItems: 'center',
  },
  lineRowGridMix: {
    display: 'grid',
    // When mix-categories is on, the row gains a leading Category dropdown.
    gridTemplateColumns: '140px minmax(140px, 2fr) 70px 100px 90px 90px 78px',
    gap: '6px', alignItems: 'center',
  },
  th: {
    fontSize: '0.7rem', color: '#9ab1d6', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  td: { fontSize: '0.85rem' },
};

// ── Sub-component: PDF preview sub-modal ──────────────────────────────────
function PdfSubModal({ title, pdfBase64, pdfBytes, onClose }) {
  // Print via a hidden iframe rather than `window.open(blobUrl, '_blank')`.
  // The window.open path was unreliable in PWAs and Chromium standalone
  // mode: blob: PDF URLs frequently failed to fire `onload`, leaving the
  // new window blank and giving the impression of a "print crash".
  // The iframe approach embeds the PDF inside the current page's origin
  // and reliably fires onload for the embedded PDF viewer.
  const handlePrint = () => {
    let bytes = pdfBytes;
    if (!bytes && pdfBase64) {
      try {
        const raw = atob(pdfBase64);
        bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      } catch {
        bytes = null;
      }
    }
    if (!bytes || bytes.length === 0) return;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';
    // Loaded into a hidden iframe, the browser invokes its built-in PDF
    // plugin which reliably exposes `print()` on contentWindow.
    iframe.src = url;

    const cleanup = () => {
      try { iframe.remove(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
    };

    iframe.onload = () => {
      // Tiny delay lets Chrome/Edge finish wiring up the PDF plugin's
      // print handler before we invoke it. Without this, calling print()
      // immediately inside onload occasionally no-ops on Chromium.
      setTimeout(() => {
        try {
          iframe.contentWindow?.focus();
          iframe.contentWindow?.print();
        } catch {
          // Fallback: open the blob in a new tab so the user can print
          // from the browser's PDF viewer manually.
          window.open(url, '_blank');
        }
      }, 200);
      // Cleanup well after the print dialog has closed. 60s is more than
      // enough for a user to finish or cancel the print.
      setTimeout(cleanup, 60_000);
    };
    iframe.onerror = cleanup;

    document.body.appendChild(iframe);
  };

  return (
    <div style={S.subModal} role="dialog" aria-label={title || 'PDF preview'}>
      <div style={S.subModalHeader}>
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{title || 'Preview'}</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(pdfBytes || pdfBase64) ? (
            <button type="button" onClick={handlePrint} style={S.secondary}>
              Print
            </button>
          ) : null}
          <button type="button" onClick={onClose} style={S.secondary}>Close</button>
        </div>
      </div>
      {(pdfBytes || pdfBase64) ? (
        <PdfPreviewViewer pdfBase64={pdfBase64} pdfBytes={pdfBytes} />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
          Loading PDF…
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────
export default function QuoteBuilder({
  onClose,
  onQuotesChanged,
  // Existing client list + areas derived in App.jsx from sites/pipelines.
  // Used as <datalist> options on the client field for fast picking.
  clients = [],
  areas = [],
}) {
  const { confirm } = useDialog();

  // ── Top-level state ───────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(TAB_NEW);
  const [catalog, setCatalog] = useState([]);          // [{ id, name, notes, items: [...] }]
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');

  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // ── Catalog fetch (single call on mount, refetch after Settings edits) ─
  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const data = await api.getQuoteRates();
      setCatalog(Array.isArray(data) ? data : []);
    } catch (e) {
      setCatalogError(e?.message || 'Failed to load rate catalog');
      setCatalog([]);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    loadCatalog();
  }, [loadCatalog, online]);

  // ── New Quote form state ──────────────────────────────────────────────
  const [client, setClient] = useState('');
  const [area, setArea] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [quoteDate, setQuoteDate] = useState(() => localISODate());
  const [mixCategories, setMixCategories] = useState(false);
  const [primaryCategoryId, setPrimaryCategoryId] = useState('');
  const [taxEnabled, setTaxEnabled] = useState(false);
  const [taxLabel, setTaxLabel] = useState(DEFAULT_TAX_LABEL);
  const [taxRate, setTaxRate] = useState(String(DEFAULT_TAX_RATE));
  const [quoteNotes, setQuoteNotes] = useState('');
  const [lineItems, setLineItems] = useState([]);

  // Submit / preview / confirmation state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  // After a successful submit we keep the assigned number / pdf_url so the
  // confirmation banner can render copy / view / new-quote actions without
  // forcing the user into the Recent Quotes tab.
  const [submittedQuote, setSubmittedQuote] = useState(null);
  // Preview sub-modal — separate from the submit confirmation. Lets the
  // user eyeball the PDF before clicking Submit. We generate fresh bytes
  // each click so edits show up.
  const [previewBase64, setPreviewBase64] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  // Server-peeked quote number for the in-progress quote. Populated by
  // GET /api/quotes/peek-number on the first Preview / Submit click and
  // cached so the same number is shown across multiple previews of the
  // same draft. The sequence is NOT consumed by peeking — if the user
  // closes without submitting, the same number is reused next time.
  // On a successful submit the backend honors this number via setval()
  // unless another operator raced ahead.
  const [peekedQuoteNumber, setPeekedQuoteNumber] = useState('');

  const resetForm = useCallback(() => {
    setClient('');
    setArea('');
    setProjectDescription('');
    setQuoteDate(localISODate());
    setMixCategories(false);
    setPrimaryCategoryId('');
    setTaxEnabled(false);
    setTaxLabel(DEFAULT_TAX_LABEL);
    setTaxRate(String(DEFAULT_TAX_RATE));
    setQuoteNotes('');
    setLineItems([]);
    setSubmittedQuote(null);
    setSubmitError('');
    setPreviewBase64('');
    // Clear the cached peek so the next "Start a new quote" gets a fresh
    // number (which may have advanced if other operators submitted in between).
    setPeekedQuoteNumber('');
  }, []);

  // ── Recent Quotes state ───────────────────────────────────────────────
  const [recent, setRecent] = useState([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentError, setRecentError] = useState('');
  const [recentFilterClient, setRecentFilterClient] = useState('');
  const [recentFilterFrom, setRecentFilterFrom] = useState('');
  const [recentFilterTo, setRecentFilterTo] = useState('');

  // PDF view sub-modal (z-index 95). State = the row + lazily-fetched bytes.
  const [viewing, setViewing] = useState(null); // { quote, pdfBytes, loading, error }

  const loadRecent = useCallback(async () => {
    if (!online) return;
    setRecentLoading(true);
    setRecentError('');
    try {
      const data = await api.listRecentQuotes({
        limit: 100,
        client: recentFilterClient || undefined,
        from: recentFilterFrom || undefined,
        to: recentFilterTo || undefined,
      });
      setRecent(Array.isArray(data) ? data : []);
    } catch (e) {
      setRecentError(e?.message || 'Failed to load recent quotes');
      setRecent([]);
    } finally {
      setRecentLoading(false);
    }
  }, [online, recentFilterClient, recentFilterFrom, recentFilterTo]);

  // Auto-load when the user lands on the Recent tab for the first time.
  // Filter-change reloads happen via the explicit Apply button to avoid
  // hammering the backend while they're typing.
  useEffect(() => {
    if (activeTab !== TAB_RECENT) return;
    loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ── Derived: categories and items in display order ────────────────────
  const activeCategories = useMemo(
    () => (catalog || []).filter((c) => c.is_active !== false),
    [catalog],
  );

  // When the user has picked a primary category in single mode, this is
  // the list shown in every line item's Item dropdown.
  const primaryCategory = useMemo(
    () => activeCategories.find((c) => String(c.id) === String(primaryCategoryId)) || null,
    [activeCategories, primaryCategoryId],
  );

  // Total math (live) — runs on every keystroke since these are pennies.
  const totals = useMemo(
    () => computeQuoteTotals({
      lineItems,
      taxEnabled,
      taxRate: taxEnabled ? Number(taxRate) || 0 : null,
    }),
    [lineItems, taxEnabled, taxRate],
  );

  // ── Line item mutation helpers ────────────────────────────────────────
  const updateLine = useCallback((idx, patch) => {
    setLineItems((prev) => prev.map((line, i) => {
      if (i !== idx) return line;
      const next = { ...line, ...patch };
      next.subtotal = computeLineSubtotal(next);
      return next;
    }));
  }, []);

  const removeLine = useCallback((idx) => {
    setLineItems((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // Reorder a line by `delta` (+1 = down, -1 = up). Out-of-range moves
  // are no-ops so the LineItemRow can disable the ↑/↓ buttons at the
  // edges and we don't have to repeat the bounds check at each call site.
  const moveLine = useCallback((idx, delta) => {
    setLineItems((prev) => {
      const target = idx + delta;
      if (idx < 0 || idx >= prev.length) return prev;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [row] = next.splice(idx, 1);
      next.splice(target, 0, row);
      return next;
    });
  }, []);

  const addLine = useCallback((kind) => {
    setLineItems((prev) => {
      const seedCategory = !mixCategories && primaryCategory
        ? { category_id: primaryCategory.id, category_name: primaryCategory.name }
        : {};
      return [...prev, emptyLine(kind, seedCategory)];
    });
  }, [mixCategories, primaryCategory]);

  // When the user picks a catalog item on a line, hydrate the row from
  // catalog defaults — unit, rate, and (if present) default markup.
  const selectCatalogItem = useCallback((idx, itemId) => {
    if (!itemId) {
      updateLine(idx, {
        item_id: null,
        description: '',
        unit: '',
        rate: '',
        markup_enabled: false,
        markup_pct: null,
        markup_label: null,
      });
      return;
    }
    // Search across the row's effective category (mix mode = the row's
    // own category; single mode = the primary category) — falls back to
    // a full-catalog search so a saved-but-then-recategorized item still
    // hydrates.
    let item = null;
    let cat = null;
    const search = (categories) => {
      for (const c of categories) {
        const found = (c.items || []).find((it) => String(it.id) === String(itemId));
        if (found) { item = found; cat = c; return; }
      }
    };
    search(activeCategories);
    if (!item) return;
    updateLine(idx, {
      item_id: item.id,
      category_id: cat.id,
      category_name: cat.name,
      description: item.name,
      unit: item.unit || '',
      rate: item.rate != null ? String(item.rate) : '',
      markup_pct: item.default_markup_pct != null ? Number(item.default_markup_pct) : null,
      markup_label: item.default_markup_label || null,
      // Markup toggle defaults ON when the catalog says there's a default.
      markup_enabled: item.default_markup_pct != null && Number(item.default_markup_pct) > 0,
    });
  }, [activeCategories, updateLine]);

  // ── Build the submit / PDF payload from current state ─────────────────
  const buildQuoteForPdf = useCallback((quoteNumber) => ({
    quote_number: quoteNumber || 'Q###### (pending)',
    quote_date: quoteDate,
    client,
    area,
    project_description: projectDescription,
    mix_categories: mixCategories,
    tax_enabled: taxEnabled,
    tax_label: taxLabel,
    tax_rate: taxEnabled ? Number(taxRate) || 0 : null,
    notes: quoteNotes,
    line_items: lineItems.map((li) => ({
      ...li,
      subtotal: computeLineSubtotal(li),
    })),
  }), [
    quoteDate, client, area, projectDescription, mixCategories,
    taxEnabled, taxLabel, taxRate, quoteNotes, lineItems,
  ]);

  const buildSubmitPayload = useCallback((pdfBase64, expectedQuoteNumber) => ({
    client: client.trim(),
    area: (area || '').trim() || null,
    project_description: projectDescription || null,
    quote_date: quoteDate,
    mix_categories: mixCategories,
    tax_enabled: taxEnabled,
    tax_label: taxEnabled ? (taxLabel || DEFAULT_TAX_LABEL) : null,
    tax_rate: taxEnabled ? Number(taxRate) || 0 : null,
    notes: quoteNotes || null,
    pdf_base64: pdfBase64 || null,
    expected_quote_number: expectedQuoteNumber || null,
    line_items: lineItems.map((li) => ({
      kind: li.kind,
      category_id: li.category_id || null,
      category_name: li.category_name || null,
      item_id: li.item_id || null,
      description: li.description || '',
      unit: li.unit || '',
      qty: li.kind === LINE_KIND_NOTE ? null : (li.qty === '' ? null : Number(li.qty)),
      rate: li.kind === LINE_KIND_NOTE ? null : (li.rate === '' ? null : Number(li.rate)),
      markup_enabled: !!li.markup_enabled,
      markup_pct: li.markup_pct == null ? null : Number(li.markup_pct),
      markup_label: li.markup_label || null,
      subtotal: computeLineSubtotal(li),
    })),
  }), [
    client, area, projectDescription, quoteDate, mixCategories,
    taxEnabled, taxLabel, taxRate, quoteNotes, lineItems,
  ]);

  // Peek the next quote number from the server, caching the result so
  // multiple Preview clicks on the same draft show the same number.
  // Falls back gracefully (returns '') if the request fails — the PDF
  // will then carry the "Q###### (pending)" placeholder.
  const peekQuoteNumberCached = useCallback(async () => {
    if (peekedQuoteNumber) return peekedQuoteNumber;
    try {
      const result = await api.peekQuoteNumber();
      const qn = result?.quote_number || '';
      if (qn) setPeekedQuoteNumber(qn);
      return qn;
    } catch {
      return '';
    }
  }, [peekedQuoteNumber]);

  // ── Form validation (matches server-side checks) ──────────────────────
  function validateForSubmit() {
    if (!client.trim()) return 'Client is required';
    if (!quoteDate) return 'Quote date is required';
    if (lineItems.length === 0) return 'Quote must include at least one line item';
    // Note-only quotes are pointless — require at least one priced line.
    const priced = lineItems.filter((li) => li.kind !== LINE_KIND_NOTE);
    if (priced.length === 0) return 'Quote needs at least one priced line (notes alone don\u2019t count)';
    for (const li of priced) {
      if (!li.description?.trim()) return 'Every priced line needs a description';
      if (li.qty === '' || li.rate === '') return 'Every priced line needs both qty and rate';
    }
    return '';
  }

  const handlePreview = useCallback(async () => {
    const err = validateForSubmit();
    if (err) { setSubmitError(err); return; }
    setSubmitError('');
    try {
      // Peek the upcoming Q###### so the preview PDF shows the real
      // number. If the user closes without submitting, the same number
      // is reused for the next quote (sequence isn't consumed by peek).
      const qn = await peekQuoteNumberCached();
      const { base64 } = await generateQuotePdf(buildQuoteForPdf(qn));
      setPreviewBase64(base64);
      setPreviewOpen(true);
    } catch (e) {
      setSubmitError(e?.message || 'PDF preview failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildQuoteForPdf, peekQuoteNumberCached, client, lineItems, quoteDate]);

  const handleSubmit = useCallback(async () => {
    const err = validateForSubmit();
    if (err) { setSubmitError(err); return; }
    if (!online) { setSubmitError('You appear to be offline.'); return; }
    setSubmitting(true);
    setSubmitError('');
    try {
      // Render the submit-time PDF with the SAME peeked number we showed
      // the user on Preview, then send `expected_quote_number` so the
      // backend honors that exact value via setval(quote_seq, n) — this
      // keeps the Dropbox PDF, the DB row, and the on-screen confirmation
      // all in sync. If a race forces the backend to fall back to a fresh
      // nextval, it re-uploads the (slightly-stale-numbered) PDF under
      // the new path; that's a 1-in-a-million case for a 1-2 admin team.
      const qn = await peekQuoteNumberCached();
      const { base64 } = await generateQuotePdf(buildQuoteForPdf(qn));
      const created = await api.submitQuote(buildSubmitPayload(base64, qn));
      setSubmittedQuote(created);
      // Refresh the Recent Quotes list silently so it's ready when the
      // user clicks the View tab.
      loadRecent();
      // Notify parent (App.jsx) so any external counters / lists refresh.
      onQuotesChanged?.();
    } catch (e) {
      setSubmitError(e?.message || 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }, [
    online,
    buildQuoteForPdf,
    buildSubmitPayload,
    peekQuoteNumberCached,
    loadRecent,
    onQuotesChanged,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    client, quoteDate, lineItems,
  ]);

  // ── Recent Quotes actions ─────────────────────────────────────────────
  const handleViewPdf = useCallback(async (quote) => {
    if (!quote?.pdf_url) {
      setViewing({ quote, pdfBytes: null, loading: false, error: 'No PDF uploaded for this quote.' });
      return;
    }
    setViewing({ quote, pdfBytes: null, loading: true, error: '' });
    try {
      const bytes = await api.fetchPdfBytes(quote.pdf_url);
      setViewing({ quote, pdfBytes: bytes, loading: false, error: '' });
    } catch (e) {
      setViewing({ quote, pdfBytes: null, loading: false, error: e?.message || 'PDF fetch failed' });
    }
  }, []);

  const handleDuplicate = useCallback(async (quoteId) => {
    try {
      const full = await api.getQuote(quoteId);
      // Hydrate the form from the saved quote. Quote # clears so a fresh
      // one is allocated on submit.
      setClient(full.client || '');
      setArea(full.area || '');
      setProjectDescription(full.project_description || '');
      setQuoteDate(localISODate());  // new date, not the original
      setMixCategories(!!full.mix_categories);
      setTaxEnabled(!!full.tax_enabled);
      setTaxLabel(full.tax_label || DEFAULT_TAX_LABEL);
      setTaxRate(full.tax_rate != null ? String(full.tax_rate) : String(DEFAULT_TAX_RATE));
      setQuoteNotes(full.notes || '');
      // If single mode and we can guess a primary category from the first
      // priced line, seed it so the dropdown filters correctly.
      let inferredPrimary = '';
      if (!full.mix_categories) {
        const firstPriced = (full.line_items_json || []).find((li) => li?.kind !== 'note');
        if (firstPriced?.category_id) inferredPrimary = String(firstPriced.category_id);
      }
      setPrimaryCategoryId(inferredPrimary);
      const lines = (full.line_items_json || []).map((li) => ({
        ...emptyLine(li.kind || LINE_KIND_CATALOG),
        ...li,
        _uid: makeUid(),
      })).map((li) => ({ ...li, subtotal: computeLineSubtotal(li) }));
      setLineItems(lines);
      setSubmittedQuote(null);
      setSubmitError('');
      setActiveTab(TAB_NEW);
    } catch (e) {
      // Surface in the recent tab error banner; the user is still on Recent.
      setRecentError(e?.message || 'Failed to load quote for duplicate');
    }
  }, []);

  const handleSoftDelete = useCallback(async (quote) => {
    if (!(await confirm({
      title: 'Delete quote',
      message: `Move quote ${quote.quote_number} (${quote.client}) to Recent Deletes? You can restore it from the Admin tab.`,
      severity: 'danger',
      okLabel: 'Delete',
    }))) return;
    try {
      await api.deleteQuote(quote.id);
      setRecent((prev) => prev.filter((q) => q.id !== quote.id));
      onQuotesChanged?.();
    } catch (e) {
      setRecentError(e?.message || 'Delete failed');
    }
  }, [confirm, onQuotesChanged]);

  // ── Settings (catalog) state — managed in the dedicated tab below.
  // We don't need its own state at this scope; the Settings tab uses the
  // shared `catalog` array via inline editors that call updateQuoteItem
  // etc. directly. Reload after each change so all dropdowns refresh.

  return (
    <div style={S.overlay} role="dialog" aria-label="Quote Builder">
      {/* Header: title + tabs + close */}
      <div style={S.header}>
        <h2 style={S.headerTitle}>📝 Quotes</h2>
        <button
          type="button"
          style={activeTab === TAB_NEW ? { ...S.tabBtn, ...S.tabBtnActive } : S.tabBtn}
          onClick={() => setActiveTab(TAB_NEW)}
        >
          New Quote
        </button>
        <button
          type="button"
          style={activeTab === TAB_RECENT ? { ...S.tabBtn, ...S.tabBtnActive } : S.tabBtn}
          onClick={() => setActiveTab(TAB_RECENT)}
        >
          Recent Quotes
        </button>
        <button
          type="button"
          style={activeTab === TAB_SETTINGS ? { ...S.tabBtn, ...S.tabBtnActive } : S.tabBtn}
          onClick={() => setActiveTab(TAB_SETTINGS)}
        >
          Settings
        </button>
        <button type="button" onClick={onClose} style={S.closeBtn} aria-label="Close quote builder">
          ✕ Close
        </button>
      </div>

      {/* Body — render the active tab. Footer (when relevant) is rendered
          inside each tab so it can be scoped to the appropriate actions. */}
      {activeTab === TAB_NEW ? (
        <NewQuoteTab
          // form state + setters
          client={client} setClient={setClient}
          area={area} setArea={setArea}
          projectDescription={projectDescription} setProjectDescription={setProjectDescription}
          quoteDate={quoteDate} setQuoteDate={setQuoteDate}
          mixCategories={mixCategories} setMixCategories={setMixCategories}
          primaryCategoryId={primaryCategoryId} setPrimaryCategoryId={setPrimaryCategoryId}
          taxEnabled={taxEnabled} setTaxEnabled={setTaxEnabled}
          taxLabel={taxLabel} setTaxLabel={setTaxLabel}
          taxRate={taxRate} setTaxRate={setTaxRate}
          quoteNotes={quoteNotes} setQuoteNotes={setQuoteNotes}
          lineItems={lineItems}
          // line item handlers
          addLine={addLine} updateLine={updateLine} removeLine={removeLine} moveLine={moveLine}
          selectCatalogItem={selectCatalogItem}
          // catalog
          catalog={catalog}
          activeCategories={activeCategories}
          primaryCategory={primaryCategory}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          onReloadCatalog={loadCatalog}
          // misc
          clients={clients} areas={areas}
          totals={totals}
          submitting={submitting}
          submitError={submitError}
          submittedQuote={submittedQuote}
          peekedQuoteNumber={peekedQuoteNumber}
          previewOpen={previewOpen}
          previewBase64={previewBase64}
          setPreviewOpen={setPreviewOpen}
          onPreview={handlePreview}
          onSubmit={handleSubmit}
          onReset={resetForm}
          online={online}
        />
      ) : null}

      {activeTab === TAB_RECENT ? (
        <RecentQuotesTab
          recent={recent}
          recentLoading={recentLoading}
          recentError={recentError}
          onApplyFilters={loadRecent}
          filterClient={recentFilterClient} setFilterClient={setRecentFilterClient}
          filterFrom={recentFilterFrom} setFilterFrom={setRecentFilterFrom}
          filterTo={recentFilterTo} setFilterTo={setRecentFilterTo}
          clients={clients}
          onViewPdf={handleViewPdf}
          onDuplicate={handleDuplicate}
          onSoftDelete={handleSoftDelete}
          online={online}
        />
      ) : null}

      {activeTab === TAB_SETTINGS ? (
        <SettingsTab
          catalog={catalog}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          onReloadCatalog={loadCatalog}
          online={online}
        />
      ) : null}

      {/* PDF sub-modals (z-index 95) — preview before submit, view after */}
      {previewOpen ? (
        <PdfSubModal
          title={`Preview — ${submittedQuote?.quote_number || peekedQuoteNumber || 'Q###### (pending)'}`}
          pdfBase64={previewBase64}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
      {viewing ? (
        <PdfSubModal
          title={`Quote ${viewing.quote?.quote_number || ''}`}
          pdfBytes={viewing.pdfBytes}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}

// ── Sub-component: New Quote tab ──────────────────────────────────────────
function NewQuoteTab(props) {
  const {
    client, setClient, area, setArea, projectDescription, setProjectDescription,
    quoteDate, setQuoteDate, mixCategories, setMixCategories,
    primaryCategoryId, setPrimaryCategoryId,
    taxEnabled, setTaxEnabled, taxLabel, setTaxLabel, taxRate, setTaxRate,
    quoteNotes, setQuoteNotes, lineItems,
    addLine, updateLine, removeLine, moveLine, selectCatalogItem,
    catalog, activeCategories, primaryCategory, catalogLoading, catalogError, onReloadCatalog,
    clients, areas, totals,
    submitting, submitError, submittedQuote, peekedQuoteNumber,
    previewOpen, previewBase64, setPreviewOpen,
    onPreview, onSubmit, onReset, online,
  } = props;

  return (
    <>
      <div style={S.body}>
        {!online ? (
          <div style={S.banner}>⚠ You're offline — submitting a quote needs an internet connection.</div>
        ) : null}
        {catalogError ? (
          <div style={{ ...S.banner, ...S.errorBanner, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <span>Couldn't load rate catalog: {catalogError}</span>
            <button type="button" onClick={onReloadCatalog} style={S.secondary}>Retry</button>
          </div>
        ) : null}

        {/* Submit confirmation — replaces the form actions after a successful POST. */}
        {submittedQuote ? (
          <div style={{ ...S.banner, ...S.successBanner }}>
            <div style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '6px' }}>
              ✓ Quote {submittedQuote.quote_number} submitted
            </div>
            <div style={{ fontSize: '0.85rem', marginBottom: '10px' }}>
              {submittedQuote.pdf_url
                ? <>PDF uploaded to Dropbox. <a href={submittedQuote.pdf_url} target="_blank" rel="noreferrer" style={{ color: '#86efac', textDecoration: 'underline' }}>Open in Dropbox</a></>
                : 'PDF upload to Dropbox didn\u2019t complete — the quote is saved in the database. Use Recent Quotes → View PDF once Dropbox sync recovers.'}
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button type="button" style={S.primary} onClick={onReset}>Start a new quote</button>
              {submittedQuote.pdf_url ? (
                <button
                  type="button"
                  style={S.secondary}
                  onClick={() => {
                    navigator.clipboard?.writeText(submittedQuote.pdf_url).catch(() => { /* ignore clipboard rejection */ });
                  }}
                >
                  Copy share link
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Quote header — client, area, date, project description, Quote # placeholder */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Quote Details</h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '10px',
          }}>
            <div>
              <label style={S.label}>Client <span style={{ color: '#fca5a5' }}>*</span></label>
              <input
                list="quote-builder-clients"
                style={S.input}
                value={client}
                onChange={(e) => setClient(e.target.value)}
                placeholder="Client name"
              />
              <datalist id="quote-builder-clients">
                {clients.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label style={S.label}>Area</label>
              <input
                list="quote-builder-areas"
                style={S.input}
                value={area}
                onChange={(e) => setArea(e.target.value)}
                placeholder="Area (optional)"
              />
              <datalist id="quote-builder-areas">
                {areas.map((a) => <option key={a} value={a} />)}
              </datalist>
            </div>
            <div>
              <label style={S.label}>Quote Date</label>
              <input type="date" style={S.input} value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Quote #</label>
              <input
                style={{ ...S.input, color: '#9ab1d6', cursor: 'not-allowed' }}
                value={
                  submittedQuote?.quote_number
                  || (peekedQuoteNumber ? `${peekedQuoteNumber} — pending submit` : 'Q###### — auto-assigned on submit')
                }
                readOnly
              />
            </div>
          </div>
          <div style={{ marginTop: '10px' }}>
            <label style={S.label}>Project description (optional)</label>
            <textarea
              style={{ ...S.input, minHeight: '60px', resize: 'vertical' }}
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              placeholder="Short summary that lands on the PDF below the bill-to block"
            />
          </div>
        </section>

        {/* Mode toggle + primary category (when not mixed) */}
        <section style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <h3 style={{ ...S.sectionTitle, marginBottom: 0 }}>Categories</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={mixCategories}
                onChange={(e) => setMixCategories(e.target.checked)}
                style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.85rem' }}>Mix categories on this quote</span>
            </label>
          </div>
          {!mixCategories ? (
            <div style={{ marginTop: '10px', maxWidth: '420px' }}>
              <label style={S.label}>Primary category</label>
              <select
                style={S.input}
                value={primaryCategoryId}
                onChange={(e) => setPrimaryCategoryId(e.target.value)}
                disabled={catalogLoading || activeCategories.length === 0}
              >
                <option value="">{catalogLoading ? 'Loading…' : 'Select a category…'}</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {primaryCategory?.notes ? (
                <div style={{ fontSize: '0.75rem', color: '#9ab1d6', marginTop: '6px' }}>
                  {primaryCategory.notes}
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: '0.78rem', color: '#9ab1d6', marginTop: '8px' }}>
              Each line picks its own category. Catalog notes from every used
              category land on the PDF footer.
            </div>
          )}
        </section>

        {/* Line items */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Line Items</h3>
          {!mixCategories && !primaryCategoryId ? (
            <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '10px 0' }}>
              Pick a primary category above to start adding line items, or check <strong>Mix categories</strong>.
            </div>
          ) : (
            <>
              {/* Column headers */}
              <div style={{
                ...(mixCategories ? S.lineRowGridMix : S.lineRowGrid),
                paddingBottom: '6px', borderBottom: '1px solid rgba(143,182,255,0.12)', marginBottom: '6px',
              }}>
                {mixCategories ? <div style={S.th}>Category</div> : null}
                <div style={S.th}>Item / Description</div>
                <div style={{ ...S.th, textAlign: 'right' }}>Qty</div>
                <div style={S.th}>Unit</div>
                <div style={{ ...S.th, textAlign: 'right' }}>Rate</div>
                <div style={{ ...S.th, textAlign: 'right' }}>Subtotal</div>
                <div />
              </div>
              {lineItems.length === 0 ? (
                <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '10px 0' }}>
                  No line items yet. Use the buttons below to add catalog rows,
                  custom one-off rows, or notes.
                </div>
              ) : (
                lineItems.map((line, idx) => (
                  <LineItemRow
                    key={line._uid}
                    idx={idx}
                    line={line}
                    mixCategories={mixCategories}
                    primaryCategory={primaryCategory}
                    activeCategories={activeCategories}
                    onUpdate={(patch) => updateLine(idx, patch)}
                    onRemove={() => removeLine(idx)}
                    onMoveUp={idx > 0 ? () => moveLine(idx, -1) : null}
                    onMoveDown={idx < lineItems.length - 1 ? () => moveLine(idx, 1) : null}
                    onSelectCatalogItem={(itemId) => selectCatalogItem(idx, itemId)}
                    onSaveCustomToCatalog={async ({ categoryId, defaultMarkupPct, defaultMarkupLabel }) => {
                      try {
                        const created = await api.createQuoteItem({
                          category_id: Number(categoryId),
                          name: line.description?.trim() || 'Custom',
                          unit: line.unit || '',
                          rate: Number(line.rate) || 0,
                          default_markup_pct: defaultMarkupPct,
                          default_markup_label: defaultMarkupLabel || null,
                          sort_order: 9999,
                        });
                        await onReloadCatalog();
                        updateLine(idx, {
                          kind: LINE_KIND_CATALOG,
                          item_id: created.id,
                          category_id: created.category_id,
                          category_name: activeCategories.find((c) => c.id === created.category_id)?.name || null,
                        });
                      } catch (err) {
                        // eslint-disable-next-line no-alert
                        alert(`Save to catalog failed: ${err?.message || 'unknown error'}`);
                      }
                    }}
                  />
                ))
              )}
              {/* Add-row buttons */}
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => addLine(LINE_KIND_CATALOG)}
                  style={S.secondary}
                  disabled={!mixCategories && !primaryCategoryId}
                >
                  + Add catalog line
                </button>
                <button type="button" onClick={() => addLine(LINE_KIND_CUSTOM)} style={S.secondary}>
                  + Add custom line
                </button>
                <button type="button" onClick={() => addLine(LINE_KIND_NOTE)} style={S.secondary}>
                  + Add note
                </button>
              </div>
            </>
          )}
        </section>

        {/* Tax */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Tax</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={taxEnabled}
              onChange={(e) => setTaxEnabled(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.85rem' }}>Include tax line on this quote</span>
          </label>
          {taxEnabled ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '10px',
              marginTop: '12px',
              maxWidth: '500px',
            }}>
              <div>
                <label style={S.label}>Label</label>
                <input style={S.input} value={taxLabel} onChange={(e) => setTaxLabel(e.target.value)} placeholder="GST" />
              </div>
              <div>
                <label style={S.label}>Rate (%)</label>
                <input
                  style={S.input}
                  type="number"
                  step="0.001"
                  min="0"
                  value={taxRate}
                  onChange={(e) => setTaxRate(e.target.value)}
                />
              </div>
            </div>
          ) : null}
        </section>

        {/* Notes appended to PDF */}
        <section style={S.card}>
          <h3 style={S.sectionTitle}>Notes (appears on PDF)</h3>
          <textarea
            style={{ ...S.input, minHeight: '70px', resize: 'vertical' }}
            value={quoteNotes}
            onChange={(e) => setQuoteNotes(e.target.value)}
            placeholder="Anything you want to clarify on the quote — terms, exclusions, scope notes, etc."
          />
        </section>

        {/* Error banner */}
        {submitError ? <div style={{ ...S.banner, ...S.errorBanner }}>{submitError}</div> : null}
      </div>

      {/* Sticky footer — totals + actions */}
      <div style={S.footer}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '0.85rem' }}>
          <div>Subtotal: <strong>{formatMoney(totals.subtotal)}</strong></div>
          {taxEnabled ? (
            <div>
              {taxLabel || 'Tax'} ({formatNumber(taxRate, 3)}%): <strong>{formatMoney(totals.taxAmount)}</strong>
            </div>
          ) : null}
          <div style={{ fontSize: '1rem' }}>Grand Total: <strong>{formatMoney(totals.grandTotal)}</strong></div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button type="button" onClick={onReset} style={S.secondary}>Reset</button>
          <button type="button" onClick={onPreview} style={S.secondary} disabled={submitting}>
            Preview PDF
          </button>
          <button
            type="button"
            onClick={onSubmit}
            style={{
              ...S.primary,
              opacity: (submitting || !online || !!submittedQuote) ? 0.6 : 1,
              cursor: (submitting || !online || !!submittedQuote) ? 'not-allowed' : 'pointer',
            }}
            disabled={submitting || !online || !!submittedQuote}
          >
            {submitting ? 'Submitting…' : submittedQuote ? 'Submitted ✓' : 'Submit & Upload'}
          </button>
        </div>
      </div>
    </>
  );
}

// ── Sub-component: single line-item row ───────────────────────────────────
function LineItemRow({ idx, line, mixCategories, primaryCategory, activeCategories, onUpdate, onRemove, onMoveUp, onMoveDown, onSelectCatalogItem, onSaveCustomToCatalog }) {
  // Effective category for this row in single mode = primary, in mixed = row's own.
  const rowCategory = useMemo(() => {
    if (mixCategories) {
      return activeCategories.find((c) => String(c.id) === String(line.category_id)) || null;
    }
    return primaryCategory;
  }, [mixCategories, line.category_id, primaryCategory, activeCategories]);

  const availableItems = useMemo(
    () => (rowCategory?.items || []).filter((i) => i.is_active !== false),
    [rowCategory],
  );

  const [savePopoverOpen, setSavePopoverOpen] = useState(false);
  const [saveCategoryId, setSaveCategoryId] = useState('');
  const [saveDefaultMarkup, setSaveDefaultMarkup] = useState(false);

  // Reset popover when row stops being custom.
  useEffect(() => {
    if (line.kind !== LINE_KIND_CUSTOM) setSavePopoverOpen(false);
  }, [line.kind]);

  // ── Note row (collapse all price columns) ──
  if (line.kind === LINE_KIND_NOTE) {
    return (
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 0' }}>
        <span style={{ fontSize: '0.7rem', color: '#9ab1d6', minWidth: '50px' }}>Note</span>
        <textarea
          style={{ ...S.inputSm, minHeight: '34px', resize: 'vertical', flex: 1, fontStyle: 'italic' }}
          value={line.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Note — renders italic on the PDF (e.g. section header, scope caveat)"
        />
        {/* ↑ ↓ ✕ for note rows. Disabled buttons render at low opacity so
            the layout doesn't shift between rows at the start/end of the
            list. */}
        <button
          type="button"
          onClick={onMoveUp || undefined}
          disabled={!onMoveUp}
          style={{ ...S.iconBtn, opacity: onMoveUp ? 1 : 0.3, cursor: onMoveUp ? 'pointer' : 'not-allowed' }}
          aria-label="Move note up"
          title="Move up"
        >↑</button>
        <button
          type="button"
          onClick={onMoveDown || undefined}
          disabled={!onMoveDown}
          style={{ ...S.iconBtn, opacity: onMoveDown ? 1 : 0.3, cursor: onMoveDown ? 'pointer' : 'not-allowed' }}
          aria-label="Move note down"
          title="Move down"
        >↓</button>
        <button type="button" onClick={onRemove} style={{ ...S.iconBtn, color: '#fca5a5' }} aria-label="Remove note">✕</button>
      </div>
    );
  }

  // ── Catalog / custom row ──
  const isCustom = line.kind === LINE_KIND_CUSTOM;

  return (
    <div style={{ ...(mixCategories ? S.lineRowGridMix : S.lineRowGrid), padding: '6px 0' }}>
      {/* Per-line category (mixed mode only) */}
      {mixCategories ? (
        <select
          style={S.inputSm}
          value={line.category_id || ''}
          onChange={(e) => {
            const newCatId = e.target.value ? Number(e.target.value) : null;
            const newCat = activeCategories.find((c) => c.id === newCatId) || null;
            onUpdate({
              category_id: newCatId,
              category_name: newCat?.name || null,
              item_id: null,
            });
          }}
        >
          <option value="">— Category —</option>
          {activeCategories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      ) : null}

      {/* Item dropdown (catalog) OR description input (custom) */}
      {isCustom ? (
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <input
            style={{ ...S.inputSm, flex: 1 }}
            value={line.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
            placeholder="Custom description"
          />
          <button
            type="button"
            title="Save this custom line as a catalog item"
            onClick={() => setSavePopoverOpen((v) => !v)}
            style={{ ...S.iconBtn, padding: '4px 6px' }}
          >
            💾
          </button>
        </div>
      ) : (
        <select
          style={S.inputSm}
          value={line.item_id || ''}
          onChange={(e) => onSelectCatalogItem(e.target.value ? Number(e.target.value) : null)}
          disabled={!rowCategory}
        >
          <option value="">{rowCategory ? '— Pick an item —' : '— Pick a category first —'}</option>
          {availableItems.map((it) => (
            <option key={it.id} value={it.id}>
              {it.name}{it.unit ? ` · ${it.unit}` : ''} {Number(it.rate) > 0 ? `· $${Number(it.rate).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
            </option>
          ))}
        </select>
      )}

      {/* Qty */}
      <input
        type="number"
        step="any"
        style={{ ...S.inputSm, textAlign: 'right' }}
        value={line.qty ?? ''}
        onChange={(e) => onUpdate({ qty: e.target.value })}
        placeholder="0"
      />
      {/* Unit (editable per-quote) */}
      <input
        style={S.inputSm}
        value={line.unit || ''}
        onChange={(e) => onUpdate({ unit: e.target.value })}
        placeholder="unit"
      />
      {/* Rate */}
      <input
        type="number"
        step="any"
        style={{ ...S.inputSm, textAlign: 'right' }}
        value={line.rate ?? ''}
        onChange={(e) => onUpdate({ rate: e.target.value })}
        placeholder="0.00"
      />
      {/* Subtotal (read-only, live-computed) */}
      <div style={{ ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
        {formatMoney(line.subtotal)}
      </div>
      {/* ↑ ↓ ✕ — packed into the trailing action column. Disabled state
          uses low opacity rather than display:none so the row layout
          stays consistent across the list. */}
      <div style={{ display: 'flex', gap: '2px', justifyContent: 'flex-end', alignItems: 'center' }}>
        <button
          type="button"
          onClick={onMoveUp || undefined}
          disabled={!onMoveUp}
          style={{ ...S.iconBtn, padding: '4px 6px', opacity: onMoveUp ? 1 : 0.3, cursor: onMoveUp ? 'pointer' : 'not-allowed' }}
          aria-label="Move line up"
          title="Move up"
        >↑</button>
        <button
          type="button"
          onClick={onMoveDown || undefined}
          disabled={!onMoveDown}
          style={{ ...S.iconBtn, padding: '4px 6px', opacity: onMoveDown ? 1 : 0.3, cursor: onMoveDown ? 'pointer' : 'not-allowed' }}
          aria-label="Move line down"
          title="Move down"
        >↓</button>
        <button
          type="button"
          onClick={onRemove}
          style={{ ...S.iconBtn, padding: '4px 6px', color: '#fca5a5' }}
          aria-label="Remove line"
          title="Remove"
        >✕</button>
      </div>

      {/* Markup checkbox row (only when the line has a markup config or is custom) */}
      {(line.markup_pct != null && Number(line.markup_pct) !== 0) || line.markup_enabled || isCustom ? (
        <div style={{ gridColumn: mixCategories ? '2 / -1' : '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '4px', paddingTop: '2px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!line.markup_enabled}
              onChange={(e) => onUpdate({
                markup_enabled: e.target.checked,
                markup_pct: e.target.checked && line.markup_pct == null ? 10 : line.markup_pct,
              })}
              style={{ width: '14px', height: '14px', cursor: 'pointer' }}
            />
            <span>Add markup</span>
          </label>
          {line.markup_enabled ? (
            <>
              <input
                type="number"
                step="0.01"
                min="0"
                style={{ ...S.inputSm, width: '70px' }}
                value={line.markup_pct ?? ''}
                onChange={(e) => onUpdate({ markup_pct: e.target.value === '' ? null : Number(e.target.value) })}
              />
              <span style={{ fontSize: '0.78rem', color: '#9ab1d6' }}>%</span>
              <input
                style={{ ...S.inputSm, width: '120px' }}
                value={line.markup_label || ''}
                onChange={(e) => onUpdate({ markup_label: e.target.value })}
                placeholder="label (e.g. cost)"
              />
            </>
          ) : null}
        </div>
      ) : null}

      {/* Save-to-catalog popover (custom rows only) */}
      {isCustom && savePopoverOpen ? (
        <div style={{ gridColumn: '1 / -1', background: 'rgba(9,17,31,0.75)', border: '1px solid rgba(143,182,255,0.18)', borderRadius: '8px', padding: '10px', marginTop: '6px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
            <div>
              <label style={S.label}>Save to category</label>
              <select style={S.input} value={saveCategoryId} onChange={(e) => setSaveCategoryId(e.target.value)}>
                <option value="">Pick a category…</option>
                {activeCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.label}>Also save default markup</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', cursor: 'pointer', marginTop: '4px' }}>
                <input
                  type="checkbox"
                  checked={saveDefaultMarkup}
                  onChange={(e) => setSaveDefaultMarkup(e.target.checked)}
                  style={{ width: '14px', height: '14px', cursor: 'pointer' }}
                />
                <span>
                  Save current markup ({line.markup_enabled && Number(line.markup_pct) > 0
                    ? `${formatNumber(line.markup_pct, 2)}%${line.markup_label ? ` — ${line.markup_label}` : ''}`
                    : 'none'})
                </span>
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
            <button
              type="button"
              style={S.primary}
              disabled={!saveCategoryId || !line.description?.trim()}
              onClick={async () => {
                await onSaveCustomToCatalog({
                  categoryId: saveCategoryId,
                  defaultMarkupPct: saveDefaultMarkup && Number(line.markup_pct) > 0 ? Number(line.markup_pct) : null,
                  defaultMarkupLabel: saveDefaultMarkup ? line.markup_label : null,
                });
                setSavePopoverOpen(false);
              }}
            >
              Save to catalog
            </button>
            <button type="button" style={S.secondary} onClick={() => setSavePopoverOpen(false)}>
              Cancel
            </button>
          </div>
          {!line.description?.trim() ? (
            <div style={{ fontSize: '0.75rem', color: '#fbbf24', marginTop: '6px' }}>
              Add a description above before saving to catalog.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Sub-component: Recent Quotes tab ─────────────────────────────────────
function RecentQuotesTab({
  recent, recentLoading, recentError, onApplyFilters,
  filterClient, setFilterClient, filterFrom, setFilterFrom, filterTo, setFilterTo,
  clients,
  onViewPdf, onDuplicate, onSoftDelete, online,
}) {
  return (
    <div style={S.body}>
      {!online ? (
        <div style={S.banner}>⚠ You're offline — recent quotes need an internet connection.</div>
      ) : null}
      <section style={S.card}>
        <h3 style={S.sectionTitle}>Filters</h3>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '10px',
          alignItems: 'end',
        }}>
          <div>
            <label style={S.label}>Client</label>
            <input
              list="recent-quote-clients"
              style={S.input}
              value={filterClient}
              onChange={(e) => setFilterClient(e.target.value)}
              placeholder="Any client"
            />
            <datalist id="recent-quote-clients">
              {clients.map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
          <div>
            <label style={S.label}>From date</label>
            <input type="date" style={S.input} value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </div>
          <div>
            <label style={S.label}>To date</label>
            <input type="date" style={S.input} value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </div>
          <div>
            <button type="button" style={S.primary} onClick={onApplyFilters} disabled={!online || recentLoading}>
              {recentLoading ? 'Loading…' : 'Apply filters'}
            </button>
          </div>
        </div>
      </section>

      {recentError ? <div style={{ ...S.banner, ...S.errorBanner }}>{recentError}</div> : null}

      <section style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap', gap: '8px' }}>
          <h3 style={{ ...S.sectionTitle, marginBottom: 0 }}>
            Recent Quotes {recent.length > 0 ? <span style={{ color: '#9ab1d6', fontWeight: 400 }}>({recent.length})</span> : null}
          </h3>
          <button type="button" style={S.secondary} onClick={onApplyFilters} disabled={!online || recentLoading}>
            Refresh
          </button>
        </div>
        {recentLoading ? (
          <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '14px 0' }}>Loading…</div>
        ) : recent.length === 0 ? (
          <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '14px 0' }}>
            No quotes match. Submit a quote from the New Quote tab and it'll appear here.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left' }}>Quote #</th>
                  <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left' }}>Client</th>
                  <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left' }}>Area</th>
                  <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left' }}>Date</th>
                  <th style={{ ...S.th, padding: '6px 8px', textAlign: 'right' }}>Grand Total</th>
                  <th style={{ ...S.th, padding: '6px 8px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((q) => (
                  <tr key={q.id} style={{ borderTop: '1px solid rgba(143,182,255,0.08)' }}>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{q.quote_number}</td>
                    <td style={{ padding: '8px' }}>{q.client}</td>
                    <td style={{ padding: '8px', color: '#9ab1d6' }}>{q.area || '—'}</td>
                    <td style={{ padding: '8px', color: '#9ab1d6' }}>{formatDate(q.quote_date)}</td>
                    <td style={{ padding: '8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {formatMoney(q.grand_total)}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <button type="button" style={S.iconBtn} onClick={() => onViewPdf(q)} disabled={!q.pdf_url}>
                          View PDF
                        </button>
                        <button type="button" style={S.iconBtn} onClick={() => onDuplicate(q.id)}>
                          Duplicate
                        </button>
                        <button
                          type="button"
                          style={{ ...S.iconBtn, color: '#fca5a5', borderColor: 'rgba(220,38,38,0.4)' }}
                          onClick={() => onSoftDelete(q)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sub-component: Settings tab ──────────────────────────────────────────
function SettingsTab({ catalog, catalogLoading, catalogError, onReloadCatalog, online }) {
  // Local "draft" state for each item/category so the user can type
  // freely. Save happens on blur (or explicit Save button).
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { confirm } = useDialog();

  // New-category form
  const [newCatName, setNewCatName] = useState('');
  const [newCatNotes, setNewCatNotes] = useState('');

  // Per-category "add item" state — keyed by category id so multiple
  // categories' add-rows don't share buffers.
  const [adding, setAdding] = useState({}); // { [categoryId]: { name, unit, rate, markup_pct, markup_label } }

  const setAddingFor = (catId, patch) => setAdding((prev) => ({
    ...prev,
    [catId]: { ...(prev[catId] || {}), ...patch },
  }));

  const handleCreateCategory = async () => {
    if (!newCatName.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createQuoteCategory({ name: newCatName.trim(), notes: newCatNotes || null, sort_order: 9999 });
      setNewCatName(''); setNewCatNotes('');
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || 'Create category failed');
    } finally {
      setBusy(false);
    }
  };

  const handlePatchCategory = async (id, patch) => {
    setBusy(true); setError('');
    try {
      await api.updateQuoteCategory(id, patch);
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteCategory = async (cat) => {
    if (!(await confirm({
      title: 'Hide category',
      message: `Hide "${cat.name}" from the Quote Builder? Items stay intact — restore by re-creating a category with the same name.`,
      severity: 'danger',
      okLabel: 'Hide',
    }))) return;
    setBusy(true); setError('');
    try {
      await api.deleteQuoteCategory(cat.id);
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const handleAddItem = async (catId) => {
    const draft = adding[catId];
    if (!draft?.name?.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createQuoteItem({
        category_id: catId,
        name: draft.name.trim(),
        unit: draft.unit || '',
        rate: Number(draft.rate) || 0,
        default_markup_pct: draft.markup_pct === '' || draft.markup_pct == null ? null : Number(draft.markup_pct),
        default_markup_label: draft.markup_label || null,
        sort_order: 9999,
      });
      setAdding((prev) => ({ ...prev, [catId]: {} }));
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || 'Create item failed');
    } finally {
      setBusy(false);
    }
  };

  const handlePatchItem = async (id, patch) => {
    setBusy(true); setError('');
    try {
      await api.updateQuoteItem(id, patch);
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteItem = async (item) => {
    if (!(await confirm({
      title: 'Hide item',
      message: `Hide "${item.name}" from this category? Historical quotes still show it.`,
      severity: 'danger',
      okLabel: 'Hide',
    }))) return;
    setBusy(true); setError('');
    try {
      await api.deleteQuoteItem(item.id);
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  // ── Reorder helpers ──
  // Swap two items' (or two categories') sort_order values via PATCH and
  // reload. We swap rather than renumber the whole list so a tap is one
  // round-trip per affected row instead of N. The catalog endpoint orders
  // by sort_order ASC then name, so swapping the two values is enough to
  // visibly reorder the pair on the next reload.
  const swapSortOrder = async (kindLabel, a, b, patchFn) => {
    setBusy(true); setError('');
    try {
      const aSort = Number(a.sort_order) || 0;
      const bSort = Number(b.sort_order) || 0;
      // If both share the same sort_order (legacy seed data), bump the
      // moved-up one one slot below the moved-down one to force order.
      const aNew = aSort === bSort ? bSort - 1 : bSort;
      const bNew = aSort === bSort ? bSort : aSort;
      await patchFn(a.id, { sort_order: aNew });
      await patchFn(b.id, { sort_order: bNew });
      await onReloadCatalog();
    } catch (e) {
      setError(e?.message || `Reorder ${kindLabel} failed`);
    } finally {
      setBusy(false);
    }
  };

  const handleMoveCategory = async (idx, delta) => {
    const target = idx + delta;
    if (target < 0 || target >= catalog.length) return;
    await swapSortOrder('category', catalog[idx], catalog[target], (id, patch) => api.updateQuoteCategory(id, patch));
  };

  const handleMoveItem = async (cat, itemIdx, delta) => {
    const items = cat.items || [];
    const target = itemIdx + delta;
    if (target < 0 || target >= items.length) return;
    await swapSortOrder('item', items[itemIdx], items[target], (id, patch) => api.updateQuoteItem(id, patch));
  };

  return (
    <div style={S.body}>
      {!online ? (
        <div style={S.banner}>⚠ You're offline — catalog edits need an internet connection.</div>
      ) : null}
      {catalogError ? (
        <div style={{ ...S.banner, ...S.errorBanner }}>{catalogError}</div>
      ) : null}
      {error ? <div style={{ ...S.banner, ...S.errorBanner }}>{error}</div> : null}

      {/* Add new category */}
      <section style={S.card}>
        <h3 style={S.sectionTitle}>Add Category</h3>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 1fr) minmax(220px, 2fr) auto',
          gap: '10px', alignItems: 'end',
        }}>
          <div>
            <label style={S.label}>Name</label>
            <input style={S.input} value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="e.g. Demolition" />
          </div>
          <div>
            <label style={S.label}>Notes (optional — shown as fine print on PDFs)</label>
            <input style={S.input} value={newCatNotes} onChange={(e) => setNewCatNotes(e.target.value)} />
          </div>
          <button
            type="button"
            style={{ ...S.primary, opacity: (!newCatName.trim() || busy) ? 0.6 : 1 }}
            disabled={!newCatName.trim() || busy}
            onClick={handleCreateCategory}
          >
            Add category
          </button>
        </div>
      </section>

      {/* Existing categories */}
      {catalogLoading && catalog.length === 0 ? (
        <div style={{ fontSize: '0.85rem', color: '#9ab1d6', padding: '14px 0' }}>Loading catalog…</div>
      ) : (
        catalog.map((cat, catIdx) => (
          <section key={cat.id} style={S.card}>
            <CategoryHeaderEditor
              cat={cat}
              busy={busy}
              onPatch={handlePatchCategory}
              onDelete={() => handleDeleteCategory(cat)}
              onMoveUp={catIdx > 0 ? () => handleMoveCategory(catIdx, -1) : null}
              onMoveDown={catIdx < catalog.length - 1 ? () => handleMoveCategory(catIdx, 1) : null}
            />

            {/* Items table */}
            <div style={{ overflowX: 'auto', marginTop: '10px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left' }}>Item</th>
                    <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left', width: '120px' }}>Unit</th>
                    <th style={{ ...S.th, padding: '6px 8px', textAlign: 'right', width: '110px' }}>Rate</th>
                    <th style={{ ...S.th, padding: '6px 8px', textAlign: 'right', width: '100px' }}>Markup %</th>
                    <th style={{ ...S.th, padding: '6px 8px', textAlign: 'left', width: '130px' }}>Markup label</th>
                    <th style={{ ...S.th, padding: '6px 8px', textAlign: 'right', width: '80px' }}>Sort</th>
                    <th style={{ ...S.th, padding: '6px 8px', width: '110px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {(cat.items || []).map((item, itemIdx) => (
                    <ItemRowEditor
                      key={item.id}
                      item={item}
                      busy={busy}
                      onPatch={handlePatchItem}
                      onDelete={() => handleDeleteItem(item)}
                      onMoveUp={itemIdx > 0 ? () => handleMoveItem(cat, itemIdx, -1) : null}
                      onMoveDown={itemIdx < (cat.items || []).length - 1 ? () => handleMoveItem(cat, itemIdx, 1) : null}
                    />
                  ))}
                  {/* Add-item row */}
                  <tr style={{ borderTop: '1px solid rgba(143,182,255,0.08)' }}>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        style={S.inputSm}
                        value={adding[cat.id]?.name || ''}
                        onChange={(e) => setAddingFor(cat.id, { name: e.target.value })}
                        placeholder="New item name"
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        style={S.inputSm}
                        value={adding[cat.id]?.unit || ''}
                        onChange={(e) => setAddingFor(cat.id, { unit: e.target.value })}
                        placeholder="hr / day / m²"
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="number"
                        step="any"
                        style={{ ...S.inputSm, textAlign: 'right' }}
                        value={adding[cat.id]?.rate ?? ''}
                        onChange={(e) => setAddingFor(cat.id, { rate: e.target.value })}
                        placeholder="0.00"
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        type="number"
                        step="0.01"
                        style={{ ...S.inputSm, textAlign: 'right' }}
                        value={adding[cat.id]?.markup_pct ?? ''}
                        onChange={(e) => setAddingFor(cat.id, { markup_pct: e.target.value })}
                        placeholder=""
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <input
                        style={S.inputSm}
                        value={adding[cat.id]?.markup_label || ''}
                        onChange={(e) => setAddingFor(cat.id, { markup_label: e.target.value })}
                        placeholder="cost"
                      />
                    </td>
                    <td style={{ padding: '6px 8px' }} />
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      <button
                        type="button"
                        style={{ ...S.iconBtn, color: '#86efac' }}
                        disabled={!adding[cat.id]?.name?.trim() || busy}
                        onClick={() => handleAddItem(cat.id)}
                      >
                        + Add
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}

// ── Sub-component: editable category header (Settings tab) ───────────────
function CategoryHeaderEditor({ cat, busy, onPatch, onDelete, onMoveUp, onMoveDown }) {
  const [name, setName] = useState(cat.name || '');
  const [notes, setNotes] = useState(cat.notes || '');
  const [sortOrder, setSortOrder] = useState(cat.sort_order ?? 0);

  // Reflect upstream changes (e.g., after onReloadCatalog refresh).
  useEffect(() => { setName(cat.name || ''); }, [cat.name]);
  useEffect(() => { setNotes(cat.notes || ''); }, [cat.notes]);
  useEffect(() => { setSortOrder(cat.sort_order ?? 0); }, [cat.sort_order]);

  const dirty = (
    name !== (cat.name || '') ||
    notes !== (cat.notes || '') ||
    Number(sortOrder) !== Number(cat.sort_order ?? 0)
  );

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(160px, 1fr) minmax(220px, 2fr) 90px auto auto',
      gap: '10px', alignItems: 'end',
    }}>
      <div>
        <label style={S.label}>Category name</label>
        <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label style={S.label}>Notes</label>
        <input style={S.input} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div>
        <label style={S.label}>Sort</label>
        <input
          type="number"
          style={{ ...S.input, textAlign: 'right' }}
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
        />
      </div>
      <button
        type="button"
        style={{ ...S.primary, opacity: (!dirty || busy) ? 0.5 : 1 }}
        disabled={!dirty || busy}
        onClick={() => onPatch(cat.id, {
          name: name.trim() || cat.name,
          notes: notes || null,
          sort_order: Number(sortOrder) || 0,
        })}
      >
        Save
      </button>
      <div style={{ display: 'flex', gap: '4px' }}>
        <button
          type="button"
          onClick={onMoveUp || undefined}
          disabled={!onMoveUp || busy}
          style={{ ...S.iconBtn, opacity: onMoveUp ? 1 : 0.3 }}
          title="Move category up"
          aria-label="Move category up"
        >↑</button>
        <button
          type="button"
          onClick={onMoveDown || undefined}
          disabled={!onMoveDown || busy}
          style={{ ...S.iconBtn, opacity: onMoveDown ? 1 : 0.3 }}
          title="Move category down"
          aria-label="Move category down"
        >↓</button>
        <button type="button" style={S.danger} disabled={busy} onClick={onDelete}>
          Hide
        </button>
      </div>
    </div>
  );
}

// ── Sub-component: editable item row (Settings tab) ──────────────────────
function ItemRowEditor({ item, busy, onPatch, onDelete, onMoveUp, onMoveDown }) {
  const [name, setName] = useState(item.name || '');
  const [unit, setUnit] = useState(item.unit || '');
  const [rate, setRate] = useState(item.rate ?? 0);
  const [markupPct, setMarkupPct] = useState(item.default_markup_pct ?? '');
  const [markupLabel, setMarkupLabel] = useState(item.default_markup_label || '');
  const [sortOrder, setSortOrder] = useState(item.sort_order ?? 0);

  useEffect(() => { setName(item.name || ''); }, [item.name]);
  useEffect(() => { setUnit(item.unit || ''); }, [item.unit]);
  useEffect(() => { setRate(item.rate ?? 0); }, [item.rate]);
  useEffect(() => { setMarkupPct(item.default_markup_pct ?? ''); }, [item.default_markup_pct]);
  useEffect(() => { setMarkupLabel(item.default_markup_label || ''); }, [item.default_markup_label]);
  useEffect(() => { setSortOrder(item.sort_order ?? 0); }, [item.sort_order]);

  // Debounced auto-save on blur. Computing dirty lets us avoid spurious
  // PATCH calls when the user tabs away without changing anything.
  const persistIfDirty = (patch) => {
    const current = {
      name: item.name || '',
      unit: item.unit || '',
      rate: Number(item.rate) || 0,
      default_markup_pct: item.default_markup_pct == null ? null : Number(item.default_markup_pct),
      default_markup_label: item.default_markup_label || '',
      sort_order: Number(item.sort_order) || 0,
    };
    const next = {
      ...current,
      ...patch,
    };
    // Normalize before compare
    const same = (
      String(next.name) === String(current.name) &&
      String(next.unit) === String(current.unit) &&
      Number(next.rate) === Number(current.rate) &&
      (next.default_markup_pct == null ? null : Number(next.default_markup_pct)) ===
        (current.default_markup_pct == null ? null : Number(current.default_markup_pct)) &&
      String(next.default_markup_label || '') === String(current.default_markup_label || '') &&
      Number(next.sort_order) === Number(current.sort_order)
    );
    if (same) return;
    onPatch(item.id, {
      name: next.name?.trim() || item.name,
      unit: next.unit,
      rate: Number(next.rate) || 0,
      default_markup_pct: next.default_markup_pct === '' || next.default_markup_pct == null ? null : Number(next.default_markup_pct),
      default_markup_label: next.default_markup_label || null,
      sort_order: Number(next.sort_order) || 0,
    });
  };

  return (
    <tr style={{ borderTop: '1px solid rgba(143,182,255,0.08)' }}>
      <td style={{ padding: '6px 8px' }}>
        <input
          style={S.inputSm}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => persistIfDirty({ name })}
        />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <input
          style={S.inputSm}
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          onBlur={() => persistIfDirty({ unit })}
        />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <input
          type="number"
          step="any"
          style={{ ...S.inputSm, textAlign: 'right' }}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          onBlur={() => persistIfDirty({ rate })}
        />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <input
          type="number"
          step="0.01"
          style={{ ...S.inputSm, textAlign: 'right' }}
          value={markupPct}
          onChange={(e) => setMarkupPct(e.target.value)}
          onBlur={() => persistIfDirty({ default_markup_pct: markupPct })}
          placeholder=""
        />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <input
          style={S.inputSm}
          value={markupLabel}
          onChange={(e) => setMarkupLabel(e.target.value)}
          onBlur={() => persistIfDirty({ default_markup_label: markupLabel })}
          placeholder=""
        />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <input
          type="number"
          style={{ ...S.inputSm, textAlign: 'right' }}
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          onBlur={() => persistIfDirty({ sort_order: sortOrder })}
        />
      </td>
      <td style={{ padding: '6px 8px', textAlign: 'right' }}>
        <div style={{ display: 'flex', gap: '2px', justifyContent: 'flex-end', alignItems: 'center' }}>
          <button
            type="button"
            onClick={onMoveUp || undefined}
            disabled={!onMoveUp || busy}
            style={{ ...S.iconBtn, padding: '4px 6px', opacity: onMoveUp ? 1 : 0.3 }}
            title="Move item up"
            aria-label="Move item up"
          >↑</button>
          <button
            type="button"
            onClick={onMoveDown || undefined}
            disabled={!onMoveDown || busy}
            style={{ ...S.iconBtn, padding: '4px 6px', opacity: onMoveDown ? 1 : 0.3 }}
            title="Move item down"
            aria-label="Move item down"
          >↓</button>
          <button type="button" style={{ ...S.iconBtn, padding: '4px 6px', color: '#fca5a5' }} disabled={busy} onClick={onDelete}>
            Hide
          </button>
        </div>
      </td>
    </tr>
  );
}
