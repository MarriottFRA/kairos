/**
 * Built-in (SYSTEM) field catalog seed.
 * -----------------------------------------------------------
 * The single source of truth for the columns Kairos ships with. The structure
 * repo pushes this into `field_catalog` per OU on first read and re-applies it
 * whenever SEED_VERSION is bumped — updating system-owned attributes while
 * preserving everything the user owns (custom_label, sort_order, visible).
 *
 * Adding/changing a system field = edit this file + bump SEED_VERSION.
 * No SQL migration needed. Array order = default display order.
 */

import { MONTH_LABELS } from "../calendar";
import {
  ACCOUNT_FIELD_KEYS,
  INPUT_BASIS_KEY,
  BASIC_SALARY_ANNUAL_KEY,
  FieldCatalog,
  FieldDef,
  HEADCOUNT_STATS_ACCOUNT_KEY,
  SALARY_ENTRY_MODE_KEY,
  SectionDef,
  SectionId,
  VectorName,
  vectorKey,
} from "./fields";
import { POSITION_COUNT_ACCOUNT, STAFFING_ACCOUNT_FILTER } from "./systemAccounts";

// v2: dropped the redundant "CONTRACT - " label prefixes — the column group
// header already names the section, so the prefix only ate the width that
// distinguishes one column from the next.
// v3: split the old "Employee" band in two. `pii` now holds ONLY the four
// identity columns — it is the band the "+" button extends, and every column
// under it is PII (maskable, encrypted store). Everything that merely describes
// the post rather than the person moved to the new `employee` band.
// v4: Job Title stopped being maskable — it names the post, not the person.
// Catalogs seeded at v3 still carry maskable=1 for it, so the bump is what
// re-applies the system-owned attributes over them.
// v5: added `active` at the head of the Employee band. Positions now persist
// across years (a scenario copy rolls them forward), so there has to be a way
// to say "this post isn't budgeted this year" without deleting the row.
// Note: the `employee` band's display label is "Position" — it only ever held
// the post's attributes (department, classification, job title), never the
// person's; the person lives under "Employee PII". Band labels come from the
// SECTIONS constant, which getFieldCatalog returns directly (never stored per
// OU), so relabelling a band needs no seed bump — only field changes do.
// v6: `departmentCode`'s dropdownSource gained `nameField: "deptName"`, wiring
// the Department picker to auto-fill the (now read-only) Dept Name column.
// v7: inverted that — the picker moved onto `deptName` (you search departments
// by name), and `departmentCode` became the read-only mirror it auto-fills, via
// `dropdownSource: { kind: "departments", codeField: "departmentCode" }`.
// dropdown_source is stored per OU and only re-applied when seed_version climbs,
// so these attribute changes need the bump to reach catalogs seeded earlier.
// v8: two changes.
//  (a) Classification (jobTypeCode) options no longer include "Hourly" — that was
//      a pay basis masquerading as a grade. Classification is now a clean set of
//      post grades (Manager, Manager (Non Exempt), Supervisor, Associate, Casual,
//      Buyout Labour); the salaried/hourly axis stays on Pay Basis (payType).
//  (b) Pay Basis (payType), Cluster, and headcount (relabelled "Count") moved
//      from the Contract band into Position — they describe the post, not its
//      contract mechanics, and sit next to Classification. "Count" is just the
//      headcount multiplier renamed; the key/column/engine are unchanged.
//      Relocating a field between bands relies on the seed re-applying sort_order
//      on a version bump (see ensureFieldCatalogSeed); without that the moved
//      field's band would draw its header twice.
// v9: Manhours Paid (yearlyManhoursPaid) became a read-only COMPUTED column —
//     paid days (Yearly Days − Days Off) × Daily Hours — instead of a free-entry
//     POSITION_EXTRA field. The bump re-applies storage/editable over catalogs
//     seeded earlier; any value previously typed into extra_values is ignored
//     (COMPUTED columns derive from the row, never read storage).
// v10: Hourly Rate (hourlyRate) added to the Basic Salary band — an alternate,
//     mutually-exclusive input to Monthly Basic that derives the base from
//     rate × hours worked (see engine reference.ts). New engine scalar column
//     hourly_rate on the positions table (migrated in schema.ts).
// v11: Daily Cost (dailyVacationCost) and Accrual Cost (accrualCostPerDay) removed
//     as inputs — a vacation/accrual day is now valued by the engine at the
//     position's derived per-working-day base pay (see engine reference.ts). The
//     bump retires the two fields from catalogs seeded earlier; their columns are
//     dropped from the positions table (schema.ts migration v5). "Estimated Cost"
//     (vacationEstimate) is now the engine-simulated Vacation Cost.
// v12: Accrual Days (accrualDaysPerMonth) stopped being an input — it is now a
//     read-only COMPUTED column, Yearly Days ÷ 12, so the monthly entitlement
//     always shows. Whether accruals are actually *generated* is decided by the
//     Accrual account: the value fed to the engine is zeroed for a position with
//     no accrual account (see loadScenarioInput / rowModel.rowToEnginePosition),
//     and the engine's existing accrualDays===0 guard suppresses the line. The
//     bump re-applies storage/editable over catalogs seeded earlier; the vestigial
//     accrual_days_per_month column is left in place (no longer read or written).
// v13: account columns sit beside the data they book, not bunched in Basic Salary.
//     Working Hours account (workingHoursAccount) moved into Contract, right after
//     Manhours Worked; Headcount account (headCountAccount) moved into Position,
//     right after Count. FTE account (fteAccount) dropped outright — FTE is a ratio
//     with no GL account of its own; ensureFieldCatalogSeed prunes retired keys, so
//     the column and its extra_values are cleaned up on the next seed. Both moves are
//     section + sort_order changes on POSITION_EXTRA fields (keys unchanged), so
//     stored values survive; the bump is what re-applies the new section/order to
//     catalogs seeded earlier (refresh is version-gated).
// v14: account fields gained a dropdown, seeded from the account_maps table and
//     narrowed per field — the picker searches by description (detail level max)
//     but stores the base_account code. The subset each field offers is carried
//     on its dropdownSource.filter: Headcount and Working Hours book to A9…
//     accounts; Salary, Accrual and Benefits book to A5…; the Home page's bank
//     holiday premium account (not a catalog field) uses the same A5… rule. The
//     prefixes are a first, broad pass to be narrowed later (see AccountFilter).
//     Filters are the only change, so stored account values survive; dropdown_source
//     is stored per OU and re-applied only when seed_version climbs, so the bump is
//     what reaches catalogs seeded earlier.
// v15: Cluster realizes its intended purpose — hotel clusters. The column now
//     stores a hotel-cluster ID from the plaintext hotel_clusters table (picker
//     displays names via dropdownSource {kind:"hotelClusters"}; "" = none); its
//     old free-text department groupings are dropped (mapping tables replace
//     that use) and cleared by secure migration v11. A new locked NUMBER field,
//     Cluster Multiplier (clusterMultiplierOverride -> cluster_multiplier_override,
//     secure v11), sits beside it: read-only display of the hotel's weight in
//     the assigned cluster, manually editable only while that cluster has
//     exactly one member hotel. The engine flexes every cost/hours/FTE line by
//     the resolved weight — headcount never flexes (a shared person still
//     counts as one head).
// v16 (2c): niOpeningBase — the prior-year NI/SS base carried into a
//     non-January tax year. RETIRED in v18: the opening base moved to
//     per-(position, scheme) storage owned by each SS block (a component_values
//     slot surfaced inside the scheme's block column group), so the single
//     per-position scalar is gone.
// v17: positionCount — read-only COMPUTED mirror of Count, beside it. Surfaces
//     the universal head the engine always books to A972540 (VBA §21), so heads
//     are never silently unreported when the per-row Headcount account is blank.
//     RETIRED in v20: mirroring Count said nothing the Count column did not, so
//     the slot now shows the pinned ACCOUNT instead (headcountStatsAccount).
// v18: retired niOpeningBase (see v16) — now a per-scheme block input, not a
//     position field. ensureFieldCatalogSeed prunes the stale catalog row.
// v19: annual salary entry. Basic Salary gains Salary Entry (which face you
//     type), Annual Basic (the contract's yearly figure) and the hidden Annual
//     Basis (÷ working months, or ÷ 12). All three are POSITION_EXTRA, so this
//     is a seed change with no SQL migration. The engine is untouched — it
//     still reads monthlyBaseSalary, which rowModel keeps derived. Rows seeded
//     before v19 carry no Salary Entry and read as MONTHLY, so their stored
//     monthly figure — and every number the engine derives from it — is
//     unchanged; only new rows default to ANNUAL.
// v20: positionCount RETIRED, replaced in the same slot by headcountStatsAccount
//     ("HC Stats") — a read-only ACCOUNT_CODE column showing the pinned A972540.
//     Position Count merely restated Count, so it explained nothing; the account
//     is the useful thing, because it is what shows up in Results. Shipped with
//     the change that finally routes the OTHER four account columns
//     (salaryAccountCode, headCountAccount, workingHoursAccount,
//     benefitsAccountCode) into the engine — until then they were stored and read
//     by nothing, which is why Results only ever showed A972540.
// v21: Additional Costs (additionalCostsTotal) — a read-only Σ of the twelve
//     Additional Cost Jan..Dec columns, seeded immediately BEFORE them. The
//     twelve are now collapsed behind it by default and expand from a chevron
//     on its header (see COLLAPSIBLE_MONTH_FAMILIES). Only the summary column is
//     new: the month fields are untouched — still visible in the catalog, still
//     stored, still fed to the engine — so this changes what the grid *shows*,
//     never what it calculates. Collapsing is grid layout state, not catalog
//     visibility, which is why hiding twelve columns needs no seed flag of its
//     own and cannot be confused with removing them.
// v22: two changes, both about columns saying one thing each.
//  (a) Job Title splits in two. `title` keeps its meaning and its
//      `position_pii.title` storage — the LOCAL, colloquial title, free text,
//      because that is what a hotel actually calls the post and users will type
//      it whatever the system offers. Beside it, a new `standardJobTitle`
//      (POSITION_EXTRA, ENUM over STANDARD_JOB_TITLE_OPTIONS) carries the
//      narrow, group-wide title the same post rolls up under. Neither is
//      derived from the other: the local one is never constrained, the standard
//      one is never free text, so consistency is enforced without fighting the
//      user for the name on the contract. Nothing engine-side reads either —
//      `jobTypeCode` is still the grade that feeds the staffing rollup — so this
//      is purely a catalog addition.
//  (b) Working Months (sea_1..sea_12) joins the collapsible families: the twelve
//      factors fold behind Total Months, which moved to sit immediately BEFORE
//      them (the summary has to keep the family's slot when they're folded).
//      Same mechanism as Additional Costs in v21 — grid layout, not catalog
//      visibility — so the values still feed the engine untouched.
// v23: the twelve vacation weights (vacw_1..12) and their Total Weights column
//     become PERCENT instead of NUMBER. They are shares of one year, and a
//     column of "0.0833" that has to add up to "1.00" asks the user to think in
//     fractions; "8.33%" adding to "100%" is the same fact in the unit they
//     already hold it in. Nothing about the numbers changes: PERCENT is a
//     display+parse skin in columnFactory (shows value × 100, accepts "8.33",
//     "8.33%" or "0.0833"), storage stays the 0..1 fraction the engine
//     normalizes by its own total, and the min/max/decimals validation is
//     untouched. Seed-only, so existing rows need no migration.
// v24: FTE stopped being free entry and became a read-only COMPUTED column —
//     the row's worked hours (Yearly Days − Vacation − Days Off − Public
//     Holidays, × Daily Hours, prorated by Working Months) over what a
//     full-timer at this hotel works (see engineInput.deriveFte). Same shape as
//     Manhours Paid in v9, with one difference: the denominator is a hotel-year
//     constant, not a row value, so it is read from the Home page's position
//     defaults (Yearly Days − Days Off − Public Holidays, Weekly Hours ÷ 5) —
//     the VBA's Menu!$O$14 and FT_Hours. `fte` therefore leaves
//     ENGINE_SCALAR_COLUMNS: both engine paths now derive it at load, the
//     `positions.fte` column is vestigial (left in place, no longer read or
//     written), and previously typed values are ignored. Anything that consumed
//     FTE — the STAT_FTE head, FTE-based pool spread, allocation bases — keeps
//     working unchanged, on a number the user can no longer contradict.
// v25: Vacation months became WEIGHTS, not percentages — dataType PERCENT →
//     NUMBER, the max-1 clamp dropped, labels "Vacation % n" → "Vacation Weight
//     n", and the total renamed "Total Weight" with its must-equal-100% tint
//     removed. The engine always normalized these by their own sum, so this is a
//     display/parse change only and STORED VALUES NEED NO MIGRATION: a row
//     holding twelve 0.0833s is still a perfectly even year, it now just reads
//     0.0833 instead of 8.33%. New rows seed twelve 1s. The percent skin could
//     not express an even year at all (1/12 = 8.3333…% ≠ 8.33%), and the 100%
//     cue actively pushed users into unequal months, which the holiday accrual
//     then reported as permanent monthly noise.
// v26: the Headcount account stopped being a pick and became a CALCULATED
//     column, derived from Classification (see HEADCOUNT_ACCOUNT_BY_JOB_TYPE):
//     Manager → A988101, Manager (Non Exempt) → A988113, Supervisor → A988102,
//     and nothing at all for Associate / Casual / Buyout Labour. The grade
//     decides the account with no judgement left over, so offering the whole A9…
//     range only invited two hotels to answer the same question differently.
//     Same shape as Manhours Paid (v9) and FTE (v24): storage POSITION_EXTRA →
//     COMPUTED, so the column is read-only, the dropdown is gone and NOTHING is
//     stored — both engine paths derive it in readPositionAccounts, which reads
//     the Classification and never the stored key, so values written before v26
//     are inert wherever they still sit in extra_values. A grade with no account
//     posts no per-row headcount line (the pinned HC Stats head still books the
//     heads), which is exactly what a blank account has always meant.
// v27: the Working Hours account gets the same treatment one step softer. Its
//     picker narrows from the whole stats range (A9…) to the staffing family
//     (A988…, STAFFING_ACCOUNT_FILTER), and the Classification now DEFAULTS it:
//     both manager grades → A988308, Supervisor / Associate / Casual → A988699,
//     Buyout Labour → none. Deliberately a default and not a derivation, unlike
//     the Headcount account: the field stays POSITION_EXTRA and editable, so a
//     post that books somewhere special keeps the account the user picked. The
//     default is (re)applied by sanitizeRow when the grade changes, and only
//     when the same edit did not also set the account by hand — so a pasted row
//     carrying both keeps its own. The bump is what re-applies the narrowed
//     dropdown_source (stored per OU, refreshed only when seed_version climbs);
//     stored accounts outside A988 survive untouched and still post — the filter
//     scopes the PICKER, never the engine.
// v28: the two A5… cost accounts a new row nearly always books to now arrive
//     filled in — Salary → A520001, Vacation Benefits → A560303. Both stay
//     ordinary editable picks over the same A5 range; the only change is what an
//     untouched new row starts at. A blank account posts NO line, so a row added
//     and left alone used to drop its salary and vacation cost out of Results
//     silently, and the most common right answer is one code in each case. This
//     is a plain catalog `defaultValue`, applied by newDraftRow, so it touches
//     NEW rows only: rows already stored keep whatever they hold, blank included.
//     The Accrual account beside Benefits is deliberately left blank — there it
//     is the on/off switch for booking the holiday accrual at all (see v12), so
//     a default there would start generating a liability nobody asked for.
// v29: the Standard Title list is curated and the picker grouped. It had grown
//     to 98 entries encoding three axes at once — role, seniority tier and
//     outlet — when the row already carries the other two: Classification is the
//     grade and Department is the outlet, so "Assistant Restaurant Manager",
//     "Restaurant Manager" and "Banquet Manager" were three ways to file one
//     post. It is now ~75 entries at one-per-role, by the four rules in the
//     docblock over STANDARD_JOB_TITLE_GROUPS, plus the roles a group-wide list
//     was missing (Cost Controller, Duty Manager, Night Manager, IT Technician,
//     Sales Coordinator, Spa Receptionist, Trainee / Apprentice, Intern). Each
//     option now also carries a `group`, which the type-ahead editors render as
//     section headers — the length that matters is the group's, not the list's.
//     Removing titles is safe by construction: a stored value the list no longer
//     offers is re-injected as its own option, so no column is blanked and no
//     migration is needed, and nothing derives from this field anyway (the only
//     reader is the Results display-name fallback, which takes the string as
//     it stands). The bump is what re-applies dropdown_source per OU.
// v30: seven roles the one-per-role list was still missing, each named in the
//     list's own idiom (spelled out, no shorthand — "Food & Beverage
//     Coordinator", not "F&B"; "Telephone Operator", not "Telecomm") and filed
//     beside the post it works with: Telephone Operator (Front Office — a PBX
//     post Front Desk Agent doesn't cover), Revenue Analyst (beside Revenue
//     Manager, the working-level shape Sales Executive already has), Food &
//     Beverage Coordinator (the department-coordinator pattern of HR and
//     Sales), and Compliance Manager (Finance — a role of its own, not a grade
//     or outlet variant of anything listed). Financial Controller (beside
//     Director of Finance) is a rule-4 coexistence: the group runs cluster
//     DOFs over several hotels each, so the on-property finance head is a
//     second post the group counts, not a junior DOF — posts worded "Assistant
//     Director of Finance" (retired v29) file here now, the contract wording
//     staying in the local title as ever. The last two are Marriott
//     vocabulary — Rooms Controller (Front Office) and Voyager (General) — in
//     the list because the group's hotels ARE Marriott-branded, so rule 3 cuts
//     the other way: these are posts the group genuinely counts across its
//     large properties, not one hotel's wording for a listed role. Front Desk
//     Manager and Housekeeping Manager stayed out on the same grounds their
//     Assistant variants left in v29: a second management post under a
//     department head is the parent title + Classification. Additions only, so
//     nothing needs a retirement mapping; the bump re-applies dropdown_source
//     per OU.
// v31: "Annual Basis" becomes "Input Basis" and moves to the head of the
//     Contract band, visible. It always asked the general question — what period
//     are this row's yearly figures stated for? — but only answered it for the
//     Annual → Monthly salary divisor, while the derived FTE assumed a full year
//     (a hardcoded ÷12), the derived man-hours assumed the contract period, and
//     the vacation weights split the difference by accident. It now governs all
//     of them: contract days, vacation days, the manual yearly increase and the
//     hours/FTE derivations read it through engineInput.basisMonthsFor /
//     basisScaleFor. Default flips to TWELVE, which is what an untouched row was
//     already behaving as. Storage key unchanged (annualDivisorBasis), so this is
//     a seed change with no field migration; the row DATA restatement that keeps
//     seasonal rows' budgets identical is secure_db MIGRATIONS[7]. The refresh
//     UPDATE rewrites section, sort_order and default_label, so existing catalogs
//     pick up the move and the rename; `visible` is never refreshed and existing
//     catalogs already hold 1, which is the value we want.
export const SEED_VERSION = 31;

