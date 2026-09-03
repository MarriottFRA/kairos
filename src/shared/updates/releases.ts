/**
 * Release notes — the content behind the app bar's bell.
 * -----------------------------------------------------------
 * Notes are NUMBERED, and the read marker is a single number: the highest note
 * id the user has opened (`updatesSeenId` in user_settings, the plaintext
 * store). Writing the next note is adding an entry with the next id — the dot
 * comes back on its own, and nothing else has to be touched.
 *
 * Deliberately NOT versioned against package.json. The app version rolls on its
 * own release cadence — several builds can ship between two things worth
 * telling anyone about, and a note that had to name a version would either lie
 * or force a bump. The note carries a DATE and nothing else; the changes
 * themselves say what the release was.
 *
 * Note 1 is the first note there has ever been, so it deliberately reaches back
 * past the current release: rate rules, Composite and Compound bases all
 * shipped without a word, and "already there, nobody knew" is exactly the
 * problem this feature exists to fix.
 */

/** One headline change — a name, where to find it, and what it does. */
export interface UpdateItem {
  title: string;
  /** Where it lives, e.g. "Positions › Blocks". Rendered as a quiet caption. */
  where?: string;
  body: string;
}

export interface UpdateNote {
  /** Notification number. Monotonic; the read marker is the highest seen. */
  id: number;
  /** ISO date, shown under the title. */
  date: string;
  /** Given their own card and a "New" tag. */
  new: UpdateItem[];
  /** Existing things that got better. Title + body, no tag. */
  improved: UpdateItem[];
  /** One-liners. Kept modest on purpose. */
  fixes: string[];
  /** Older note only: open it in the dialog rather than collapsed behind its
   *  date. For a note still worth reading when the next one lands on top of it —
   *  people do not click a folded heading, and a small improvement should not
   *  bury a release nobody has read yet. Drop the flag once it has had its run;
   *  collapsed is the resting state. Ignored on the newest note, which is always
   *  open. */
  startOpen?: boolean;
}

/** Newest first — index 0 is the one the bell is about, and the rest stay in the
 *  dialog underneath it (collapsed unless the note sets `startOpen`). Nothing is
 *  ever removed from this list: a note is the only place a feature is announced,
 *  so deleting one un-announces it. A note may leave any of its three sections
 *  empty. */
