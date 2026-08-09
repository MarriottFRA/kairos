/**
 * Hotel setup — one shared copy, and everybody's.
 * ---------------------------------------------------------------------------
 * Columns, blocks, social security schemes, allocations, KPI drivers, the
 * calendar and the defaults for new positions. Not a plan's, not a department's:
 * the property's, and every scenario in it renders through them.
 *
 * ## Why this card exists in this shape
 *
 * Blocks and columns are editable by anybody who opens the Positions page, and
 * deliberately so — the alternative was gating them on plan delegation, which is
 * the wrong axis. `PUT /ou/{ou}/structure` is per-hotel and gated on owning ANY
 * plan at that hotel, so a delegate who wanted a block could simply create their
 * own plan and push one. Withholding the editor would have been theatre.
 *
 * So the boundary is the publish, and it needs two things this card supplies and
 * nothing else did:
 *
 * 1. **Divergence, visible without being asked for.** Somebody whose local setup
 *    has drifted from the hotel's is producing numbers nobody else can
 *    reproduce, and the only way to find out used to be pressing a button
 *    labelled "Check for changes".
 * 2. **The blast radius, before the button.** `pushStructure` sends the WHOLE
 *    local document — not a delta since the last publish — and the server merges
 *    it into everyone's. "Publish setup" said none of that.
 *
 * For anybody who cannot publish it, the same divergence is a different message:
 * their work is real, it is not going anywhere, and the useful next step is to
 * tell whoever can.
 */

import { useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { StructureChange } from "../../shared/kairosSync/structureDoc";

/** Plain-English names for the hotel-setup document's sections. */
export const STRUCTURE_LABELS: Record<string, string> = {
  fieldCatalog: "Columns",
  blockConfigs: "Blocks",
  componentDefs: "Block components",
  ssSchemes: "Social security schemes",
  allocations: "Allocations",
  kpiDrivers: "KPI drivers",
  calendars: "Calendar",
  positionDefaults: "Defaults for new positions",
};

/**
 * Plain-English names for the document's own field names.
 *
 * The compare dialog lists differing fields one per line, and the document is
 * camelCase all the way down — `customLabel`, `bankHolidayPaidWhenNotWorked`.
 * Unmapped keys fall back to `humaniseField` below rather than being hidden: a
 * field a newer client added is still a real difference, and showing it spelled
 * awkwardly beats not showing it at all.
 */
export const STRUCTURE_FIELD_LABELS: Record<string, string> = {
  accountCode: "Account",
  accumulationMode: "Accumulation",
  allocations: "Allocations",
  baseComponentIds: "Base components",
  baseRef: "Base",
  baseRefs: "Included components",
  baseSelectorKind: "Base selector",
  blockId: "Block",
  blockType: "Type",
  brackets: "Bands",
  bucketIndex: "Bucket",
  config: "Settings",
  countExempt: "Excluded from headcount",
  createdBy: "Created by",
  customLabel: "Label",
  dataType: "Data type",
  defaultLabel: "Default label",
  defaultValue: "Default value",
  deletedAt: "Deleted",
  departmentMode: "Department",
  deptMode: "Department matching",
  deptPatterns: "Department patterns",
  accountPrefixes: "Account prefixes",
  dropdownSource: "Dropdown options",
  editable: "Editable",
  excludedDepartments: "Excluded departments",
  fields: "Field values",
  fixedDepartment: "Fixed department",
  includeBaseSalary: "Includes base salary",
  includeVacation: "Includes vacation",
  increaseAware: "Follows increases",
  injectAccount: "Injected to account",
  kpiDriverId: "KPI driver",
  locked: "Locked",
  maskable: "Personal data",
  monthIndex: "Month",
  monthlyCap: "Monthly cap",
  months: "Months",
  multiplier: "Multiplier",
  origin: "Origin",
  section: "Band",
  sortOrder: "Position",
  spreadBase: "Spread base",
  spreadMethod: "Spread",
  ssSchemeId: "Social security scheme",
  statKind: "Statistic",
  storage: "Storage",
  taxYearStartMonth: "Tax year starts",
  validation: "Validation",
  vector: "Vector",
  visible: "Shown",
  weeklyHours: "Weekly hours",
  weekendMask: "Weekend days",
  yearlyCap: "Yearly cap",
};

/** `bankHolidayStaffFraction` → "Bank holiday staff fraction". */
export function humaniseField(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The name to show for a document field. */
export function fieldLabel(field: string): string {
  return STRUCTURE_FIELD_LABELS[field] ?? humaniseField(field);
}

export interface HotelSetupCardProps {
  /** What downloading would change here. Null until the check has run. */
  incoming: StructureChange[] | null;
  /** What publishing would change for everybody else. Null until checked. */
  outgoing: StructureChange[] | null;
  /** True once a check has completed, so "no differences" can be said plainly. */
  checked: boolean;
  /**
   * Whether the hotel has ever published its setup.
   *
   * Its own state, because an empty diff means two different things. A hotel
   * with nothing on the server has nothing to differ from, and the card used to
   * report that as "Matches the server" — a green tick for a copy that does not
   * exist, on the one screen whose job is to say whether it does.
   */
  published: boolean;
  busy: boolean;
  /** Owns some plan at this hotel, so `PUT /ou/{ou}/structure` will not 403. */
  canPublish: boolean;
  /** Whoever could publish it, when this user cannot. Best-effort. */
  publisherEmail: string | null;
  onCheck: () => void;
  onCompare: () => void;
  onPublish: () => void;
}

function countBySection(changes: StructureChange[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.section, (counts.get(change.section) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function sectionList(changes: StructureChange[]): string {
  return countBySection(changes)
    .map(([section]) => STRUCTURE_LABELS[section] ?? section)
    .join(", ");
}

export default function HotelSetupCard({
  incoming,
  outgoing,
  checked,
  published,
  busy,
  canPublish,
  publisherEmail,
  onCheck,
  onCompare,
  onPublish,
}: HotelSetupCardProps) {
  const [copied, setCopied] = useState(false);

  const outgoingCounts = useMemo(
    () => countBySection(outgoing ?? []),
    [outgoing]
  );
  const incomingCounts = useMemo(
    () => countBySection(incoming ?? []),
    [incoming]
  );

  const hasOutgoing = (outgoing?.length ?? 0) > 0;
  const hasIncoming = (incoming?.length ?? 0) > 0;

  /**
   * A readable summary of what is only on this machine.
   *
   * For somebody who cannot publish it, this is the whole affordance: the
   * changes are theirs and real, they are not reaching anybody, and the way
   * forward is a message to whoever can push them. Sections and labels only —
   * the underlying rows are configuration blobs nobody would read.
   */
  const copySummary = (): void => {
    const lines = [
      "Hotel setup changes on my computer that are not on the server:",
      "",
      ...(outgoing ?? []).map(
        (change) =>
          `- ${STRUCTURE_LABELS[change.section] ?? change.section}: ${change.label} (${change.kind})`
      ),
      "",
      "These are hotel-wide settings, so they need to be published by somebody who owns a plan at this hotel.",
    ];
    void navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 2, mt: 3 }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", flexWrap: "wrap", mb: 1 }}
        >
          <Typography variant="h6" sx={{ fontWeight: 600, flexGrow: 1 }}>
            Hotel setup
          </Typography>
          {checked && !published && (
            <Chip size="small" color="default" variant="outlined" label="Not published yet" />
          )}
          {checked && published && !hasOutgoing && !hasIncoming && (
            <Chip size="small" color="success" variant="outlined" label="Matches the server" />
          )}
          {hasOutgoing && (
            <Chip
              size="small"
              color="warning"
              label={`${outgoing?.length} not published`}
            />
          )}
          {hasIncoming && (
            <Chip size="small" color="info" label={`${incoming?.length} to download`} />
          )}
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Columns, blocks, social security schemes, allocations, KPI drivers, the
          calendar and the defaults for new positions.{" "}
          <strong>One shared copy per hotel</strong>, used by every scenario in it
          — including your colleagues&apos;.
        </Typography>

        {checked && !published && (
          // The 404 case, said out loud. It came back as an empty diff, which
          // the card read as agreement — so a hotel whose setup had never left
          // this machine got the same green tick as one in perfect sync.
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>This hotel&apos;s setup has never been published</AlertTitle>
            The server holds no columns, blocks or schemes for this property. Until
            somebody publishes them, a colleague who downloads a plan from here
            renders it through whatever setup their own computer happens to have,
            and their figures will not match yours.
            {!canPublish && (
              <>
                {" "}
                It is published by somebody who owns a plan here
                {publisherEmail ? (
                  <>
                    {" — "}
                    <strong>{publisherEmail}</strong>
                  </>
                ) : null}
                .
              </>
            )}
          </Alert>
        )}

        {hasIncoming && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>
              {incoming?.length} {incoming?.length === 1 ? "change" : "changes"} to
              download
            </AlertTitle>
            Somebody has changed <strong>{sectionList(incoming ?? [])}</strong> at
            this hotel. Downloading brings your copy in line; you will see exactly
            what changes first.
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
              {incomingCounts.map(([section, count]) => (
                <Chip
                  key={section}
                  size="small"
                  variant="outlined"
                  label={`${STRUCTURE_LABELS[section] ?? section}: ${count}`}
                />
              ))}
            </Stack>
          </Alert>
        )}

        {hasOutgoing && canPublish && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {outgoing?.length} {outgoing?.length === 1 ? "change" : "changes"} on
              this computer only
            </AlertTitle>
            You have changed <strong>{sectionList(outgoing ?? [])}</strong> here and
            not published it. Publishing changes the columns and blocks in{" "}
            <strong>every plan at this hotel</strong>, including colleagues&apos;
            — and it sends the whole of your local setup, not only what you
            changed today.
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mt: 1 }}>
              {outgoingCounts.map(([section, count]) => (
                <Chip
                  key={section}
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={`${STRUCTURE_LABELS[section] ?? section}: ${count}`}
                />
              ))}
            </Stack>
          </Alert>
        )}

        {hasOutgoing && !canPublish && (
          // The honest version of the boundary. They may edit blocks — that is a
          // deliberate decision, not an oversight — and their edits are real and
          // useful. They simply cannot be the one to make them everybody's.
          <Alert severity="info" sx={{ mb: 2 }}>
            <AlertTitle>Your setup changes are only on this computer</AlertTitle>
            You have changed <strong>{sectionList(outgoing ?? [])}</strong> here.
            These are hotel-wide settings shared by every plan at this hotel, so
            they are published by somebody who owns a plan here
            {publisherEmail ? (
              <>
                {" — "}
                <strong>{publisherEmail}</strong>
              </>
            ) : null}
            . Your changes keep working on this computer in the meantime, and your
            figures will differ from theirs until the change is published.
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap" }} useFlexGap>
              <Button size="small" variant="outlined" onClick={copySummary}>
                {copied ? "Copied" : "Copy my setup changes"}
              </Button>
              {publisherEmail && (
                <Button
                  size="small"
                  href={`mailto:${encodeURIComponent(publisherEmail)}?subject=${encodeURIComponent(
                    "Hotel setup change"
                  )}&body=${encodeURIComponent(
                    "I have made some changes to this hotel's setup that need publishing:\n\n" +
                      (outgoing ?? [])
                        .map(
                          (change) =>
                            `- ${STRUCTURE_LABELS[change.section] ?? change.section}: ${change.label}`
                        )
                        .join("\n")
                  )}`}
                >
                  Email them
                </Button>
              )}
            </Stack>
          </Alert>
        )}

        <Divider sx={{ mb: 2 }} />
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {/* The action that was missing. "Check again" only ever re-ran the
              same count; the question in front of anybody reading a divergence
              is which rows, and what about them. */}
          {(hasIncoming || hasOutgoing) && (
            <Button variant="contained" onClick={onCompare} disabled={busy}>
              See what&apos;s different
            </Button>
          )}
          <Button onClick={onCheck} disabled={busy}>
            {checked ? "Check again" : "Check for changes"}
          </Button>
          {canPublish && (
            <Button
              // Primary on a hotel that has published nothing: there is no
              // download to weigh it against, and until it happens nobody
              // else's figures agree with this machine's.
              variant={!published ? "contained" : "outlined"}
              color={hasOutgoing ? "warning" : "primary"}
              onClick={onPublish}
              disabled={busy}
            >
              Publish setup
            </Button>
          )}
        </Stack>
        {canPublish && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 1 }}
          >
            Publishing affects every plan at this hotel. You will see what changes
            before anything is sent.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/** Used by the confirm dialog, so the two never word the sections differently. */
export { countBySection };
