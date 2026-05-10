import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Promise-based replacement for `window.alert` / `confirm` / `prompt`.
 *
 * Why this exists:
 *   - Native dialogs look like Windows 95 in a 2026 PWA.
 *   - They block the JS thread, freezing animations + Realtime listeners.
 *   - They behave inconsistently across iOS Safari / Android Chrome / desktop.
 *   - They can't include rich content (severity colors, multi-line bullet
 *     lists, inline validation errors).
 *
 * The hook returns three functions whose semantics match the natives 1:1
 * so existing call sites translate with minimal edits — the only change
 * at the call site is adding `await` (and making the enclosing function
 * `async` if it isn't already).
 *
 *   await alert('Saved.');                        // void
 *   if (!(await confirm('Delete?'))) return;      // boolean
 *   const x = await prompt({ message: 'Why?',     // string | null
 *     validate: (v) => v.trim() ? null : 'required' });
 *
 * Resolution rules (mirror native):
 *
 *                       alert      confirm      prompt
 *   Click OK            undefined  true         trimmed value or ''
 *   Click Cancel        n/a        false        null
 *   Press Escape        undefined  false        null
 *   Press Enter         undefined  true         OK (validate must pass)
 *   Click backdrop      undefined  false        null
 *   Provider unmounts   undefined  false        null
 *
 * Stable identities: the {alert, confirm, prompt} object returned by
 * useDialog() has a stable reference across renders. Callers can safely
 * use these functions in useCallback / useEffect dependency lists
 * without invalidating their memoizations on every parent re-render.
 *
 * Layering: dialogs render at z-index 2000 to sit above the existing
 * ApproveEditModal / SignaturePadModal / PdfPreviewOverlay components
 * (all of which use 1000). A confirm fired from inside one of those
 * modals visually layers on top, as expected.
 *
 * Queueing: if a dialog is open and another is requested, the second
 * one queues FIFO. Prevents two dialogs stacking on top of each other
 * and stealing focus.
 */

const DialogContext = createContext(null);

let _dialogIdSeq = 0;
function nextDialogId() {
  _dialogIdSeq += 1;
  return _dialogIdSeq;
}

export function DialogProvider({ children }) {
  // Queue of pending dialog requests. queue[0] is the active one.
  const [queue, setQueue] = useState([]);

  // Stable API. setQueue from useState already has a stable identity
  // per the React contract, so a useMemo with [] keeps the returned
  // {alert, confirm, prompt} object identity-stable across renders.
  // Critical for callers that put these into useEffect dep arrays.
  const api = useMemo(() => {
    const enqueue = (kind, opts) =>
      new Promise((resolve) => {
        const normalized = typeof opts === 'string' ? { message: opts } : (opts || {});
        setQueue((q) => [...q, { id: nextDialogId(), kind, opts: normalized, resolve }]);
      });
    return {
      alert: (opts) => enqueue('alert', opts),
      confirm: (opts) => enqueue('confirm', opts),
      prompt: (opts) => enqueue('prompt', opts),
    };
  }, []);

  // Provider-unmount safety: if the whole tree tears down while
  // dialogs are still pending, resolve them all to their cancel
  // value so awaiting code paths complete instead of hanging.
  // Promises are resolved exactly once; subsequent calls no-op.
  const queueRef = useRef(queue);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => {
    return () => {
      for (const entry of queueRef.current) {
        try {
          entry.resolve(entry.kind === 'alert' ? undefined : entry.kind === 'prompt' ? null : false);
        } catch { /* ignore */ }
      }
    };
  }, []);

  const dismiss = useCallback((id, value) => {
    setQueue((q) => {
      const idx = q.findIndex((e) => e.id === id);
      if (idx === -1) return q;
      try { q[idx].resolve(value); } catch { /* ignore */ }
      const next = q.slice();
      next.splice(idx, 1);
      return next;
    });
  }, []);

  // Body scroll lock while ANY dialog is open. Restored when the queue
  // empties. Critical on iOS Safari where rubber-band scrolling through
  // a modal feels broken. Captures the previous overflow value so we
  // restore exactly what was there before (typically '' — the default).
  const previousOverflowRef = useRef('');
  useLayoutEffect(() => {
    if (queue.length === 0) return undefined;
    previousOverflowRef.current = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflowRef.current;
    };
  }, [queue.length === 0]);  // toggle only when transitioning to/from empty

  const active = queue[0] || null;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {active ? (
        <DialogPortal
          key={active.id}
          entry={active}
          onResolve={(value) => dismiss(active.id, value)}
        />
      ) : null}
    </DialogContext.Provider>
  );
}

/**
 * Renders a single active dialog. Re-mounts (via the `key={active.id}`
 * on the parent) when the next dialog in the queue takes over, which
 * naturally resets focus / input state without manual cleanup.
 */
