/**
 * The canonical identity of a department × account combo.
 *
 * Kairos writes codes as "D0410" / "A988112", but not every source goes through
 * a picker: Manual Input lets the Dept Code be typed when no mapping tables are
 * loaded, and the legacy importer takes whatever the old workbook held. So the
 * same combo can reach the output table as "D0410"/"0410"/"d0410 ".
 *
 * That mattered the moment the BST push started sending the Results rows: the
 * push strips the D/A prefixes to form the workbook's `0410-988112` combo, so
 * two rows that LOOK distinct on the page resolve to one row in the workbook —
 * one write silently overwriting the other, or double-counting on "add". The
 * page and the push have to agree on what one combo is, which means one
 * function, used by both.
 *
 * The key is the bare, upper-cased code (exactly what the push sends); the
 * display form re-applies the prefix, so a bare legacy code is shown the way
 * the rest of the app writes it. Display always round-trips back to the same
 * key, so a code that genuinely begins with D or A cannot drift.
 */

/** "D0410" | "0410" | " d0410 " → "0410". The BST's sheet name. */
export function bareDept(dept: string): string {
  return String(dept ?? "").trim().toUpperCase().replace(/^D/, "");
}

/** "A988112" | "988112" → "988112". The BST's account. */
export function bareAccount(account: string): string {
  return String(account ?? "").trim().toUpperCase().replace(/^A/, "");
}

/** Kairos's own way of writing a department code. Blank stays blank. */
export function displayDept(dept: string): string {
  const bare = bareDept(dept);
  return bare ? `D${bare}` : "";
}

/** Kairos's own way of writing an account code. Blank stays blank. */
export function displayAccount(account: string): string {
  const bare = bareAccount(account);
  return bare ? `A${bare}` : "";
}

/**
 * The aggregation key: one string per dept × account combo, identical for every
 * spelling of the same combo. Uses the BST's separator so the key IS the combo
 * the push writes.
 */
export function comboKeyOf(dept: string, account: string): string {
  return `${bareDept(dept)}-${bareAccount(account)}`;
}

/** The two spellings a stored code may have, for matching rows back to a key. */
export function deptVariants(dept: string): [string, string] {
  const bare = bareDept(dept);
  return [bare, `D${bare}`];
}

/** The two spellings a stored account may have. */
export function accountVariants(account: string): [string, string] {
  const bare = bareAccount(account);
  return [bare, `A${bare}`];
}
