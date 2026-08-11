/**
 * Common IPC Middleware Functions
 * Reusable middleware for cross-cutting concerns
 */

import { IpcMainInvokeEvent } from "electron";
import { IpcMiddleware } from "./types";

/**
 * Logging middleware - logs all IPC requests
 */
export const loggingMiddleware = (logger: any): IpcMiddleware => {
  return async (event, channel, args, next) => {
    const startTime = Date.now();
    logger.debug(`IPC Request: ${channel}`, { args });
    
    try {
      const result = await next();
      const duration = Date.now() - startTime;
      logger.debug(`IPC Response: ${channel} (${duration}ms)`, { success: true });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`IPC Error: ${channel} (${duration}ms)`, { error: error.message });
      throw error;
    }
  };
};

/**
 * Authentication middleware - ensures user is authenticated
 */
export const authMiddleware = (authService: any): IpcMiddleware => {
  return async (event, channel, args, next) => {
    if (!authService.isAuthenticated()) {
      throw new Error('Authentication required for this operation');
    }
    return next();
  };
};

/**
 * Rate limiting middleware - prevents spam requests
 */
export const rateLimitMiddleware = (
  maxRequests: number = 10,
  windowMs: number = 1000
): IpcMiddleware => {
  const requests = new Map<string, { count: number; resetTime: number }>();
  
  return async (event, channel, args, next) => {
    const now = Date.now();
    const key = `${event.sender.id}-${channel}`;
    
    let requestInfo = requests.get(key);
    if (!requestInfo || now > requestInfo.resetTime) {
      requestInfo = { count: 0, resetTime: now + windowMs };
      requests.set(key, requestInfo);
    }
    
    if (requestInfo.count >= maxRequests) {
      throw new Error(`Rate limit exceeded for ${channel}. Please wait and try again.`);
    }
    
    requestInfo.count++;
    return next();
  };
};

/**
 * Validation middleware - validates request schema
 */
export const validationMiddleware = (schema: any): IpcMiddleware => {
  return async (event, channel, args, next) => {
    // Simple validation example - you could use Zod, Joi, or similar
    if (schema.required && schema.required.length > 0) {
      const request = args[0] || {};
      const missing = schema.required.filter((field: string) => 
        !(field in request) || request[field] === null || request[field] === undefined
      );
      
      if (missing.length > 0) {
        throw new Error(`Missing required fields: ${missing.join(', ')}`);
      }
    }
    
    return next();
  };
};

/**
 * Performance monitoring middleware
 */
export const performanceMiddleware = (slowThreshold: number = 1000): IpcMiddleware => {
  return async (event, channel, args, next) => {
    const startTime = Date.now();

    const result = await next();

    const duration = Date.now() - startTime;
    if (duration > slowThreshold) {
      // The threshold is what makes this quiet enough to leave on: a recalc or a
      // publish legitimately takes seconds, so only channels that block the UI
      // for longer than a frame budget's worth of work say anything.
      console.warn(`Slow IPC: ${channel} took ${duration}ms`);
    }

    return result;
  };
};

/**
 * Error handling middleware - standardizes error responses
 */
export const errorHandlingMiddleware = (logger?: any): IpcMiddleware => {
  return async (event, channel, args, next) => {
    try {
      return await next();
    } catch (error: any) {
      // Log the error
      if (logger) {
        logger.error(`IPC Error in ${channel}:`, error);
      }

      // Rethrow the ORIGINAL error unchanged. The renderer routes on exact
      // sentinel messages (e.g. DEVICE_NOT_REGISTERED, DEVICE_SECRET_INVALID),
      // so we must not prefix/rewrite the message here — doing so silently
      // breaks the auth device (re-)registration flow.
      throw error;
    }
  };
};

/**
 * Sender validation middleware - rejects IPC from any frame that is not our own
 * app content. Guards against a compromised/embedded frame invoking main-process
 * handlers. Trusted senders are the packaged renderer (file://) and, in dev, the
 * Vite dev-server origin.
 */
export const senderValidationMiddleware = (
  allowedOrigins: string[]
): IpcMiddleware => {
  return async (event, channel, args, next) => {
    const url = event.senderFrame?.url ?? "";
    const trusted =
      url.startsWith("file://") ||
      allowedOrigins.some((origin) => origin && url.startsWith(origin));

    if (!trusted) {
      throw new Error(`Untrusted IPC sender rejected for ${channel}`);
    }
    return next();
  };
};

/**
 * OU scope middleware - defense-in-depth gate for hotel-scoped channels.
 * Rejects any request whose first argument does not carry a valid 7-character
 * hotel OU ("OU" + 5 digits) BEFORE handler code runs. The structural
 * guarantee lives one layer down (repositories require a branded OuScope, see
 * src/main/positions/ouScope.ts); this middleware simply fails fast with a
 * uniform message.
 */
export const ouScopeMiddleware = (): IpcMiddleware => {
  return async (event, channel, args, next) => {
    const { isValidOu } = await import("../main/positions/ouScope");
    const request = args[0] as { ou?: unknown } | undefined;
    if (!isValidOu(request?.ou)) {
      throw new Error(
        `INVALID_OU: '${channel}' requires a hotel OU ("OU" + 5 digits)`
      );
    }
    return next();
  };
};

/**
 * Security middleware - sanitizes potentially dangerous inputs
 */
export const securityMiddleware = (): IpcMiddleware => {
  return async (event, channel, args, next) => {
    // Basic security checks on all arguments
    const sanitizedArgs = args.map(arg => {
      if (typeof arg === 'string') {
        // Check for potential script injection
        if (/<script|javascript:/i.test(arg)) {
          throw new Error('Potentially malicious content detected');
        }
        return arg;
      }
      
      // Deep sanitization for objects
      if (typeof arg === 'object' && arg !== null) {
        return sanitizeObject(arg);
      }
      
      return arg;
    });
    
    // Replace args with sanitized versions
    args.splice(0, args.length, ...sanitizedArgs);
    
    return next();
  };
};

/**
 * Helper function to sanitize objects recursively
 */
function sanitizeObject(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  
  if (typeof obj === 'object' && obj !== null) {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip potentially dangerous keys
      if (key.startsWith('__') || key === 'constructor' || key === 'prototype') {
        continue;
      }
      sanitized[key] = sanitizeObject(value);
    }
    return sanitized;
  }
  
  if (typeof obj === 'string') {
    // Basic XSS protection
    return obj.replace(/<script.*?>.*?<\/script>/gi, '')
             .replace(/javascript:/gi, '')
             .replace(/on\w+\s*=/gi, '');
  }
  
  return obj;
}