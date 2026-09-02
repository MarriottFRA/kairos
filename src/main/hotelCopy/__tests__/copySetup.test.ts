/**
 * Copy-hotel-setup tests — the cluster "set it up once" flow against a real
 * in-memory store holding BOTH hotels, which is exactly the hazard: source and
 * target rows live in one file, so a copy that reused an id or forgot a WHERE
 * would corrupt the hotel it copied FROM. Covers: the full-section copy with
 * fresh ids, every reference remap (block bases, rate-rule outcomes, scheme
 * membership, KPI drivers, sys-head accounts), display order, the additive
 * calendar rule, source integrity, and each guard.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { ALLOCATIONS_SQL } from "../../allocations/schema";
import { BLOCK_CONFIGS_SQL, applyStructureColumns } from "../../blocks/schema";
import { CALENDAR_TABLES_SQL, applyBankHolidayV4 } from "../../calendar/schema";
import { KPI_DRIVERS_SQL } from "../../kpiDrivers/schema";
import {
  POSITIONS_STRUCTURE_TABLES_SQL,
  applySsSchemeBaseColumns,
} from "../../positions/schema";
import { resolveOuScope } from "../../positions/ouScope";
import { ensureFieldCatalogSeed } from "../../positions/structureRepo";
import { ensureSystemDefs, listBlocks, saveBlock } from "../../blocks/repo";
import {
  BlockDto,
  BlockInput,
  baseSalaryDefId,
  blockCostDefId,
  blockStatDefId,
} from "../../../shared/blocks/ipc";
import { copyHotelSetup, listLocalSetupSources } from "../copySetup";

type Db = InstanceType<typeof Database>;

const SRC = resolveOuScope("OU11111");
const TGT = resolveOuScope("OU22222");
const NOW = { now: "2026-02-03T04:05:06.000Z" };

/** `position_defaults` is declared inline in `local_db.ts` — copied verbatim,
 *  the structure.test.ts pattern. */
const POSITION_DEFAULTS_SQL = `
  CREATE TABLE IF NOT EXISTS position_defaults (
      ou           TEXT NOT NULL,
      year         INTEGER NOT NULL,
      weekly_hours REAL NOT NULL DEFAULT 40,
      fields_json  TEXT NOT NULL,
      updated_at   TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (ou, year)
  );
`;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(CALENDAR_TABLES_SQL);
  applyBankHolidayV4(db);
  db.exec(POSITIONS_STRUCTURE_TABLES_SQL);
  db.exec(POSITION_DEFAULTS_SQL);
  db.exec(KPI_DRIVERS_SQL);
  db.exec(BLOCK_CONFIGS_SQL);
  applyStructureColumns(db);
  applySsSchemeBaseColumns(db);
  db.exec(ALLOCATIONS_SQL);
});

