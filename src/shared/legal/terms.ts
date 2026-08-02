/**
 * Terms of use — single source for the one-time acceptance modal and the
 * Settings card that lets a user re-read what they accepted.
 *
 * The substance is one point made several ways: Kairos computes, the user
 * decides. Every figure it produces comes from inputs and assumptions the user
 * controls, so the user — not the tool — is the last check before anything is
 * relied upon.
 *
 * TERMS_VERSION is the acceptance gate. Bump it whenever the wording below
 * changes in a way a user would need to see again; every user is then re-
 * prompted on next launch and the new acceptance is recorded against the new
 * version. Cosmetic edits (typos, formatting) do not need a bump.
 */

export const TERMS_VERSION = "1.0";

export const TERMS_TITLE = "Terms of Use and Acknowledgement of Responsibility";

export const TERMS_INTRO =
  "Please read the following before using Kairos. This is shown once — you can " +
  "re-read it at any time from Settings.";

export interface TermsSection {
  heading: string;
  body: string;
}

export const TERMS_SECTIONS: TermsSection[] = [
  {
    heading: "1. Provision of the tool",
    body:
      "Kairos is provided for internal planning, budgeting and forecasting use " +
      "on an \"as is\" and \"as available\" basis, without warranty of any kind, " +
      "whether express or implied, including any implied warranty of accuracy, " +
      "merchantability or fitness for a particular purpose.",
  },
  {
    heading: "2. Ongoing development and support",
    body:
      "Kairos is actively maintained. Its calculations, imports and reports are " +
      "developed with care and tested against the source models they replace, " +
      "and reported defects will be investigated and corrected as promptly as " +
      "is practicable. Features and behaviour may change between releases.",
  },
  {
    heading: "3. Your inputs determine your outputs",
    body:
      "You control the data entered into Kairos and the assumptions, rates, " +
      "drivers and structures configured within it. All output is derived from " +
      "those inputs. Incomplete, out-of-date or incorrect inputs will produce " +
      "incorrect output, and the tool cannot determine on your behalf whether an " +
      "input reflects your organisation's intent.",
  },
  {
    heading: "4. You hold the final say on accuracy",
    body:
      "You remain responsible for reviewing and validating every figure produced " +
      "by Kairos before it is used, submitted, published or otherwise relied " +
      "upon, whether internally or externally. Output is a working aid and not a " +
      "substitute for your own professional judgement; no figure should be " +
      "treated as final or authoritative until you have reviewed it. Where " +
      "output disagrees with an authoritative source or your own expectation, " +
      "your review governs.",
  },
  {
    heading: "5. Reporting suspected errors",
    body:
      "Kairos models a large number of interacting rules, and an error may not be " +
      "apparent from within the tool. If output looks wrong, please raise it " +
      "through Help & Support with enough detail to reproduce it. Issues that are " +
      "not reported cannot be corrected.",
  },
  {
    heading: "6. Limitation of liability",
    body:
      "To the fullest extent permitted by law, no liability is accepted for any " +
      "loss, cost, damage or decision arising from the use of, or reliance on, " +
      "Kairos output that has not been independently reviewed and verified by " +
      "the user.",
  },
];

export const TERMS_ACKNOWLEDGEMENT =
  "I have read and understood the above, and I accept that I am responsible " +
  "for reviewing and validating all data and output produced by Kairos before " +
  "it is used or relied upon.";