/** base_account prefixes each account field books to. The A5 cost prefixes are a
 *  picker-scoped narrowing only — a cost is any non-stats account (the split
 *  itself is STATS_ACCOUNT_FILTER, which is what Results toggles on).
 *  The Headcount account has no filter since v26: it is derived from
 *  Classification, not picked. Working Hours narrowed to the staffing family in
 *  v27 — still stats accounts, just the part of the range staffing books to. */
const HOURS_ACCOUNT_FILTER = STAFFING_ACCOUNT_FILTER;
const SALARY_ACCOUNT_FILTER = { startsWith: ["A5"] };
const VACATION_ACCOUNT_FILTER = { startsWith: ["A5"] };

/** What a NEW row's two A5 accounts start at (v28). Starting points, not rules:
 *  no classification or department narrows them the way the staffing accounts
 *  are narrowed, so there is nothing to derive — but "the usual one, change it if
 *  yours differs" beats a blank that quietly posts nothing. Exported so the seed
 *  and the tests that pin it agree on the code rather than both spelling it out.
 *  Both sit inside the A5 range their own picker offers, so a defaulted account
 *  is always one the user could have chosen by hand. */
export const DEFAULT_SALARY_ACCOUNT = "A520001";
export const DEFAULT_BENEFITS_ACCOUNT = "A560303";

