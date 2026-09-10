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
 * The second row of the card is the EXCEPTIONS: accounts (or families) a rule
 * reaches but must leave alone. "Clear every 5xxxxx except 510001" is one
 * rule and one exception, not nine rules. An exception always wins over a
 * rule, and the account table has a Keep / Clear button per row, so the
 * natural way to build the list is to open the table and click the accounts
 * that should survive.
 *
 * One thing an exception does NOT do, and the card must keep saying so: it
 * does not stop the value pass. A Replace or Add month writes whatever Kairos
 * holds for a kept account on top of it — and when Kairos holds only zeroes,
 * that is a wipe by another name unless "skip unused combos" is on. So the
 * card scans the kept accounts, splits "has values" from "only zeroes", and
 * offers the switch right there rather than leaving it to a warning below.
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
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";

import {
  BstPushOptions,
  ClearScope,
  ClearScopeAccount,
  DEFAULT_CLEAR_PREFIXES,
  normalizeClearPrefix,
  writesValues,
} from "../../shared/bstPush/ipc";

/** A partial save — the card edits one list at a time. */
export interface ClearRulesPatch {
  clearPrefixes?: string[];
  clearExcludes?: string[];
}

export interface ClearRulesCardProps {
  /**
   * The saved rules, straight from config — NOT `clearScope.prefixes`. The
   * scope is recomputed by a round-trip to main, so binding the chips to it
   * would leave a deleted rule on screen until the re-preview lands. The chips
   * answer instantly; only the counts beside them lag.
   */
  prefixes: string[];
  /** The saved exceptions — same reasoning, same source. */
  excludes: string[];
  clearScope: ClearScope;
  /**
   * The live push options — which months write values, and whether unused
   * combos are skipped. Both decide whether a kept account is really left
   * alone, so the advice under the Keep row reads them directly.
   */
  options: Pick<BstPushOptions, "months" | "skipUnusedCombos">;
  onSave: (patch: ClearRulesPatch) => void;
  /** The one-click fix for the zero case: switch "skip unused combos" on. */
  onSkipUnusedCombos?: () => void;
  saving?: boolean;
  disabled?: boolean;
}

const MONO = "'IBM Plex Mono', monospace";

/** The bare account behind a scope row's "A512400". */
const bareOf = (account: ClearScopeAccount) =>
  normalizeClearPrefix(account.account) ?? account.account;

