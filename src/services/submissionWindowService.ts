import api from './api';

/**
 * A single Owner-Budget submission window as returned by the API.
 * Windows are created/locked by admins directly in the database; the API only
 * reads them and stamps a submission date. A budget row may only be submitted
 * if its (ou, scenario, version, period) falls inside an open (unlocked) window.
 */
export interface SubmissionWindow {
  id: number;
  ou: string;
  /** Dropdown label, e.g. "2027 - Owner Budget" */
  name: string;
  /** Scenario to submit under — fed into the upload rows, never typed by the user */
  scenario: string;
  /** Version to submit under — fed into the upload rows, never typed by the user */
  version: string;
  /** First month, YYYY-MM */
  start_period: string;
  /** Number of consecutive months (usually 12) */
  period_count: number;
  /** false = open/submittable; true = show disabled */
  is_locked: boolean;
  /** Last successful submit for this window, or null */
  last_submission_date: string | null;
  /** User id of the last submitter, or null */
  last_submitted_by: number | null;
}

/** One month column of a window, derived from start_period + offset. */
export interface WindowMonth {
  /** Column header as it appears in the BST extract, e.g. "M1" */
  col: string;
  /** Period in YYYY-MM */
  period: string;
  /** Human label, e.g. "Jan 2027" */
  label: string;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Derive the consecutive months covered by a window.
 *
 * Starts at `startPeriod` (YYYY-MM) and steps forward `count` months, rolling
 * the year over. e.g. deriveWindowMonths("2027-11", 3) →
 *   [M1 2027-11 "Nov 2027", M2 2027-12 "Dec 2027", M3 2028-01 "Jan 2028"]
 *
 * Pure + side-effect free so it can drive the periods table and (later) the ETL.
 */
export function deriveWindowMonths(startPeriod: string, count: number): WindowMonth[] {
  const [startYearStr, startMonthStr] = (startPeriod || '').split('-');
  const startYear = Number(startYearStr);
  const startMonth = Number(startMonthStr); // 1-12

  if (!Number.isFinite(startYear) || !Number.isFinite(startMonth) || count <= 0) {
    return [];
  }

  const months: WindowMonth[] = [];
  for (let i = 0; i < count; i++) {
    const monthIndex = (startMonth - 1) + i; // 0-based, may exceed 11
    const year = startYear + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1; // back to 1-12
    months.push({
      col: `M${i + 1}`,
      period: `${year}-${String(month).padStart(2, '0')}`,
      label: `${MONTH_LABELS[month - 1]} ${year}`,
    });
  }
  return months;
}

class SubmissionWindowService {
  /**
   * Fetch the Owner-Budget submission windows for the OUs the user can access.
   * Locked windows are returned too so the GUI can show them greyed-out.
   *
   * @param ou Optional OU to restrict to. Omit to get all the user's OUs.
   */
  async fetchSubmissionWindows(ou?: string): Promise<SubmissionWindow[]> {
    const endpoint = ou
      ? `/submission-windows/?ou=${encodeURIComponent(ou)}`
      : `/submission-windows/`;

    const response = await api.get(endpoint);

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error('Access denied to this OU');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to fetch submission windows');
    }

    return await response.json();
  }
}

export default new SubmissionWindowService();