export const SECTIONS: SectionDef[] = [
  // The row gutter: select / active / row actions. Unlabelled on purpose —
  // it is a control strip, not data, and a band title over it would read as a
  // column heading for the checkboxes.
  { id: "control", label: "", order: 5 },
  { id: "pii", label: "Employee PII", order: 10 },
  { id: "employee", label: "Position", order: 15 },
  { id: "contract", label: "Contract", order: 20 },
  { id: "seasonality", label: "Working Months", order: 30 },
  { id: "basicSalary", label: "Basic Salary", order: 40 },
  { id: "vacation", label: "Vacation", order: 50 },
];

/** Job classification options. These name the *post* (grade/role band) only —
 *  the pay basis (salaried vs hourly) is a separate axis, carried by `payType`.
 *  "Hourly" used to live here, which conflated the two; it now belongs solely to
 *  Pay Basis. Values are free-form strings and double as half of the staffing
 *  stats rollup key (`cluster|jobTypeCode` in compile.ts — the other half is
 *  now the hotel-cluster name). */
/** The Classification dropdown. Exported so config surfaces that filter by
 *  classification (e.g. a pooled block's eligibility rule) offer the same list
 *  the grid stores — one place to add a job type. */
export const JOB_TYPE_OPTIONS = [
  "Manager",
  "Manager (Non Exempt)",
  "Supervisor",
  "Associate",
  "Casual",
  "Buyout Labour",
].map((value) => ({ value, label: value }));

