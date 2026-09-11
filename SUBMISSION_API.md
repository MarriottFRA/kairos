# Budget submission API — contract for the backend

Kairos submits a hotel's **staffing** budget data to head office from the
Reports rail ("Submit data"). This document is what the backend has to
implement. The client side is built (`src/main/submission/`, `src/shared/submission/`);
nothing here is negotiable on the client without a schema-version bump.

Decisions this reflects (2026-09-11):

- One submission per **OU + slot + year**. Sending again **replaces** it.
- Slots are free tags. Today only `BUD`. Forecasts will arrive later as their
  own tags (`F2026_09`), never as a period column.
- Staffing only: positions with their inputs and calculated heads / FTE /
  hours, manual input rows, buyout rows. **No money by department × account**
  (the ledger pipeline owns financials), no blocks, no allocations.
- **No PII.** Names, employee numbers and hiring dates never leave the hotel.
  The position *title* (the post, not the person) is included.
- No publish gate, no owner gate. Anyone who can open the plan can submit it.
- `submitted_by` comes from the **bearer token**, never from the body.

## Endpoints

Both sit under the existing Kairos surface and use the same bearer auth,
gzip handling and error envelope as `/kairos/plans/*` and `/kairos/ou/{ou}/*`.

### `PUT /kairos/ou/{ou}/submissions/{slot}/{year}`

Stores the submission, replacing any earlier one for the same `(ou, slot, year)`.

- `ou` — hotel OU as Kairos sends it, e.g. `OU12345` (canonical, upper-case, branded).
- `slot` — the tag, e.g. `BUD`.
- `year` — the budget year, e.g. `2027`.
- Headers: `Authorization: Bearer …`, `Content-Type: application/json`,
  `Content-Encoding: gzip` when the body exceeded 1 KiB (it always will),
  `Idempotency-Key: <submission_id>` — a retry of the *same* build carries the
  same key and must not count as a second replacement.
- Body: the payload below. The path values **must** equal the header row's
  `ou`, `slot` and `year`; reject with 400 if they differ.
- Response `200`:

```json
{
  "submissionId": "…",           // the body's submission_id
  "ou": "OU12345",
  "slot": "BUD",
  "year": 2027,
  "receivedAt": "2026-09-11T10:00:00Z",   // server clock
  "submittedBy": "someone@company.com",   // from the token
  "counts": { "positions": 412, "manualRows": 18, "buyoutRows": 3 },
  "replaced": true                        // an earlier (ou, slot, year) existed
}
```

- Errors: `400` malformed / path–body mismatch / row width ≠ column count /
  unknown `schema_version`; `403` the caller has no access to the OU;
  `413` over the size limit (the existing 8 MiB wire / 32 MiB decompressed
  ceilings are ample: ~400 positions × ~120 columns is well under 1 MiB
  uncompressed).

### `GET /kairos/ou/{ou}/submissions`

What the hotel has submitted, one entry per `(slot, year)` — the *current*
submission only, newest first.

```json
{
  "submissions": [
    {
      "submissionId": "…",
      "slot": "BUD",
      "year": 2027,
      "submittedAt": "2026-09-11T10:00:00Z",
      "submittedBy": "someone@company.com",
      "scenarioId": "…",
      "scenarioLabel": "Planning",
      "appVersion": "1.0.34",
      "schemaVersion": 1,
      "counts": { "positions": 412, "manualRows": 18, "buyoutRows": 3 }
    }
  ]
}
```

An empty list is `{ "submissions": [] }`, not 404.

## Payload

Dense tables: each is `{ "columns": [...], "rows": [[...], ...] }`, rows in
column order, so a loader never interprets keys. **Column names are the
Postgres column names.** Cells are JSON `string | number | boolean | null`.

```json
{
  "schemaVersion": 1,
  "submission": { "columns": [...], "rows": [[ one row ]] },
  "positions":  { "columns": [...], "rows": [...] },
  "manualRows": { "columns": [...], "rows": [...] },
  "buyoutRows": { "columns": [...], "rows": [...] }
}
```

