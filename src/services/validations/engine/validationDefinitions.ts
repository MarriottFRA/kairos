/**
 * Validation Definitions
 * ======================
 *
 * All validation functions defined in one place.
 *
 * To add a new validation:
 * 1. Add the validation name to PostgreSQL via the API (for the relevant OU)
 * 2. Add the corresponding function here with the same name as the key
 *
 * The key in this object MUST match the 'name' field in the PostgreSQL validations table.
 *
 * COMBO ID FORMAT:
 * - dep_acc_combo_id = "D{department}_A{account}" e.g., "D0480_A701110"
 * - department column = "D0480" (with D prefix)
 * - account column = "A701110" (with A prefix)
 */

import { ValidationResult, ValidationOptions, ValidationFn } from './ValidationEngine';

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - COMBO BASED (uses dep_acc_combo_id for performance)
// ═══════════════════════════════════════════════════════════════════════════

interface ComboCheckConfig {
  /** Department code (without D prefix), e.g., "0480" - use "_" for single char wildcard */
  department: string;
  /** Account code (without A prefix), e.g., "701110" - use "_" for single char wildcard */
  account: string;
  /** Error message to display when validation fails */
  errorMessage: string;
}

/**
 * Build a LIKE pattern for dep_acc_combo_id
 * Input: department="0480", account="701110"
 * Output: "D0480_A701110"
 */
function buildComboPattern(department: string, account: string): string {
  return `D${department}_A${account}`;
}

/**
 * Check that a combo exists AND has a non-zero value
 */
async function comboMustHaveValue(
  db: any,
  options: ValidationOptions,
  config: ComboCheckConfig
): Promise<ValidationResult> {
  const comboPattern = buildComboPattern(config.department, config.account);

  const result = await db.execute({
    sql: `
      SELECT dep_acc_combo_id, department, account, SUM(amount) as total_amount
      FROM financial_data_staging
      WHERE ou = ?
        AND dep_acc_combo_id LIKE ?
      GROUP BY dep_acc_combo_id, department, account
    `,
    args: [options.ou, comboPattern]
  });

  const rows = result.rows || [];
  const errors: string[] = [];

  if (rows.length === 0) {
    errors.push(config.errorMessage);
  } else {
    for (const row of rows) {
      if (row.total_amount === 0 || row.total_amount === null) {
        errors.push(`${config.errorMessage} (Combo: ${row.dep_acc_combo_id})`);
      }
    }
  }

  return {
    success: errors.length === 0,
    recordCount: rows.length,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: rows.length,
      issuesFound: errors.length
    }
  };
}

/**
 * Check that a combo has zero value (or doesn't exist)
 */
async function comboMustBeZero(
  db: any,
  options: ValidationOptions,
  config: ComboCheckConfig
): Promise<ValidationResult> {
  const comboPattern = buildComboPattern(config.department, config.account);

  const result = await db.execute({
    sql: `
      SELECT dep_acc_combo_id, department, account, SUM(amount) as total_amount
      FROM financial_data_staging
      WHERE ou = ?
        AND dep_acc_combo_id LIKE ?
        AND amount != 0
      GROUP BY dep_acc_combo_id, department, account
    `,
    args: [options.ou, comboPattern]
  });

  const rows = result.rows || [];
  const errors: string[] = [];

  for (const row of rows) {
    errors.push(`${config.errorMessage} (Combo: ${row.dep_acc_combo_id}, Amount: ${row.total_amount})`);
  }

  return {
    success: errors.length === 0,
    recordCount: rows.length,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: rows.length,
      issuesFound: errors.length
    }
  };
}

/**
 * Check that a combo only has values in January (month = 1)
 */
async function comboJanuaryOnly(
  db: any,
  options: ValidationOptions,
  config: ComboCheckConfig
): Promise<ValidationResult> {
  const comboPattern = buildComboPattern(config.department, config.account);

  const result = await db.execute({
    sql: `
      SELECT dep_acc_combo_id, department, account, month, SUM(amount) as total_amount
      FROM financial_data_staging
      WHERE ou = ?
        AND dep_acc_combo_id LIKE ?
        AND month != 1
        AND amount != 0
      GROUP BY dep_acc_combo_id, department, account, month
    `,
    args: [options.ou, comboPattern]
  });

  const rows = result.rows || [];
  const errors: string[] = [];

  for (const row of rows) {
    errors.push(`${config.errorMessage} (Combo: ${row.dep_acc_combo_id}, Month: ${row.month})`);
  }

  return {
    success: errors.length === 0,
    recordCount: rows.length,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: rows.length,
      issuesFound: errors.length
    }
  };
}

/**
 * Check that a combo line exists (even if value is zero)
 */
