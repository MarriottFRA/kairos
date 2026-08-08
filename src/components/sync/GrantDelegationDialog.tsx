/**
 * Grant a delegation: pick departments, pick a person, set what they may do.
 * -----------------------------------------------------------
 * Two rules from the API guide are load-bearing here and neither is optional.
 *
 * **A department with no rows cannot be delegated.** "Delegatable" means it has
 * at least one live department-scoped row — a position, a buyout row or a manual
 * input line. The fix is to add a placeholder position first, so the reason is
 * shown rather than the department being quietly missing.
 *
 * **The partial-overlap warning must be surfaced.** Effective scope is
 * `requested ∩ what the delegate actually holds`, and both directions narrow. If
 * the server says two of the four departments will not take effect, the owner
 * sees exactly which two and confirms before the grant is retried with
 * `acknowledgeNonOverlap`. Suppressing that produces an owner who waits
 * indefinitely for work that can never be published.
 *
 * Candidates who are ineligible arrive WITH a reason and are shown greyed rather
 * than filtered out — "why isn't Anna in the list?" has to have an answer.
 *
 * ## What they will actually receive
 *
 * The overlap is computed and shown BEFORE submitting, from the candidate's own
 * `deptScope` which the candidate list already carries. The server still has the
 * last word — the effective set is intersected per request, not frozen at grant
 * time — but an owner should not learn that two of their four departments will
 * do nothing by being refused. `acknowledgeNonOverlap` then confirms something
 * already on the screen rather than answering a surprise.
 *
 * The row counts come along too. "3 departments" is an abstraction; "3
 * departments, 96 positions, and you will not be able to edit them until you
 * withdraw" is the sentence that stops somebody over-delegating.
 */

import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  DelegatableDepartment,
  DelegationCandidate,
  DelegationCreate,
  PartialOverlapContext,
} from "../../shared/kairosSync/protocol";

/** Why a department cannot be granted, in words the owner can act on. */
const UNGRANTABLE_REASON: Record<string, string> = {
  NO_LIVE_ROWS:
    "No positions or rows yet — add a placeholder position to this department first.",
  UNKNOWN_DEPARTMENT_CODE:
    "This code is not in the department mapping tables, so it cannot be delegated.",
};

/** Why a colleague cannot be delegated to. */
const INELIGIBLE_REASON: Record<string, string> = {
  IS_PLAN_OWNER: "Already owns this plan",
  NO_OU_ACCESS: "No access to this hotel",
  DEACTIVATED: "Account is not active",
  NO_APP_ACCESS: "No Kairos access",
  NO_DEPARTMENTS: "Has no department access",
};

export interface GrantDelegationDialogProps {
  open: boolean;
  busy: boolean;
  departments: DelegatableDepartment[];
  candidates: DelegationCandidate[];
  candidatesLoading: boolean;
  /** Non-null once the server has warned about a partial overlap. */
  overlap: PartialOverlapContext | null;
  onSearch: (query: string) => void;
  onSubmit: (body: DelegationCreate) => void;
  onClose: () => void;
}