Monthly figures are wide: `<prefix>_01` … `<prefix>_12` (Jan..Dec) with
`<prefix>_year` beside them. The authoritative column lists live in
`src/shared/submission/schema.ts`; the tables below describe them.

### Suggested storage

Four tables keyed by `submission_id`, with a unique constraint on
`(ou, slot, year)` for the header. On a PUT: delete the previous
submission's rows for that `(ou, slot, year)` (or mark it superseded and
keep history — the client does not care, only that the GET returns the
current one) and insert the new one in a transaction. Treat every column
below as nullable except the keys.

### `submission` (1 row)

| column | type | meaning |
|---|---|---|
| submission_id | uuid | client-minted per build; also the idempotency key |
| schema_version | int | 1 |
| ou | text | hotel OU (`OU12345`) |
| hotel_name | text | best effort from the client; the OU stands in when unknown |
| year | int | budget year |
| slot | text | `BUD` |
| scenario_id | uuid | the Kairos plan submitted (same id as the cloud plan) |
| scenario_label | text | e.g. `Planning` |
| app_version | text | Kairos version |
| submitted_at | timestamptz | client clock when built |
| engine_computed_at | timestamptz | when the plan's results were calculated (the build recalculates first, so this is fresh) |
| contract_week | numeric | the hotel-year full-time week (hours), e.g. 40 |
| effective_week | numeric | the derived effective week: full-time hours a year ÷ 52 |
| effective_week_posted | numeric | what the run posted to D0410 / A988112; equals `effective_week` on a fresh run |
| productive_days | numeric | full-timer's yearly days − days off − public holidays |
| daily_hours | numeric | contract_week ÷ 5 |
| average_vacation_days | numeric | FTE-weighted mean vacation of the hours-driven positions |
| full_time_days | numeric | productive_days − average_vacation_days |
| full_time_hours_year | numeric | full_time_days × daily_hours — the hours of one FTE for the year |
| weighted_fte | numeric | the FTE the vacation average was weighted over |
| calendar_weekend_mask | int | weekday bitmask (bit 0 = Sun … bit 6 = Sat) |
| working_days_01 … working_days_12, working_days_year | numeric | calendar days − public holidays − weekend days, per month |
| public_holidays_year | numeric | Σ public holidays in the hotel calendar |
| position_count, manual_row_count, buyout_row_count | int | row counts of the three tables, for a completeness check |

### `positions` (one row per ACTIVE position)

Identity and grouping:

| column | type | meaning |
|---|---|---|
| position_id | uuid | the position's id in this plan |
| lineage_id | uuid | stable across years (a year clone keeps it) |
| cluster_link_id | uuid | the same person mirrored into every member hotel of a cluster; **dedupe on it** across hotels |
| cluster_name | text | hotel-cluster name, null when none |
| cluster_weight | numeric | this hotel's share of the position (1 = wholly its own) |
| department_code | text | `D0410` form |
| department_name | text | as typed on the row, else the mapping tables' name |
| title | text | the post's title |
| standard_job_title | text | the closed-list standard title, when picked |
| classification | text | grade: `Manager`, `Manager (Non Exempt)`, `Supervisor`, `Associate`, `Casual`, `Buyout Labour` |
| pay_type | text | `HOURLY` or `SALARIED` |
| headcount | numeric | the grid's Count |
| fte | numeric | the grid's derived FTE for **one** head (contract vs the hotel-year yardstick); can exceed 1 |

Contract, as entered:

| column | type | meaning |
|---|---|---|
| contract_yearly_days | numeric | |
| contract_days_off | numeric | |
| contract_pub_holidays | numeric | |
| daily_contract_hours | numeric | |
| yearly_hours_worked | numeric | net of vacation, restated for the input basis — the engine's HOURS input |
| yearly_manhours_paid | numeric | (yearly days − days off) × daily hours, restated for the input basis |
| vacation_days | numeric | entitlement as stated on the row |
| accrual_days_per_month | numeric | vacation ÷ working months |
| total_working_months | numeric | Σ of the twelve working fractions |
| working_01 … working_12 | numeric | fractional activity per month, 0..1 (the seasonality) |
| vacation_weight_01 … vacation_weight_12 | numeric | relative weights of when leave is taken |

