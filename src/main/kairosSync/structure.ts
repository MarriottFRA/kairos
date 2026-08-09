/**
 * `GET|PUT /ou/{ou}/structure` — the property's shared configuration.
 * -----------------------------------------------------------
 * Reads the OU-scoped tables out of the plaintext store, assembles them into one
 * document, and writes a pulled one back the same way. This is where the field
 * catalog, blocks, component definitions, SS schemes, allocations, KPI drivers,
 * the budget calendar and the safe defaults for new positions live on the wire.
 *
 * They travel as a document rather than as per-plan entities because that is
 * what they are: `(ou, …)`-keyed rows shared by every scenario at the property.
 * See `shared/kairosSync/structureDoc.ts` for the merge rule and why it must be
 * additive.
 *
 * ## Two hazards worth stating
 *
 * **The hash must agree with Python's.** Unlike entity hashes, which the server
 * stores on trust, `docHash` is RE-COMPUTED server-side with
 * `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)` and a
 * mismatch is a 422. Our canonicaliser clamps exponent-range floats for exactly
 * this reason — JS writes `1e-7` where Python writes `1e-07`. The document is
 * built, canonicalised ONCE, and both the hash and the request body come from
 * that same canonical form; hashing one shape and sending another is how this
 * goes wrong.
 *
 * **`404` is not an error.** It means the property has published no
 * configuration yet, and the right response is to keep the local copy — the same
 * contract `src/main/mappingTables/sync.ts` already follows.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { prepared } from "../positions/stmtCache";
import { KairosApiError, KAIROS_ERRORS, KairosClient } from "./client";
import { documentHash } from "./hash";
import { canonicalize } from "../../shared/kairosSync/canonical";
import { StructureDocument } from "../../shared/kairosSync/protocol";
import {
  STRUCTURE_DOC_VERSION,
  StructureChange,
  StructureDoc,
  allocationFromDoc,
  allocationToDoc,
  blockConfigFromDoc,
  blockConfigToDoc,
  calendarFromDoc,
  calendarToDoc,
  componentDefFromDoc,
  componentDefToDoc,
  emptyStructureDoc,
  fieldCatalogFromDoc,
  fieldCatalogToDoc,
  kpiDriverFromDoc,
  kpiDriverToDoc,
  mergeStructureDoc,
  positionDefaultsFromDoc,
  positionDefaultsToDoc,
  ssSchemeFromDoc,
  ssSchemeToDoc,
} from "../../shared/kairosSync/structureDoc";
import { Row } from "../../shared/kairosSync/entityMap";

type Db = InstanceType<typeof Database>;

function all(db: Db, sql: string, ...args: unknown[]): Row[] {
  return prepared(db, sql).all(...(args as never[])) as Row[];
}

/** Group child rows by the parent id they hang off. */
function groupBy(rows: Row[], key: string): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const id = String(row[key] ?? "");
    const bucket = map.get(id);
    if (bucket) bucket.push(row);
    else map.set(id, [row]);
  }
  return map;
}

/**
 * Assemble the property's structure document from the plaintext store.
 *
 * Soft-deleted rows are INCLUDED, carrying their `deletedAt`. That is what makes
 * a removal travel at all: under an additive merge, a row that is simply absent
 * is kept by the recipient, so a deletion has to be an explicit tombstone or it
 * never propagates.
 */