export default function GrantDelegationDialog(props: GrantDelegationDialogProps) {
  const {
    open,
    busy,
    departments,
    candidates,
    candidatesLoading,
    overlap,
    onSearch,
    onSubmit,
    onClose,
  } = props;

  const [selected, setSelected] = useState<string[]>([]);
  const [person, setPerson] = useState<DelegationCandidate | null>(null);
  const [canAddRows, setCanAddRows] = useState(true);
  const [canDeleteRows, setCanDeleteRows] = useState(false);
  const [canReadPii, setCanReadPii] = useState(true);

  // A fresh dialog every time it opens: leaving the previous grant's
  // departments ticked is how somebody delegates Housekeeping by accident.
  useEffect(() => {
    if (open) {
      setSelected([]);
      setPerson(null);
      setCanAddRows(true);
      setCanDeleteRows(false);
      setCanReadPii(true);
    }
  }, [open]);

  const grantable = useMemo(
    () => departments.filter((department) => department.grantable),
    [departments]
  );
  const blocked = useMemo(
    () => departments.filter((department) => !department.grantable),
    [departments]
  );

  /**
   * The intersection, computed from data already on the client.
   *
   * `deptScope.mode === "ALL"` is the common case for a hotel admin and means
   * everything requested lands. A LIST narrows it. This mirrors the server's
   * rule rather than replacing it — the grant still goes through the same
   * validation, and a 422 still wins.
   */
  const effective = useMemo(() => {
    const rows = grantable
      .filter((department) => selected.includes(department.code))
      .reduce((total, department) => total + department.activeCount, 0);

    if (!person || person.deptScope.mode === "ALL") {
      return { effective: selected, ineffective: [] as string[], rows };
    }
    const theirs = new Set(person.deptScope.departments);
    return {
      effective: selected.filter((code) => theirs.has(code)),
      ineffective: selected.filter((code) => !theirs.has(code)),
      rows,
    };
  }, [selected, person, grantable]);

  const submit = (acknowledge: boolean) => {
    if (!person) return;
    onSubmit({
      delegateUserId: person.userId,
      departments: selected,
      canEdit: true,
      canAddRows,
      canDeleteRows,
      canReadPii,
      expiresAt: null,
      acknowledgeNonOverlap: acknowledge,
    });
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Delegate departments</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Departments
            </Typography>
            <Autocomplete
              multiple
              disableCloseOnSelect
              options={grantable}
              value={grantable.filter((d) => selected.includes(d.code))}
              getOptionLabel={(option) => option.code}
              onChange={(_event, value) => setSelected(value.map((d) => d.code))}
              renderOption={(optionProps, option, { selected: isSelected }) => (
                <li {...optionProps} key={option.code}>
                  <Checkbox checked={isSelected} sx={{ mr: 1 }} />
                  <ListItemText
                    primary={option.code}
                    secondary={`${option.activeCount} rows${
                      option.delegatedTo.length
                        ? ` · already with ${option.delegatedTo
                            .map((holder) => holder.email)
                            .join(", ")}`
                        : ""
                    }`}
                  />
                </li>
              )}
              renderInput={(params) => (
                <TextField {...params} placeholder="Choose one or more" />
              )}
            />

            {blocked.length > 0 && (
              <Alert severity="info" sx={{ mt: 2 }}>
                <AlertTitle>
                  {blocked.length} {blocked.length === 1 ? "department" : "departments"}{" "}
                  cannot be delegated yet
                </AlertTitle>
                <Stack spacing={0.5} sx={{ mt: 1 }}>
                  {blocked.map((department) => (
                    <Typography key={department.code} variant="body2">
                      <strong>{department.code}</strong> —{" "}
                      {UNGRANTABLE_REASON[department.reason ?? ""] ?? department.reason}
                    </Typography>
                  ))}
                </Stack>
              </Alert>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Delegate to
            </Typography>
            <Autocomplete
              options={candidates}
              value={person}
              loading={candidatesLoading}
              getOptionLabel={(option) => option.email}
              getOptionDisabled={(option) => !option.eligible}
              onChange={(_event, value) => setPerson(value)}
              onInputChange={(_event, value) => onSearch(value)}
              renderOption={(optionProps, option) => (
                <li {...optionProps} key={option.userId}>
                  <ListItemText
                    primary={option.email}
                    secondary={
                      option.eligible
                        ? option.deptScope.mode === "ALL"
                          ? "All departments"
                          : `${option.deptScope.departments.length} departments`
                        : // Shown, not hidden: the owner needs to know WHY
                          // somebody they expected to see cannot be chosen.
                          option.reasons
                            .map((reason) => INELIGIBLE_REASON[reason] ?? reason)
                            .join(" · ")
                    }
                  />
                  {option.existingDelegationId && (
                    <Chip size="small" label="Already delegated" />
                  )}
                </li>
              )}
              renderInput={(params) => (
                // The Autocomplete's own `loading` prop renders the progress
                // state; overriding the input's adornments to add a spinner
                // would mean reaching into slot internals for something already
                // handled.
                <TextField {...params} placeholder="Search colleagues at this hotel" />
              )}
            />
            <Typography variant="caption" color="text.secondary">
              Only people with access to this hotel are listed. Delegating gives
              them nothing outside this plan.
            </Typography>
          </Box>

          {selected.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                What they will get
              </Typography>
              <Alert severity={effective.ineffective.length > 0 ? "warning" : "info"}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap", mb: 1 }}>
                  {effective.effective.map((code) => (
                    <Chip key={code} size="small" color="success" label={code} />
                  ))}
                  {effective.ineffective.map((code) => (
                    <Chip
                      key={code}
                      size="small"
                      variant="outlined"
                      label={code}
                      sx={{ textDecoration: "line-through", opacity: 0.7 }}
                    />
                  ))}
                </Stack>

                {!person ? (
                  <Typography variant="body2">
                    Choose a colleague below to see which of these will take
                    effect for them.
                  </Typography>
                ) : effective.ineffective.length > 0 ? (
                  <Typography variant="body2">
                    <strong>
                      {effective.ineffective.length} of these will do nothing:
                    </strong>{" "}
                    {person.email} does not have access to{" "}
                    {effective.ineffective.join(", ")}. The grant is still
                    recorded, so if their access is widened later it starts
                    working with no second action.
                  </Typography>
                ) : (
                  <Typography variant="body2">
                    All {effective.effective.length} will take effect.
                  </Typography>
                )}

                <Typography variant="body2" sx={{ mt: 1 }}>
                  {effective.rows} {effective.rows === 1 ? "position" : "positions"} in
                  total. You will not be able to edit these departments yourself
                  until you withdraw the delegation.
                </Typography>
              </Alert>
            </Box>
          )}

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              They may
            </Typography>
            <Stack>
              <FormControlLabel
                control={<Checkbox checked disabled />}
                label="Edit rows in these departments"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={canAddRows}
                    onChange={(event) => setCanAddRows(event.target.checked)}
                  />
                }
                label="Add new rows"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={canDeleteRows}
                    onChange={(event) => setCanDeleteRows(event.target.checked)}
                  />
                }
                label="Delete rows"
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={canReadPii}
                    onChange={(event) => setCanReadPii(event.target.checked)}
                  />
                }
                label="See employee names and personal details"
              />
            </Stack>
          </Box>

          {overlap && (
            // The server's own version of the warning above. It still runs: the
            // client-side preview is built from the candidate list, which can be
            // a few seconds stale, and the effective set is resolved per request.
            // When both agree this simply restates it; when they disagree, the
            // server is right.
            <Alert severity="warning">
              <AlertTitle>Some departments will not take effect</AlertTitle>
              <Typography variant="body2" sx={{ mb: 1 }}>
                This person does not have access to{" "}
                <strong>{overlap.nonOverlapping.join(", ")}</strong>, so those will
                be recorded but will do nothing until their access is widened.
              </Typography>
              <Typography variant="body2">
                They will be able to edit:{" "}
                <strong>{overlap.effective.join(", ") || "nothing"}</strong>.
              </Typography>
              {overlap.remedy && (
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                  {overlap.remedy}
                </Typography>
              )}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={busy || !person || selected.length === 0}
          // Acknowledged up front when the preview already showed the shortfall:
          // the owner has seen exactly which departments will do nothing, so a
          // second round trip to tell them again is a speed bump with no
          // information in it. A shortfall only the server knows about still
          // comes back as `overlap` and still stops here first.
          onClick={() => submit(overlap !== null || effective.ineffective.length > 0)}
          color={overlap || effective.ineffective.length > 0 ? "warning" : "primary"}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          {overlap || effective.ineffective.length > 0
            ? `Delegate ${effective.effective.length} of ${selected.length}`
            : "Delegate"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