Pay, as entered:

| column | type | meaning |
|---|---|---|
| salary_entry_mode | text | how the salary was typed (annual / monthly), null when default |
| annual_divisor_basis | text | `TWELVE` or `WORKING_MONTHS` — what period the yearly figures on the row are stated over |
| annual_base_salary | numeric | the Annual Basic as typed, when the row was entered annually |
| monthly_base_salary | numeric | the engine's salary input (0 for hourly) |
| hourly_rate | numeric | 0 for salaried |
| merit_increase_pct | numeric | 0.05 = 5% |
| manual_yearly_increase | numeric | |
| increase_month | int | 1..12; 13 = none |
| salary_account, working_hours_account, benefits_account, accrual_account | text | GL / stat accounts on the row |

Calculated by the run (read exactly as the Staffing statistics report reads them):

| column | type | meaning |
|---|---|---|
| calc_heads_01 … calc_heads_12, calc_heads_year | numeric | heads that month (a LEVEL); the year is December's |
| calc_fte_01 … calc_fte_12, calc_fte_year | numeric | manager heads + FTE-driving hours ÷ one full-timer's hours; the year is the annual figure |
| calc_hours_total_01 … _12, calc_hours_total_year | numeric | every hours account the position posts to |
| calc_hours_fte_01 … _12, calc_hours_fte_year | numeric | only the FTE-driving hours (excl. overtime, manager and buyout hours) |

`calc_fte_year` for hours-driven staff is `calc_hours_fte_year ÷ full_time_hours_year`
(header). Managers count as FTE by head. It will not equal `headcount × fte`
exactly — that difference is the FTE reconciliation head office wants to see.

### `manual_rows` (one row per Manual Input grid line)

| column | type | meaning |
|---|---|---|
| row_id | uuid | |
| description | text | |
| department_code, department_name | text | |
| cost_account | text | the dollar side, null when the row has none |
| stats_account | text | the statistical side, null when none |
| rate | numeric | null when amounts are typed |
| rate_driven | bool | amounts = rate × stats |
| stats_kpi_driver_id | text | null when stats are typed |
| stats_kpi_divisor, stats_kpi_factor | numeric | "factor per divisor of KPI" |
| stats_kpi_driven | bool | |
| spread_mode | text | `flat`, `daysInMonth`, or null |
| spread_base_stats, spread_base_amount | numeric | |
| increase_pct | numeric | 0.05 = 5% |
| increase_month | int | 13 = none |
| sort_order | int | |
| stats_01 … stats_12, stats_year | numeric | effective operational units (derived when KPI-driven) |
| amount_01 … amount_12, amount_year | numeric | effective amounts (derived when rate-driven) — the same figures the run posts |

### `buyout_rows` (one row per buyout line)

| column | type | meaning |
|---|---|---|
| row_id | uuid | |
| department_code, department_name | text | |
| account | text | |
| amount_01 … amount_12, amount_year | numeric | |

## Validation the server should do

1. `schemaVersion` is one it knows (1).
2. Every table: `rows[i].length === columns.length`.
3. Every table's `columns` equals the known list for that schema version,
   in order (the client builds from the same constants).
4. Path `ou`/`slot`/`year` equal the header row's.
5. `position_count` / `manual_row_count` / `buyout_row_count` equal the row counts.

## What the client does before sending

- Recalculates the plan when its results are missing or out of date, so the
  calculated columns are the inputs' own.
- Refuses slots and years that are not open (`BUD`, `2027` today) — enforce
  the same list server-side so a future client cannot slip a tag through early.
- Refuses a plan whose year differs from the requested year.
