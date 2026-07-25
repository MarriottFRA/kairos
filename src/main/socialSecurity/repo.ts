/**
 * Social Security / NI scheme repository (plaintext structure store).
 *
 * The engine already reads schemes (structureRepo.getSsSchemes) and runs them
 * (compile/execute); this is the missing WRITE half. Schemes are OU-scoped, so
 * — unlike hotel clusters — every function takes an OuScope. The Database
 * handle is passed explicitly (vitest runs these against in-memory databases).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { uuidv7 } from "../../shared/engine/ids";
import {
  SsSchemeInput,
  validateSsSchemeInput,
} from "../../shared/socialSecurity/ipc";
import { OuScope } from "../positions/ouScope";
import { prepared } from "../positions/stmtCache";

type Db = InstanceType<typeof Database>;

/**
 * Create or update a scheme for the OU. One transaction: upsert the parent
 * (ss_schemes), rewrite the bracket set (ss_brackets).
 *
 * INVARIANT: every save stamps ss_schemes.updated_at — the engine-output
 * staleness fingerprint probes ss_schemes (outputsRepo.computeFingerprint), so
 * an unstamped edit would leave the Results page stale-blind. Validated first
 * (validateSsSchemeInput), matching the engine compiler's validateScheme so a
 * persisted scheme can never fail compile.
 */
export function saveScheme(
  db: Db,
  scope: OuScope,
  input: SsSchemeInput,
  opts: { now: string }
): string {
  validateSsSchemeInput(input);

  const existing = input.id
    ? (prepared(
        db,
        `SELECT id FROM ss_schemes
          WHERE id = ? AND ou = ? AND deleted_at IS NULL`
      ).get(input.id, scope.ou) as { id: string } | undefined)
    : undefined;
  if (input.id && !existing) {
    throw new Error("This scheme no longer exists.");
  }

  const id = existing?.id ?? uuidv7();
  const label = input.label.trim();

  const accumulationMode = input.accumulationMode === "PER_PERIOD" ? "PER_PERIOD" : "CUMULATIVE";
  const taxYearStartMonth = input.taxYearStartMonth ?? 1;
  const includeBaseSalary = (input.includeBaseSalary ?? true) ? 1 : 0;
  const includeVacation = (input.includeVacation ?? true) ? 1 : 0;
  const baseComponentIds = JSON.stringify(input.baseComponentIds ?? []);

  db.transaction(() => {
    prepared(
      db,
      `INSERT INTO ss_schemes
         (id, ou, label, monthly_cap, yearly_cap,
          accumulation_mode, tax_year_start_month,
          include_base_salary, include_vacation, base_component_ids,
          updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         monthly_cap = excluded.monthly_cap,
         yearly_cap = excluded.yearly_cap,
         accumulation_mode = excluded.accumulation_mode,
         tax_year_start_month = excluded.tax_year_start_month,
         include_base_salary = excluded.include_base_salary,
         include_vacation = excluded.include_vacation,
         base_component_ids = excluded.base_component_ids,
         updated_at = excluded.updated_at,
         deleted_at = NULL`
    ).run(
      id,
      scope.ou,
      label,
      input.monthlyCap,
      input.yearlyCap,
      accumulationMode,
      taxYearStartMonth,
      includeBaseSalary,
      includeVacation,
      baseComponentIds,
      opts.now
    );

    prepared(db, `DELETE FROM ss_brackets WHERE scheme_id = ?`).run(id);
    input.brackets.forEach((bracket, index) => {
      prepared(
        db,
        `INSERT INTO ss_brackets (scheme_id, bracket_index, up_to, rate)
         VALUES (?, ?, ?, ?)`
      ).run(id, index, bracket.upTo, bracket.rate);
    });
  })();

  return id;
}

/**
 * Soft-delete a scheme. Brackets are kept (ON DELETE CASCADE only fires on a
 * hard purge; a future restore needs them). The caller guards against deleting
 * a scheme a SOCIAL_SECURITY definition still references (Phase 2b).
 */
export function deleteScheme(
  db: Db,
  scope: OuScope,
  id: string,
  opts: { now: string }
): void {
  const result = prepared(
    db,
    `UPDATE ss_schemes SET updated_at = ?, deleted_at = ?
      WHERE id = ? AND ou = ? AND deleted_at IS NULL`
  ).run(opts.now, opts.now, id, scope.ou);
  if (result.changes === 0) {
    throw new Error("This scheme no longer exists.");
  }
}