export function buildStructureDoc(db: Db, ou: string): StructureDoc {
  const baseRefs = groupBy(
    all(
      db,
      `SELECT r.* FROM component_base_refs r
         JOIN cost_component_definitions d ON d.id = r.component_def_id
        WHERE d.ou = ?`,
      ou
    ),
    "component_def_id"
  );
  const brackets = groupBy(
    all(
      db,
      `SELECT b.* FROM ss_brackets b
         JOIN ss_schemes s ON s.id = b.scheme_id
        WHERE s.ou = ?`,
      ou
    ),
    "scheme_id"
  );
  const patterns = groupBy(
    all(
      db,
      `SELECT p.* FROM kpi_driver_dept_patterns p
         JOIN kpi_drivers k ON k.id = p.driver_id
        WHERE k.ou = ?`,
      ou
    ),
    "driver_id"
  );
  const accounts = groupBy(
    all(
      db,
      `SELECT a.* FROM kpi_driver_accounts a
         JOIN kpi_drivers k ON k.id = a.driver_id
        WHERE k.ou = ?`,
      ou
    ),
    "driver_id"
  );
  const months = groupBy(
    all(db, `SELECT * FROM calendar_months WHERE ou = ? ORDER BY year, month`, ou),
    "year"
  );

  return {
    docVersion: STRUCTURE_DOC_VERSION,
    ou,
    fieldCatalog: all(
      db,
      `SELECT * FROM field_catalog WHERE ou = ? ORDER BY field_key`,
      ou
    ).map(fieldCatalogToDoc),
    blockConfigs: all(
      db,
      `SELECT * FROM block_configs WHERE ou = ? ORDER BY id`,
      ou
    ).map(blockConfigToDoc),
    componentDefs: all(
      db,
      `SELECT * FROM cost_component_definitions WHERE ou = ? ORDER BY id`,
      ou
    ).map((row) => componentDefToDoc(row, baseRefs.get(String(row.id)) ?? [])),
    ssSchemes: all(db, `SELECT * FROM ss_schemes WHERE ou = ? ORDER BY id`, ou).map(
      (row) => ssSchemeToDoc(row, brackets.get(String(row.id)) ?? [])
    ),
    allocations: all(db, `SELECT * FROM allocations WHERE ou = ? ORDER BY id`, ou).map(
      allocationToDoc
    ),
    kpiDrivers: all(db, `SELECT * FROM kpi_drivers WHERE ou = ? ORDER BY id`, ou).map(
      (row) =>
        kpiDriverToDoc(
          row,
          patterns.get(String(row.id)) ?? [],
          accounts.get(String(row.id)) ?? []
        )
    ),
    calendars: all(db, `SELECT * FROM calendar_years WHERE ou = ? ORDER BY year`, ou).map(
      (row) => calendarToDoc(row, months.get(String(row.year)) ?? [])
    ),
    positionDefaults: all(
      db,
      `SELECT * FROM position_defaults WHERE ou = ? ORDER BY year`,
      ou
    ).map(positionDefaultsToDoc),
  };
}

/**
 * Write a merged document back into the plaintext store.
 *
 * Child tables are replaced wholesale for the parents present in the document —
 * a base-ref list or a bracket ladder has no identity of its own, so "delete the
 * old set, insert the new one" is the only coherent update. Parents NOT in the
 * document are untouched, which is the additive rule.
 *
 * One transaction: a half-applied field catalog renders a grid with columns
 * whose definitions disagree with the values stored under them.
 */