/**
 * The narrow, group-wide job titles — the other half of the Job Title pair.
 *
 * The local title (`title`) is free text on purpose: a hotel calls a post what
 * it calls it, and a picker that refuses the name on the contract just gets
 * worked around. This list is what that post rolls up AS, so it is deliberately
 * short and generic — one entry per recognisable role, not per hotel's wording.
 *
 * What keeps it short is that the row already carries the other axes, so a
 * title must not restate them (v29):
 *  1. No entry differing from another only by a seniority prefix (Assistant /
 *     Deputy / Junior) — Classification is the grade, and the local title keeps
 *     the exact wording. "Assistant Restaurant Manager" is Outlet Manager +
 *     Manager, and the contract wording survives in `title`.
 *  2. No entry differing only by outlet — Department carries that. A banquet
 *     waiter and a restaurant waiter are one title in two departments.
 *  3. No entry finer than what a group would actually count across hotels: the
 *     trades roll up as Technician, the finance clerks as Accounts Clerk.
 *  4. "Director of X" only where an "X Manager" genuinely coexists with it in
 *     one hotel (Rooms, F&B, Sales, Engineering, Finance). Where they are two
 *     brandings of the same post (HR, Security), there is one entry.
 *
 * Retired in v29, and where each now belongs. Shortening the list never blanks
 * a filled column — a stored value the list no longer offers is re-injected as
 * its own option (see OptionEditCell) — so these live on as typed-in history
 * rather than needing a remap:
 *   Assistant Director of Finance / Assistant Front Office Manager /
 *   Assistant Executive Housekeeper / Assistant Restaurant Manager /
 *   Assistant Chief Engineer .................. parent title + Classification
 *   Executive Sous Chef, Demi Chef de Partie .. Sous Chef / Chef de Partie
 *   Director of Operations .................... Hotel Manager
 *   Financial Analyst ......................... Accountant
 *   Accounts Payable Clerk, Accounts Receivable
 *     Clerk, General Cashier .................. Accounts Clerk
 *   Paymaster ................................. Payroll Officer
 *   Receiving Clerk ........................... Storekeeper
 *   Director of Human Resources ............... Human Resources Manager
 *   Director of Security ...................... Security Manager
 *   Guest Relations Manager ................... Front Office Manager
 *   Doorperson ................................ Bell Attendant
 *   Linen Attendant, Tailor ................... Laundry Attendant
 *   Restaurant / Bar / Banquet Manager ........ Outlet Manager
 *   Restaurant / Banquet Supervisor ........... Outlet Supervisor
 *   Banquet Server, Room Service Attendant .... Waiter / Waitress
 *   Butcher, Baker ............................ Chef de Partie / Pastry Chef
 *   Electrician, Plumber, Painter, Carpenter .. Technician
 *   Director of Sales ......................... Director of Sales & Marketing
 *   Director of Revenue Management ............ Revenue Manager
 *
 * Static for now, like Classification. When titles need to differ per group or
 * be edited without a release they become a reference table (the departments /
 * accounts pattern) and this constant is the seed for it — the field key and its
 * stored values are unaffected by that move, since the column stores the title
 * string itself.
 */