export default function ClearRulesCard({
  prefixes,
  excludes,
  clearScope,
  options,
  onSave,
  onSkipUnusedCombos,
  saving = false,
  disabled = false,
}: ClearRulesCardProps) {
  const [draftRule, setDraftRule] = useState("");
  const [draftKeep, setDraftKeep] = useState("");
  const [showAccounts, setShowAccounts] = useState(false);

  const busy = saving || disabled;

  // ── The "Clear" input ──
  const parsedRule = normalizeClearPrefix(draftRule);
  const ruleInvalid = draftRule.trim().length > 0 && parsedRule === null;
  const ruleDuplicate = parsedRule !== null && prefixes.includes(parsedRule);
  // A rule that sits entirely inside an exception can never clear anything —
  // refusing it beats a chip that says "0 rows" for a reason the user has to
  // work out.
  const ruleShadowedBy =
    parsedRule !== null
      ? (excludes.find((exclude) => parsedRule.startsWith(exclude)) ?? null)
      : null;
  const ruleHelper = ruleInvalid
    ? "Digits only"
    : ruleDuplicate
      ? "Already a rule"
      : ruleShadowedBy
        ? `Kept by the ${ruleShadowedBy} exception — it would never clear`
        : undefined;
  const canAddRule =
    !busy && parsedRule !== null && !ruleDuplicate && ruleShadowedBy === null;

  // ── The "Keep" input ──
  const parsedKeep = normalizeClearPrefix(draftKeep);
  const keepInvalid = draftKeep.trim().length > 0 && parsedKeep === null;
  const keepDuplicate = parsedKeep !== null && excludes.includes(parsedKeep);
  // An exception at least as broad as a rule switches that rule off wholesale.
  // That is never what "except" means, so it is refused rather than allowed
  // to silently disarm the rule.
  const keepKills =
    parsedKeep !== null
      ? (prefixes.find((prefix) => prefix.startsWith(parsedKeep)) ?? null)
      : null;
  const keepUnreached =
    parsedKeep !== null &&
    keepKills === null &&
    !prefixes.some((prefix) => parsedKeep.startsWith(prefix));
  const keepHelper = keepInvalid
    ? "Digits only"
    : keepDuplicate
      ? "Already an exception"
      : keepKills
        ? `Would switch off the ${keepKills} rule entirely`
        : keepUnreached
          ? "No clear rule reaches this — it keeps nothing yet"
          : undefined;
  const canAddKeep =
    !busy && parsedKeep !== null && !keepDuplicate && keepKills === null;

  const isDefaultSet = useMemo(
    () =>
      excludes.length === 0 &&
      prefixes.length === DEFAULT_CLEAR_PREFIXES.length &&
      DEFAULT_CLEAR_PREFIXES.every((prefix) => prefixes.includes(prefix)),
    [prefixes, excludes]
  );

  const addRule = () => {
    if (!canAddRule || parsedRule === null) return;
    onSave({ clearPrefixes: [...prefixes, parsedRule] });
    setDraftRule("");
  };
  const addKeep = () => {
    if (!canAddKeep || parsedKeep === null) return;
    onSave({ clearExcludes: [...excludes, parsedKeep] });
    setDraftKeep("");
  };
  const removeRule = (prefix: string) =>
    onSave({ clearPrefixes: prefixes.filter((p) => p !== prefix) });
  const removeKeep = (exclude: string) =>
    onSave({ clearExcludes: excludes.filter((e) => e !== exclude) });
  /** Keep one account, exactly — the per-row shortcut in the table. */
  const keepAccount = (bare: string) =>
    onSave({ clearExcludes: [...excludes, bare] });
  /** Clear one account, exactly — the per-row counterpart to "Add all". */
  const clearAccount = (bare: string) =>
    onSave({ clearPrefixes: [...prefixes, bare] });

  const totalClearedRows = clearScope.cellsPerClearedMonth;

  // ── What Keep does NOT do ──
  // Kept accounts Kairos still writes to, in the two cases that matter.
  const anyWriteMonths = options.months.some(writesValues);
  const keptStillWritten = useMemo(
    () => clearScope.accounts.filter((a) => a.matchedBy && a.keptBy && a.written),
    [clearScope.accounts]
  );
  const keptWithValues = keptStillWritten.filter((a) => a.hasData);
  const keptOnlyZeroes = keptStillWritten.filter((a) => !a.hasData);
  const zeroesAreAProblem =
    anyWriteMonths && keptOnlyZeroes.length > 0 && !options.skipUnusedCombos;

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
            Matching {totalClearedRows.toLocaleString()} row(s) in this file
            {clearScope.rowsKept > 0
              ? `, ${clearScope.rowsKept.toLocaleString()} more kept by the exceptions`
              : ""}
            . Allocation rows and locked cells follow the push settings below.
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
          <Tooltip title={`Back to ${DEFAULT_CLEAR_PREFIXES.join(", ")}, with no exceptions`}>
            <span>
              <Button
                size="small"
                disabled={busy || isDefaultSet}
                startIcon={<RestartAltIcon />}
                onClick={() =>
                  onSave({ clearPrefixes: [...DEFAULT_CLEAR_PREFIXES], clearExcludes: [] })
                }
                sx={{ textTransform: "none" }}
              >
                Reset
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {/* ── Clear ── */}
      <RuleRow label="Clear" hint="Zero every account starting with…">
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
                    ? `No account in this BST starts with ${prefix} and escapes the exceptions — check for a typo.`
                    : `Zeroes ${rows.toLocaleString()} row(s) in every cleared month.`
              }
            >
              <Chip
                size="small"
                // Red outline mirrors Keep's green one: this is the side that
                // deletes. Outlined, never filled — a card of solid red chips
                // would read as an error. The zero-row state goes DASHED orange
                // so it still stands apart from the healthy red.
                variant="outlined"
                color={empty ? "warning" : "error"}
                icon={<DeleteOutlineIcon sx={{ fontSize: 14 }} />}
                label={`${prefix} • ${rows === undefined ? "counting…" : `${rows.toLocaleString()} rows`}`}
                onDelete={busy ? undefined : () => removeRule(prefix)}
                sx={{
                  fontFamily: MONO,
                  fontSize: "0.6875rem",
                  ...(empty ? { borderStyle: "dashed" } : {}),
                }}
              />
            </Tooltip>
          );
        })}

        <TextField
          size="small"
          value={draftRule}
          placeholder="e.g. 5 or A512400"
          error={ruleInvalid || ruleDuplicate || ruleShadowedBy !== null}
          helperText={ruleHelper}
          disabled={busy}
          onChange={(event) => setDraftRule(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addRule();
          }}
          sx={{ width: 168, "& .MuiInputBase-input": { fontSize: "0.8125rem" } }}
        />
        <Button
          size="small"
          startIcon={<DeleteOutlineIcon />}
          disabled={!canAddRule}
          onClick={addRule}
          sx={{ textTransform: "none" }}
        >
          Add rule
        </Button>
      </RuleRow>

      {/* ── Keep ── */}
      <RuleRow label="Keep" hint="…except accounts starting with">
        {excludes.length === 0 && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            No exceptions — every account the rules reach is cleared.
          </Typography>
        )}
        {excludes.map((exclude) => {
          const rows = clearScope.excludeMatches[exclude];
          const idle = rows === 0;
          return (
            <Tooltip
              key={exclude}
              title={
                rows === undefined
                  ? "Recounting against the BST…"
                  : idle
                    ? `No clear rule reaches an account starting with ${exclude}, so this keeps nothing — a typo, or a rule you have since removed.`
                    : `Keeps ${rows.toLocaleString()} row(s) a clear rule would otherwise zero.`
              }
            >
              <Chip
                size="small"
                variant="outlined"
                color={idle ? "warning" : "success"}
                icon={<ShieldOutlinedIcon sx={{ fontSize: 14 }} />}
                label={`${exclude} • ${rows === undefined ? "counting…" : `${rows.toLocaleString()} rows kept`}`}
                onDelete={busy ? undefined : () => removeKeep(exclude)}
                sx={{
                  fontFamily: MONO,
                  fontSize: "0.6875rem",
                  ...(idle ? { borderStyle: "dashed" } : {}),
                }}
              />
            </Tooltip>
          );
        })}

        <TextField
          size="small"
          value={draftKeep}
          placeholder="e.g. 510001"
          error={keepInvalid || keepDuplicate || keepKills !== null}
          helperText={keepHelper}
          disabled={busy}
          onChange={(event) => setDraftKeep(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addKeep();
          }}
          sx={{ width: 168, "& .MuiInputBase-input": { fontSize: "0.8125rem" } }}
        />
        <Button
          size="small"
          startIcon={<ShieldOutlinedIcon />}
          disabled={!canAddKeep}
          onClick={addKeep}
          sx={{ textTransform: "none" }}
        >
          Add exception
        </Button>
      </RuleRow>

      {excludes.length > 0 && (
        <Typography
          variant="caption"
          sx={{ display: "block", mt: 0.5, pl: "52px", color: "text.secondary" }}
        >
          Keep only stops the clearing. A <strong>Replace</strong> or <strong>Add</strong>{" "}
          month still writes Kairos values over a kept account — zeroes included, unless{" "}
          <strong>Skip unused combos</strong> is on in the push settings.
          {keptStillWritten.length > 0 && " Accounts marked * below are written this way."}
        </Typography>
      )}

      {zeroesAreAProblem && (
        <Alert
          severity="warning"
          sx={{ mt: 1 }}
          action={
            onSkipUnusedCombos ? (
              <Button
                size="small"
                color="inherit"
                disabled={busy}
                onClick={onSkipUnusedCombos}
                sx={{ textTransform: "none", whiteSpace: "nowrap" }}
              >
                Skip unused combos
              </Button>
            ) : undefined
          }
        >
          Kairos holds only zeroes for{" "}
          <Box component="span" sx={{ fontFamily: MONO }}>
            {keptOnlyZeroes.slice(0, 6).map((a) => a.account).join(", ")}
            {keptOnlyZeroes.length > 6 ? ", …" : ""}
          </Box>
          , so a replaced or added month writes those zeroes over{" "}
          {keptOnlyZeroes.length === 1 ? "it" : "them"} anyway — keeping{" "}
          {keptOnlyZeroes.length === 1 ? "it" : "them"} changes nothing until unused combos
          are skipped.
        </Alert>
      )}

      {anyWriteMonths && keptWithValues.length > 0 && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Kairos has values for{" "}
          <Box component="span" sx={{ fontFamily: MONO }}>
            {keptWithValues.slice(0, 6).map((a) => a.account).join(", ")}
            {keptWithValues.length > 6 ? ", …" : ""}
          </Box>
          ; they still land in every replaced or added month. The exception protects only
          the rows Kairos writes nothing to.
        </Alert>
      )}

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
                onSave({
                  clearPrefixes: [
                    ...prefixes,
                    ...clearScope.uncoveredWritten
                      .map((code) => normalizeClearPrefix(code))
                      .filter((code): code is string => code !== null),
                  ],
                })
              }
              sx={{ textTransform: "none", whiteSpace: "nowrap" }}
            >
              Add all {clearScope.uncoveredWritten.length}
            </Button>
          }
        >
          Kairos writes {clearScope.uncoveredWritten.length} account(s) no rule covers:{" "}
          <Box component="span" sx={{ fontFamily: MONO }}>
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
          {" "}Use <strong>Keep</strong> on any that should survive.
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
                <th style={{ textAlign: "right" }} />
              </tr>
            </thead>
            <tbody>
              {clearScope.accounts.map((account) => (
                <tr key={account.account}>
                  <td style={{ fontFamily: MONO }}>{account.account}</td>
                  <td>{account.name || "—"}</td>
                  <td style={{ textAlign: "right", fontFamily: MONO }}>
                    {account.bstRows.toLocaleString()}
                  </td>
                  <td>
                    <ClearedCell account={account} />
                  </td>
                  <td>
                    <WrittenCell account={account} anyWriteMonths={anyWriteMonths} />
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <RowAction
                      account={account}
                      busy={busy}
                      onKeep={keepAccount}
                      onClear={clearAccount}
                      onRemoveKeep={removeKeep}
                    />
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

/** One labelled line of chips + an input, shared by the Clear and Keep rows. */
function RuleRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ mt: 1.25, alignItems: "center", flexWrap: "wrap", rowGap: 0.75 }}
    >
      <Tooltip title={hint} placement="left">
        <Typography
          variant="caption"
          sx={{
            fontWeight: 700,
            color: "text.secondary",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            width: 44,
            flexShrink: 0,
          }}
        >
          {label}
        </Typography>
      </Tooltip>
      {children}
    </Stack>
  );
}

