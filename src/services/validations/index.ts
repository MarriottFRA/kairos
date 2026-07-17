/**
 * Validations Module
 * ==================
 *
 * Central export point for the validation system.
 *
 * Usage:
 * ```typescript
 * import { ValidationEngine, validationDefinitions } from './services/validations';
 *
 * const engine = new ValidationEngine(db);
 * engine.registerAll(validationDefinitions);
 *
 * const result = await engine.execute('royalty_fee_expense', { ou: 'hotel123' });
 * ```
 */

// Export engine and definitions
export { ValidationEngine, ValidationResult, ValidationOptions, ValidationFn } from './engine/ValidationEngine';
export { validationDefinitions } from './engine/validationDefinitions';
