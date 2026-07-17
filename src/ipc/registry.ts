/**
 * IPC Handler Registry
 * Manages registration and routing of IPC handlers
 */

import { ipcMain, IpcMainInvokeEvent } from "electron";
import { IpcHandler, IpcMiddleware, IpcHandlerRegistration, IpcResult } from "./types";

class IpcRegistry {
  private handlers = new Map<string, IpcHandlerRegistration>();
  private globalMiddleware: IpcMiddleware[] = [];
  private logger: any;

  constructor(logger?: any) {
    this.logger = logger || console;
  }

  /**
   * Add global middleware that runs for all handlers
   */
  use(middleware: IpcMiddleware): void {
    this.globalMiddleware.push(middleware);
  }

  /**
   * Register a handler for a specific channel
   */
  register(
    channel: string,
    handler: IpcHandler,
    middleware: IpcMiddleware[] = []
  ): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler for channel '${channel}' already registered`);
    }

    this.handlers.set(channel, {
      channel,
      handler,
      middleware,
    });

    this.logger.debug(`IPC handler registered: ${channel}`);
  }

  /**
   * Bulk register handlers from a module
   */
  registerModule(handlers: Record<string, IpcHandler>, prefix?: string): void {
    Object.entries(handlers).forEach(([channel, handler]) => {
      const fullChannel = prefix ? `${prefix}:${channel}` : channel;
      this.register(fullChannel, handler);
    });
  }

  /**
   * Initialize the registry and set up the main IPC handler
   */
  initialize(): void {
    ipcMain.handle("ipcMain", async (event: IpcMainInvokeEvent, channel: string, ...args: any[]) => {
      return this.handleRequest(event, channel, args);
    });
    
    this.logger.info(`IPC Registry initialized with ${this.handlers.size} handlers`);
  }

  /**
   * Handle incoming IPC requests with middleware chain
   */
  private async handleRequest(
    event: IpcMainInvokeEvent,
    channel: string,
    args: any[]
  ): Promise<IpcResult> {
    const startTime = Date.now();
    
    try {
      const registration = this.handlers.get(channel);
      if (!registration) {
        throw new Error(`No handler registered for channel: ${channel}`);
      }

      // Build middleware chain (global + handler-specific)
      const middleware = [...this.globalMiddleware, ...registration.middleware];
      
      // Execute middleware chain
      const result = await this.executeMiddlewareChain(
        middleware,
        event,
        channel,
        args,
        registration.handler
      );

      const duration = Date.now() - startTime;
      this.logger.debug(`IPC request completed: ${channel} (${duration}ms)`);

      return this.wrapResult(result);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      this.logger.error(`IPC request failed: ${channel} (${duration}ms)`, error);
      
      return {
        success: false,
        error: error.message || 'Unknown error occurred',
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Execute the middleware chain
   */
  private async executeMiddlewareChain(
    middleware: IpcMiddleware[],
    event: IpcMainInvokeEvent,
    channel: string,
    args: any[],
    handler: IpcHandler
  ): Promise<any> {
    let index = 0;

    const next = async (): Promise<any> => {
      if (index >= middleware.length) {
        // All middleware executed, call the actual handler
        return handler(event, ...args);
      }

      const currentMiddleware = middleware[index++];
      return currentMiddleware(event, channel, args, next);
    };

    return next();
  }

  /**
   * Wrap result in consistent format
   */
  private wrapResult(result: any): IpcResult {
    // If result is already wrapped, return as-is
    if (result && typeof result === 'object' && 'success' in result) {
      return result;
    }

    // Wrap plain results
    return {
      success: true,
      data: result,
      timestamp: Date.now(),
    };
  }

  /**
   * Get all registered channels (useful for debugging)
   */
  getRegisteredChannels(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Unregister a handler (useful for testing)
   */
  unregister(channel: string): boolean {
    return this.handlers.delete(channel);
  }

  /**
   * Clear all handlers (useful for testing)
   */
  clear(): void {
    this.handlers.clear();
    this.globalMiddleware = [];
  }
}

export const ipcRegistry = new IpcRegistry();
export { IpcRegistry };