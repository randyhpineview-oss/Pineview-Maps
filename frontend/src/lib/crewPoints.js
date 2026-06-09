/**
 * crewMemberPoints(shift)
 *
 * Flatten a check-in shift into one row per crew member with their
 * latest known passive location (if any). Shared by:
 *   - components/CrewLayer.jsx  — one map pin per located member
 *   - components/CrewSidebar.jsx — one sidebar row per member
 *
 * The shift carries:
 *   shift.user_id          — lead's user id
 *   shift.crew_members[]   — [{id, name, email}] for everyone on the
 *                            shift (lead + crew mates), resolved by the
 *                            admin endpoints' user batch
 *   shift.member_locations — [{user_id, user_name, lat, lon,
 *                            accuracy_m, updated_at}] per member who
 *                            has reported a passive location on this
 *                            shift (POST /api/checkins/me/location)
 *   shift.last_loc_*       — back-compat shift-level "truck" position
 *                            from before per-member rows existed
 *
 * Returns: [{ key, shiftId, userId, name, isLead, mode, lat, lon,
 *             accuracyM, updatedAt }]. lat/lon/accuracyM/updatedAt are
 * null when the member has no position yet.
 *
 * key is `${shiftId}:${userId}` — used as both React key and selection
 * id by CrewLayer/CrewSidebar.
 */
export function crewMemberPoints(shift) {
  if (!shift) return [];

  // Start with everyone on the shift (lead + crew mates) so the sidebar
  // can list members without a position too.
  const byUser = new Map();
  const seed = (id, name) => {
    if (id == null || byUser.has(id)) return;
    byUser.set(id, {
      userId: id,
      name: name || `User #${id}`,
      isLead: id === shift.user_id,
      lat: null,
      lon: null,
      accuracyM: null,
      updatedAt: null,
    });
  };

  if (Array.isArray(shift.crew_members) && shift.crew_members.length) {
    for (const m of shift.crew_members) seed(m.id, m.name);
  }
  // Always make sure the lead is present (crew_members may be missing
  // on worker self-serve responses).
  seed(shift.user_id, shift.user_name);

  // Apply per-member passive locations.
  for (const loc of shift.member_locations || []) {
    const existing = byUser.get(loc.user_id) || {
      userId: loc.user_id,
      name: loc.user_name || `User #${loc.user_id}`,
      isLead: loc.user_id === shift.user_id,
    };
    existing.name = existing.name || loc.user_name || `User #${loc.user_id}`;
    existing.lat = loc.lat;
    existing.lon = loc.lon;
    existing.accuracyM = loc.accuracy_m;
    existing.updatedAt = loc.updated_at;
    byUser.set(loc.user_id, existing);
  }

  const points = [...byUser.values()];

  // Back-compat: no per-member rows yet (shift started before the
  // per-member tracking shipped, OR only the shift-level reporter
  // wrote anything). Attribute the shift-level last_loc to the lead so
  // older shifts still show a pin instead of vanishing.
  const anyLocated = points.some((p) => Number.isFinite(p.lat));
  if (!anyLocated && Number.isFinite(shift.last_loc_lat) && Number.isFinite(shift.last_loc_lon)) {
    const lead = points.find((p) => p.isLead) || points[0];
    if (lead) {
      lead.lat = shift.last_loc_lat;
      lead.lon = shift.last_loc_lon;
      lead.accuracyM = shift.last_loc_accuracy_m;
      lead.updatedAt = shift.last_loc_at;
    }
  }

  return points.map((p) => ({
    ...p,
    shiftId: shift.id,
    mode: shift.mode,
    key: `${shift.id}:${p.userId}`,
  }));
}
