/**
 * The status dot's colour, in one place.
 *
 * Both the plan cards and the delegation cards lead with a coloured dot and a
 * one-sentence state. They have to agree on what the colours mean — a reader
 * scanning the Sync page and then the Delegation page is reading the same
 * vocabulary — and a constant living inside one of the two components would
 * make the other import a whole card to draw a circle.
 *
 * `attention` is the only one that draws: it means there is something to do.
 */
import { PlanState } from "../../shared/kairosSync/planState";

export const TONE_COLOUR: Record<PlanState["tone"], string> = {
  neutral: "text.disabled",
  good: "success.main",
  attention: "warning.main",
  blocked: "error.main",
};
