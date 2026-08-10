/**
 * Hand a plan to a new owner.
 * -----------------------------------------------------------
 * Not an administrator action. `plan:transfer` is an OWNER capability, so the
 * plan's own owner calls this directly, with no lease and nobody else involved.
 * An administrator transferring somebody else's plan needs a lease first, as
 * with any other write — the Sync page prompts for one rather than letting the
 * refusal arrive as a 403.
 *
 * ## Why this exists at all
 *
 * Because a delegate can never push to the budget workbook, however many
 * departments they hold. If the person who builds a plan is not the person who
 * loads it into the workbook — an HR director building it, a finance director
 * pushing it — delegation cannot express that. The plan has to change hands.
 *
 * ## What the dialog has to say out loud
 *
 * Transferring is not reversible from this end: afterwards you cannot edit the
 * plan or transfer it back. The incoming owner's own delegation is revoked in
 * the same transaction, because an owner is not a delegate of themselves;
 * everybody else's survives, so the new owner inherits the existing delegates
 * intact. And BST push moves with ownership, which for most hotels is the point
 * of doing it.
 *
 * ## You do not lose sight of the plan
 *
 * The bullets used to say you become an ordinary member of the hotel on this
 * plan, which was true and was the problem: hotel access confers no read, so the
 * person who built the numbers dropped to seeing the plan exist and not one byte
 * of it. The handover now leaves them a read-only delegation over every
 * department, granted by the incoming owner — an ordinary delegation, withdrawn
 * by the ordinary DELETE whenever the new owner likes.
 *
 * Saying so here matters more than it looks. The bullets are what somebody reads
 * while deciding whether to press the button, and "I will lose the plan" is the
 * belief that stops a handover happening at all — which is how a plan ends up
 * stranded on a departing owner's account instead.
 *
 * What this dialog must NOT promise is that they definitely keep it. Retention
 * is best effort and is skipped for an owner who has already been deactivated —
 * the commonest reason to hand a plan over. The Sync page reads the outcome off
 * the response and says which way it went; the bullet stays hedged.
 *
 * The candidate list is `/delegation-candidates`, which is the same set of
 * people and the same eligibility data. Note it answers a slightly different
 * question — it screens for delegation, and ownership needs the full bar
 * (all departments, write access, the right access type). So `eligible` here is
 * necessary but not sufficient, and the server's `kairos_owner_not_eligible` is
 * rendered in full rather than reduced to "no".
 */

import { useState } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { DelegationCandidate } from "../../shared/kairosSync/protocol";

export interface TransferOwnershipDialogProps {
  open: boolean;
  busy: boolean;
  planLabel: string;
  candidates: DelegationCandidate[];
  candidatesLoading: boolean;
  /**
   * The `context` of a `kairos_owner_not_eligible` refusal, if the last attempt
   * was refused. Rendered as the list of conditions the successor must meet.
   */
  ineligible: Record<string, unknown> | null;
  onSearch: (query: string) => void;
  onSubmit: (newOwnerUserId: number, reason: string) => void;
  onClose: () => void;
}

export default function TransferOwnershipDialog({
  open,
  busy,
  planLabel,
  candidates,
  candidatesLoading,
  ineligible,
  onSearch,
  onSubmit,
  onClose,
}: TransferOwnershipDialogProps) {
  const [person, setPerson] = useState<DelegationCandidate | null>(null);
  const [reason, setReason] = useState("");

  const valid = person !== null && reason.trim().length >= 3;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Transfer ownership</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Gives <strong>{planLabel}</strong> to somebody else.
        </Typography>

        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>What changes</AlertTitle>
          <Box component="ul" sx={{ pl: 2.5, m: 0 }}>
            <li>They can delegate, publish and push this plan to the budget workbook.</li>
            <li>
              You keep a read-only view of it — you can open it and read every
              department, but not edit it or take it back. The new owner can withdraw
              that view whenever they like.
            </li>
            <li>
              Everyone you have delegated to keeps their departments. If the new owner
              is one of them, their delegation is withdrawn — an owner does not need
              one.
            </li>
          </Box>
        </Alert>

        {ineligible && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <AlertTitle>They cannot own a plan at this hotel</AlertTitle>
            <Typography variant="body2" sx={{ mb: 1 }}>
              Owning requires all of the following. Their administrator can grant
              what is missing.
            </Typography>
            <RequirementList context={ineligible} />
          </Alert>
        )}

        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              New owner
            </Typography>
            <Autocomplete
              options={candidates}
              value={person}
              loading={candidatesLoading}
              getOptionLabel={(option) => option.email}
              onChange={(_event, value) => setPerson(value)}
              onInputChange={(_event, value) => onSearch(value)}
              renderOption={(optionProps, option) => (
                <li {...optionProps} key={option.userId}>
                  <ListItemText
                    primary={option.email}
                    secondary={
                      option.deptScope.mode === "ALL"
                        ? `${option.accessType} · all departments`
                        : `${option.accessType} · ${option.deptScope.departments.length} departments`
                    }
                  />
                  {option.deptScope.mode !== "ALL" && (
                    // Not disabled — this list screens for delegation, and only
                    // the server can decide ownership. But an owner hands out
                    // slices of a plan they must be able to see whole, so a
                    // partial-department successor will almost certainly be
                    // refused, and saying so beats a 422.
                    <Chip size="small" color="warning" label="Not all departments" />
                  )}
                </li>
              )}
              renderInput={(params) => (
                <TextField {...params} placeholder="Search colleagues at this hotel" />
              )}
            />
          </Box>

          <TextField
            fullWidth
            required
            label="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            helperText="Recorded on the audit trail. “Previous owner left the business” is a perfectly good one."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="warning"
          disabled={busy || !valid}
          onClick={() => person && onSubmit(person.userId, reason.trim())}
        >
          Transfer
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The server's `context.required` block, as a list.
 *
 * Printed from whatever arrives rather than from a fixed set of conditions: the
 * eligibility bar is the server's to define, and a client that only rendered the
 * four conditions it knew about would hide the fifth one that is the problem.
 */
function RequirementList({ context }: { context: Record<string, unknown> }) {
  const required = (context.required ?? context) as Record<string, unknown>;
  const entries = Object.entries(required);
  if (entries.length === 0) return null;

  return (
    <Box component="ul" sx={{ pl: 2.5, m: 0 }}>
      {entries.map(([key, value]) => (
        <li key={key}>
          <Typography variant="body2">
            <strong>{key}</strong>: {Array.isArray(value) ? value.join(", ") : String(value)}
          </Typography>
        </li>
      ))}
    </Box>
  );
}