/** The source hotel: one of everything, with every kind of cross-reference. */
function seedSourceHotel(): { bonusId: string } {
  ensureFieldCatalogSeed(db, SRC);
  // A hotel-configured posting account on a system head must travel.
  ensureSystemDefs(db, SRC, NOW);
  db.prepare(
    `UPDATE cost_component_definitions SET account_code = '500100' WHERE id = ? AND ou = ?`
  ).run(baseSalaryDefId(SRC.ou), SRC.ou);
  db.prepare(
    `INSERT INTO field_catalog (ou, field_key, section, data_type, storage, origin, default_label, sort_order, updated_at)
     VALUES (?, 'u_grade', 'extra', 'TEXT', 'POSITION_EXTRA', 'USER', 'Grade', 500, ?)`
  ).run(SRC.ou, NOW.now);

  db.prepare(
    `INSERT INTO ss_schemes (id, ou, label, accumulation_mode, tax_year_start_month,
                             include_base_salary, include_vacation, base_component_ids, updated_at)
     VALUES ('scheme-src', ?, 'UK NI', 'CUMULATIVE', 4, 1, 1, '[]', ?)`
  ).run(SRC.ou, NOW.now);
  db.prepare(
    `INSERT INTO ss_brackets (scheme_id, bracket_index, up_to, rate)
     VALUES ('scheme-src', 0, 1048, 0), ('scheme-src', 1, NULL, 0.138)`
  ).run();

  db.prepare(
    `INSERT INTO kpi_drivers (id, ou, label, dept_mode, bucket_index, aggregation, multiplier, sort_order, updated_at)
     VALUES ('driver-src', ?, 'Rooms sold', 'EXPLICIT', 1, 'SUM', 1, 0, ?)`
  ).run(SRC.ou, NOW.now);
  db.prepare(
    `INSERT INTO kpi_driver_dept_patterns (driver_id, pattern) VALUES ('driver-src', '*')`
  ).run();
  db.prepare(
    `INSERT INTO kpi_driver_accounts (driver_id, starts_with) VALUES ('driver-src', 'A3')`
  ).run();

  db.prepare(
    `INSERT INTO allocations (id, ou, name, spread_base, excluded_departments, inject_account, sort_order, updated_at)
     VALUES ('alloc-src', ?, 'Admin split', 'HEADCOUNT', '["D099"]', '988100', 0, ?)`
  ).run(SRC.ou, NOW.now);

  db.prepare(
    `INSERT INTO calendar_years (ou, year, weekend_mask) VALUES (?, 2026, 96)`
  ).run(SRC.ou);
  for (let month = 1; month <= 12; month += 1) {
    db.prepare(
      `INSERT INTO calendar_months (ou, year, month, calendar_days, public_holidays, weekend_days)
       VALUES (?, 2026, ?, 30, 1, 8)`
    ).run(SRC.ou, month);
  }
  db.prepare(
    `INSERT INTO position_defaults (ou, year, weekly_hours, fields_json)
     VALUES (?, 2026, 42, '{}')`
  ).run(SRC.ou);

  const bonusId = saveBlock(
    db,
    SRC,
    {
      blockType: "MULTIPLIER",
      label: "Bonus",
      accountCode: "510200",
      accountLocked: true,
      base: { kind: "BASE_SALARY" },
    },
    NOW
  );
  saveBlock(
    db,
    SRC,
    {
      blockType: "MULTIPLIER",
      label: "Pension",
      accountCode: "510300",
      accountLocked: true,
      base: { kind: "BLOCK", blockId: bonusId },
    },
    NOW
  );
  saveBlock(
    db,
    SRC,
    {
      blockType: "MULTIPLIER",
      label: "Incentive",
      accountCode: "510400",
      accountLocked: true,
      base: { kind: "KPI", kpiDriverId: "driver-src" },
    },
    NOW
  );
  saveBlock(
    db,
    SRC,
    {
      blockType: "SOCIAL_SECURITY",
      label: "NI",
      accountCode: "560100",
      accountLocked: true,
      ssSchemeId: "scheme-src",
    },
    NOW
  );
  saveBlock(
    db,
    SRC,
    {
      blockType: "COUNT_RATE",
      label: "Meals",
      accountCode: "512000",
      accountLocked: true,
      statsAccountCode: "988200",
      spread: "DAYS",
    },
    NOW
  );
  saveBlock(
    db,
    SRC,
    {
      blockType: "MULTIPLIER",
      label: "Tips",
      accountCode: "510500",
      accountLocked: true,
      base: { kind: "BASE_SALARY" },
      rateRules: {
        rules: [
          {
            when: [
              {
                source: { kind: "FIELD", fieldKey: "departmentCode", dataType: "TEXT" },
                op: "EQ",
                value: "D001",
              },
            ],
            rate: 0,
            rateBlockId: bonusId,
          },
        ],
        otherwise: 0.05,
      },
    },
    NOW
  );
  // Scheme membership names a block's cost def — the deferred-remap case.
  db.prepare(
    `UPDATE ss_schemes SET base_component_ids = ? WHERE id = 'scheme-src'`
  ).run(JSON.stringify([blockCostDefId(bonusId)]));

  return { bonusId };
}

function targetBlock(label: string): BlockDto {
  const block = listBlocks(db, TGT).find((entry) => entry.label === label);
  expect(block, `target block "${label}"`).toBeTruthy();
  return block as BlockDto;
}

