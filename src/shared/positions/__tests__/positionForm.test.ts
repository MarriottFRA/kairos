/**
 * Position form model — the Edit Position dialog's layout.
 *
 * The form is generated from the catalog and the block list, exactly like the
 * grid's columns are. That is what makes it grow with blocks for free, and it
 * is also the failure mode worth guarding: a seed bump, a renamed section or a
 * new block slot can silently drop a field off the form while the grid keeps
 * showing it. So the load-bearing assertion here is COMPLETENESS — every field
 * the grid would draw appears on exactly one card, once.
 */

import { describe, expect, it } from "vitest";
import { BlockDto } from "../../blocks/ipc";
import {
  buildPositionForm,
  ESSENTIAL_FIELD_KEYS,
  fieldSpan,
  isEssentialField,
  matchFormFields,
} from "../positionForm";
import { BUILTIN_CATALOG } from "../fieldSeed";
import {
  COLLAPSIBLE_MONTH_FAMILIES,
  FieldCatalog,
  FieldDef,
  VectorName,
  vectorKey,
  vectorKeys,
} from "../fields";
import {
  blockAccountKey,
  blockDepartmentKey,
  blockFieldKey,
  blockInputSlots,
  blockStatsAccountKey,
  blockTotalKey,
} from "../blockRows";

const MONTHS = 12;

function block(overrides: Partial<BlockDto> & Pick<BlockDto, "blockType">): BlockDto {
  return {
    id: `b-${overrides.blockType}`,
    ou: "H001",
    label: overrides.blockType,
    accountCode: "A500000",
    accountLocked: true,
    statsAccountCode: "A900000",
    statsAccountLocked: true,
    spread: "EVEN",
    increaseAware: false,
    departmentMode: "POSITION",
    sortOrder: 10,
    updatedAt: "2026-01-01T00:00:00.000Z",
    costDefId: `${overrides.id ?? `b-${overrides.blockType}`}:cost`,
    ...overrides,
  } as BlockDto;
}

/** Every key the form renders, flattened out of the card tree. */
function renderedKeys(cards: ReturnType<typeof buildPositionForm>): string[] {
  const keys: string[] = [];
  for (const card of cards) {
    for (const node of card.nodes) {
      if (node.kind === "field") keys.push(node.key);
      else if (node.kind === "monthFamily") {
        if (node.summaryKey) keys.push(node.summaryKey);
        keys.push(...node.keys);
      } else keys.push(...node.keys);
    }
  }
  return keys;
}

