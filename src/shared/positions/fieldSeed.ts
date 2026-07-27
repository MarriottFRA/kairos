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
  ANNUAL_DIVISOR_KEY,
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
import { POSITION_COUNT_ACCOUNT, STATS_ACCOUNT_FILTER } from "./systemAccounts";

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
export const SEED_VERSION = 24;

/** base_account prefixes each account field books to — a first, broad pass the
 *  user will narrow later. The stats side is the shared STATS_ACCOUNT_FILTER, so
 *  the accounts these pickers offer and the accounts Results counts as
 *  statistics are by construction the same set. The A5 cost prefixes are a
 *  picker-scoped narrowing only — a cost is any non-stats account. */
const HEADCOUNT_ACCOUNT_FILTER = STATS_ACCOUNT_FILTER;
const HOURS_ACCOUNT_FILTER = STATS_ACCOUNT_FILTER;
const SALARY_ACCOUNT_FILTER = { startsWith: ["A5"] };
const VACATION_ACCOUNT_FILTER = { startsWith: ["A5"] };

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
 * Static for now, like Classification. When titles need to differ per group or
 * be edited without a release they become a reference table (the departments /
 * accounts pattern) and this constant is the seed for it — the field key and its
 * stored values are unaffected by that move, since the column stores the title
 * string itself.
 */
const STANDARD_JOB_TITLE_OPTIONS = [
  // Executive / admin
  "General Manager",
  "Hotel Manager",
  "Executive Assistant",
  "Director of Operations",
  "Director of Finance",
  "Assistant Director of Finance",
  "Financial Analyst",
  "Accountant",
  "Accounts Payable Clerk",
  "Accounts Receivable Clerk",
  "Income Auditor",
  "Paymaster",
  "General Cashier",
  "Purchasing Manager",
  "Receiving Clerk",
  "Storekeeper",
  "IT Manager",
  "Director of Human Resources",
  "Human Resources Manager",
  "Human Resources Coordinator",
  "Training Manager",
  // Rooms — front office
  "Director of Rooms",
  "Front Office Manager",
  "Assistant Front Office Manager",
  "Front Desk Supervisor",
  "Front Desk Agent",
  "Guest Relations Manager",
  "Guest Relations Agent",
  "Concierge",
  "Night Auditor",
  "Reservations Manager",
  "Reservations Agent",
  "Bell Attendant",
  "Doorperson",
  "Driver",
  // Rooms — housekeeping
  "Executive Housekeeper",
  "Assistant Executive Housekeeper",
  "Housekeeping Supervisor",
  "Room Attendant",
  "Public Area Attendant",
  "Houseperson",
  "Laundry Attendant",
  "Linen Attendant",
  "Tailor",
  // Food & beverage
  "Director of Food & Beverage",
  "Food & Beverage Manager",
  "Restaurant Manager",
  "Assistant Restaurant Manager",
  "Restaurant Supervisor",
  "Host / Hostess",
  "Waiter / Waitress",
  "Busser",
  "Bar Manager",
  "Bartender",
  "Banquet Manager",
  "Banquet Supervisor",
  "Banquet Server",
  "Room Service Attendant",
  // Kitchen
  "Executive Chef",
  "Executive Sous Chef",
  "Sous Chef",
  "Chef de Partie",
  "Demi Chef de Partie",
  "Commis Chef",
  "Pastry Chef",
  "Butcher",
  "Baker",
  "Kitchen Steward",
  "Chief Steward",
  // Sales, marketing & events
  "Director of Sales & Marketing",
  "Director of Sales",
  "Sales Manager",
  "Sales Executive",
  "Director of Revenue Management",
  "Revenue Manager",
  "Marketing Manager",
  "Events Manager",
  "Events Executive",
  // Engineering & security
  "Director of Engineering",
  "Chief Engineer",
  "Assistant Chief Engineer",
  "Engineering Supervisor",
  "Technician",
  "Electrician",
  "Plumber",
  "Painter",
  "Carpenter",
  "Gardener",
  "Director of Security",
  "Security Manager",
  "Security Supervisor",
  "Security Officer",
  // Spa, recreation & wellness
  "Spa Manager",
  "Spa Therapist",
  "Spa Attendant",
  "Fitness Instructor",
  "Lifeguard",
  "Recreation Attendant",
].map((value) => ({ value, label: value }));

