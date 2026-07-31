import { builtinModules } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { ConfigEnv, Plugin, UserConfig } from 'vite';
import pkg from './package.json';

export const builtins = ['electron', ...builtinModules.map((m) => [m, `node:${m}`]).flat()];

// Modules that SHOULD be bundled by Vite
// These are pure JS modules that work well when bundled
const bundledModules = [
  // Main process modules that CAN be bundled
  'update-electron-app',
  'electron-log',
  // 3D rendering libraries (renderer only)
  'three',
  'framer-motion',
  '@react-three/fiber',
  '@react-three/drei',
  // UI libraries (renderer only)
  '@mui/x-data-grid-premium',
  '@mui/material',
  '@mui/icons-material',
  '@emotion/react',
  '@emotion/styled',
  // React and related (renderer only)
  'react',
  'react-dom',
  'react-router-dom',
  // Pure JS utilities (can be bundled)
  'csv-parse',
  'xlsx',
  // OOXML zip surgery for BST Push — main process. MUST stay bundled: the
  // packaged app ships no node_modules except the hand-copied native list in
  // forge.config.ts, so externalizing this makes main.js crash on launch with
  // "Cannot find module 'fflate'".
  'fflate',
  'uuid',
  '@faker-js/faker',
  '@fontsource/roboto'
];

// Native modules that MUST be externalized (cannot be bundled)
const nativeModules = [
  'electron-squirrel-startup',
  'better-sqlite3-multiple-ciphers',
  'bindings',
  'file-uri-to-path',
  'detect-libc',
  'node-machine-id',
  'systeminformation',
  'nodejs-polars',
  // exceljs and all transitive dependencies
  'exceljs', 'jszip', 'archiver', 'dayjs', 'fast-csv', 'readable-stream', 'saxes', 'tmp', 'unzipper',
  '@fast-csv/format', '@fast-csv/parse', 'archiver-utils', 'async', 'balanced-match', 'base64-js',
  'big-integer', 'binary', 'bl', 'bluebird', 'brace-expansion', 'buffer', 'buffer-crc32',
  'buffer-indexof-polyfill', 'buffers', 'chainsaw', 'compress-commons', 'concat-map', 'crc-32',
  'crc32-stream', 'duplexer2', 'end-of-stream', 'fs-constants', 'fs.realpath', 'fstream', 'glob',
  'graceful-fs', 'ieee754', 'immediate', 'inflight', 'inherits', 'lazystream', 'lie',
  'listenercount', 'lodash.defaults', 'lodash.difference', 'lodash.escaperegexp', 'lodash.flatten',
  'lodash.groupby', 'lodash.isboolean', 'lodash.isequal', 'lodash.isfunction', 'lodash.isnil',
  'lodash.isplainobject', 'lodash.isundefined', 'lodash.union', 'lodash.uniq', 'minimatch', 'mkdirp',
  'normalize-path', 'once', 'pako', 'path-is-absolute', 'readdir-glob', 'rimraf', 'safe-buffer',
  'setimmediate', 'string_decoder', 'tar-stream', 'traverse', 'util-deprecate', 'wrappy',
  'xmlchars', 'zip-stream', 'process-nextick-args', 'core-util-is', 'isarray'
];

export const external = [
  ...builtins,
  // Externalize all native modules and their sub-dependencies
  ...nativeModules,
  /^nodejs-polars/,  // All polars sub-packages
  // Externalize all dependencies EXCEPT those explicitly bundled
  ...Object.keys('dependencies' in pkg ? (pkg.dependencies as Record<string, unknown>) : {})
    .filter(dep => !bundledModules.includes(dep) && !nativeModules.includes(dep))
];

export function getBuildConfig(env: ConfigEnv<'build'>): UserConfig {
  const { root, mode, command } = env;

  return {
    root,
    mode,
    build: {
      // Prevent multiple builds from interfering with each other.
      emptyOutDir: false,
      // 🚧 Multiple builds may conflict.
      outDir: '.vite/build',
      watch: command === 'serve' ? {} : null,
      minify: command === 'build',
    },
    clearScreen: false,
  };
}

export function getDefineKeys(names: string[]) {
  const define: { [name: string]: VitePluginRuntimeKeys } = {};

  return names.reduce((acc, name) => {
    const NAME = name.toUpperCase();
    const keys: VitePluginRuntimeKeys = {
      VITE_DEV_SERVER_URL: `${NAME}_VITE_DEV_SERVER_URL`,
      VITE_NAME: `${NAME}_VITE_NAME`,
    };

    return { ...acc, [name]: keys };
  }, define);
}

export function getBuildDefine(env: ConfigEnv<'build'>) {
  const { command, forgeConfig } = env;
  const names = forgeConfig.renderer.filter(({ name }) => name != null).map(({ name }) => name!);
  const defineKeys = getDefineKeys(names);
  const define = Object.entries(defineKeys).reduce((acc, [name, keys]) => {
    const { VITE_DEV_SERVER_URL, VITE_NAME } = keys;
    const def = {
      [VITE_DEV_SERVER_URL]: command === 'serve' ? JSON.stringify(process.env[VITE_DEV_SERVER_URL]) : undefined,
      [VITE_NAME]: JSON.stringify(name),
    };
    return { ...acc, ...def };
  }, {} as Record<string, any>);

  return define;
}

export function pluginExposeRenderer(name: string): Plugin {
  const { VITE_DEV_SERVER_URL } = getDefineKeys([name])[name];

  return {
    name: '@electron-forge/plugin-vite:expose-renderer',
    configureServer(server) {
      process.viteDevServers ??= {};
      // Expose server for preload scripts hot reload.
      process.viteDevServers[name] = server;

      server.httpServer?.once('listening', () => {
        const addressInfo = server.httpServer!.address() as AddressInfo;
        // Expose env constant for main process use.
        process.env[VITE_DEV_SERVER_URL] = `http://localhost:${addressInfo?.port}`;
      });
    },
  };
}

export function pluginHotRestart(command: 'reload' | 'restart'): Plugin {
  return {
    name: '@electron-forge/plugin-vite:hot-restart',
    closeBundle() {
      if (command === 'reload') {
        for (const server of Object.values(process.viteDevServers)) {
          // Preload scripts hot reload.
          server.ws.send({ type: 'full-reload' });
        }
      } else {
        // Main process hot restart.
        // https://github.com/electron/forge/blob/v7.2.0/packages/api/core/src/api/start.ts#L216-L223
        process.stdin.emit('data', 'rs');
      }
    },
  };
}
