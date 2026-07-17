import { IpcApi } from './preload';

declare global {
  interface Window {
    ipcApi: IpcApi;
  }
  const __APP_VERSION__: string;
}

export {};
