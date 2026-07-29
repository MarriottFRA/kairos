/**
 * Saved-layout repairs for the Positions grid.
 * -----------------------------------------------------------
 * The grid's layout (column order, widths, visibility) is exported and stored
 * per user, then handed back as `initialState` on the next mount. That snapshot
 * is by definition older than the code reading it, so a layout saved before a
 * column existed has to be repaired rather than trusted or thrown away.
 *
 * Every function here is a DEFAULT, not a reset: it only fills in what the saved
 * state is silent about, so a deliberate arrangement always survives. Kept free
 * of React so the rules can be tested on their own.
 */

import { GridInitialState } from "@mui/x-data-grid-premium";

/**
 * Fold the collapsible month families away in a layout that predates them.
 *
 * Only fills in keys the saved model says nothing about, so it is a default and
 * not a reset: the moment the user works the chevron every month carries an
 * explicit true/false, and an expanded family stays expanded across reloads.
 */
export function healCollapsedFamilies(
  state: GridInitialState,
  monthKeys: string[]
): GridInitialState {
  const model = { ...(state.columns?.columnVisibilityModel ?? {}) };
  let changed = false;
  for (const key of monthKeys) {
    if (!(key in model)) {
      model[key] = false;
      changed = true;
    }
  }
  if (!changed) return state;
  return { ...state, columns: { ...state.columns, columnVisibilityModel: model } };
}

/**
 * Splice a column a saved layout has never seen into the order it belongs in.
 *
 * The grid appends unknown fields to the far right, which would strand a new
 * column outside its own band — and a band with a gap in it draws its banner
 * twice. Anchoring on a neighbour that layout already knows puts it back where
 * the catalog has it. (The runtime equivalent for user-added columns is
 * withNewFieldInLayout in positions.tsx; this one covers columns that arrive
 * with a seed bump, where there is no add-time hook to run.)
 */
export function healNewColumn(
  state: GridInitialState,
  key: string,
  /** The column the new one goes in front of — its family's first month. */
  anchorKey: string
): GridInitialState {
  const ordered = state.columns?.orderedFields;
  if (!ordered || ordered.includes(key)) return state;
  const at = ordered.indexOf(anchorKey);
  if (at < 0) return state;
  return {
    ...state,
    columns: {
      ...state.columns,
      orderedFields: [...ordered.slice(0, at), key, ...ordered.slice(at)],
    },
  };
}
