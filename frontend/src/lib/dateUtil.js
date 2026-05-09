// Date helpers that respect the worker's local timezone.
//
// Why this module exists:
//   `new Date().toISOString().split('T')[0]` returns the UTC date, not
//   the local date. In PST that means anything after 4 PM (during DST)
//   or 5 PM (standard time) returns tomorrow's date. A worker entering
//   a lease sheet at 9 PM would see the date pre-filled to tomorrow,
//   which is confusing and — worse — produces records backdated by a
//   day once submitted.
//
// `localDateISO()` pulls Y-M-D from the local timezone instead, so
// `new Date()` → "2026-05-09" at 9 PM PST on May 9, not "2026-05-10".

export function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