async function comboMustExist(
  db: any,
  options: ValidationOptions,
  config: ComboCheckConfig
): Promise<ValidationResult> {
  const comboPattern = buildComboPattern(config.department, config.account);

  const result = await db.execute({
    sql: `
      SELECT COUNT(*) as count
      FROM financial_data_staging
      WHERE ou = ?
        AND dep_acc_combo_id LIKE ?
    `,
    args: [options.ou, comboPattern]
  });

  const count = result.rows?.[0]?.count || 0;
  const errors: string[] = [];

  if (count === 0) {
    errors.push(config.errorMessage);
  }

  return {
    success: errors.length === 0,
    recordCount: count,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: 1,
      issuesFound: errors.length
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS - ACCOUNT ONLY (ignores department)
// Use these when the validation applies to an account regardless of department
// ═══════════════════════════════════════════════════════════════════════════

interface AccountCheckConfig {
  /** Account code (without A prefix), e.g., "701110" - use "_" for single char wildcard */
  account: string;
  /** Error message to display when validation fails */
  errorMessage: string;
}

/**
 * Check that an account exists AND has a non-zero value (any department)
 */
async function accountMustHaveValue(
  db: any,
  options: ValidationOptions,
  config: AccountCheckConfig
): Promise<ValidationResult> {
  const accountPattern = `A${config.account}`;

  const result = await db.execute({
    sql: `
      SELECT account, department, SUM(amount) as total_amount
      FROM financial_data_staging
      WHERE ou = ?
        AND account LIKE ?
      GROUP BY account, department
    `,
    args: [options.ou, accountPattern]
  });

  const rows = result.rows || [];
  const errors: string[] = [];

  if (rows.length === 0) {
    errors.push(config.errorMessage);
  } else {
    for (const row of rows) {
      if (row.total_amount === 0 || row.total_amount === null) {
        errors.push(`${config.errorMessage} (Account: ${row.account}, Dept: ${row.department})`);
      }
    }
  }

  return {
    success: errors.length === 0,
    recordCount: rows.length,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: rows.length,
      issuesFound: errors.length
    }
  };
}

/**
 * Check that an account has zero value (any department)
 */
async function accountMustBeZero(
  db: any,
  options: ValidationOptions,
  config: AccountCheckConfig
): Promise<ValidationResult> {
  const accountPattern = `A${config.account}`;

  const result = await db.execute({
    sql: `
      SELECT account, department, SUM(amount) as total_amount
      FROM financial_data_staging
      WHERE ou = ?
        AND account LIKE ?
        AND amount != 0
      GROUP BY account, department
    `,
    args: [options.ou, accountPattern]
  });

  const rows = result.rows || [];
  const errors: string[] = [];

  for (const row of rows) {
    errors.push(`${config.errorMessage} (Account: ${row.account}, Dept: ${row.department}, Amount: ${row.total_amount})`);
  }

  return {
    success: errors.length === 0,
    recordCount: rows.length,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: rows.length,
      issuesFound: errors.length
    }
  };
}

/**
 * Check that an account line exists (any department, even if value is zero)
 */
async function accountMustExist(
  db: any,
  options: ValidationOptions,
  config: AccountCheckConfig
): Promise<ValidationResult> {
  const accountPattern = `A${config.account}`;

  const result = await db.execute({
    sql: `
      SELECT COUNT(*) as count
      FROM financial_data_staging
      WHERE ou = ?
        AND account LIKE ?
    `,
    args: [options.ou, accountPattern]
  });

  const count = result.rows?.[0]?.count || 0;
  const errors: string[] = [];

  if (count === 0) {
    errors.push(config.errorMessage);
  }

  return {
    success: errors.length === 0,
    recordCount: count,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: 1,
      issuesFound: errors.length
    }
  };
}

/**
 * Check that an account only has values in January (any department)
 */
