/**
 * The one "Account" section every block dialog shows — the generic block
 * dialog and the Social-Security scheme dialog alike — so the three ways a
 * block can get its posting account read and behave the same everywhere:
 *
 *   Pick an account            type one; optionally let each row pick its own.
 *   Same as a block            post wherever that block posts (row for row if
 *                              that block is per-row). Change it there, this
 *                              block follows.
 *   Same as a position column  post wherever each row's Salary / Benefits /
 *                              Working Hours / Accrual account posts.
 *
 * The section owns no state: it renders the three fields it is given and
 * reports every change as a patch. Following forces the per-row switch off
 * (the source decides per row), so the switch is only offered in the first
 * mode. What a link resolves to is read from the OU's blocks with the same
 * pure helper the read model uses, so the caption here and the band header
 * in the grid cannot disagree.
 */

import { useMemo } from "react";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import LinkIcon from "@mui/icons-material/Link";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  BLOCK_ACCOUNT_FIELDS,
  BLOCK_ACCOUNT_FIELD_META,
  BlockAccountField,
  BlockAccountSource,
  BlockDto,
  describeAccountLink,
} from "../../shared/blocks/ipc";
import { AccountOption } from "../../shared/mappingTables/types";
import AccountAutocomplete from "../common/AccountAutocomplete";

type Mode = "OWN" | "BLOCK" | "FIELD";

export interface BlockAccountPatch {
  accountCode?: string;
  accountLocked?: boolean;
  /** `undefined` inside the patch means "no source" (back to a typed account). */
  accountSource?: BlockAccountSource;
}

export interface BlockAccountSectionProps {
  /** "Account" for most blocks, "Cost account" where a stats account follows. */
  title?: string;
  accountCode: string;
  accountLocked: boolean;
  accountSource?: BlockAccountSource;
  onChange: (patch: BlockAccountPatch) => void;
  /** Every block in the OU — the candidates to follow (self excluded). */
  blocks: readonly BlockDto[];
  /** The block being edited, so it never offers itself. Undefined on create. */
  selfId?: string;
  accounts: AccountOption[];
  /** Offer the "Same account for every row" switch in the typed mode. */
  lockSwitch?: boolean;
  /** Caption under a typed account (the block-type specific wording). */
  typedHint?: (accountCode: string) => string;
}

const DEFAULT_TYPED_HINT = (accountCode: string) =>
  accountCode
    ? "The generated line posts to this account."
    : "No account: the block still calculates (and other blocks can use it) but it is not included in the output.";

export default function BlockAccountSection({
  title = "Account",
  accountCode,
  accountLocked,
  accountSource,
  onChange,
  blocks,
  selfId,
  accounts,
  lockSwitch = true,
  typedHint = DEFAULT_TYPED_HINT,
}: BlockAccountSectionProps) {
  const mode: Mode = !accountSource
    ? "OWN"
    : accountSource.kind === "BLOCK"
      ? "BLOCK"
      : "FIELD";

  const blockById = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);

  // Followable: not this block, and carrying a typed account of its own
  // (depth one — a follower cannot be followed). A block already following
  // THIS one has a source, so it drops out here too.
  const candidates = useMemo(
    () => blocks.filter((block) => block.id !== selfId && !block.accountSource),
    [blocks, selfId]
  );

  const link = useMemo(
    () => (accountSource ? describeAccountLink({ accountSource }, blockById) : undefined),
    [accountSource, blockById]
  );

  const setMode = (next: Mode | null) => {
    if (!next || next === mode) return;
    if (next === "OWN") {
      onChange({ accountSource: undefined });
      return;
    }
    if (next === "BLOCK") {
      const first = candidates[0];
      onChange({
        accountSource: { kind: "BLOCK", blockId: first?.id ?? "" },
        accountLocked: true,
      });
      return;
    }
    onChange({ accountSource: { kind: "POSITION_FIELD", field: "salary" }, accountLocked: true });
  };

  const caption = (() => {
    if (mode === "OWN") return typedHint(accountCode);
    if (!link) return "";
    if (link.issue) return link.issue;
    if (mode === "FIELD") {
      return `Posts wherever each row's ${link.targetLabel} posts. Change a row's ${link.targetLabel} and this block follows.`;
    }
    const where = link.perRow
      ? "row by row, as that block is set per row"
      : link.account
        ? `currently ${link.account}`
        : "currently no account, so calculation only";
    return `Posts wherever ${link.targetLabel} posts — ${where}. Change it there and this block follows.`;
  })();

  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">{title}</Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={mode}
        onChange={(_event, next: Mode | null) => setMode(next)}
      >
        <ToggleButton value="OWN">Pick an account</ToggleButton>
        <ToggleButton value="BLOCK" disabled={candidates.length === 0 && mode !== "BLOCK"}>
          Same as a block
        </ToggleButton>
        <ToggleButton value="FIELD">Same as a position column</ToggleButton>
      </ToggleButtonGroup>

      {mode === "OWN" && (
        <AccountAutocomplete
          options={accounts}
          value={accountCode}
          onChange={(next) => onChange({ accountCode: next })}
          size="small"
        />
      )}

      {mode === "BLOCK" && accountSource?.kind === "BLOCK" && (
        <TextField
          select
          size="small"
          label="Block"
          value={candidates.some((block) => block.id === accountSource.blockId) ? accountSource.blockId : ""}
          onChange={(event) =>
            onChange({ accountSource: { kind: "BLOCK", blockId: event.target.value } })
          }
          error={!!link?.issue}
          slotProps={{ select: { renderValue: (value) => blockById.get(String(value))?.label ?? "" } }}
        >
          {candidates.map((block) => (
            <MenuItem key={block.id} value={block.id}>
              <ListItemText
                primary={block.label}
                secondary={
                  block.accountLocked
                    ? block.accountCode || "no account"
                    : `${block.accountCode || "no default"} · per row`
                }
                slotProps={{ secondary: { variant: "caption" } }}
              />
            </MenuItem>
          ))}
        </TextField>
      )}

      {mode === "FIELD" && accountSource?.kind === "POSITION_FIELD" && (
        <TextField
          select
          size="small"
          label="Position column"
          value={accountSource.field}
          onChange={(event) =>
            onChange({
              accountSource: {
                kind: "POSITION_FIELD",
                field: event.target.value as BlockAccountField,
              },
            })
          }
        >
          {BLOCK_ACCOUNT_FIELDS.map((field) => (
            <MenuItem key={field} value={field}>
              {BLOCK_ACCOUNT_FIELD_META[field].label}
            </MenuItem>
          ))}
        </TextField>
      )}

      <Box sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
        {mode !== "OWN" &&
          (link?.issue ? (
            <WarningAmberOutlinedIcon sx={{ fontSize: 16, mt: "1px", color: "warning.main" }} />
          ) : (
            <LinkIcon sx={{ fontSize: 16, mt: "1px", color: "text.disabled" }} />
          ))}
        <Typography
          variant="caption"
          color={link?.issue ? "warning.main" : "text.secondary"}
        >
          {caption}
        </Typography>
      </Box>

      {mode === "OWN" && lockSwitch && (
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={accountLocked}
              onChange={(event) => onChange({ accountLocked: event.target.checked })}
            />
          }
          label={
            <Typography variant="body2">
              Same account for every row
              <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                {accountLocked ? "" : "— each row gets its own account dropdown"}
              </Typography>
            </Typography>
          }
        />
      )}
    </Stack>
  );
}