describe("copyHotelSetup", () => {
  it("copies every section with fresh ids and every reference remapped", () => {
    const { bonusId } = seedSourceHotel();

    const counts = copyHotelSetup(db, TGT, SRC, NOW);
    expect(counts).toEqual({
      blocks: 6,
      ssSchemes: 1,
      kpiDrivers: 1,
      allocations: 1,
      customFields: 1,
      calendarYears: 1,
    });

    // Blocks arrive under new ids, in the source's display order.
    const copied = listBlocks(db, TGT);
    expect(copied.map((block) => block.label)).toEqual([
      "Bonus",
      "Pension",
      "Incentive",
      "NI",
      "Meals",
      "Tips",
    ]);
    const sourceIds = new Set(listBlocks(db, SRC).map((block) => block.id));
    for (const block of copied) expect(sourceIds.has(block.id)).toBe(false);

    // Block → block base.
    const bonus = targetBlock("Bonus");
    const pension = targetBlock("Pension");
    expect(pension.base).toEqual({ kind: "BLOCK", blockId: bonus.id });

    // Block → KPI driver base, onto the driver's copy (children included).
    const driver = db
      .prepare(`SELECT id FROM kpi_drivers WHERE ou = ? AND deleted_at IS NULL`)
      .get(TGT.ou) as { id: string };
    expect(driver.id).not.toBe("driver-src");
    expect(targetBlock("Incentive").base).toEqual({
      kind: "KPI",
      kpiDriverId: driver.id,
    });
    expect(
      db.prepare(`SELECT pattern FROM kpi_driver_dept_patterns WHERE driver_id = ?`).all(driver.id)
    ).toEqual([{ pattern: "*" }]);
    expect(
      db.prepare(`SELECT starts_with FROM kpi_driver_accounts WHERE driver_id = ?`).all(driver.id)
    ).toEqual([{ starts_with: "A3" }]);

    // SS block → scheme copy; the scheme's base membership → Bonus's new def.
    const scheme = db
      .prepare(
        `SELECT id, base_component_ids FROM ss_schemes WHERE ou = ? AND deleted_at IS NULL`
      )
      .get(TGT.ou) as { id: string; base_component_ids: string };
    expect(scheme.id).not.toBe("scheme-src");
    expect(targetBlock("NI").ssSchemeId).toBe(scheme.id);
    expect(JSON.parse(scheme.base_component_ids)).toEqual([blockCostDefId(bonus.id)]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ss_brackets WHERE scheme_id = ?`).get(scheme.id)
    ).toEqual({ n: 2 });

    // Rate-rule outcome → the copied block.
    expect(targetBlock("Tips").rateRules?.rules[0]?.rateBlockId).toBe(bonus.id);

    // Dual-output block keeps both defs, derived from its NEW id.
    const meals = targetBlock("Meals");
    expect(meals.costDefId).toBe(blockCostDefId(meals.id));
    expect(meals.statDefId).toBe(blockStatDefId(meals.id));

    // The configured sys-head posting account travels to the target's head.
    const sysBase = db
      .prepare(`SELECT account_code FROM cost_component_definitions WHERE id = ? AND ou = ?`)
      .get(baseSalaryDefId(TGT.ou), TGT.ou) as { account_code: string };
    expect(sysBase.account_code).toBe("500100");

    // Plain sections: allocation, custom column, calendar, defaults.
    const allocation = db
      .prepare(`SELECT id, name, inject_account FROM allocations WHERE ou = ?`)
      .get(TGT.ou) as { id: string; name: string; inject_account: string };
    expect(allocation.id).not.toBe("alloc-src");
    expect(allocation.name).toBe("Admin split");
    expect(allocation.inject_account).toBe("988100");
    expect(
      db.prepare(`SELECT default_label FROM field_catalog WHERE ou = ? AND field_key = 'u_grade'`).get(TGT.ou)
    ).toEqual({ default_label: "Grade" });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM calendar_months WHERE ou = ? AND year = 2026`).get(TGT.ou)
    ).toEqual({ n: 12 });
    expect(
      db.prepare(`SELECT weekly_hours FROM position_defaults WHERE ou = ? AND year = 2026`).get(TGT.ou)
    ).toEqual({ weekly_hours: 42 });

    // The source hotel is untouched.
    expect(listBlocks(db, SRC)).toHaveLength(6);
    expect(listBlocks(db, SRC).some((block) => block.id === bonusId)).toBe(true);
    const srcScheme = db
      .prepare(`SELECT ou, base_component_ids FROM ss_schemes WHERE id = 'scheme-src'`)
      .get() as { ou: string; base_component_ids: string };
    expect(srcScheme.ou).toBe(SRC.ou);
    expect(JSON.parse(srcScheme.base_component_ids)).toEqual([blockCostDefId(bonusId)]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM kpi_drivers WHERE ou = ?`).get(SRC.ou)
    ).toEqual({ n: 1 });
  });

  it("keeps a calendar year the target had already set up", () => {
    seedSourceHotel();
    db.prepare(
      `INSERT INTO calendar_years (ou, year, weekend_mask) VALUES (?, 2026, 3)`
    ).run(TGT.ou);

    const counts = copyHotelSetup(db, TGT, SRC, NOW);
    expect(counts.calendarYears).toBe(0);
    expect(
      db.prepare(`SELECT weekend_mask FROM calendar_years WHERE ou = ? AND year = 2026`).get(TGT.ou)
    ).toEqual({ weekend_mask: 3 });
  });

  it("refuses a target that already has blocks", () => {
    seedSourceHotel();
    saveBlock(
      db,
      TGT,
      {
        blockType: "FLAT_MONTHLY",
        label: "Uniforms",
        accountCode: "511000",
        accountLocked: true,
      } as BlockInput,
      NOW
    );
    expect(() => copyHotelSetup(db, TGT, SRC, NOW)).toThrow(/already has blocks/);
    // Nothing else landed either — the guard fires before any write.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM kpi_drivers WHERE ou = ?`).get(TGT.ou)
    ).toEqual({ n: 0 });
  });

  it("refuses a source with nothing to copy, and the same hotel", () => {
    expect(() => copyHotelSetup(db, TGT, SRC, NOW)).toThrow(/no blocks to copy/);
    expect(() => copyHotelSetup(db, TGT, TGT, NOW)).toThrow(/different hotel/);
  });

  it("lists only OTHER hotels with live blocks as sources", () => {
    seedSourceHotel();
    expect(listLocalSetupSources(db, TGT)).toEqual([
      { ou: SRC.ou, blockCount: 6 },
    ]);
    // From the source's own point of view there is nothing to copy.
    expect(listLocalSetupSources(db, SRC)).toEqual([]);
  });
});