describe("completeness", () => {
  const cards = buildPositionForm(BUILTIN_CATALOG, []);

  it("renders every visible catalog field exactly once", () => {
    const rendered = renderedKeys(cards);
    const expected = BUILTIN_CATALOG.fields
      .filter((def) => def.visible)
      .map((def) => def.key);

    expect([...rendered].sort()).toEqual([...expected].sort());
    // Once, not twice: a summary field that also emitted its own line would
    // give the user two Total Months boxes disagreeing about which is live.
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("leaves out fields removed via Manage Columns", () => {
    const hidden: FieldCatalog = {
      sections: BUILTIN_CATALOG.sections,
      fields: BUILTIN_CATALOG.fields.map((def) =>
        def.key === "hourlyRate" ? { ...def, visible: false } : def
      ),
    };
    expect(renderedKeys(buildPositionForm(hidden, []))).not.toContain("hourlyRate");
  });

  it("places a user-added field on its section's card", () => {
    const withUser: FieldCatalog = {
      sections: BUILTIN_CATALOG.sections,
      fields: [
        ...BUILTIN_CATALOG.fields,
        {
          key: "u_0192",
          section: "employee",
          dataType: "TEXT",
          storage: "POSITION_EXTRA",
          origin: "USER",
          locked: false,
          defaultLabel: "Locker no.",
          sortOrder: 999,
          visible: true,
          editable: true,
          maskable: false,
        },
      ],
    };
    const card = buildPositionForm(withUser, []).find((c) => c.id === "employee");
    expect(card?.nodes).toContainEqual({ kind: "field", key: "u_0192" });
  });

  it("groups by section rather than by position in the fields array", () => {
    // A field parked out of order must still land on its own card — the grid
    // only loses a divider when that happens, the form would lose the field.
    const shuffled: FieldCatalog = {
      sections: BUILTIN_CATALOG.sections,
      fields: [...BUILTIN_CATALOG.fields].reverse(),
    };
    for (const card of buildPositionForm(shuffled, [])) {
      for (const node of card.nodes) {
        if (node.kind !== "field") continue;
        const def = BUILTIN_CATALOG.fields.find((f) => f.key === node.key);
        expect(def?.section).toBe(card.id);
      }
    }
  });
});

describe("month families", () => {
  const cards = buildPositionForm(BUILTIN_CATALOG, []);
  const families = cards.flatMap((card) =>
    card.nodes.filter((node) => node.kind === "monthFamily")
  );

  it("folds all three families, each behind its own Σ field", () => {
    expect(families).toHaveLength(3);

    const summaryOf = new Map(
      families.map((node) => [
        (node as { vector: VectorName }).vector,
        (node as { summaryKey: string | null }).summaryKey,
      ])
    );
    // The two the grid folds come from the shared constant, so a change there
    // moves both surfaces together.
    for (const [summaryKey, vector] of Object.entries(COLLAPSIBLE_MONTH_FAMILIES)) {
      expect(summaryOf.get(vector as VectorName)).toBe(summaryKey);
    }
    // Vacation weights are always expanded in the grid (the twelve are the
    // point of that section) but fold in the form, which has far less width.
    expect(summaryOf.get("vacationMonthlyWeights")).toBe("vacationWeightsTotal");
  });

  it("carries the twelve cells in month order", () => {
    for (const node of families) {
      const family = node as { vector: VectorName; keys: string[] };
      expect(family.keys).toEqual(vectorKeys(family.vector));
      expect(family.keys).toHaveLength(MONTHS);
      expect(family.keys[0]).toBe(vectorKey(family.vector, 1));
    }
  });

  it("puts each family on the same card as its summary", () => {
    for (const card of cards) {
      for (const node of card.nodes) {
        if (node.kind !== "monthFamily" || !node.summaryKey) continue;
        const summary = BUILTIN_CATALOG.fields.find((f) => f.key === node.summaryKey);
        expect(summary?.section).toBe(card.id);
      }
    }
  });

  it("keeps the family in the slot the seed gave it, whichever end the Σ sits", () => {
    // Total Months and Additional Costs lead their twelve; Total Weights trails
    // them. Either way the family occupies the FIRST of the two slots, so the
    // card reads in the order the seed's comments describe.
    const seasonality = cards.find((card) => card.id === "seasonality");
    expect(seasonality?.nodes[0]).toMatchObject({
      kind: "monthFamily",
      vector: "seasonality",
    });

    const vacation = cards.find((card) => card.id === "vacation");
    const familyAt = vacation?.nodes.findIndex((node) => node.kind === "monthFamily");
    const total = vacation?.nodes.findIndex(
      (node) => node.kind === "field" && node.key === "vacationWeightsTotal"
    );
    expect(familyAt).toBeGreaterThan(0);
    // Absorbed into the family, never a separate line.
    expect(total).toBe(-1);
  });
});

describe("section cards", () => {
  it("orders cards by the section order, not the fields array", () => {
    const cards = buildPositionForm(BUILTIN_CATALOG, []).filter(
      (card) => card.kind === "section"
    );
    const expected = [...BUILTIN_CATALOG.sections]
      .sort((a, b) => a.order - b.order)
      .map((section) => section.id);
    expect(cards.map((card) => card.id)).toEqual(expected);
  });

  it("labels each card from the catalog", () => {
    for (const card of buildPositionForm(BUILTIN_CATALOG, [])) {
      if (card.kind !== "section") continue;
      const section = BUILTIN_CATALOG.sections.find((s) => s.id === card.id);
      expect(card.label).toBe(section?.label);
    }
  });
});

describe("block cards", () => {
  it("trails every section card", () => {
    const cards = buildPositionForm(BUILTIN_CATALOG, [block({ blockType: "MULTIPLIER" })]);
    const firstBlock = cards.findIndex((card) => card.kind === "block");
    expect(firstBlock).toBe(cards.length - 1);
    expect(cards.slice(0, firstBlock).every((card) => card.kind === "section")).toBe(true);
  });

  it("carries exactly the input slots the block type declares, plus a Total", () => {
    const types: BlockDto["blockType"][] = [
      "MULTIPLIER",
      "FLAT_MONTHLY",
      "COUNT_RATE",
      "CUSTOM_MONTHLY",
      "SOCIAL_SECURITY",
      "POOL_SPREAD",
    ];
    for (const blockType of types) {
      const dto = block({ blockType });
      const card = buildPositionForm(BUILTIN_CATALOG, [dto]).at(-1)!;

      const keys = card.nodes.flatMap((node) =>
        node.kind === "field" ? [node.key] : node.kind === "blockMonths" ? node.keys : []
      );
      // Asserted against blockInputSlots — the same function buildBlockColumns
      // uses — so the form and the grid band cannot disagree about a slot.
      const expected = blockInputSlots(dto).map((slot) =>
        blockFieldKey(dto.costDefId, slot)
      );
      expect([...keys].sort()).toEqual([...expected].sort());
      expect(card.totalKey).toBe(blockTotalKey(dto));
      expect(card.block).toBe(dto);
      expect(card.label).toBe(dto.label);
    }
  });

  it("folds a CUSTOM_MONTHLY block's twelve amounts behind one row", () => {
    const dto = block({ blockType: "CUSTOM_MONTHLY" });
    const card = buildPositionForm(BUILTIN_CATALOG, [dto]).at(-1)!;
    expect(card.nodes).toHaveLength(1);
    expect(card.nodes[0]).toEqual({
      kind: "blockMonths",
      defId: dto.costDefId,
      keys: Array.from({ length: MONTHS }, (_, m) =>
        blockFieldKey(dto.costDefId, `m${m + 1}`)
      ),
    });
  });

  it("gives a SOCIAL_SECURITY block an opening base only on a non-January cumulative scheme", () => {
    const plain = block({ blockType: "SOCIAL_SECURITY" });
    expect(buildPositionForm(BUILTIN_CATALOG, [plain]).at(-1)!.nodes).toEqual([]);

    const cumulative = block({ blockType: "SOCIAL_SECURITY", ssCumulativeNonJan: true });
    expect(buildPositionForm(BUILTIN_CATALOG, [cumulative]).at(-1)!.nodes).toEqual([
      { kind: "field", key: blockFieldKey(cumulative.costDefId, "openingBase") },
    ]);
  });

  it("shows per-row account cells only while the block is unlocked", () => {
    const locked = block({ blockType: "COUNT_RATE" });
    const lockedKeys = buildPositionForm(BUILTIN_CATALOG, [locked])
      .at(-1)!
      .nodes.flatMap((node) => (node.kind === "field" ? [node.key] : []));
    expect(lockedKeys).not.toContain(blockAccountKey(locked.costDefId));

    const open = block({
      blockType: "COUNT_RATE",
      accountLocked: false,
      statsAccountLocked: false,
    });
    const openKeys = buildPositionForm(BUILTIN_CATALOG, [open])
      .at(-1)!
      .nodes.flatMap((node) => (node.kind === "field" ? [node.key] : []));
    expect(openKeys).toContain(blockAccountKey(open.costDefId));
    expect(openKeys).toContain(blockStatsAccountKey(open.costDefId));
  });

  it("shows the per-row department cell only for a PER_ROW multiplier", () => {
    const formKeys = (dto: BlockDto) =>
      buildPositionForm(BUILTIN_CATALOG, [dto])
        .at(-1)!
        .nodes.flatMap((node) => (node.kind === "field" ? [node.key] : []));

    const normal = block({ blockType: "MULTIPLIER" });
    expect(formKeys(normal)).not.toContain(blockDepartmentKey(normal.costDefId));

    const fixed = block({ blockType: "MULTIPLIER", departmentMode: "FIXED" });
    expect(formKeys(fixed)).not.toContain(blockDepartmentKey(fixed.costDefId));

    const perRow = block({ blockType: "MULTIPLIER", departmentMode: "PER_ROW" });
    expect(formKeys(perRow)).toContain(blockDepartmentKey(perRow.costDefId));

    // Double-gated on the type: PER_ROW is rejected at save time for anything
    // but a multiplier, so a config carrying it arrived hand-edited or from a
    // peer and must not sprout a cell.
    const wrongType = block({ blockType: "FLAT_MONTHLY", departmentMode: "PER_ROW" });
    expect(formKeys(wrongType)).not.toContain(
      blockDepartmentKey(wrongType.costDefId)
    );
  });

  it("keeps one card per block, in the block list's order", () => {
    const blocks = [
      block({ id: "b1", blockType: "MULTIPLIER", label: "Pension", costDefId: "b1:cost" }),
      block({ id: "b2", blockType: "FLAT_MONTHLY", label: "Meals", costDefId: "b2:cost" }),
    ];
    const cards = buildPositionForm(BUILTIN_CATALOG, blocks).filter(
      (card) => card.kind === "block"
    );
    expect(cards.map((card) => card.label)).toEqual(["Pension", "Meals"]);
    expect(cards.map((card) => card.id)).toEqual(["blk:b1", "blk:b2"]);
  });
});

describe("cell geometry", () => {
  const def = (key: string) => BUILTIN_CATALOG.fields.find((f) => f.key === key)!;

  it("gives an account picker two tracks and a number one", () => {
    // An account reads "A511000 · Salaries — Front Office"; a merit % reads
    // "3.5". Same box for both is what made the old layout truncate.
    expect(fieldSpan("salaryAccountCode", def("salaryAccountCode"))).toBe(2);
    expect(fieldSpan("headCountAccount", def("headCountAccount"))).toBe(2);
    expect(fieldSpan("meritIncreasePct", def("meritIncreasePct"))).toBe(1);
    expect(fieldSpan("headcount", def("headcount"))).toBe(1);
  });

  it("widens the pickers whose VALUE is long, not whose label is", () => {
    expect(fieldSpan("deptName", def("deptName"))).toBe(2);
    expect(fieldSpan("title", def("title"))).toBe(2);
    expect(fieldSpan("cluster", def("cluster"))).toBe(2);
    // Short free text stays narrow — two tracks of "1042" is wasted lattice.
    expect(fieldSpan("empNumber", def("empNumber"))).toBe(1);
  });

  it("widens a block's account cells, which carry no catalog def", () => {
    expect(fieldSpan("blk:b1:cost:account")).toBe(2);
    expect(fieldSpan("blk:b1:cost:statsAccount")).toBe(2);
    expect(fieldSpan("blk:b1:cost:multiplier")).toBe(1);
    expect(fieldSpan("blk:b1:cost:m7")).toBe(1);
  });

  it("never asks for more tracks than a narrow dialog has", () => {
    for (const field of BUILTIN_CATALOG.fields) {
      expect(fieldSpan(field.key, field)).toBeLessThanOrEqual(2);
    }
  });
});

describe("essentials", () => {
  it("names only fields the catalog actually ships", () => {
    // The failure this guards: a seed rename leaves a stale key here, the field
    // silently drops out of the default view, and it looks like it never saved.
    const known = new Set(BUILTIN_CATALOG.fields.map((f) => f.key));
    for (const key of ESSENTIAL_FIELD_KEYS) expect(known).toContain(key);
  });

  it("holds back only posting accounts, mirrors and rare overrides", () => {
    const monthCells = new Set(
      (
        [
          "seasonality",
          "additionalMonthlyCosts",
          "vacationMonthlyWeights",
        ] as VectorName[]
      ).flatMap(vectorKeys)
    );
    const held = BUILTIN_CATALOG.fields
      .filter((f) => f.visible && !monthCells.has(f.key) && !isEssentialField(f))
      .map((f) => f.key);

    // Stated as a whole set rather than a spot-check: this list IS the promise
    // the "Key / All" toggle makes, so growing it has to be deliberate.
    expect([...held].sort()).toEqual(
      [
        "accrualAccount",
        "benefitsAccountCode",
        "departmentCode",
        "headCountAccount",
        "headcountStatsAccount",
        "manualYearlyIncrease",
        "salaryAccountCode",
        "standardJobTitle",
        "clusterMultiplierOverride",
        "workingHoursAccount",
      ].sort()
    );
  });

  it("always keeps a user-added field, which somebody added on purpose", () => {
    const custom: FieldDef = {
      key: "u_0192",
      section: "employee",
      dataType: "TEXT",
      storage: "POSITION_EXTRA",
      origin: "USER",
      locked: false,
      defaultLabel: "Locker no.",
      sortOrder: 999,
      visible: true,
      editable: true,
      maskable: false,
    };
    expect(isEssentialField(custom)).toBe(true);
  });

  it("keeps each month family's Σ, so no family disappears when folded", () => {
    // The form anchors a family on its summary line; dropping the Σ from the
    // default view would take all twelve cells with it.
    for (const summaryKey of Object.keys(COLLAPSIBLE_MONTH_FAMILIES)) {
      expect(ESSENTIAL_FIELD_KEYS).toContain(summaryKey);
    }
    expect(ESSENTIAL_FIELD_KEYS).toContain("vacationWeightsTotal");
  });
});

describe("field jump", () => {
  it("matches the label the user sees", () => {
    expect(matchFormFields(BUILTIN_CATALOG, "merit")).toContain("meritIncreasePct");
  });

  it("matches the field key, so a pasted key still finds its box", () => {
    expect(matchFormFields(BUILTIN_CATALOG, "hourlyRate")).toContain("hourlyRate");
  });

  it("matches a section label, pulling in the whole card", () => {
    const hits = matchFormFields(BUILTIN_CATALOG, "Employee PII");
    const pii = BUILTIN_CATALOG.fields.filter(
      (def) => def.section === "pii" && def.visible
    );
    for (const def of pii) expect(hits).toContain(def.key);
  });

  it("treats an empty query as no filter rather than no matches", () => {
    expect(matchFormFields(BUILTIN_CATALOG, "   ").size).toBe(0);
  });

  it("never offers a field the catalog has hidden", () => {
    const hidden = BUILTIN_CATALOG.fields.filter((def) => !def.visible);
    expect(hidden.length).toBeGreaterThan(0); // annualDivisorBasis at least
    for (const def of hidden) {
      expect(matchFormFields(BUILTIN_CATALOG, def.defaultLabel)).not.toContain(def.key);
    }
  });
});
