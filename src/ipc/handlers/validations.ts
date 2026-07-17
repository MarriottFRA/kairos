/**
 * Validation IPC Handlers
 * =======================
 *
 * Handles all validation-related IPC requests from the renderer process.
 * Uses the new ValidationEngine for executing named validations.
 */

import { IpcHandler } from "../types";
import { IPC_CHANNELS } from "../types";
import { ValidationEngine, validationDefinitions } from "../../services/validations/engine";
import * as db from "../../local_db";

// Singleton validation engine instance
let validationEngine: ValidationEngine | null = null;

/**
 * Get or create the validation engine instance
 */
function getValidationEngine(): ValidationEngine {
  if (!validationEngine) {
    // Create engine with database wrapper
    const dbWrapper = {
      execute: (query: { sql: string; args: any[] }) => db.executeQuery(query),
    };

    validationEngine = new ValidationEngine(dbWrapper);

    // Register all validation definitions
    validationEngine.registerAll(validationDefinitions);

    console.log(`[ValidationEngine] Initialized with ${validationEngine.count} validations`);
  }

  return validationEngine;
}

export class ValidationHandlers {
  constructor() {
    // Initialize engine when handlers are created
    getValidationEngine();
  }

  /**
   * Run a validation by name
   * Request: { validationName: string, ou: string, period?: { year, month } }
   */
  runValidationHandler: IpcHandler = async (event, request) => {
    try {
      const engine = getValidationEngine();

      const result = await engine.execute(request.validationName, {
        ou: request.ou,
        period: request.period,
      });

      return {
        success: true,
        data: result,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('[ValidationHandlers] Error running validation:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Get all registered validation names
   * Request: { ou?: string }
   *
   * Note: This returns the locally registered validations.
   * The UI typically uses the API-fetched validations for display,
   * and this endpoint can be used for debugging/verification.
   */
  getAllValidationsHandler: IpcHandler = async (event, request) => {
    try {
      const engine = getValidationEngine();
      const names = engine.getRegisteredNames();

      return {
        success: true,
        data: names,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('[ValidationHandlers] Error getting validations:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Run multiple validations by name
   * Request: { validationNames: string[], ou: string, period?: { year, month }, stopOnFirstError?: boolean }
   */
  runAllValidationsHandler: IpcHandler = async (event, request) => {
    try {
      const engine = getValidationEngine();

      const results = await engine.executeAll(
        request.validationNames || [],
        {
          ou: request.ou,
          period: request.period,
        },
        request.stopOnFirstError || false
      );

      // Convert Map to array of results for IPC transport
      const resultsArray = Array.from(results.entries()).map(([name, result]) => ({
        validationName: name,
        ...result,
      }));

      return {
        success: true,
        data: resultsArray,
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('[ValidationHandlers] Error running all validations:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Check if a validation is registered
   * Request: { validationName: string }
   */
  checkValidationExistsHandler: IpcHandler = async (event, request) => {
    try {
      const engine = getValidationEngine();
      const exists = engine.has(request.validationName);

      return {
        success: true,
        data: { exists, validationName: request.validationName },
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('[ValidationHandlers] Error checking validation:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  };

  /**
   * Get validation engine statistics
   */
  getValidationStatsHandler: IpcHandler = async (event) => {
    try {
      const engine = getValidationEngine();

      return {
        success: true,
        data: {
          totalValidations: engine.count,
          registeredNames: engine.getRegisteredNames(),
        },
        timestamp: Date.now(),
      };
    } catch (error) {
      console.error('[ValidationHandlers] Error getting validation stats:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };
    }
  };
}

// Factory function to create and register validation handlers
export function createValidationHandlers() {
  const handlers = new ValidationHandlers();

  return {
    [IPC_CHANNELS.VALIDATION_RUN]: handlers.runValidationHandler,
    'validation:get-all': handlers.getAllValidationsHandler,
    'validation:run-all': handlers.runAllValidationsHandler,
    'validation:check-exists': handlers.checkValidationExistsHandler,
    'validation:stats': handlers.getValidationStatsHandler,
  };
}
