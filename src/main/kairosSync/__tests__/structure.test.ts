/**
 * The hotel-setup document, against a real store.
 * -----------------------------------------------------------
 * `structureDoc.test.ts` covers the merge rule with hand-built rows. This covers
 * the thing those tests structurally cannot: what happens when the document goes
 * out through `pushStructure`'s canonicaliser, comes back the way the server
 * stores it, and is compared against a copy freshly assembled from SQLite.
 *
 * That round trip is where the Sync page's "N changes to download / N not
 * published" came from on a hotel nobody had touched. `buildStructureDoc` reads
 * rows in field-declaration order; `canonicalize` sorts them. A whole-row
 * `JSON.stringify` comparison of the two is never equal, so every seeded column
 * and every system component definition reported as changed — in both
 * directions, permanently, because applying the download rebuilt the local
 * document in declaration order again.
 *
 * The assertion is therefore the boring one: a machine in sync with the hotel
 * has NOTHING to download and NOTHING to publish.
 */

import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { canonicalize } from "../../../shared/kairosSync/canonical";
import { StructureDoc, mergeStructureDoc } from "../../../shared/kairosSync/structureDoc";
import { SEED_VERSION } from "../../../shared/positions/fieldSeed";
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
import { applyStructureDoc, buildStructureDoc } from "../structure";

type Db = InstanceType<typeof Database>;

const SCOPE = resolveOuScope("OU25RJ2");
const OU = SCOPE.ou;

/**
 * `position_defaults` is declared inline in `local_db.ts` rather than in a
 * feature schema module, so it has no constant to import. Copied verbatim —
 * `positionDefaultsToDoc` reads it, and its `CURRENT_TIMESTAMP` default is one
 * of the two timestamp formats this test exists to prove is harmless.
 */
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

/**
 * The document as the hotel gets it back.
 *
 * `pushStructure` canonicalises before sending and the server re-serialises with
 * `json.dumps(sort_keys=True)`, so what a colleague downloads has its keys
 * sorted at every level and its numbers normalised. Reproduced exactly, because
 * this is the shape the local copy is compared against.
 */
function asPublished(doc: StructureDoc): StructureDoc {
  return JSON.parse(JSON.stringify(canonicalize(doc))) as StructureDoc;
}

/** A hotel with the setup any install has after somebody opens Positions. */
function seedHotel(): void {
  ensureFieldCatalogSeed(db, SCOPE);
  db.prepare(
    `INSERT INTO calendar_years (ou, year, weekend_mask) VALUES (?, 2026, 96)`
  ).run(OU);
  for (let month = 1; month <= 12; month += 1) {
    db.prepare(
      `INSERT INTO calendar_months (ou, year, month, calendar_days, public_holidays, weekend_days)
       VALUES (?, 2026, ?, 30, 1, 8)`
    ).run(OU, month);
  }
  db.prepare(
    `INSERT INTO position_defaults (ou, year, weekly_hours, fields_json)
     VALUES (?, 2026, 40, '{}')`
  ).run(OU);
  db.prepare(
    `INSERT INTO block_configs (id, ou, block_type, label, config, sort_order, updated_at)
     VALUES ('b1', ?, 'MULTIPLIER', 'Merit increase', '{"rate":0.035,"month":4}', 10, ?)`
  ).run(OU, "2026-01-02T03:04:05.000Z");
}

describe("structure document round trip", () => {
  it("has nothing to download and nothing to publish when the two agree", () => {
    // THE regression. Every row here is byte-identical in meaning to the
    // server's, and every one of them used to be reported as changed.
    seedHotel();
    const local = buildStructureDoc(db, OU);
    const published = asPublished(local);

    expect(mergeStructureDoc(local, published).changes).toEqual([]);
    expect(mergeStructureDoc(published, local).changes).toEqual([]);
  });

  it("still has nothing to download after the download is applied", () => {
    // The symptom the user saw: pressing Download appeared to do nothing,
    // because applying the rows rebuilt the local document in declaration order
    // and the diff came straight back.
    seedHotel();
    const published = asPublished(buildStructureDoc(db, OU));

    const { doc: merged } = mergeStructureDoc(buildStructureDoc(db, OU), published);
    applyStructureDoc(db, merged);

    expect(mergeStructureDoc(buildStructureDoc(db, OU), published).changes).toEqual([]);
  });

  it("ignores a colleague's clock", () => {
    // Two machines seed the same catalog at different moments. Nothing about
    // the hotel's configuration differs.
    seedHotel();
    const local = buildStructureDoc(db, OU);
    const theirs = asPublished(local);
    for (const row of theirs.fieldCatalog ?? []) {
      row.updatedAt = "2020-01-01T00:00:00.000Z";
    }

    expect(mergeStructureDoc(local, theirs).changes).toEqual([]);
  });

  it("does not adopt a colleague's seed version", () => {
    // `seed_version` says which release of fieldSeed.ts last refreshed the row.
    // Taking a colleague's number would tell a client on an older build it is
    // already up to date, and `ensureFieldCatalogSeed` would skip a refresh it
    // owes.
    seedHotel();
    const theirs = asPublished(buildStructureDoc(db, OU));
    for (const row of theirs.fieldCatalog ?? []) row.seedVersion = 1;

    applyStructureDoc(db, theirs);

    const stored = db
      .prepare(`SELECT DISTINCT seed_version FROM field_catalog WHERE ou = ?`)
      .all(OU) as Array<{ seed_version: number }>;
    expect(stored).toEqual([{ seed_version: SEED_VERSION }]);
  });

  it("reports a real change, and applies it", () => {
    seedHotel();
    const theirs = asPublished(buildStructureDoc(db, OU));
    const renamed = (theirs.fieldCatalog ?? []).find(
      (row) => row.fieldKey === "deptName"
    );
    expect(renamed).toBeDefined();
    if (renamed) renamed.customLabel = "Cost centre";

    const { doc: merged, changes } = mergeStructureDoc(buildStructureDoc(db, OU), theirs);
    expect(changes).toEqual([
      expect.objectContaining({
        section: "fieldCatalog",
        kind: "updated",
        fields: [{ field: "customLabel", base: "—", incoming: "Cost centre" }],
      }),
    ]);

    applyStructureDoc(db, merged);
    const stored = db
      .prepare(`SELECT custom_label FROM field_catalog WHERE ou = ? AND field_key = 'deptName'`)
      .get(OU) as { custom_label: string | null };
    expect(stored.custom_label).toBe("Cost centre");
    // And now the two agree again — which is what "Download" is supposed to
    // leave behind.
    expect(mergeStructureDoc(buildStructureDoc(db, OU), theirs).changes).toEqual([]);
  });
});