/** What the rules decide for one account, as the table shows it. */
function ClearedCell({ account }: { account: ClearScopeAccount }) {
  const tiny = { height: 18, fontSize: "0.625rem" } as const;
  if (account.matchedBy && !account.keptBy) {
    return (
      <Chip
        size="small"
        color="error"
        variant="outlined"
        icon={<DeleteOutlineIcon sx={{ fontSize: 12 }} />}
        label={`rule ${account.matchedBy}`}
        sx={tiny}
      />
    );
  }
  if (account.keptBy) {
    return (
      <Tooltip
        title={
          account.matchedBy
            ? `The ${account.matchedBy} rule reaches it; the ${account.keptBy} exception keeps it.`
            : `The ${account.keptBy} exception covers it, but no clear rule reaches it anyway.`
        }
      >
        <Chip
          size="small"
          color={account.matchedBy ? "success" : "default"}
          variant="outlined"
          icon={<ShieldOutlinedIcon sx={{ fontSize: 12 }} />}
          label={`kept · ${account.keptBy}`}
          sx={tiny}
        />
      </Tooltip>
    );
  }
  return (
    <Typography variant="caption" sx={{ color: "text.disabled" }}>
      no
    </Typography>
  );
}

/**
 * Whether Kairos writes the account — and, for a kept one, the asterisk that
 * says the keep does not stop that. "zeroes" rather than "yes" when every
 * Kairos row for it is zero, because that is the case where a Replace month
 * wipes the account despite the exception.
 */