const STANDARD_JOB_TITLE_GROUPS: Array<{ group: string; titles: string[] }> = [
  {
    group: "Executive",
    titles: ["General Manager", "Hotel Manager", "Duty Manager", "Executive Assistant"],
  },
  {
    group: "Finance & Purchasing",
    titles: [
      "Director of Finance",
      "Financial Controller",
      "Cost Controller",
      "Accountant",
      "Accounts Clerk",
      "Income Auditor",
      "Compliance Manager",
      "Payroll Officer",
      "Purchasing Manager",
      "Storekeeper",
    ],
  },
  {
    group: "Human Resources",
    titles: [
      "Human Resources Manager",
      "Human Resources Coordinator",
      "Training Manager",
    ],
  },
  { group: "IT", titles: ["IT Manager", "IT Technician"] },
  {
    group: "Front Office",
    titles: [
      "Director of Rooms",
      "Front Office Manager",
      "Night Manager",
      "Front Desk Supervisor",
      "Front Desk Agent",
      "Rooms Controller",
      "Guest Relations Agent",
      "Concierge",
      "Night Auditor",
      "Telephone Operator",
      "Reservations Manager",
      "Reservations Agent",
      "Bell Attendant",
      "Driver",
    ],
  },
  {
    group: "Housekeeping",
    titles: [
      "Executive Housekeeper",
      "Housekeeping Supervisor",
      "Room Attendant",
      "Public Area Attendant",
      "Houseperson",
      "Laundry Attendant",
    ],
  },
  {
    group: "Food & Beverage",
    titles: [
      "Director of Food & Beverage",
      "Food & Beverage Manager",
      "Food & Beverage Coordinator",
      "Outlet Manager",
      "Outlet Supervisor",
      "Host / Hostess",
      "Waiter / Waitress",
      "Busser",
      "Bartender",
    ],
  },
  {
    group: "Kitchen",
    titles: [
      "Executive Chef",
      "Sous Chef",
      "Chef de Partie",
      "Commis Chef",
      "Pastry Chef",
      "Chief Steward",
      "Kitchen Steward",
    ],
  },
  {
    group: "Sales, Marketing & Events",
    titles: [
      "Director of Sales & Marketing",
      "Sales Manager",
      "Sales Executive",
      "Sales Coordinator",
      "Revenue Manager",
      "Revenue Analyst",
      "Marketing Manager",
      "Events Manager",
      "Events Executive",
    ],
  },
  {
    group: "Engineering",
    titles: [
      "Director of Engineering",
      "Chief Engineer",
      "Engineering Supervisor",
      "Technician",
      "Gardener",
    ],
  },
  {
    group: "Security",
    titles: ["Security Manager", "Security Supervisor", "Security Officer"],
  },
  {
    group: "Spa & Recreation",
    titles: [
      "Spa Manager",
      "Spa Therapist",
      "Spa Receptionist",
      "Spa Attendant",
      "Fitness Instructor",
      "Lifeguard",
      "Recreation Attendant",
    ],
  },
  // Not a department: these are budgeted anywhere and have no role of their own.
  // Voyager is Marriott's management-trainee programme — its own line, not a
  // Trainee spelling, because a hotel budgets both at once.
  { group: "General", titles: ["Voyager", "Trainee / Apprentice", "Intern"] },
];

/** Flattened for the picker. The order matters: the editor renders a section
 *  header every time `group` changes, so a title emitted away from its own
 *  group would print that header twice. Group-contiguous by construction here,
 *  and pinned by standardTitleList.test.ts. */
const STANDARD_JOB_TITLE_OPTIONS = STANDARD_JOB_TITLE_GROUPS.flatMap(
  ({ group, titles }) => titles.map((value) => ({ value, label: value, group }))
);

const PAY_TYPE_OPTIONS = [
  { value: "SALARIED", label: "Salaried (30/360)" },
  { value: "HOURLY", label: "Hourly" },
];

/** Which basic-salary figure the user types; the other face is derived. */
const SALARY_ENTRY_OPTIONS = [
  { value: "ANNUAL", label: "Annual" },
  { value: "MONTHLY", label: "Monthly" },
];

/** What period the row's yearly figures are stated for — see fields.InputBasis.
 *  Full year keeps the ÷12 in the label because it is also the salary divisor,
 *  which is the form long-time users know this switch by. */
const INPUT_BASIS_OPTIONS = [
  { value: "TWELVE", label: "Full year (÷12)" },
  { value: "WORKING_MONTHS", label: "Working months" },
];

type SeedOverrides = Partial<FieldDef> & Pick<FieldDef, "key" | "defaultLabel">;

/** Fill the invariants every system field shares; sortOrder is assigned in a
 *  final pass from array position. */
function sys(
  section: SectionId,
  dataType: FieldDef["dataType"],
  storage: FieldDef["storage"],
  overrides: SeedOverrides
): FieldDef {
  return {
    section,
    dataType,
    storage,
    origin: "SYSTEM",
    locked: false,
    customLabel: null,
    visible: true,
    editable: storage !== "COMPUTED",
    maskable: false,
    sortOrder: 0,
    ...overrides,
  };
}

/** One field per month for an engine vector (sea_1..sea_12 etc). */
function monthFamily(
  section: SectionId,
  vector: VectorName,
  labelFor: (month: string) => string,
  base: Omit<Partial<FieldDef>, "key">
): FieldDef[] {
  return MONTH_LABELS.map((month, index) =>
    sys(section, "NUMBER", "ENGINE", {
      key: vectorKey(vector, index + 1),
      defaultLabel: labelFor(month),
      locked: true,
      vector,
      monthIndex: index + 1,
      ...base,
    })
  );
}