function DialogPortal({ entry, onResolve }) {
  const { kind, opts } = entry;
  const isAlert = kind === 'alert';
  const isConfirm = kind === 'confirm';
  const isPrompt = kind === 'prompt';

  const panelRef = useRef(null);
  const okButtonRef = useRef(null);
  const cancelButtonRef = useRef(null);
  const inputRef = useRef(null);

  // Snapshot the element that was focused before we opened, so we can
  // restore it when this dialog dismisses. Without this, focus jumps
  // to <body> after dismissal — feels like the page just rebooted.
  const previousActiveElementRef = useRef(null);
  useLayoutEffect(() => {
    previousActiveElementRef.current = document.activeElement;
    return () => {
      const el = previousActiveElementRef.current;
      if (el && typeof el.focus === 'function' && document.body.contains(el)) {
        try { el.focus(); } catch { /* ignore */ }
      }
    };
  }, []);

  const [inputValue, setInputValue] = useState(() => opts.defaultValue ?? '');
  const [validationError, setValidationError] = useState('');

  // Focus the right element on open. Layout effect (not regular useEffect)
  // so the focus happens before the browser paints the dialog — avoids
  // a flicker where the OK button briefly shows un-focused.
  useLayoutEffect(() => {
    if (isPrompt) {
      inputRef.current?.focus();
      // If a defaultValue was provided, place cursor at end (matches
      // native window.prompt behavior).
      if (typeof opts.defaultValue === 'string' && opts.defaultValue.length > 0) {
        try {
          inputRef.current?.setSelectionRange(opts.defaultValue.length, opts.defaultValue.length);
        } catch { /* select-only inputs ignore this */ }
      }
    } else {
      okButtonRef.current?.focus();
    }
  }, [isPrompt, opts.defaultValue]);

  const cancelValue = isAlert ? undefined : isPrompt ? null : false;
  const handleOk = useCallback(() => {
    if (isPrompt) {
      const trimmed = String(inputValue).trim();
      // Validate first; if validate throws (caller bug), treat as no
      // error and accept the value rather than crashing the dialog.
      let err = null;
      if (typeof opts.validate === 'function') {
        try { err = opts.validate(trimmed); } catch { err = null; }
      }
      if (err) { setValidationError(String(err)); return; }
      onResolve(trimmed);
      return;
    }
    onResolve(isConfirm ? true : undefined);
  }, [isPrompt, isConfirm, inputValue, opts, onResolve]);

  const handleCancel = useCallback(() => {
    onResolve(cancelValue);
  }, [cancelValue, onResolve]);

  // Document-level keyboard handlers. Attached only while this dialog
  // is mounted so they don't leak Escape interception elsewhere.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
        return;
      }
      // Enter — submit OK on alert/confirm always; on prompt only when
      // focus is in the input (so newlines in a future textarea variant
      // wouldn't auto-submit).
      if (e.key === 'Enter') {
        if (isPrompt && document.activeElement !== inputRef.current) return;
        e.preventDefault();
        handleOk();
        return;
      }
      // Focus trap: cycle Tab between the panel's tabbable elements.
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const tabbable = panel.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
        );
        if (tabbable.length === 0) return;
        const first = tabbable[0];
        const last = tabbable[tabbable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleOk, handleCancel, isPrompt]);

  const handleBackdropClick = useCallback((e) => {
    // Only the dimmed backdrop area — clicks inside the panel bubble
    // up here too unless we check the original target. e.currentTarget
    // is the backdrop div; e.target is whatever was actually clicked.
    if (e.target === e.currentTarget) handleCancel();
  }, [handleCancel]);

  // Severity → button class mapping. Defaults to a primary blue OK
  // button; danger gets the existing red `danger-button` class.
  const okButtonClass = opts.severity === 'danger' ? 'danger-button' : 'primary-button';
  const okLabel = opts.okLabel ?? (isPrompt ? 'OK' : isConfirm ? 'OK' : 'OK');
  const cancelLabel = opts.cancelLabel ?? 'Cancel';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={opts.title ? `dialog-title-${entry.id}` : undefined}
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: '1rem',
      }}
    >
      <div
        ref={panelRef}
        style={{
          background: '#1f2937',
          color: '#f9fafb',
          borderRadius: 8,
          padding: '1.25rem',
          minWidth: 280,
          maxWidth: 480,
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
          touchAction: 'pan-y',
        }}
      >
        {opts.title ? (
          <h3
            id={`dialog-title-${entry.id}`}
            style={{
              margin: '0 0 0.5rem 0',
              fontSize: '1.05rem',
              fontWeight: 600,
              color: opts.severity === 'danger' ? '#fca5a5' : '#f9fafb',
            }}
          >
            {opts.title}
          </h3>
        ) : null}

        {opts.message ? (
          <div
            style={{
              fontSize: '0.9rem',
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: '#e5eefb',
            }}
          >
            {opts.message}
          </div>
        ) : null}

        {isPrompt ? (
          <div style={{ marginTop: '0.75rem' }}>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                if (validationError) setValidationError('');
              }}
              placeholder={opts.placeholder || ''}
              style={{
                width: '100%',
                padding: '0.5rem 0.65rem',
                borderRadius: 6,
                border: validationError ? '1px solid #f87171' : '1px solid #374151',
                background: '#111827',
                color: '#f9fafb',
                fontSize: '0.95rem',
                boxSizing: 'border-box',
              }}
            />
            {validationError ? (
              <div
                style={{
                  marginTop: '0.35rem',
                  color: '#f87171',
                  fontSize: '0.8rem',
                }}
              >
                {validationError}
              </div>
            ) : null}
          </div>
        ) : null}

        <div
          className="button-row"
          style={{
            marginTop: '1rem',
            justifyContent: 'flex-end',
          }}
        >
          {!isAlert ? (
            <button
              ref={cancelButtonRef}
              type="button"
              className="secondary-button"
              onClick={handleCancel}
            >
              {cancelLabel}
            </button>
          ) : null}
          <button
            ref={okButtonRef}
            type="button"
            className={okButtonClass}
            onClick={handleOk}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Returns `{ alert, confirm, prompt }` — Promise-based replacements
 * for the native window.* functions. Must be called from inside a
 * <DialogProvider>; throws otherwise.
 *
 * Returned function identities are stable across renders, so they
 * are safe to put into useCallback / useEffect dependency lists.
 */
export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog() must be called from inside a <DialogProvider>.');
  }
  return ctx;
}
