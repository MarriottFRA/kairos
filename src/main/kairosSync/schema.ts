/**
 * Sync bookkeeping DDL.
 * -----------------------------------------------------------
 * Two tables, both in the ENCRYPTED store, holding what the server last told us
 * rather than any plan data of their own.
 *
 * Why encrypted, when a hash is not the data: a content hash here is twelve
 * base64url characters over a payload whose shape is public (it is in
 * `entityMap.ts`) and whose contents include an employee's name, number and
 * hiring date. Anyone holding the plaintext file could confirm a guessed name
 * by hashing it. That is a weaker disclosure than the record itself, and it is
 * still a disclosure, so the shadow lives where the records live. Sync only ever
 * runs signed in, which is exactly when the secure store is unlocked, so this
 * costs nothing operationally.
 *
 * Neither table is authoritative about anything. The feature tables keep their
 * `updated_at`/`deleted_at` and remain the source of truth; the shadow is a
 * cache of the server's opinion and can be rebuilt at any time from
 * `GET /plans/{id}/manifest`. That is the recovery path when a rebuild, an
 * import or a cluster propagation writes behind the dirty tracker's back.
 *
 * Electron-free so the tests can execute it against an in-memory database, the
 * same shape as every other `src/main/<feature>/schema.ts`.
 */

export const KAIROS_SYNC_TABLES_SQL = `
  -- What the server last confirmed it holds, per entity. Supplies baseHash on a
  -- commit and the client side of POST /manifest/diff.
  --
  -- Rows are kept for tombstones too (deleted = 1): dropping them would make the
  -- next manifest report every deleted row as serverOnly, and the client would
  -- re-pull tombstones it has already applied on every single sync.
  CREATE TABLE IF NOT EXISTS kairos_sync_shadow (
      plan_id     TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      -- The 12-char base64url content hash the server currently stores.
      hash        TEXT NOT NULL,
      server_seq  INTEGER NOT NULL DEFAULT 0,
      deleted     INTEGER NOT NULL DEFAULT 0,
      synced_at   TEXT NOT NULL,
      PRIMARY KEY (plan_id, entity_type, entity_id)
  );
  -- Ordered exactly like the /changes keyset, so the watermark comparisons in
  -- reconcile.ts are an index walk rather than a scan of the whole plan.
  CREATE INDEX IF NOT EXISTS idx_kairos_shadow_seq
      ON kairos_sync_shadow (plan_id, server_seq);

  -- One row per plan we have ever talked to the server about. Absent = never
  -- published, which is a meaningful state: it is what makes ?bootstrap=1 safe.
  CREATE TABLE IF NOT EXISTS kairos_sync_state (
      -- == scenarios.id. Plan and scenario are 1:1 and share an id, which is
      -- what makes a retried first publish idempotent for free.
      plan_id            TEXT PRIMARY KEY,
      ou                 TEXT NOT NULL,
      -- toVersion of the last COMPLETE pull. Never advanced mid-pagination:
      -- recording a watermark that covers rows we did not receive loses them
      -- permanently, because no future delta will ever mention them again.
      watermark          INTEGER NOT NULL DEFAULT 0,
      -- Moves when a support lease is handed back. A change means discard and
      -- re-pull from zero; the server's copy wins outright.
      sync_epoch         INTEGER NOT NULL DEFAULT 0,
      -- PII is a separate stream (GET /plans/{id}/pii), so it has its own
      -- watermark. Sharing one with /changes would skip rows on either side.
      pii_watermark      INTEGER NOT NULL DEFAULT 0,
      structure_version  INTEGER NOT NULL DEFAULT 0,
      -- The last authorization answer, cached so the UI can render before the
      -- first round trip. Advisory only: the server re-resolves on every request
      -- and a 403 always wins over anything stored here.
      relation           TEXT,
      scope_kind         TEXT,
      scope_departments  TEXT,
      structure_editable INTEGER NOT NULL DEFAULT 0,
      -- Superseded by kairos_ou_state.heads_etag: the heads answer is about a
      -- whole property, not about a plan. Retained so an older build downgrading
      -- onto this file still finds its column.
      heads_etag         TEXT,
      -- ETag + the body it validates. Note these also invalidate when GRANTS
      -- change, not only when data does: the server folds the caller's
      -- authorization digest into them, so a revoked delegation cannot be served
      -- from a cache for a scope no longer held. A 200 where a 304 was expected
      -- is normal.
      ownership_etag     TEXT,
      ownership_json     TEXT,
      last_published_at  TEXT,
      last_pulled_at     TEXT,
      -- kairos_delegation_revoked context, kept so the banner and its Export
      -- button survive a restart. Local data is NEVER wiped on a revoke.
      revoked_json       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_kairos_sync_state_ou
      ON kairos_sync_state (ou);

  -- The last GET /sync/heads answer for a property, ETag AND body.
  --
  -- Caching the body is not an optimisation, it is a correctness requirement.
  -- A 304 carries no plan list, so a client that stored only the ETag has, from
  -- the second sync onwards, no idea which plans exist on the server, what
  -- version they are at, or what the caller's relation to them is. Everything
  -- downstream then reads "not published": the page offers to register a plan
  -- that is already registered, and a publish sends baseVersion 0 against a live
  -- plan, which conflicts on every row.
  --
  -- Per-OU because that is what the answer is about. The ETag used to be copied
  -- onto every plan's state row and read back with LIMIT 1, which worked but
  -- left no home for the body and no row at all for a property with no plans.
  CREATE TABLE IF NOT EXISTS kairos_ou_state (
      ou          TEXT PRIMARY KEY,
      heads_etag  TEXT,
      -- The verbatim SyncHeads body last received with a 200. Replayed whenever
      -- the server answers 304.
      heads_json  TEXT,
      fetched_at  TEXT
  );
`;
