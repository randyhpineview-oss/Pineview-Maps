import { useEffect, useRef } from 'react';

/**
 * Shared "save a draft of the open form" hook used by both
 * HerbicideLeaseSheet and HydroseedDailyRecord.
 *
 * Triggers a call to `save()` when:
 *   1. The browser tab loses focus (`visibilitychange` → hidden).
 *   2. The page is about to unload (`pagehide` — best-effort, fire-and-forget).
 *   3. The host component unmounts (i.e. the modal/form closes).
 *
 * The hook is intentionally storage-agnostic — `save` is a caller-supplied
 * async function that does whatever persistence the form needs (typically
 * `saveLeaseSheetDraft(...)` from `offlineStore.js`). The hook just decides
 * *when* to fire it.
 *
 * Guards:
 *   - `enabled=false` short-circuits everything. Forms set this to false
 *     while submitting / previewing so we don't race with the real submit.
 *   - `hasContent()` returns false → skip. An empty form shouldn't pollute
 *     the draft list every time the user opens & closes it.
 *   - Concurrent saves are coalesced via `inFlightRef` — if a save is
 *     already running and another trigger fires, we just remember to
 *     re-save once the first one finishes.
 *
 * Returns `{ saveNow }` so callers can imperatively flush before, e.g.,
 * opening a sub-modal that might trash state.
 */
export function useAutoSaveDraft({
  enabled = true,
  hasContent,
  save,
}) {
  // Latest closures — refs so the event listeners don't need to be
  // re-bound on every render (which would be every keystroke).
  const enabledRef = useRef(enabled);
  const hasContentRef = useRef(hasContent);
  const saveRef = useRef(save);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { hasContentRef.current = hasContent; }, [hasContent]);
  useEffect(() => { saveRef.current = save; }, [save]);

  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  // The actual save kicker. Coalesces overlapping calls and respects guards.
  // Pass `{ force: true }` to bypass the `enabled` gate — used by callers
  // that close the modal (which flips `enabled` to false synchronously)
  // but still want one last save to land.
  const runSave = async (opts) => {
    const force = !!(opts && opts.force);
    if (!force && !enabledRef.current) return;
    try {
      if (typeof hasContentRef.current === 'function' && !hasContentRef.current()) return;
    } catch { /* if the predicate throws, assume we should save */ }
    if (typeof saveRef.current !== 'function') return;
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      await saveRef.current();
    } catch { /* swallow — autosave is best-effort */ }
    finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        // Re-run once if a trigger fired while we were busy.
        setTimeout(runSave, 0);
      }
    }
  };

  // Wire up the lifecycle listeners exactly once.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') runSave();
    };
    // `pagehide` is the modern replacement for `unload` that fires on
    // iOS Safari bfcache evictions too. We can't await it, so we just
    // kick off the save and hope the browser flushes before tear-down.
    const onPageHide = () => { runSave(); };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      // On unmount (form close): one last save attempt.
      runSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { saveNow: runSave };
}