const SEED: FieldDef[] = [
  // ── Employee PII (the four identity columns) ──────────────────────
  sys("pii", "DATE", "PII_CORE", {
    key: "hiringDate",
    defaultLabel: "Hiring Date",
    locked: true,
    maskable: true,
  }),
  sys("pii", "TEXT", "PII_CORE", {
    key: "empNumber",
    defaultLabel: "Emp Number",
    locked: true,
    maskable: true,
  }),
  sys("pii", "TEXT", "PII_CORE", {
    key: "lastName",
    defaultLabel: "Last Name",
    locked: true,
    maskable: true,
  }),
  sys("pii", "TEXT", "PII_CORE", {
    key: "firstName",
    defaultLabel: "First Name",
    locked: true,
    maskable: true,
  }),
  // ── Control gutter ────────────────────────────────────────────────
  // Active is a switch for the whole row rather than a property of it, so it
  // sits in the frozen gutter beside the selection checkbox and the row menu,
  // not inside a data band. Unchecking retains the row across years (it still
  // rolls forward with a scenario copy) while removing it from the budget.
  sys("control", "BOOLEAN", "ENGINE", {
    key: "active",
    defaultLabel: "Active",
    locked: true,
    defaultValue: true,
  }),

  // ── Employee (the post, not the person) ───────────────────────────
  // The user picks a department by NAME (Dept Name is the dropdown); the code is
  // derived. departmentCode therefore holds no dropdown of its own — it is the
  // read-only mirror that `deptName`'s picker auto-fills (see columnFactory).
  sys("employee", "TEXT", "ENGINE", {
    key: "departmentCode",
    defaultLabel: "Department",
    locked: true,
  }),
  sys("employee", "TEXT", "POSITION_EXTRA", {
    key: "deptName",
    defaultLabel: "Dept Name",
    // Picking a name auto-fills `departmentCode` and renders it read-only.
    dropdownSource: { kind: "departments", codeField: "departmentCode" },
  }),
  sys("employee", "ENUM", "ENGINE", {
    key: "jobTypeCode",
    defaultLabel: "Classification",
    locked: true,
    dropdownSource: { kind: "static", options: JOB_TYPE_OPTIONS },
  }),
  // Job title describes the post, not the person — it bands with Employee and
  // is NOT masked. It keeps its `position_pii` column purely as storage.
  //
  // The pair (v22): this one is the LOCAL title — free text, exactly the wording
  // the hotel and the contract use — and `standardJobTitle` beside it is the
  // narrow one the post rolls up under. Constraining this column instead would
  // only push the real title into a note; letting it stay free is what makes the
  // standard column beside it something users will actually fill in.
  sys("employee", "TEXT", "PII_CORE", {
    key: "title",
    defaultLabel: "Job Title",
  }),
  // The group-wide title the local one maps to. A closed list (see
  // STANDARD_JOB_TITLE_OPTIONS) so "F&B Attendant", "F and B attendant" and
  // "Food & Bev. attendant" all report as one title. Independent of the local
  // column — no auto-fill either way, because a guess here would be wrong often
  // enough that users would stop trusting the column.
  sys("employee", "ENUM", "POSITION_EXTRA", {
    key: "standardJobTitle",
    defaultLabel: "Standard Title",
    dropdownSource: { kind: "static", options: STANDARD_JOB_TITLE_OPTIONS },
  }),
  // Pay basis and cluster describe the post's shape, not its contract mechanics,
  // so they band with Position. Pay basis (salaried 30/360 vs hourly real days)
  // still drives the engine's day-count.
  sys("employee", "ENUM", "ENGINE", {
    key: "payType",
    defaultLabel: "Pay Basis",
    locked: true,
    dropdownSource: { kind: "static", options: PAY_TYPE_OPTIONS },
    defaultValue: "SALARIED",
  }),
  // Hotel cluster this position is shared across (stores the cluster ID; the
  // picker shows names). The position's own hotel's weight in that cluster
  // flexes its costs/hours/FTE down — headcount never flexes. The resolved
  // cluster NAME doubles as the staffing-stats rollup key
  // (`cluster|jobTypeCode` in compile.ts).
  sys("employee", "TEXT", "ENGINE", {
    key: "cluster",
    defaultLabel: "Cluster",
    locked: true,
    dropdownSource: { kind: "hotelClusters" },
  }),
  // The effective share this hotel carries for the row: read-only display of
  // the assigned cluster's weight, manually editable ONLY while that cluster
  // has exactly one member hotel (grid isCellEditable gates it; rowModel
  // sanitize clears it when the assignment changes). NULL = cluster weight.
  sys("employee", "NUMBER", "ENGINE", {
    key: "clusterMultiplierOverride",
    defaultLabel: "Cluster Multiplier",
    locked: true,
    validation: { min: 0, max: 1 },
    // NULL = "use the cluster's weight". Without this, newDraftRow's numeric
    // fallback would seed 0 — an out-of-domain value the column must never
    // store (see ENGINE_EMPTY_OVERRIDES in positionsRepo).
    defaultValue: null,
  }),
  // "Count" is the engine's headcount multiplier under a name that reads for
  // budgeting: one row with Count = 5 is five identical positions, and every cost
  // the engine derives is scaled by it (posHeadcount in compile.ts). Same `key`
  // and `headcount` column as before — only the label and band moved — so nothing
  // on the engine or write path changes.
  sys("employee", "NUMBER", "ENGINE", {
    key: "headcount",
    defaultLabel: "Count",
    locked: true,
    validation: { min: 0 },
    defaultValue: 1,
  }),
  // The account the headcount books to — sits right beside Count so the number
  // and the account it posts under read as one pair (moved out of Basic Salary
  // in v13). Calculated from Classification since v26, not picked: the grade
  // fixes the account (HEADCOUNT_ACCOUNT_BY_JOB_TYPE), and the grades that book
  // none leave the cell empty, which posts no per-row headcount line.
  sys("employee", "ACCOUNT_CODE", "COMPUTED", {
    key: ACCOUNT_FIELD_KEYS.headcount,
    defaultLabel: "Headcount",
    locked: true,
  }),
  // The universal position-count head (VBA §21), surfaced as the account it
  // books to. Read-only and pinned: whatever the per-row Headcount account above
  // says, the engine books Count to A972540 as well, so heads can never go
  // unreported. This column exists purely so that account is traceable — it is
  // the answer to "where did A972540 in Results come from?". The defaultValue is
  // only the fallback: the cell derives per row, blank for Buyout Labour, whose
  // Count is bought-in labour and posts no headcount (see
  // systemAccounts.positionCountAccountForJobType).
  //
  // It replaced (v20) a "Position Count" NUMBER column, which restated Count and
  // so explained nothing about the head it stood for.
  sys("employee", "ACCOUNT_CODE", "COMPUTED", {
    key: HEADCOUNT_STATS_ACCOUNT_KEY,
    defaultLabel: "HC Stats",
    locked: true,
    defaultValue: POSITION_COUNT_ACCOUNT,
  }),

  // ── Contract ──────────────────────────────────────────────────────
  // Declared FIRST because it says how to read everything after it. A yearly
  // figure on a position is ambiguous on its own: 365 contract days, 25 vacation
  // days and a 45,000 salary can describe a full-time year that this post only
  // works six months of, or a six-month contract stated in its own terms. This
  // column is the row's answer, and the derived man-hours, FTE, vacation cost,
  // accrual, manual increase and Monthly Basic all read it (engineInput
  // .applyInputBasis). Stored per row, not as a global preference, so flipping it
  // never re-bases positions that were already set up.
  sys("contract", "ENUM", "POSITION_EXTRA", {
    key: INPUT_BASIS_KEY,
    defaultLabel: "Input Basis",
    locked: true,
    dropdownSource: { kind: "static", options: INPUT_BASIS_OPTIONS },
    // A full year is what the hotel-year defaults seed a new row with (365 days,
    // 104 off, 8 public holidays) and what every row written before this switch
    // was already treated as. Marking a post seasonal is then the ONLY thing the
    // user has to do for the common new-starter/mid-year-leaver case.
    defaultValue: "TWELVE",
  }),
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "contractYearlyDays",
    defaultLabel: "Yearly Days",
    validation: { min: 0, max: 366 },
  }),
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "contractDaysOff",
    defaultLabel: "Days Off",
    validation: { min: 0, max: 366 },
  }),
  sys("contract", "NUMBER", "POSITION_EXTRA", {
    key: "contractPubHolidays",
    defaultLabel: "Public Holidays",
    validation: { min: 0, max: 366 },
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "dailyContractHours",
    defaultLabel: "Daily Hours",
    locked: true,
    validation: { min: 0, max: 24 },
  }),
  // Manhours Paid is derived, not entered: paid days (yearly days − days off)
  // × daily contract hours. Read-only computed column (see rowModel COMPUTES).
  sys("contract", "NUMBER", "COMPUTED", {
    key: "yearlyManhoursPaid",
    defaultLabel: "Manhours Paid",
    locked: true,
    computeKey: "yearlyManhoursPaid",
  }),
  sys("contract", "NUMBER", "ENGINE", {
    key: "yearlyHoursWorked",
    defaultLabel: "Manhours Worked",
    locked: true,
    validation: { min: 0 },
  }),
  // The account worked hours book to — sits right beside Manhours Worked so the
  // hours and their posting account read as one pair (moved out of Basic Salary
  // in v13). POSITION_EXTRA, so relocating it only changes its band + order.
  sys("contract", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "workingHoursAccount",
    defaultLabel: "Working Hours",
    dropdownSource: { kind: "accounts", filter: HOURS_ACCOUNT_FILTER },
  }),
  // FTE is derived, not entered (v24): the row's own worked hours over what a
  // full-timer at this hotel works. See engineInput.deriveFte for the formula
  // and why vacation appears on both sides of it. The yardstick comes from the
  // hotel-year defaults, so this column has no row-only COMPUTES entry — the
  // grid reads it from ctx.fteById, like Vacation Cost.
  sys("contract", "NUMBER", "COMPUTED", {
    key: "fte",
    defaultLabel: "FTE",
    locked: true,
    validation: { min: 0, decimals: 2 },
    computeKey: "fte",
  }),
  // (v18) The prior-year NI/SS opening base is no longer a position field — it
  // moved to per-(position, scheme) storage owned by each SS block, edited as a
  // conditional "Opening base" column inside the scheme's block group.

  // ── Seasonality ───────────────────────────────────────────────────
  // The twelve Working month columns sit behind this one, collapsed by default:
  // most positions work the whole year, so twelve cells of "1" is width spent on
  // saying nothing. The summary answers the only question most rows raise ("how
  // many months does this post work?") and its chevron opens the twelve in place
  // for the seasonal ones (see COLLAPSIBLE_MONTH_FAMILIES / columnFactory).
  // Declared BEFORE the family so the summary keeps its slot when they're folded.
  sys("seasonality", "NUMBER", "COMPUTED", {
    key: "totalWorkingMonths",
    defaultLabel: "Total Months",
    locked: true,
    computeKey: "totalWorkingMonths",
  }),
  ...monthFamily("seasonality", "seasonality", (m) => `Working ${m}`, {
    validation: { min: 0, max: 1, decimals: 2 },
    defaultValue: 1,
  }),

  // ── Basic Salary ──────────────────────────────────────────────────
  // Pay Basis picks the outer pair: a fixed basic salary, or an Hourly Rate that
  // drives the base from hours worked. Only one holds a value per row; the grid
  // locks the other (see rowModel.sanitizeRow + PositionsGrid.isCellEditable).
  //
  // Within the salaried side, Salary Entry picks the inner pair: contracts are
  // written per year, so Annual Basic is what most users hold, and Monthly Basic
  // is derived from it (÷ the row's Input Basis months — a flat 12, or its
  // working months). Typing Monthly reverses the derivation. Whichever face is
  // derived is locked, but BOTH are stored — the engine only ever reads
  // monthlyBaseSalary, so this is a grid + storage concern that leaves the
  // spread math untouched.
  sys("basicSalary", "ENUM", "POSITION_EXTRA", {
    key: SALARY_ENTRY_MODE_KEY,
    defaultLabel: "Salary Entry",
    locked: true,
    dropdownSource: { kind: "static", options: SALARY_ENTRY_OPTIONS },
    // New rows favour the contract figure. Rows written before this field
    // existed carry no value and read as MONTHLY, preserving their behaviour
    // exactly (see rowModel.hydrateBasicSalary).
    defaultValue: "ANNUAL",
  }),
  sys("basicSalary", "NUMBER", "POSITION_EXTRA", {
    key: BASIC_SALARY_ANNUAL_KEY,
    defaultLabel: "Annual Basic",
    locked: true,
    validation: { min: 0 },
  }),
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "monthlyBaseSalary",
    defaultLabel: "Monthly Basic",
    locked: true,
    validation: { min: 0 },
  }),
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "hourlyRate",
    defaultLabel: "Hourly Rate",
    locked: true,
    validation: { min: 0 },
  }),
  // The twelve Additional Cost columns sit behind this one, collapsed by
  // default: they are a wide, rarely-used family, and the summary answers the
  // only question most users have of them ("is there anything in there?").
  // Read-only Σ of the family — the chevron on its header expands the months in
  // place (see COLLAPSIBLE_MONTH_FAMILIES / columnFactory). Declared BEFORE the
  // family so the summary keeps its slot when the twelve are folded away.
  sys("basicSalary", "NUMBER", "COMPUTED", {
    key: "additionalCostsTotal",
    defaultLabel: "Additional Costs",
    locked: true,
    computeKey: "additionalCostsTotal",
  }),
  ...monthFamily(
    "basicSalary",
    "additionalMonthlyCosts",
    (m) => `Additional Cost ${m}`,
    {}
  ),
  sys("basicSalary", "NUMBER", "COMPUTED", {
    key: "fullYearWage",
    defaultLabel: "Full Year Wage",
    locked: true,
    computeKey: "fullYearWage",
  }),
  sys("basicSalary", "PERCENT", "ENGINE", {
    key: "meritIncreasePct",
    defaultLabel: "Merit Increase",
    locked: true,
    validation: { min: 0, max: 10, decimals: 4 },
  }),
  sys("basicSalary", "NUMBER", "ENGINE", {
    key: "manualYearlyIncrease",
    defaultLabel: "Manual Increase",
    locked: true,
  }),
  sys("basicSalary", "ENUM", "ENGINE", {
    key: "increaseMonth",
    defaultLabel: "Increase Month",
    locked: true,
    dropdownSource: { kind: "months" },
    defaultValue: 13,
  }),
  // Working Hours / Headcount accounts moved to sit beside their data columns
  // (Contract / Position) in v13; the FTE account was dropped. Salary is the one
  // account that belongs with the basic-salary figure, so it stays here.
  sys("basicSalary", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "salaryAccountCode",
    defaultLabel: "Salary",
    dropdownSource: { kind: "accounts", filter: SALARY_ACCOUNT_FILTER },
    defaultValue: DEFAULT_SALARY_ACCOUNT,
  }),
  sys("basicSalary", "NUMBER", "COMPUTED", {
    key: "budgetYearBasicSalary",
    defaultLabel: "Budget Year Total",
    locked: true,
    computeKey: "budgetYearBasicSalary",
  }),

  // ── Vacation ──────────────────────────────────────────────────────
  sys("vacation", "NUMBER", "ENGINE", {
    key: "vacationDays",
    defaultLabel: "Yearly Days",
    locked: true,
    validation: { min: 0, max: 366 },
  }),
  // Auto-calculated, not entered: the monthly entitlement is Yearly Days ÷ the
  // position's WORKING months (the engine earns the provision only in months it
  // works, so a seasonal row accrues faster than a twelfth a month). Read-only
  // COMPUTED, so it always shows the accrued amount; whether the accrual is
  // actually booked is gated separately by the Accrual account below.
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "accrualDaysPerMonth",
    defaultLabel: "Accrual Days",
    locked: true,
    computeKey: "accrualDaysPerMonth",
  }),
  // No defaultValue, unlike the two accounts around it (v28): blank here means
  // "do not book the accrual at all", so filling it in would start every new row
  // generating a liability nobody asked for.
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "accrualAccount",
    defaultLabel: "Accrual",
    dropdownSource: { kind: "accounts", filter: VACATION_ACCOUNT_FILTER },
  }),
  // NUMBER, not PERCENT: these are relative WEIGHTS, not shares of 100. The
  // engine normalizes them by their own total (reference.vacationDaysTaken), so
  // twelve 1s, twelve 8.33s and twelve 0.0833s all mean the same even year —
  // only the ratios between the months matter.
  //
  // They were PERCENT, and that skin caused a real bug. It scaled ×100, parsed
  // anything > 1 as a whole percent (so a typed "2" silently became 0.02),
  // clamped at max 1, and paired with a "must total 100%" cue. Users hand-nudged
  // months to 8.36/8.40 to make the column add up, and the holiday accrual — which
  // reads zero only when the twelve are exactly EQUAL — showed the resulting
  // inequality as permanent monthly noise. An even year is 1/12 = 8.3333…%, which
  // two decimals cannot express, so the percent framing could not represent the
  // most common case. Weights can: type 1 twelve times.
  ...monthFamily(
    "vacation",
    "vacationMonthlyWeights",
    (m) => `Vacation Weight ${m}`,
    { dataType: "NUMBER", validation: { min: 0, decimals: 4 } }
  ),
  // Informational only — there is no target to hit, so nothing reddens.
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "vacationWeightsTotal",
    defaultLabel: "Total Weight",
    locked: true,
    computeKey: "vacationWeightsTotal",
  }),
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "benefitsAccountCode",
    defaultLabel: "Benefits",
    dropdownSource: { kind: "accounts", filter: VACATION_ACCOUNT_FILTER },
    defaultValue: DEFAULT_BENEFITS_ACCOUNT,
  }),
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "vacationEstimate",
    defaultLabel: "Vacation Cost",
    locked: true,
    computeKey: "vacationEstimate",
  }),
];

/** Display order = array order. */
export const SYSTEM_FIELD_SEED: FieldDef[] = SEED.map((field, index) => ({
  ...field,
  sortOrder: (index + 1) * 10,
}));

export const BUILTIN_CATALOG: FieldCatalog = {
  sections: SECTIONS,
  fields: SYSTEM_FIELD_SEED,
};
