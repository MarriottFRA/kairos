/**
 * Which accounts a `replace` or `clear` month zeroes — visible, and editable.
 *
 * This used to be three hardcoded prefixes and one sentence of copy. That was
 * an ASSUMPTION about which accounts this tool generates, presented to the user
 * as a fact: we believe it is the 5xxxxx wage accounts plus some of the stats
 * lines, but nobody has seen every hotel's chart. So the rules are now a list
 * the user can read, extend and correct, and the card answers the two questions
 * that assumption was hiding:
 *
 *   - What EXACTLY will be wiped? Every matched account, with its row count.
 *   - What will these rules never clean up? Any account Kairos writes that no
 *     rule covers — overwriting it works fine, but a value left there by an
 *     earlier push, in a row Kairos no longer produces, would survive forever.
 *     One button adopts them all.
 *
 * The counts are computed against the chosen workbook, not in the abstract, so
 * a typo'd prefix is obvious: it says "0 rows".
 */

import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RestartAltIcon from "@mui/icons-material/RestartAlt";

import {
  ClearScope,
  DEFAULT_CLEAR_PREFIXES,
  normalizeClearPrefix,
} from "../../shared/bstPush/ipc";

export interface ClearRulesCardProps {
  /**
   * The saved rules, straight from config — NOT `clearScope.prefixes`. The
   * scope is recomputed by a round-trip to main, so binding the chips to it
   * would leave a deleted rule on screen until the re-preview lands. The chips
   * answer instantly; only the counts beside them lag.
   */
  prefixes: string[];
  clearScope: ClearScope;
  onSave: (prefixes: string[]) => void;
  saving?: boolean;
  disabled?: boolean;
}

