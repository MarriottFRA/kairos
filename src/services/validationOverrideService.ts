/**
 * Validation Override Service
 * ============================
 *
 * Service for managing validation override requests.
 * Allows users to request approval to bypass failed validations.
 *
 * Flow:
 * 1. User runs validations and some required validations fail
 * 2. User requests an override for specific validation (with reason)
 * 3. Admin approves the override in the database
 * 4. User checks status and can proceed past the failed validation
 */

import api from './api';

// Types for Validation Override
export interface ValidationOverrideRequest {
  context: string;
  validations: Array<{
    name: string;
    state: string;
  }>;
  reason: string | null;
}

export interface ValidationOverrideResponse {
  id: number;
  user_id: number;
  context: string;
  validations: Array<{
    name: string;
    state: string;
  }>;
  reason: string | null;
  is_approved: boolean;
  requested_at: string;
  approved_at: string | null;
}

export interface ValidationOverrideStatus {
  context: string;
  is_approved: boolean;
  validations: Array<{
    name: string;
    state: string;
  }>;
  requested_at: string | null;
  approved_at: string | null;
}

class ValidationOverrideService {
  /**
   * Request a validation override
   * @param context Unique identifier (e.g., "validation_total_must_balance_A01")
   * @param validations Array of failed validations to bypass
   * @param reason User's justification for the override
   * @returns Promise<ValidationOverrideResponse>
   */
  async requestOverride(
    context: string,
    validations: Array<{ name: string; state: string }>,
    reason: string | null
  ): Promise<ValidationOverrideResponse> {
    const response = await api.post(`/validation-override/request`, {
      context,
      validations,
      reason
    });

    if (!response.ok) {
      if (response.status === 422) {
        const error = await response.json();
        throw new Error(error.detail?.[0]?.msg || 'Validation error');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to request override');
    }

    return await response.json();
  }

  /**
   * Check the status of a validation override request
   * @param context Unique identifier (e.g., "validation_total_must_balance_A01")
   * @returns Promise<ValidationOverrideStatus>
   */
  async checkOverrideStatus(context: string): Promise<ValidationOverrideStatus> {
    const response = await api.get(`/validation-override/status/${context}`);

    if (!response.ok) {
      if (response.status === 422) {
        const error = await response.json();
        throw new Error(error.detail?.[0]?.msg || 'Validation error');
      }
      const error = await response.json();
      throw new Error(error.detail || 'Failed to check override status');
    }

    return await response.json();
  }

  /**
   * Check multiple override statuses at once
   * @param contexts Array of context identifiers
   * @returns Promise<Map<string, ValidationOverrideStatus>>
   */
  async checkMultipleOverrideStatuses(
    contexts: string[]
  ): Promise<Map<string, ValidationOverrideStatus>> {
    const statusMap = new Map<string, ValidationOverrideStatus>();

    // Fetch all statuses in parallel
    const results = await Promise.allSettled(
      contexts.map(context => this.checkOverrideStatus(context))
    );

    // Map results back to contexts
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        statusMap.set(contexts[index], result.value);
      } else {
        // If failed, set a default "not approved" status
        statusMap.set(contexts[index], {
          context: contexts[index],
          is_approved: false,
          validations: [],
          requested_at: null,
          approved_at: null
        });
      }
    });

    return statusMap;
  }

  /**
   * Generate context string for a specific validation
   * @param validationName The name of the validation
   * @param ou The organizational unit
   * @param period The period in YYYY-MM format (e.g., "2026-01")
   * @returns Context string (e.g., "validation_total_must_balance_A01_2026-01")
   */
  getContextForValidation(validationName: string, ou: string, period: string): string {
    // Sanitize period to remove any quotes that may have been accidentally included
    // This can happen if the period was double-JSON-encoded somewhere in the data flow
    const sanitizedPeriod = period.replace(/"/g, '');
    return `validation_${validationName}_${ou}_${sanitizedPeriod}`;
  }
}

export default new ValidationOverrideService();