export const UPDATE_NOTES: UpdateNote[] = [
  {
    id: 2,
    date: "2026-09-03",
    new: [],
    improved: [
      {
        title: "Input Basis on positions",
        body:
          "A new column at the front of the Contract band says what period a row's yearly figures cover: a full twelve-month contract, or only the months the post actually works. Contract days, vacation, the manual increase, Manhours Worked, FTE and Monthly Basic all read it. Positions you already have keep exactly the figures they have.",
      },
    ],
    fixes: [],
  },
  {
    id: 1,
    date: "2026-09-02",
    // Still open: note 2 is a single improvement and this one is the release
    // most people have not read yet. Remove when note 3 lands.
    startOpen: true,
    new: [
      {
        title: "Rates by rules",
        where: "Positions › Blocks › Multiplier",
        body:
          "A multiplier can work out each row's rate instead of you typing it. Build an ordered list of IF … THEN rules with an Otherwise fallback — the first match wins. Conditions read any position field (including columns you added yourself), a KPI driver, or length of service, and the outcome is either a fixed number or another block's monthly value. A rule that changes part-way through the year — a service milestone, a KPI crossing a threshold — applies from the month it changes.",
      },
      {
        title: "Composite bases",
        where: "Positions › Blocks › Multiplier › Build a base",
        body:
          "Add any number of bases together and multiply the total — “% of salary + allowances”. Rules work on top of a composite base.",
      },
      {
        title: "Compound bases",
        where: "Positions › Blocks › Multiplier › Build a base",
        body:
          "Two bases either side of + − × ÷ — a difference, a product, or a rate such as salary ÷ hours. Rules work on these too, so a ratio can drive its own multiplier.",
      },
      {
        title: "Put your blocks in your own order",
        where: "Positions › Blocks",
        body:
          "Drag blocks into the order you want them read. The order follows through to the grid columns and the Edit position form, and it is saved with the hotel. Only the order moves — no number changes.",
      },
      {
        title: "Pin columns",
        where: "Positions",
        body:
          "Any column can now be pinned left or right from its column menu, so the name, department or a block band stays in view while you scroll across the year. Pinned columns keep their row and block colouring, and your pinning is saved with the rest of the layout — it is still there next time you open the grid.",
      },
      {
        title: "Land a year in chosen months",
        where: "Positions › Blocks › Multiplier",
        body:
          "A multiplier's whole yearly figure can be booked into the months you pick — the 13th-month shape. Pick several and it splits evenly between them. The yearly total is unchanged; it only moves.",
      },
      {
        title: "Spread by weekday",
        where: "Positions › Blocks",
        body:
          "Book an amount once per selected weekday, so a month with five Fridays books five times and February books four. Useful for anything paid per shift rather than per month.",
      },
      {
        title: "Copy a hotel's setup into another",
        where: "Positions › Blocks",
        body:
          "Set one hotel up properly, then copy the whole structure across: field catalog, blocks, NI and social security schemes, KPI drivers, allocations, calendar and position defaults. Offered while the receiving hotel's blocks are still untouched, and it either lands completely or not at all. Positions and anything scenario-specific are never copied.",
      },
      {
        title: "Manual rows can follow the budget",
        where: "Manual Input",
        body:
          "A manual row no longer has to be twelve typed numbers. Point its Stats at a KPI driver and they are worked out from live budget figures — “20 hours per 50,000 of revenue”, as KPI ÷ Per × Units — and set a Rate beside it to turn those units into money, Stats × Rate. Nothing is baked in: pull a fresh budget and every driven row moves with it, on the page and in the Results. Driver, Per, Units and Rate now sit together in one band you can fold away, and derived cells are marked and locked, so it is always clear which numbers are yours and which are worked out.",
      },
      {
        title: "You decide what a push may touch",
        where: "BST Push",
        body:
          "Protection-locked cells and the BST's own allocation rows each have their own setting — leave alone, overwrite, or clear to zero — so cells the push always refused can now be written when that is what you want. Both start on leave alone, and where a cell falls under both the more careful setting wins. Alongside them the clear rules are an editable list rather than a hidden assumption, and your month-by-month plan is remembered between sessions.",
      },
      {
        title: "Copy and paste with the mouse",
        where: "Positions, Manual Input",
        body:
          "Copy and Paste are on the right-click menu as well as Ctrl+C / Ctrl+V, for anyone who would rather not chord. Both go through the same path as the keyboard, so locked and masked cells stay protected.",
      },
    ],
    improved: [
      {
        title: "Copying positions between years and scenarios",
        body:
          "The dialog now spells out exactly which year and scenario the positions are landing in before you commit.",
      },
      {
        title: "Read-only delegations are honoured everywhere",
        body:
          "A read-only grant is read-only across the whole grid, including departments nobody has claimed, and a read-only delegate is no longer reported as mid-edit.",
      },
      {
        title: "Owners are no longer locked out of empty departments",
        body:
          "A department with no rows yet used to be missing from the ownership answer and so was treated as refused. A full-scope owner can now open and edit it.",
      },
      {
        title: "Push and Results always agree",
        body:
          "BST Push recalculates the scenario through exactly the same path the Results page uses, so what is written to the workbook is what the Results page shows.",
      },
      {
        title: "Grid columns keep their place",
        body:
          "Column order, widths, visibility, pinning and density survive a reload — and so do the totals: a sum or an average switched on from a column's menu is still at the foot of that column next time you open the grid. A grid you have set up the way you like stays that way.",
      },
    ],
    fixes: [
      "Pasted values respect locked departments and masked columns.",
      "Manual rows derive the same figure on screen as in the saved output.",
      "Malformed saved block settings read back safely instead of blocking the page.",
      "Assorted performance and stability improvements.",
    ],
  },
];

/** The note the bell is about. */
export const LATEST_UPDATE = UPDATE_NOTES[0];

/** Read marker: the dot shows while `updatesSeenId` is below this. */
export const LATEST_UPDATE_ID = LATEST_UPDATE.id;