function WrittenCell({
  account,
  anyWriteMonths,
}: {
  account: ClearScopeAccount;
  anyWriteMonths: boolean;
}) {
  if (!account.written) {
    return (
      <Typography variant="caption" sx={{ color: "text.disabled" }}>
        no
      </Typography>
    );
  }
  const kept = Boolean(account.matchedBy && account.keptBy);
  const label = account.hasData ? "yes" : "zeroes";
  const chip = (
    <Chip
      size="small"
      color={kept && anyWriteMonths ? "warning" : "success"}
      variant="outlined"
      label={kept && anyWriteMonths ? `${label} *` : label}
      sx={{ height: 18, fontSize: "0.625rem" }}
    />
  );
  if (!kept || !anyWriteMonths) return chip;
  return (
    <Tooltip
      title={
        account.hasData
          ? "Kept from clearing, but Kairos has values for it and writes them in every replaced or added month."
          : "Kept from clearing, but Kairos holds only zeroes for it and writes them in every replaced or added month unless unused combos are skipped."
      }
    >
      {chip}
    </Tooltip>
  );
}

/**
 * The per-row shortcut: Keep a cleared account, or Clear a kept / uncovered
 * one. Exactly one account each time — the row's own code — so a click never
 * has a wider effect than the row it sits on.
 */
