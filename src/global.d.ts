import { IpcApi } from './preload';

declare global {
  interface Window {
    ipcApi: IpcApi;
  }
  const __APP_VERSION__: string;

  // Vite injects these; `import.meta.env.DEV` is statically replaced at build
  // time, so a `if (import.meta.env.DEV)` block is dead-code-eliminated from
  // production bundles. (We don't pull in `vite/client`, so declare the slice
  // we use.)
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
