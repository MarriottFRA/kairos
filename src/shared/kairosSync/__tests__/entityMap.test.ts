/**
 * Row ⇄ entity round trips.
 *
 * The single most important property in the sync feature:
 *
 *     toPayload(fromPayload(p)) is value-identical to p
 *
 * If it fails for any type, the hash of a row read back after a pull differs
 * from the hash of the row that was published — so every sync reports the row as
 * dirty, republishes it, and the two clients ping-pong forever.
 *
 * Also pins the two id conventions the server enforces, because getting either
 * wrong produces a manifest that can never converge.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../canonical";
import {
  ENTITY_SPECS,
  PUBLISHED_ENTITY_TYPES,
  PublishedEntityType,
  Row,
  componentValueId,
  normalizeDepartment,
  splitComponentValueId,
  toEntity,
} from "../entityMap";

/** A representative row per type, with every column populated. */
const SAMPLES: Record<PublishedEntityType, Row> = {
  scenario: {
    id: "018f-scenario",
    ou: "OU25RJ2",
    year: 2026,
    label: "Budget",
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
  },
  position: {
    id: "018f-position",
    ou: "OU25RJ2",
    scenario_id: "018f-scenario",
    lineage_id: "lin-1",
    active: 1,
    department_code: "D0410",
    job_type_code: "JT9",
    cluster: "cl-1",
    cluster_multiplier_override: 0.5,
    cluster_link_id: "link-1",
    pay_type: "HOURLY",
    headcount: 2,
    fte: 1.5,
    seasonality: "[1,1,1,1,1,1,1,1,1,1,1,1]",
    monthly_base_salary: 3200.55,
    hourly_rate: 12.25,
    additional_monthly_costs: "[0,0,0,0,0,0,0,0,0,0,0,0]",
    merit_increase_pct: 0.03,
    manual_yearly_increase: 100,
    increase_month: 4,
    daily_contract_hours: 8,
    yearly_hours_worked: 1800,
    vacation_days: 25,
    vacation_monthly_weights: "[0,0,0,0,0,0,1,0,0,0,0,0]",
    accrual_days_per_month: 2.08,
    extra_values: '{"customField":"x"}',
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
  },
  position_pii: {
    position_id: "018f-position",
    ou: "OU25RJ2",
    scenario_id: "018f-scenario",
    hiring_date: "2020-03-01",
    emp_number: "E1234",
    last_name: "Nowak",
    first_name: "Ana",
    title: "Receptionist",
    extra_values: "{}",
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
  },
  component_value: {
    position_id: "018f-position",
    component_def_id: "def-1",
    ou: "OU25RJ2",
    scenario_id: "018f-scenario",
    rate: 0.0725,
    yearly_value: null,
    monthly_values: "[1,2,3,4,5,6,7,8,9,10,11,12]",
    qty: 3,
    unit_rate: 15.5,
    ss_opening_base: 1000,
    account_code: "A6100",
    stats_account_code: null,
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
  },
  buyout_row: {
    id: "018f-buyout",
    ou: "OU25RJ2",
    scenario_id: "018f-scenario",
    department_code: "D0510",
    account_code: "A6200",
    monthly_values: "[0,0,0,0,0,0,0,0,0,0,0,500]",
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
  },
  manual_input_row: {
    id: "018f-manual",
    ou: "OU25RJ2",
    scenario_id: "018f-scenario",
    description: "Agency cover",
    department: "Housekeeping",
    department_code: "D0510",
    cost_account: "A6300",
    stats_account: "A9300",
    rate: 22.5,
    stats_json: "[10,10,10,10,10,10,10,10,10,10,10,10]",
    amounts_json: "[225,225,225,225,225,225,225,225,225,225,225,225]",
    spread_mode: "flat",
    spread_base_stats: 120,
    spread_base_amount: 2700,
    increase_pct: 0.05,
    increase_month: 7,
    sort_order: 3,
    created_by: "someone",
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
    deleted_at: null,
  },
  engine_run: {
    ou: "OU25RJ2",
    scenario_id: "018f-scenario",
    fingerprint: "fp-1",
    computed_at: "2026-07-01T10:00:00.000Z",
    line_count: 1200,
    position_count: 80,
  },
};

describe("payload round trip", () => {
  for (const entityType of PUBLISHED_ENTITY_TYPES) {
    it(`${entityType} survives payload → row → payload unchanged`, () => {
      const spec = ENTITY_SPECS[entityType];
      const first = spec.toPayload(SAMPLES[entityType]);
      const second = spec.toPayload(spec.fromPayload(first));

      // Compared through the canonical form, because that is what is hashed —
      // key order and float representation are exactly what must not drift.
      expect(canonicalJson(second)).toBe(canonicalJson(first));
    });

    it(`${entityType} is stable over three round trips`, () => {
      // Two passes catch a mapping that is merely self-consistent after the
      // first normalisation; three catch one that oscillates.
      const spec = ENTITY_SPECS[entityType];
      let payload = spec.toPayload(SAMPLES[entityType]);
      const original = canonicalJson(payload);
      for (let index = 0; index < 3; index += 1) {
        payload = spec.toPayload(spec.fromPayload(payload));
      }
      expect(canonicalJson(payload)).toBe(original);
    });
  }
});

