import 'dotenv/config';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
// import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { cpSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    icon: './src/images/marriott_logo',
    prune: false,  // Keep false - postPackage hook needs to install deps
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/node_modules($|\/)/,  // Exclude initial node_modules - postPackage installs what's needed
      /^\/src($|\/)/,           // Source files not needed in package
      /^\/out($|\/)/,
      /\.ts$/,
      /\.tsx$/,
      /\.map$/,
      /^\/vite.*\.config\.ts$/,
      /^\/tsconfig\.json$/,
      /^\/forge\.config\.ts$/,
      /^\/eslint\.config\./,
      /\.md$/,
      /^\/\.env/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_config, options) => {
      console.log('\n========================================');
      console.log('POST PACKAGE HOOK STARTED');
      console.log('Platform:', options.platform);
      console.log('Arch:', options.arch);
      console.log('Output paths:', options.outputPaths);
      console.log('========================================\n');

      // Find the app resources path
      const appPath = options.outputPaths[0] + '/resources/app';
      const sourceNodeModules = join(process.cwd(), 'node_modules');
      const targetNodeModules = join(appPath, 'node_modules');

      // List of external native dependencies that need to be copied
      const externalDeps = [
        // SQLite driver for both the settings DB and the encrypted feature DB.
        // `bindings` (and its own dep file-uri-to-path) is what locates the
        // compiled better_sqlite3.node at runtime, so all three must be copied.
        'better-sqlite3-multiple-ciphers',
        'bindings',
        'file-uri-to-path',
        'detect-libc',
        'node-machine-id',
        'systeminformation',
        'electron-squirrel-startup',
        // FFI into ncrypt.dll for TPM device binding. `koffi` itself is only a
        // JS shim — the actual koffi.node binary lives in the platform sibling
        // package, so BOTH must be copied or the packaged app silently loses
        // TPM support while dev keeps working.
        'koffi',
        '@koromix/koffi-win32-x64',
      ];

      console.log('Copying dependencies from:', sourceNodeModules);
      console.log('To:', targetNodeModules);
      console.log('Dependencies:', externalDeps.join(', '));

      try {
        // Create node_modules directory in the package
        mkdirSync(targetNodeModules, { recursive: true });

        // Copy each dependency from dev node_modules to package
        for (const dep of externalDeps) {
          const sourcePath = join(sourceNodeModules, dep);
          const targetPath = join(targetNodeModules, dep);

          console.log(`Copying ${dep}...`);
          cpSync(sourcePath, targetPath, { recursive: true });
        }

        console.log('\n========================================');
        console.log('✓ Dependencies copied successfully');
        console.log('========================================\n');

        // Create app-update.yml for electron-updater
        const updateYml = `provider: github
owner: MarriottFRA
repo: kairos
updaterCacheDirName: kairos-updater`;

        // Write to resources/ (for Squirrel installer)
        const resourcesPath = options.outputPaths[0] + '/resources';
        const updateYmlPathResources = join(resourcesPath, 'app-update.yml');
        console.log('Creating app-update.yml at:', updateYmlPathResources);
        writeFileSync(updateYmlPathResources, updateYml, 'utf8');

        // Also write to resources/app/ (backup location)
        const updateYmlPathApp = join(appPath, 'app-update.yml');
        console.log('Creating app-update.yml at:', updateYmlPathApp);
        writeFileSync(updateYmlPathApp, updateYml, 'utf8');

        console.log('✓ app-update.yml created successfully\n');

      } catch (err) {
        console.error('\n========================================');
        console.error('✗ Copy failed:', err);
        console.error('========================================\n');
        throw err;
      }
    },
    postMake: async (_config, makeResults) => {
      console.log('\n========================================');
      console.log('POST MAKE HOOK - Verifying Squirrel artifacts');
      console.log('========================================\n');

      // Verify that all required Squirrel.Windows artifacts are present
      // update-electron-app works with update.electronjs.org which reads
      // artifacts directly from GitHub Releases, so no custom metadata needed
      for (const result of makeResults) {
        if (result.platform === 'win32' && result.artifacts.some(a => a.includes('squirrel.windows'))) {
          const squirrelDir = result.artifacts.find(a => a.includes('squirrel.windows') && a.endsWith('.nupkg'))?.replace(/[^/\\]+$/, '') || '';

          if (!squirrelDir) continue;

          try {
            const files = readdirSync(squirrelDir);
            const nupkgFile = files.find(f => f.endsWith('-full.nupkg'));
            const setupExe = files.find(f => f.endsWith(' Setup.exe'));
            const releasesFile = files.find(f => f === 'RELEASES');

            console.log('Squirrel.Windows artifacts:');
            console.log('  ✓ .nupkg:', nupkgFile || 'NOT FOUND');
            console.log('  ✓ Setup.exe:', setupExe || 'NOT FOUND');
            console.log('  ✓ RELEASES:', releasesFile || 'NOT FOUND');

            if (!nupkgFile || !setupExe || !releasesFile) {
              console.warn('⚠ Warning: Some Squirrel artifacts are missing!');
            } else {
              console.log('\n✓ All required artifacts generated successfully');
              console.log('These will be uploaded to GitHub Releases for auto-update');
            }

          } catch (err) {
            console.error('✗ Failed to verify artifacts:', err);
          }
        }
      }

      console.log('========================================\n');
      return makeResults;
    },
  },
  makers: [
    new MakerSquirrel({
      // Per-user install - no admin rights required
      // Installs to: %LocalAppData%\kairos
      setupIcon: './src/images/marriott_logo.ico',
      loadingGif: undefined, // Optional: add a loading animation path
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({})
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'MarriottFRA',
          name: 'kairos'
        },
        prerelease: false,
        draft: true
      }
    }
  ],
  plugins: [
    // Removed AutoUnpackNativesPlugin - not needed when asar is disabled
    // new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false
    }),
  ],
};

export default config;