export default function ClearRulesCard({
  prefixes,
  clearScope,
  onSave,
  saving = false,
  disabled = false,
}: ClearRulesCardProps) {
  const [draft, setDraft] = useState("");
  const [showAccounts, setShowAccounts] = useState(false);

  const busy = saving || disabled;

  const parsedDraft = normalizeClearPrefix(draft);
  const draftInvalid = draft.trim().length > 0 && parsedDraft === null;
  const draftDuplicate = parsedDraft !== null && prefixes.includes(parsedDraft);

  const isDefaultSet = useMemo(
    () =>
      prefixes.length === DEFAULT_CLEAR_PREFIXES.length &&
      DEFAULT_CLEAR_PREFIXES.every((prefix) => prefixes.includes(prefix)),
    [prefixes]
  );

  const totalClearedRows = clearScope.cellsPerClearedMonth;

  const addDraft = () => {
    if (!parsedDraft || draftDuplicate) return;
    onSave([...prefixes, parsedDraft]);
    setDraft("");
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", rowGap: 1 }}
      >
        <Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            Clear rules
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            Accounts a <strong>Replace</strong> or <strong>Clear</strong> month zeroes first.
            Matching {totalClearedRows.toLocaleString()} row(s) in this file.
            Allocation rows and locked cells follow the push settings below.
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.75}>
          <Button
            size="small"
            startIcon={<ExpandMoreIcon sx={{ transform: showAccounts ? "rotate(180deg)" : "none" }} />}
            onClick={() => setShowAccounts((open) => !open)}
            sx={{ textTransform: "none" }}
          >
            {showAccounts ? "Hide accounts" : `Show ${clearScope.accounts.length} accounts`}
          </Button>
          <Tooltip title={`Back to ${DEFAULT_CLEAR_PREFIXES.join(", ")}`}>
            <span>
              <Button
                size="small"
                disabled={busy || isDefaultSet}
                startIcon={<RestartAltIcon />}
                onClick={() => onSave([...DEFAULT_CLEAR_PREFIXES])}
                sx={{ textTransform: "none" }}
              >
                Reset
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      <Stack
        direction="row"
        spacing={0.75}
        sx={{ mt: 1.25, alignItems: "center", flexWrap: "wrap", rowGap: 0.75 }}
      >
        {prefixes.length === 0 && (
          <Typography variant="body2" sx={{ color: "warning.main", fontWeight: 600 }}>
            No rules — nothing will be cleared, whatever the months say.
          </Typography>
        )}
        {prefixes.map((prefix) => {
          // Undefined means "saved, not yet re-counted against the file".
          const rows = clearScope.ruleMatches[prefix];
          const empty = rows === 0;
          return (
            <Tooltip
              key={prefix}
              title={
                rows === undefined
                  ? "Recounting against the BST…"
                  : empty
                    ? `No account in this BST starts with ${prefix} — check for a typo.`
                    : `Zeroes ${rows.toLocaleString()} row(s) in every cleared month.`
              }
            >
              <Chip
                size="small"
                variant={empty ? "outlined" : "filled"}
                color={empty ? "warning" : "default"}
                label={`${prefix} • ${rows === undefined ? "counting…" : `${rows.toLocaleString()} rows`}`}
                onDelete={busy ? undefined : () => onSave(prefixes.filter((p) => p !== prefix))}
                sx={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.6875rem" }}
              />
            </Tooltip>
          );
        })}

        <TextField
          size="small"
          value={draft}
          placeholder="e.g. 5 or A512400"
          error={draftInvalid || draftDuplicate}
          helperText={
            draftInvalid
              ? "Digits only"
              : draftDuplicate
                ? "Already a rule"
                : undefined
          }
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addDraft();
          }}
          sx={{ width: 168, "& .MuiInputBase-input": { fontSize: "0.8125rem" } }}
        />
        <Button
          size="small"
          startIcon={<AddIcon />}
          disabled={busy || !parsedDraft || draftDuplicate}
          onClick={addDraft}
          sx={{ textTransform: "none" }}
        >
          Add rule
        </Button>
      </Stack>

      {clearScope.uncoveredWritten.length > 0 && (
        <Alert
          severity="warning"
          sx={{ mt: 1.25 }}
          action={
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              onClick={() =>
                onSave([
                  ...prefixes,
                  ...clearScope.uncoveredWritten
                    .map((code) => normalizeClearPrefix(code))
                    .filter((code): code is string => code !== null),
                ])
              }
              sx={{ textTransform: "none", whiteSpace: "nowrap" }}
            >
              Add all {clearScope.uncoveredWritten.length}
            </Button>
          }
        >
          Kairos writes {clearScope.uncoveredWritten.length} account(s) no rule covers:{" "}
          <Box component="span" sx={{ fontFamily: "'IBM Plex Mono', monospace" }}>
            {clearScope.uncoveredWritten.slice(0, 8).join(", ")}
            {clearScope.uncoveredWritten.length > 8 ? ", …" : ""}
          </Box>
          . They will still be overwritten — but a value an earlier push left in a row
          Kairos no longer produces can never be cleaned up.
        </Alert>
      )}

      {clearScope.clearedNotWritten.length > 0 && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {clearScope.clearedNotWritten.length} account(s) match these rules but Kairos
          writes nothing back to them, so a cleared month leaves them at zero.
        </Alert>
      )}

      <Collapse in={showAccounts} unmountOnExit>
        <Divider sx={{ my: 1.25 }} />
        <Box sx={{ maxHeight: 260, overflowY: "auto" }}>
          <Box
            component="table"
            sx={{
              width: "100%",
              borderCollapse: "collapse",
              "& th": {
                position: "sticky", top: 0, zIndex: 1,
                textAlign: "left", fontSize: "0.6875rem", fontWeight: 700,
                color: "text.secondary", py: 0.5, px: 1,
                backgroundColor: (theme) => theme.palette.background.paper,
                borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
              },
              "& td": {
                fontSize: "0.75rem", py: 0.4, px: 1,
                borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
              },
            }}
          >
            <thead>
              <tr>
                <th>Account</th>
                <th>Description</th>
                <th style={{ textAlign: "right" }}>BST rows</th>
                <th>Cleared</th>
                <th>Written by Kairos</th>
              </tr>
            </thead>
            <tbody>
              {clearScope.accounts.map((account) => (
                <tr key={account.account}>
                  <td style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
                    {account.account}
                  </td>
                  <td>{account.name || "—"}</td>
                  <td style={{ textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>
                    {account.bstRows.toLocaleString()}
                  </td>
                  <td>
                    {account.matchedBy ? (
                      <Chip
                        size="small"
                        label={`rule ${account.matchedBy}`}
                        sx={{ height: 18, fontSize: "0.625rem" }}
                      />
                    ) : (
                      <Typography variant="caption" sx={{ color: "text.disabled" }}>
                        no
                      </Typography>
                    )}
                  </td>
                  <td>
                    {account.written ? (
                      <Chip
                        size="small"
                        color="success"
                        variant="outlined"
                        label="yes"
                        sx={{ height: 18, fontSize: "0.625rem" }}
                      />
                    ) : (
                      <Typography variant="caption" sx={{ color: "text.disabled" }}>
                        no
                      </Typography>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Box>
        </Box>
      </Collapse>
    </Paper>
  );
}