describe("id conventions", () => {
  it("position_pii keys itself under the position id", () => {
    // entityId MUST equal parentId, or the server rejects it as PII_KEY_MISMATCH
    // and the manifest keys the row one way while storage keys it the other.
    const mapped = toEntity("position_pii", SAMPLES.position_pii);
    expect(mapped.entityId).toBe("018f-position");
    expect(mapped.parentId).toBe("018f-position");
    expect(mapped.entityId).toBe(mapped.parentId);
  });

  it("component_value uses {positionId}:{componentDefId}", () => {
    const mapped = toEntity("component_value", SAMPLES.component_value);
    expect(mapped.entityId).toBe("018f-position:def-1");
    expect(mapped.parentId).toBe("018f-position");
    expect(splitComponentValueId(mapped.entityId)).toEqual({
      positionId: "018f-position",
      componentDefId: "def-1",
    });
  });

  it("splits a component id containing further colons at the first one", () => {
    expect(splitComponentValueId("pos:a:b")).toEqual({
      positionId: "pos",
      componentDefId: "a:b",
    });
    expect(componentValueId("pos", "a:b")).toBe("pos:a:b");
  });
});

describe("department normalisation", () => {
  it("treats the empty string as no department", () => {
    // Both positions and manual_input_rows default department_code to ''. The
    // server collapses it to NULL, which routes the row to the owner-only
    // branch — sending null makes that deliberate rather than accidental.
    expect(normalizeDepartment("")).toBeNull();
    expect(normalizeDepartment("   ")).toBeNull();
    expect(normalizeDepartment(null)).toBeNull();
    expect(normalizeDepartment("D0410")).toBe("D0410");
  });

  it("puts the authorising code in the payload as well as the envelope", () => {
    // departmentCode is the ONE field the server reads out of a payload, and it
    // must agree with the envelope or the row is rejected DEPARTMENT_MISMATCH.
    const mapped = toEntity("position", SAMPLES.position);
    expect(mapped.department).toBe("D0410");
    expect(mapped.payload.departmentCode).toBe("D0410");
  });

  it("gives plan-wide rows no department at all", () => {
    expect(toEntity("scenario", SAMPLES.scenario).department).toBeNull();
    expect(toEntity("engine_run", SAMPLES.engine_run).department).toBeNull();
  });
});

describe("deletion and JSON columns", () => {
  it("reads deleted_at as the tombstone flag", () => {
    const live = toEntity("position", SAMPLES.position);
    const dead = toEntity("position", {
      ...SAMPLES.position,
      deleted_at: "2026-07-02T00:00:00.000Z",
    });
    expect(live.deleted).toBe(false);
    expect(dead.deleted).toBe(true);
  });

  it("hashes JSON columns on their values, not their text", () => {
    // A stored "[1, 2, 3]" and "[1,2,3]" are the same row; whitespace must not
    // read as a content change.
    const spaced = ENTITY_SPECS.position.toPayload({
      ...SAMPLES.position,
      seasonality: "[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]",
    });
    const tight = ENTITY_SPECS.position.toPayload(SAMPLES.position);
    expect(canonicalJson(spaced)).toBe(canonicalJson(tight));
  });

  it("pads a short month vector rather than failing", () => {
    const payload = ENTITY_SPECS.buyout_row.toPayload({
      ...SAMPLES.buyout_row,
      monthly_values: "[1,2,3]",
    });
    expect(payload.monthlyValues).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("survives a corrupted JSON column", () => {
    // Local corruption is not a reason to abort a whole publish; the row stays
    // syncable with a defensible value.
    const payload = ENTITY_SPECS.position.toPayload({
      ...SAMPLES.position,
      extra_values: "{not json",
    });
    expect(payload.extraValues).toEqual({});
  });

  it("keeps NULL distinct from a zero-filled vector", () => {
    // component_values.monthly_values NULL means "unset"; a zero array means
    // "explicitly zero every month". The engine reads them differently.
    const unset = ENTITY_SPECS.component_value.toPayload({
      ...SAMPLES.component_value,
      monthly_values: null,
    });
    expect(unset.monthlyValues).toBeNull();
    expect(
      ENTITY_SPECS.component_value.fromPayload(unset).monthly_values
    ).toBeNull();
  });

  it("keeps a null rate distinct from zero on a manual input row", () => {
    // NULL rate is the mode switch: amounts were typed. Coercing it to 0 would
    // silently flip the row to derived-from-rate and zero every month.
    const typed = ENTITY_SPECS.manual_input_row.toPayload({
      ...SAMPLES.manual_input_row,
      rate: null,
    });
    expect(typed.rate).toBeNull();
    expect(ENTITY_SPECS.manual_input_row.fromPayload(typed).rate).toBeNull();
  });
});