const PAY_TYPE_OPTIONS = [
  { value: "SALARIED", label: "Salaried (30/360)" },
  { value: "HOURLY", label: "Hourly" },
];

/** Which basic-salary figure the user types; the other face is derived. */
const SALARY_ENTRY_OPTIONS = [
  { value: "ANNUAL", label: "Annual" },
  { value: "MONTHLY", label: "Monthly" },
];

/** What Annual Basic is divided by to reach the monthly base. */
const ANNUAL_DIVISOR_OPTIONS = [
  { value: "WORKING_MONTHS", label: "÷ Working months" },
  { value: "TWELVE", label: "÷ 12" },
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
  // in v13). POSITION_EXTRA, so relocating it only changes its band + order.
  sys("employee", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "headCountAccount",
    defaultLabel: "Headcount",
    dropdownSource: { kind: "accounts", filter: HEADCOUNT_ACCOUNT_FILTER },
  }),
  // The universal position-count head (VBA §21), surfaced as the account it
  // books to. Read-only and pinned: whatever the per-row Headcount account above
  // says, the engine ALWAYS books Count to A972540 as well, so heads can never go
  // unreported. This column exists purely so that account is traceable — it is
  // the answer to "where did A972540 in Results come from?".
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
  // is derived from it (÷ the row's working months). Typing Monthly reverses the
  // derivation. Whichever face is derived is locked, but BOTH are stored — the
  // engine only ever reads monthlyBaseSalary, so this is a grid + storage
  // concern that leaves the spread math untouched.
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
  // The Annual → Monthly divisor, per row. Working months is the default: a
  // nine-month contract states nine months' pay, so spreading it over twelve
  // would understate every month. A flat 12 is there for shops that quote a
  // full-year rate regardless — rare enough to ship hidden, reachable from
  // Manage Columns. Stored per row (not as a global preference) so flipping it
  // never re-bases positions that were already set up.
  sys("basicSalary", "ENUM", "POSITION_EXTRA", {
    key: ANNUAL_DIVISOR_KEY,
    defaultLabel: "Annual Basis",
    locked: true,
    dropdownSource: { kind: "static", options: ANNUAL_DIVISOR_OPTIONS },
    defaultValue: "WORKING_MONTHS",
    visible: false,
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
  // Auto-calculated, not entered: the monthly entitlement is Yearly Days ÷ 12.
  // Read-only COMPUTED, so it always shows the accrued amount; whether the
  // accrual is actually booked is gated separately by the Accrual account below.
  sys("vacation", "NUMBER", "COMPUTED", {
    key: "accrualDaysPerMonth",
    defaultLabel: "Accrual Days",
    locked: true,
    computeKey: "accrualDaysPerMonth",
  }),
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "accrualAccount",
    defaultLabel: "Accrual",
    dropdownSource: { kind: "accounts", filter: VACATION_ACCOUNT_FILTER },
  }),
  // PERCENT, not NUMBER: the twelve are shares of the year, so they read as
  // "8.33%" and total "100%" rather than "0.0833" summing to "1.00". Storage is
  // unchanged — still the 0..1 fraction the engine normalizes — because PERCENT
  // is purely a display/parse skin (columnFactory), so nothing downstream moves.
  ...monthFamily(
    "vacation",
    "vacationMonthlyWeights",
    (m) => `Vacation % ${m}`,
    { dataType: "PERCENT", validation: { min: 0, max: 1, decimals: 4 } }
  ),
  sys("vacation", "PERCENT", "COMPUTED", {
    key: "vacationWeightsTotal",
    defaultLabel: "Total Weights",
    locked: true,
    computeKey: "vacationWeightsTotal",
  }),
  sys("vacation", "ACCOUNT_CODE", "POSITION_EXTRA", {
    key: "benefitsAccountCode",
    defaultLabel: "Benefits",
    dropdownSource: { kind: "accounts", filter: VACATION_ACCOUNT_FILTER },
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