export function applyStructureDoc(db: Db, doc: StructureDoc): void {
  const upsert = (table: string, keys: string[], row: Row): void => {
    const columns = Object.keys(row);
    const assignments = columns
      .filter((column) => !keys.includes(column))
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    prepared(
      db,
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(${keys.join(", ")}) DO UPDATE SET ${assignments}`
    ).run(...(columns.map((column) => row[column]) as never[]));
  };

  db.transaction(() => {
    for (const row of doc.fieldCatalog ?? []) {
      upsert("field_catalog", ["ou", "field_key"], fieldCatalogFromDoc(row));
    }
    for (const row of doc.blockConfigs ?? []) {
      upsert("block_configs", ["id"], blockConfigFromDoc(row));
    }
    for (const row of doc.componentDefs ?? []) {
      const { def, baseRefs } = componentDefFromDoc(row);
      upsert("cost_component_definitions", ["id"], def);
      prepared(db, `DELETE FROM component_base_refs WHERE component_def_id = ?`).run(
        def.id as string
      );
      for (const ref of baseRefs) {
        upsert("component_base_refs", ["component_def_id", "referenced_def_id"], ref);
      }
    }
    for (const row of doc.ssSchemes ?? []) {
      const { scheme, brackets } = ssSchemeFromDoc(row);
      upsert("ss_schemes", ["id"], scheme);
      prepared(db, `DELETE FROM ss_brackets WHERE scheme_id = ?`).run(scheme.id as string);
      for (const bracket of brackets) {
        upsert("ss_brackets", ["scheme_id", "bracket_index"], bracket);
      }
    }
    for (const row of doc.allocations ?? []) {
      upsert("allocations", ["id"], allocationFromDoc(row));
    }
    for (const row of doc.kpiDrivers ?? []) {
      const { driver, patterns, accounts } = kpiDriverFromDoc(row);
      upsert("kpi_drivers", ["id"], driver);
      prepared(db, `DELETE FROM kpi_driver_dept_patterns WHERE driver_id = ?`).run(
        driver.id as string
      );
      prepared(db, `DELETE FROM kpi_driver_accounts WHERE driver_id = ?`).run(
        driver.id as string
      );
      for (const pattern of patterns) {
        prepared(
          db,
          `INSERT INTO kpi_driver_dept_patterns (driver_id, pattern) VALUES (?, ?)`
        ).run(pattern.driver_id as string, pattern.pattern as string);
      }
      for (const account of accounts) {
        prepared(
          db,
          `INSERT INTO kpi_driver_accounts (driver_id, starts_with) VALUES (?, ?)`
        ).run(account.driver_id as string, account.starts_with as string);
      }
    }
    for (const row of doc.calendars ?? []) {
      const { year, months } = calendarFromDoc(row);
      upsert("calendar_years", ["ou", "year"], year);
      for (const month of months) {
        upsert("calendar_months", ["ou", "year", "month"], month);
      }
    }
    for (const row of doc.positionDefaults ?? []) {
      upsert("position_defaults", ["ou", "year"], positionDefaultsFromDoc(row));
    }
  })();
}

export interface StructurePullResult {
  /** null when the property has published nothing — keep the local copy. */
  document: StructureDocument | null;
  /**
   * Whether the property has EVER published its setup.
   *
   * Its own flag rather than `document === null`, which is also what a 304 says.
   * The two need telling apart: a hotel that has published nothing has an empty
   * diff because there is nothing to compare against, and calling that "matches
   * the server" — as the card did — is untrue in the one direction that matters.
   */
  published: boolean;
  /** What DOWNLOADING would change here. */
  changes: StructureChange[];
  /**
   * What PUBLISHING would change for everybody else at this hotel.
   *
   * The mirror image, and it has to be computed separately: `changes` merges the
   * server into the local copy, and the answer to "what would my publish do to
   * theirs" is the same merge run the other way round. Both documents are in
   * hand at this point, so it costs one more pure call and no request.
   *
   * This is what makes the blast radius visible before the button is pressed —
   * `pushStructure` sends the WHOLE local document, not just what was touched
   * since the last publish, and the merge server-side is additive.
   */
  outgoing: StructureChange[];
  merged: StructureDoc | null;
  applied: boolean;
}

/**
 * Fetch the property's document and work out what applying it would change.
 *
 * `apply` defaults to false so the Sync page can show the diff first — the same
 * review-then-apply discipline the entity pull uses, and more important here: a
 * structure change reshapes the grid for everyone at the hotel.
 */
export async function pullStructure(
  db: Db,
  client: KairosClient,
  ou: string,
  options: { apply?: boolean; etag?: string | null } = {}
): Promise<StructurePullResult & { etag: string | null; notModified: boolean }> {
  let response;
  try {
    response = await client.getConditional<StructureDocument>(
      `/ou/${encodeURIComponent(ou)}/structure`,
      options.etag ?? null
    );
  } catch (error) {
    if (error instanceof KairosApiError && error.is(KAIROS_ERRORS.STRUCTURE_NOT_FOUND)) {
      // Nothing published yet. Not a failure — the hotel simply has not
      // uploaded its configuration, and its local copy stands.
      return {
        document: null,
        published: false,
        changes: [],
        // Nothing published yet, so publishing sends the local document whole.
        // The card says that in words rather than listing every row.
        outgoing: [],
        merged: null,
        applied: false,
        etag: null,
        notModified: false,
      };
    }
    throw error;
  }

  if (response.status === 304) {
    return {
      document: null,
      // A 304 is only ever an answer to "has it changed", which the server can
      // only give about something it holds.
      published: true,
      changes: [],
      outgoing: [],
      merged: null,
      applied: false,
      etag: response.etag,
      notModified: true,
    };
  }

  const incoming = response.body.doc as unknown as StructureDoc;
  const local = buildStructureDoc(db, ou);
  const { doc, changes } = mergeStructureDoc(local, incoming);
  // The same merge the other way round: what this machine's copy would do to
  // the hotel's. Never applied — only reported.
  const { changes: outgoing } = mergeStructureDoc(incoming, local);

  if (options.apply) applyStructureDoc(db, doc);

  return {
    document: response.body,
    published: true,
    changes,
    outgoing,
    merged: doc,
    applied: options.apply === true,
    etag: response.etag,
    notModified: false,
  };
}

/**
 * Publish the property's structure.
 *
 * `If-Match` carries the version we believe we are editing; a 412 means somebody
 * else changed the hotel's columns while this screen was open, and the answer is
 * to reload and reapply rather than overwrite them.
 *
 * Owner-eligible callers only — a delegate calling this gets a 403, which is why
 * the Sync page hides the action when `structureEditableByMe` is false rather
 * than letting the user discover it at save time.
 */
export async function pushStructure(
  db: Db,
  client: KairosClient,
  ou: string,
  currentVersion: number | null
): Promise<StructureDocument> {
  const built = buildStructureDoc(db, ou);
  // Canonicalise once and use the SAME object for both the hash and the body.
  // Hashing one shape and sending another is the whole failure mode here.
  const canonical = canonicalize(built) as unknown as Record<string, unknown>;

  return client.put<StructureDocument>(
    `/ou/${encodeURIComponent(ou)}/structure`,
    { doc: canonical, docHash: documentHash(canonical) },
    { ifMatch: currentVersion === null ? null : String(currentVersion) }
  );
}

/** The local document, for the "nothing published yet" case. */
export function localStructure(db: Db, ou: string): StructureDoc {
  const doc = buildStructureDoc(db, ou);
  return doc.fieldCatalog?.length ? doc : emptyStructureDoc(ou);
}