async function accountJanuaryOnly(
  db: any,
  options: ValidationOptions,
  config: AccountCheckConfig
): Promise<ValidationResult> {
  const accountPattern = `A${config.account}`;

  const result = await db.execute({
    sql: `
      SELECT account, department, month, SUM(amount) as total_amount
      FROM financial_data_staging
      WHERE ou = ?
        AND account LIKE ?
        AND month != 1
        AND amount != 0
      GROUP BY account, department, month
    `,
    args: [options.ou, accountPattern]
  });

  const rows = result.rows || [];
  const errors: string[] = [];

  for (const row of rows) {
    errors.push(`${config.errorMessage} (Account: ${row.account}, Dept: ${row.department}, Month: ${row.month})`);
  }

  return {
    success: errors.length === 0,
    recordCount: rows.length,
    errors: errors.length > 0 ? errors : undefined,
    stats: {
      recordsChecked: rows.length,
      issuesFound: errors.length
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

export const validationDefinitions: Record<string, ValidationFn> = {

  // ─────────────────────────────────────────────────────────────────────────
  // COMBO MUST HAVE NON-ZERO VALUE
  // Format: department (4 chars), account (6 chars)
  // Use "_" for single character wildcard, "%" for multi-character wildcard
  // ─────────────────────────────────────────────────────────────────────────

  royalty_fee_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '706001',
      errorMessage: 'No amount found for Royalty Fees'
    });
  },

  incentive_fee_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '701125',
      errorMessage: 'No amount found for incentive fee expense'
    });
  },

  ff_e_escrow_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '701110',
      errorMessage: 'No FF&E amount found please ensure this is added'
    });
  },

  threshold_priority_agor: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '948004',
      errorMessage: 'No AGOR amount found please ensure this is added'
    });
  },

  property_tax: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '720601',
      errorMessage: 'No property tax amount found please ensure this is added'
    });
  },

  building_insurance: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '730002',
      errorMessage: 'No amount found for building insurance expense'
    });
  },

  liability_insurance: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '730108',
      errorMessage: 'No liability insurance amount found please ensure this is added'
    });
  },

  marketing_ecommerce: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0470',
      account: '600212',
      errorMessage: 'No marketing ecommerce amount found please ensure this is added'
    });
  },

  base_management_fee: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '701120',
      errorMessage: 'The base management fee line should have a value please recheck data'
    });
  },

  fixed_rent_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '701728',
      errorMessage: 'The fixed rent expense line should have a value please recheck data'
    });
  },

  real_estate_tax: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '720701',
      errorMessage: 'No real estate tax amount found please ensure this is added'
    });
  },

  owner_priority_threshold: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '948001',
      errorMessage: 'No owners priority/threshold amount found please ensure this is added'
    });
  },

  owner_priority_threshold_2nd: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '948017',
      errorMessage: 'Missing second owners priority/threshold amount please ensure this is added'
    });
  },

  other_tax: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '720901',
      errorMessage: 'Missing Municipality Fees and Duties amount please ensure this is added'
    });
  },

  owner_priority_threshold_2nd_alt: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '948022',
      errorMessage: 'Missing second owners priority/threshold amount please ensure this is added'
    });
  },

  incentive_fee_other: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '701126',
      errorMessage: 'No amount found for other incentive fee expense lines please populate this'
    });
  },

  other_owner_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '700341',
      errorMessage: 'There should be an amount populated for this line'
    });
  },

  rent_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '700306',
      errorMessage: 'This expense line should be populated'
    });
  },

  insurance_expense: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '730175',
      errorMessage: 'This expense line should be populated'
    });
  },

  ff_e_transfer: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0480',
      account: '759372',
      errorMessage: 'This line has forecast populated and requires actuals'
    });
  },

  ff_e_owner_funded: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '700320',
      errorMessage: 'This line has historical data populated and requires actuals'
    });
  },

  consulting_fees: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0490',
      account: '760656',
      errorMessage: 'This line should be populated please recheck data'
    });
  },

  marketing_fee: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0470',
      account: '760405',
      errorMessage: 'No Amount Found for Marketing Fee'
    });
  },

  loyalty_program_cost: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0470',
      account: '602101',
      errorMessage: 'No Amount Found for Loyalty Program'
    });
  },

  sold_rooms: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0010',
      account: '960103',
      errorMessage: 'No sold rooms amount found please ensure this is populated'
    });
  },

  total_rooms: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0010',
      account: '960101',
      errorMessage: 'No Total Rooms amount found for hotel, this needs to be populated'
    });
  },

  // PSF Accounts - uses pattern matching ("_" = single char wildcard in SQL LIKE)
  // This matches any department with account 77011X
  psf_accounts: async (db, options) => {
    return comboMustHaveValue(db, options, {
      department: '0410',
      account: '77011_',
      errorMessage: 'No amounts in PSF accounts please add these'
    });
  },

  // ─────────────────────────────────────────────────────────────────────────
  // COMBO MUST BE ZERO
  // ─────────────────────────────────────────────────────────────────────────

  no_other_tax: async (db, options) => {
    return comboMustBeZero(db, options, {
      department: '0480',
      account: '720901',
      errorMessage: 'The other tax fee line should be 0'
    });
  },

  no_base_management_fee: async (db, options) => {
    return comboMustBeZero(db, options, {
      department: '0480',
      account: '701120',
      errorMessage: 'The base management fee line should be 0'
    });
  },

  no_building_insurance: async (db, options) => {
    return comboMustBeZero(db, options, {
      department: '0480',
      account: '730002',
      errorMessage: 'No amount should be populated for building insurance line'
    });
  },

  no_other_owner_expense: async (db, options) => {
    return comboMustBeZero(db, options, {
      department: '0490',
      account: '700341',
      errorMessage: 'No amount should be populated for this line'
    });
  },

  no_real_estate_tax: async (db, options) => {
    return comboMustBeZero(db, options, {
      department: '0480',
      account: '720701',
      errorMessage: 'No amount should be populated for this line'
    });
  },

  // ─────────────────────────────────────────────────────────────────────────
  // COMBO JANUARY ONLY
  // ─────────────────────────────────────────────────────────────────────────

  threshold_priority_january: async (db, options) => {
    return comboJanuaryOnly(db, options, {
      department: '0490',
      account: '948004',
      errorMessage: 'This amount should only be populated in January'
    });
  },

  // Square meters - any department, specific account (use % for any dept)
  square_meters_january: async (db, options) => {
    return comboJanuaryOnly(db, options, {
      department: '____', // any 4-char department
      account: '957317',
      errorMessage: 'Square meters should only be populated in January'
    });
  },

  seat_counts_january: async (db, options) => {
    return comboJanuaryOnly(db, options, {
      department: '____', // any 4-char department
      account: '914020',
      errorMessage: 'Seat counts should only be populated in January'
    });
  },

  // ─────────────────────────────────────────────────────────────────────────
  // COMBO MUST EXIST (even if zero)
  // ─────────────────────────────────────────────────────────────────────────

  ff_e_escrow_line_exists: async (db, options) => {
    return comboMustExist(db, options, {
      department: '0480',
      account: '701110',
      errorMessage: 'No FF&E Line found, this must be submitted even if the value is 0'
    });
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CUSTOM / COMPLEX VALIDATIONS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * All customer stats for banquets should go to 0231, not 0230
   */
  no_0230_customer_stats: async (db, options) => {
    const result = await db.execute({
      sql: `
        SELECT dep_acc_combo_id, department, account, SUM(amount) as total
        FROM financial_data_staging
        WHERE ou = ?
          AND department = 'D0230'
          AND account LIKE 'A9140__'
        GROUP BY dep_acc_combo_id, department, account
      `,
      args: [options.ou]
    });

    const rows = result.rows || [];

    if (rows.length > 0) {
      return {
        success: false,
        recordCount: rows.length,
        errors: ['All customer stats for banquets should go to 0231, this has caused an error ytd'],
        errorDetails: [{
          type: 'INVALID_DEPARTMENT',
          message: 'Customer stats found in D0230 instead of D0231',
          count: rows.length,
          sampleRecords: rows.slice(0, 5)
        }]
      };
    }

    return { success: true, recordCount: 0 };
  },

  /**
   * Food cost lines must be coded to a Kitchen department (D0190-D0199)
   */
  food_cost_to_kitchen: async (db, options) => {
    const result = await db.execute({
      sql: `
        SELECT dep_acc_combo_id, department, account, SUM(amount) as total
        FROM financial_data_staging
        WHERE ou = ?
          AND account LIKE 'A414001'
          AND (department < 'D0190' OR department > 'D0199')
        GROUP BY dep_acc_combo_id, department, account
      `,
      args: [options.ou]
    });

    const rows = result.rows || [];

    if (rows.length > 0) {
      return {
        success: false,
        recordCount: rows.length,
        errors: ['Please ensure that all food cost lines are coded to a Kitchen (D0190-D0199)'],
        errorDetails: [{
          type: 'WRONG_DEPARTMENT',
          message: 'Food cost not coded to Kitchen department',
          count: rows.length,
          sampleRecords: rows.slice(0, 5)
        }]
      };
    }

    return { success: true, recordCount: 0 };
  },

  /**
   * Segment Total v Stats
   * Checks that D0010 A960103 (Total SOLD Room Nights) matches sum of individual segment stats
   * Uses explicit segment stats accounts from Room Segment Review
   */
  segment_total_v_stats: async (db, options) => {
    // Explicit segment stats accounts from Room Segment Review (all in D0010)
    const segmentStatsAccounts: string[] = [
      'A961010', 'A961011', 'A961012', 'A961013', 'A961014', 'A961015',
      'A961016', 'A961017', 'A961018', 'A961019', 'A961020', 'A961021',
      'A961026', 'A961027', 'A961028', 'A961029', 'A961030', 'A961031',
      'A961032', 'A961033',
      'A961318', 'A961334', 'A961335', 'A961336', 'A961337', 'A961338',
      'A961510', 'A961511', 'A961512', 'A961513', 'A961514', 'A961515',
      'A961516', 'A961517', 'A961518', 'A961519', 'A961520', 'A961521',
      'A961526', 'A961527', 'A961528', 'A961529', 'A961530', 'A961531',
      'A961533',
      'A961601', 'A961602', 'A961603', 'A961604', 'A961607', 'A961608',
      'A961734', 'A961735', 'A961736', 'A961737', 'A961738',
      'A961818',
    ];

    // Get total rooms from D0010_A960103
    const totalRoomsResult = await db.execute({
      sql: `
        SELECT SUM(amount) as total_rooms
        FROM financial_data_staging
        WHERE ou = ?
          AND dep_acc_combo_id = 'D0010_A960103'
      `,
      args: [options.ou]
    });

    const totalRooms = totalRoomsResult.rows?.[0]?.total_rooms || 0;

    // Build placeholders for IN clause
    const placeholders = segmentStatsAccounts.map(() => '?').join(', ');

    // Get sum of all individual segment stats in D0010
    const segmentStatsResult = await db.execute({
      sql: `
        SELECT SUM(amount) as segment_total
        FROM financial_data_staging
        WHERE ou = ?
          AND department = 'D0010'
          AND account IN (${placeholders})
      `,
      args: [options.ou, ...segmentStatsAccounts]
    });

    const segmentTotal = segmentStatsResult.rows?.[0]?.segment_total || 0;

    if (totalRooms !== segmentTotal) {
      return {
        success: false,
        recordCount: 1,
        errors: [`Total rooms (${totalRooms}) does not match segment count (${segmentTotal})`]
      };
    }

    return { success: true, recordCount: 1 };
  },

  /**
   * Rooms revenue accounts must have corresponding stat values
   * Uses explicit account pairs from Room Segment Review - D0010 only
   * Note: Some revenue accounts (A361041, A361541) have no stat counterpart
   */
  rooms_rev_stats_match: async (db, options) => {
    // Explicit revenue/stats account pairs from Room Segment Review
    // All accounts are in department D0010
    const accountPairs: [string, string][] = [
      ['A361010', 'A961010'],
      ['A361011', 'A961011'],
      ['A361012', 'A961012'],
      ['A361013', 'A961013'],
      ['A361014', 'A961014'],
      ['A361015', 'A961015'],
      ['A361016', 'A961016'],
      ['A361017', 'A961017'],
      ['A361018', 'A961018'],
      ['A361019', 'A961019'],
      ['A361020', 'A961020'],
      ['A361021', 'A961021'],
      ['A361026', 'A961026'],
      ['A361027', 'A961027'],
      ['A361028', 'A961028'],
      ['A361029', 'A961029'],
      ['A361030', 'A961030'],
      ['A361031', 'A961031'],
      ['A361032', 'A961032'],
      ['A361033', 'A961033'],
      // A361041 excluded - no stats counterpart (Bonvoy Occ Premium - WD)
      ['A361318', 'A961318'],
      ['A361334', 'A961334'],
      ['A361335', 'A961335'],
      ['A361336', 'A961336'],
      ['A361337', 'A961337'],
      ['A361338', 'A961338'],
      ['A361510', 'A961510'],
      ['A361511', 'A961511'],
      ['A361512', 'A961512'],
      ['A361513', 'A961513'],
      ['A361514', 'A961514'],
      ['A361515', 'A961515'],
      ['A361516', 'A961516'],
      ['A361517', 'A961517'],
      ['A361518', 'A961518'],
      ['A361519', 'A961519'],
      ['A361520', 'A961520'],
      ['A361521', 'A961521'],
      ['A361526', 'A961526'],
      ['A361527', 'A961527'],
      ['A361528', 'A961528'],
      ['A361529', 'A961529'],
      ['A361530', 'A961530'],
      ['A361531', 'A961531'],
      ['A361533', 'A961533'],
      // A361541 excluded - no stats counterpart (Bonvoy Occ Premium - WE)
      ['A361601', 'A961601'],
      ['A361602', 'A961602'],
      ['A361603', 'A961603'],
      ['A361604', 'A961604'],
      ['A361607', 'A961607'],
      ['A361608', 'A961608'],
      ['A361734', 'A961734'],
      ['A361735', 'A961735'],
      ['A361736', 'A961736'],
      ['A361737', 'A961737'],
      ['A361738', 'A961738'],
      ['A361818', 'A961818'],
    ];

    const errors: string[] = [];
    const errorDetails: any[] = [];
    let pairsChecked = 0;

    for (const [revenueAccount, statsAccount] of accountPairs) {
      // Get revenue amount for D0010
      const revenueResult = await db.execute({
        sql: `
          SELECT SUM(amount) as total
          FROM financial_data_staging
          WHERE ou = ?
            AND department = 'D0010'
            AND account = ?
        `,
        args: [options.ou, revenueAccount]
      });

      // Get stats amount for D0010
      const statsResult = await db.execute({
        sql: `
          SELECT SUM(amount) as total
          FROM financial_data_staging
          WHERE ou = ?
            AND department = 'D0010'
            AND account = ?
        `,
        args: [options.ou, statsAccount]
      });

      const revenueTotal = revenueResult.rows?.[0]?.total || 0;
      const statsTotal = statsResult.rows?.[0]?.total || 0;

      const revenueHasValue = revenueTotal !== 0 && revenueTotal !== null;
      const statsHasValue = statsTotal !== 0 && statsTotal !== null;

      pairsChecked++;

      // Error if one has value but the other doesn't
      if (revenueHasValue !== statsHasValue) {
        if (revenueHasValue && !statsHasValue) {
          errors.push(`Revenue ${revenueAccount} has value (${revenueTotal}) but stats ${statsAccount} is zero/missing`);
          errorDetails.push({
            type: 'REVENUE_WITHOUT_STATS',
            revenueAccount,
            statsAccount,
            revenueAmount: revenueTotal,
            statsAmount: statsTotal
          });
        } else {
          errors.push(`Stats ${statsAccount} has value (${statsTotal}) but revenue ${revenueAccount} is zero/missing`);
          errorDetails.push({
            type: 'STATS_WITHOUT_REVENUE',
            revenueAccount,
            statsAccount,
            revenueAmount: revenueTotal,
            statsAmount: statsTotal
          });
        }
      }
    }

    return {
      success: errors.length === 0,
      recordCount: pairsChecked,
      errors: errors.length > 0 ? errors : undefined,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      stats: {
        recordsChecked: pairsChecked,
        issuesFound: errors.length
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SEGMENT STATS VALIDATION
  // Validates that revenue segment accounts (3xxxxx) and their corresponding
  // stats accounts (9xxxxx) are either both populated or both zero/missing
  // ─────────────────────────────────────────────────────────────────────────

  segment_stats_validation: async (db, options) => {
    // Explicit account pairs: [revenue_account, stats_account]
    // All accounts are in department D0010
    const accountPairs: [string, string][] = [
      ['A361010', 'A961010'],
      ['A361011', 'A961011'],
      ['A361012', 'A961012'],
      ['A361013', 'A961013'],
      ['A361014', 'A961014'],
      ['A361015', 'A961015'],
      ['A361016', 'A961016'],
      ['A361017', 'A961017'],
      ['A361018', 'A961018'],
      ['A361019', 'A961019'],
      ['A361020', 'A961020'],
      ['A361021', 'A961021'],
      ['A361026', 'A961026'],
      ['A361027', 'A961027'],
      ['A361028', 'A961028'],
      ['A361029', 'A961029'],
      ['A361030', 'A961030'],
      ['A361031', 'A961031'],
      ['A361032', 'A961032'],
      ['A361033', 'A961033'],
      // A361041 excluded - no stats counterpart
      ['A361318', 'A961318'],
      ['A361334', 'A961334'],
      ['A361335', 'A961335'],
      ['A361336', 'A961336'],
      ['A361337', 'A961337'],
      ['A361338', 'A961338'],
      ['A361510', 'A961510'],
      ['A361511', 'A961511'],
      ['A361512', 'A961512'],
      ['A361513', 'A961513'],
      ['A361514', 'A961514'],
      ['A361515', 'A961515'],
      ['A361516', 'A961516'],
      ['A361517', 'A961517'],
      ['A361518', 'A961518'],
      ['A361519', 'A961519'],
      ['A361520', 'A961520'],
      ['A361521', 'A961521'],
      ['A361526', 'A961526'],
      ['A361527', 'A961527'],
      ['A361528', 'A961528'],
      ['A361529', 'A961529'],
      ['A361530', 'A961530'],
      ['A361531', 'A961531'],
      ['A361533', 'A961533'],
      // A361541 excluded - no stats counterpart
      ['A361601', 'A961601'],
      ['A361602', 'A961602'],
      ['A361603', 'A961603'],
      ['A361604', 'A961604'],
      ['A361607', 'A961607'],
      ['A361608', 'A961608'],
      ['A361734', 'A961734'],
      ['A361735', 'A961735'],
      ['A361736', 'A961736'],
      ['A361737', 'A961737'],
      ['A361738', 'A961738'],
      ['A361818', 'A961818'],
    ];

    const errors: string[] = [];
    const errorDetails: any[] = [];
    let pairsChecked = 0;

    for (const [revenueAccount, statsAccount] of accountPairs) {
      // Get revenue amount
      const revenueResult = await db.execute({
        sql: `
          SELECT SUM(amount) as total
          FROM financial_data_staging
          WHERE ou = ?
            AND department = 'D0010'
            AND account = ?
        `,
        args: [options.ou, revenueAccount]
      });

      // Get stats amount
      const statsResult = await db.execute({
        sql: `
          SELECT SUM(amount) as total
          FROM financial_data_staging
          WHERE ou = ?
            AND department = 'D0010'
            AND account = ?
        `,
        args: [options.ou, statsAccount]
      });

      const revenueTotal = revenueResult.rows?.[0]?.total || 0;
      const statsTotal = statsResult.rows?.[0]?.total || 0;

      const revenueHasValue = revenueTotal !== 0 && revenueTotal !== null;
      const statsHasValue = statsTotal !== 0 && statsTotal !== null;

      pairsChecked++;

      // Error if one has value but the other doesn't
      if (revenueHasValue !== statsHasValue) {
        if (revenueHasValue && !statsHasValue) {
          errors.push(`Revenue ${revenueAccount} has value (${revenueTotal}) but stats ${statsAccount} is zero/missing`);
          errorDetails.push({
            type: 'REVENUE_WITHOUT_STATS',
            revenueAccount,
            statsAccount,
            revenueAmount: revenueTotal,
            statsAmount: statsTotal
          });
        } else {
          errors.push(`Stats ${statsAccount} has value (${statsTotal}) but revenue ${revenueAccount} is zero/missing`);
          errorDetails.push({
            type: 'STATS_WITHOUT_REVENUE',
            revenueAccount,
            statsAccount,
            revenueAmount: revenueTotal,
            statsAmount: statsTotal
          });
        }
      }
    }

    return {
      success: errors.length === 0,
      recordCount: pairsChecked,
      errors: errors.length > 0 ? errors : undefined,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      stats: {
        recordsChecked: pairsChecked,
        issuesFound: errors.length
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // SEGMENT TOTALS VALIDATION
  // Validates that the sum of individual segment stats equals the total stat line
  // Total: D0010 A960103
  // ─────────────────────────────────────────────────────────────────────────

  segment_totals: async (db, options) => {
    // All individual segment stats accounts that should sum to the total
    const segmentStatsAccounts: string[] = [
      'A961010', 'A961011', 'A961012', 'A961013', 'A961014', 'A961015',
      'A961016', 'A961017', 'A961018', 'A961019', 'A961020', 'A961021',
      'A961026', 'A961027', 'A961028', 'A961029', 'A961030', 'A961031',
      'A961032', 'A961033',
      // A961041 excluded - no stats account exists
      'A961318', 'A961334', 'A961335', 'A961336', 'A961337', 'A961338',
      'A961510', 'A961511', 'A961512', 'A961513', 'A961514', 'A961515',
      'A961516', 'A961517', 'A961518', 'A961519', 'A961520', 'A961521',
      'A961526', 'A961527', 'A961528', 'A961529', 'A961530', 'A961531',
      'A961533',
      // A961541 excluded - no stats account exists
      'A961601', 'A961602', 'A961603', 'A961604', 'A961607', 'A961608',
      'A961734', 'A961735', 'A961736', 'A961737', 'A961738',
      'A961818',
    ];

    // Get the total from D0010 A960103
    const totalResult = await db.execute({
      sql: `
        SELECT SUM(amount) as total
        FROM financial_data_staging
        WHERE ou = ?
          AND department = 'D0010'
          AND account = 'A960103'
      `,
      args: [options.ou]
    });

    const totalValue = totalResult.rows?.[0]?.total || 0;

    // Build placeholders for IN clause
    const placeholders = segmentStatsAccounts.map(() => '?').join(', ');

    // Get sum of all individual segment stats
    const segmentSumResult = await db.execute({
      sql: `
        SELECT SUM(amount) as segment_sum
        FROM financial_data_staging
        WHERE ou = ?
          AND department = 'D0010'
          AND account IN (${placeholders})
      `,
      args: [options.ou, ...segmentStatsAccounts]
    });

    const segmentSum = segmentSumResult.rows?.[0]?.segment_sum || 0;

    const errors: string[] = [];

    if (totalValue !== segmentSum) {
      const difference = totalValue - segmentSum;
      errors.push(`Segment stats total mismatch: Total line (A960103) = ${totalValue}, Sum of segments = ${segmentSum}, Difference = ${difference}`);
    }

    return {
      success: errors.length === 0,
      recordCount: segmentStatsAccounts.length + 1,
      errors: errors.length > 0 ? errors : undefined,
      errorDetails: errors.length > 0 ? [{
        type: 'SEGMENT_TOTAL_MISMATCH',
        totalLineAccount: 'A960103',
        totalLineValue: totalValue,
        segmentSum: segmentSum,
        difference: totalValue - segmentSum,
        segmentAccountsChecked: segmentStatsAccounts.length
      }] : undefined,
      stats: {
        recordsChecked: segmentStatsAccounts.length + 1,
        issuesFound: errors.length
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // NON-STATS ACCOUNTS BALANCE TO ZERO
  // All accounts that do NOT start with A9 (i.e. non-stats / financial accounts)
  // should net to zero when summed. This validates that the uploaded trial balance
  // and balance sheet are in balance (debits = credits).
  // ─────────────────────────────────────────────────────────────────────────

  non_stats_balance_zero: async (db, options) => {
    // Sum all non-stats accounts (accounts not starting with A9) per month
    const result = await db.execute({
      sql: `
        SELECT
          month,
          SUM(amount) as month_total,
          COUNT(*) as line_count
        FROM financial_data_staging
        WHERE ou = ?
          AND account NOT LIKE 'A9%'
        GROUP BY month
        ORDER BY month
      `,
      args: [options.ou]
    });

    const rows = result.rows || [];
    const errors: string[] = [];
    const errorDetails: any[] = [];
    let totalRecords = 0;
    let overallTotal = 0;
    const TOLERANCE = 0.01;

    for (const row of rows) {
      totalRecords += (row.line_count as number) || 0;
      const monthTotal = row.month_total as number || 0;
      overallTotal += monthTotal;

      if (Math.abs(monthTotal) > TOLERANCE) {
        errors.push(`Month ${row.month}: non-stats accounts are out of balance by ${monthTotal.toFixed(2)}`);
        errorDetails.push({
          type: 'MONTH_OUT_OF_BALANCE',
          message: `Non-stats accounts do not net to zero for month ${row.month}`,
          month: row.month,
          imbalance: monthTotal,
          lineCount: row.line_count
        });
      }
    }

    if (rows.length === 0) {
      return {
        success: false,
        recordCount: 0,
        errors: ['No non-stats financial data found in staging']
      };
    }

    // Summary error if overall total is also out of balance
    if (errors.length > 0 && Math.abs(overallTotal) > TOLERANCE) {
      errors.unshift(`Overall non-stats accounts are out of balance by ${overallTotal.toFixed(2)} across all months`);
    }

    return {
      success: errors.length === 0,
      recordCount: totalRecords,
      errors: errors.length > 0 ? errors : undefined,
      info: errors.length === 0
        ? [`All non-stats accounts balance to zero across ${rows.length} month(s) (${totalRecords} lines checked)`]
        : undefined,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
      stats: {
        recordsChecked: totalRecords,
        issuesFound: errors.length
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // TEST VALIDATION (for development/testing)
  // ─────────────────────────────────────────────────────────────────────────

  test_validation: async (db, options) => {
    const result = await db.execute({
      sql: `SELECT COUNT(*) as count FROM financial_data_staging WHERE ou = ?`,
      args: [options.ou]
    });

    const count = result.rows?.[0]?.count || 0;

    return {
      success: true,
      recordCount: count,
      info: [`Found ${count} records in staging table for OU: ${options.ou}`]
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // INVALID COMBOS VALIDATION
  // Checks that all account-department combinations in staging exist in the
  // master account_department_combos table. Catches "creative" coding.
  //
  // Optimization: Uses a CTE to build the valid combo lookup set once, then
  // does a simple NOT IN check against distinct staging combos.
  // ─────────────────────────────────────────────────────────────────────────

  invalid_combos: async (db, options) => {
    // Step 1: Build a set of valid combo IDs from master table (format: D0480_A701110)
    // Step 2: Find distinct combos in staging that aren't in that set
    // This approach is efficient because:
    //   - We build the valid set once (small table, ~few thousand rows typically)
    //   - We only check distinct combos from staging, not every row
    //   - The NOT IN uses a hash lookup
    const result = await db.execute({
      sql: `
        WITH valid_combos AS (
          SELECT 'D' || department || '_A' || account AS combo_id
          FROM account_department_combos
        ),
        staging_combos AS (
          SELECT DISTINCT
            dep_acc_combo_id,
            department,
            account
          FROM financial_data_staging
          WHERE ou = ?
        )
        SELECT
          s.dep_acc_combo_id,
          s.department,
          s.account
        FROM staging_combos s
        WHERE s.dep_acc_combo_id NOT IN (SELECT combo_id FROM valid_combos)
        ORDER BY s.department, s.account
      `,
      args: [options.ou]
    });

    const invalidCombos = result.rows || [];
    const errors: string[] = [];

    if (invalidCombos.length > 0) {
      errors.push(`Found ${invalidCombos.length} invalid combo(s) not in master COA list:`);

      // Show up to 15 invalid combos in error messages
      const displayLimit = 15;
      for (let i = 0; i < Math.min(invalidCombos.length, displayLimit); i++) {
        const combo = invalidCombos[i];
        errors.push(`  ${combo.dep_acc_combo_id}`);
      }

      if (invalidCombos.length > displayLimit) {
        errors.push(`  ... and ${invalidCombos.length - displayLimit} more`);
      }
    }

    return {
      success: invalidCombos.length === 0,
      recordCount: invalidCombos.length,
      errors: errors.length > 0 ? errors : undefined,
      errorDetails: invalidCombos.length > 0 ? [{
        type: 'INVALID_COMBOS',
        message: 'Combos not in master COA list',
        count: invalidCombos.length,
        combos: invalidCombos.map(c => c.dep_acc_combo_id)
      }] : undefined,
      stats: {
        recordsChecked: invalidCombos.length,
        issuesFound: invalidCombos.length
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // UNMAPPED LINES VALIDATION
  // Checks that all lines in staging have been mapped (have account and department)
  // ─────────────────────────────────────────────────────────────────────────

  unmapped_lines: async (db, options) => {
    // Find lines where mapping_status indicates unmapped or where account/department is null
    const result = await db.execute({
      sql: `
        SELECT
          source_account,
          source_department,
          source_description,
          COUNT(*) as line_count,
          SUM(amount) as total_amount
        FROM financial_data_staging
        WHERE ou = ?
          AND (
            mapping_status LIKE '%unmapped%'
            OR account IS NULL
            OR department IS NULL
            OR account = ''
            OR department = ''
          )
        GROUP BY source_account, source_department, source_description
        ORDER BY line_count DESC
      `,
      args: [options.ou]
    });

    const unmappedLines = result.rows || [];
    const errors: string[] = [];
    let totalUnmappedCount = 0;

    if (unmappedLines.length > 0) {
      // Calculate total unmapped lines
      for (const row of unmappedLines) {
        totalUnmappedCount += (row.line_count as number) || 0;
      }

      errors.push(`Found ${totalUnmappedCount} unmapped line(s) across ${unmappedLines.length} unique source combination(s):`);

      // Show up to 10 unmapped source combinations
      const displayLimit = 10;
      for (let i = 0; i < Math.min(unmappedLines.length, displayLimit); i++) {
        const line = unmappedLines[i];
        const srcAcct = line.source_account || '(none)';
        const srcDept = line.source_department || '(none)';
        errors.push(`  - Acct: ${srcAcct}, Dept: ${srcDept} (${line.line_count} line(s))`);
      }

      if (unmappedLines.length > displayLimit) {
        errors.push(`  ... and ${unmappedLines.length - displayLimit} more source combinations`);
      }
    }

    return {
      success: unmappedLines.length === 0,
      recordCount: totalUnmappedCount,
      errors: errors.length > 0 ? errors : undefined,
      errorDetails: unmappedLines.length > 0 ? [{
        type: 'UNMAPPED_LINES',
        message: 'Lines without account/department mapping',
        count: totalUnmappedCount,
        uniqueCombinations: unmappedLines.length,
        samples: unmappedLines.slice(0, 10).map(l => ({
          sourceAccount: l.source_account,
          sourceDepartment: l.source_department,
          sourceDescription: l.source_description,
          lineCount: l.line_count,
          totalAmount: l.total_amount
        }))
      }] : undefined,
      stats: {
        recordsChecked: totalUnmappedCount,
        issuesFound: totalUnmappedCount
      }
    };
  },

};
