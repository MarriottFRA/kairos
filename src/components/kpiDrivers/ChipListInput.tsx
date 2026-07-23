/**
 * ChipListInput — a freeform "type a token, Enter to add" chip editor.
 *
 * KPI dept patterns (GLOB, e.g. D00??) and account prefixes (e.g. A3) are short
 * freeform tokens, not picks from a fixed list, so a chip input fits better than
 * the exact-account AccountAutocomplete. Tokens are upper-cased and de-duped on
 * add (matching the repo's normalization); comma or Enter commits.
 */

import { useState, KeyboardEvent } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import TextField from "@mui/material/TextField";

export interface ChipListInputProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  helperText?: string;
  error?: boolean;
  disabled?: boolean;
}

export default function ChipListInput({
  label,
  values,
  onChange,
  placeholder,
  helperText,
  error,
  disabled,
}: ChipListInputProps) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const token = raw.trim().toUpperCase();
    if (!token) return;
    if (!values.includes(token)) onChange([...values, token]);
    setDraft("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  const remove = (token: string) => onChange(values.filter((v) => v !== token));

  return (
    <Box>
      <TextField
        label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={placeholder}
        helperText={helperText}
        error={error}
        disabled={disabled}
        size="small"
        fullWidth
      />
      {values.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
          {values.map((token) => (
            <Chip
              key={token}
              label={token}
              size="small"
              onDelete={disabled ? undefined : () => remove(token)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