function RowAction({
  account,
  busy,
  onKeep,
  onClear,
  onRemoveKeep,
}: {
  account: ClearScopeAccount;
  busy: boolean;
  onKeep: (bare: string) => void;
  onClear: (bare: string) => void;
  onRemoveKeep: (exclude: string) => void;
}) {
  const bare = bareOf(account);
  const tiny = { textTransform: "none", minWidth: 0, px: 0.75, py: 0, fontSize: "0.6875rem" } as const;

  if (account.matchedBy && !account.keptBy) {
    return (
      <Tooltip title={`Add a ${bare} exception so this account is never cleared.`}>
        <span>
          <Button size="small" disabled={busy} startIcon={<ShieldOutlinedIcon />} onClick={() => onKeep(bare)} sx={tiny}>
            Keep
          </Button>
        </span>
      </Tooltip>
    );
  }
  if (account.keptBy) {
    const exact = account.keptBy === bare;
    return (
      <Tooltip
        title={
          exact
            ? `Remove the ${bare} exception so the rules apply again.`
            : `Kept by the broader ${account.keptBy} exception — remove that exception to clear this account.`
        }
      >
        <span>
          <Button size="small" disabled={busy || !exact} startIcon={<DeleteOutlineIcon />} onClick={() => onRemoveKeep(bare)} sx={tiny}>
            Clear
          </Button>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={`Add a ${bare} rule so this account is cleared too.`}>
      <span>
        <Button size="small" disabled={busy} startIcon={<DeleteOutlineIcon />} onClick={() => onClear(bare)} sx={tiny}>
          Clear
        </Button>
      </span>
    </Tooltip>
  );
}
