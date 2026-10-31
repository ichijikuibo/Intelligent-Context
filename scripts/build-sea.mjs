/**
 * build-sea.mjs — Build a Single Executable Application (SEA) binary.
 *
 * USAGE:
 *   node scripts/build-sea.mjs                    # build for current platform
 *   node scripts/build-sea.mjs --wsl-tmp           # use /tmp for injection (WSL2 cross-fs workaround)
 *   node scripts/build-sea.mjs --platform linux   # build for linux (in Docker)
 *   node scripts/build-sea.mjs --platform windows # build for windows
 *   node scripts/build-sea.mjs --platform darwin  # build for macOS
 *
 * PREREQUISITES:
 *   - Node.js >= 20.12 (>= 24.x recommended)
 *   - npm ci (dependencies installed)
 *   - npx postject (auto-installed via npx)
 *
 * OUTPUT:
 *   dist/sea/intelligent-context    (Linux/macOS)
 *   dist/sea/intelligent-context.exe (Windows)
 *   dist/sea/ui/                     (shipped alongside the binary)
 *   dist/sea/sql-wasm.wasm           (shipped alongside the binary)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SEA_DIR = path.join(ROOT, 'dist', 'sea');
const BUNDLE_PATH = path.join(SEA_DIR, 'bundle.cjs');
const BLOB_PATH = path.join(SEA_DIR, 'sea-prep.blob');
const CONFIG_PATH = path.join(SEA_DIR, 'sea-config.json');

// ── Platform detection ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argPlatform = args.includes('--platform')
  ? args[args.indexOf('--platform') + 1]
  : null;

const PLATFORM = argPlatform || os.platform(); // 'linux', 'darwin', 'win32'
const IS_WIN = PLATFORM === 'win32';
const EXE_NAME = IS_WIN ? 'intelligent-context.exe' : 'intelligent-context';
const EXE_PATH = path.join(SEA_DIR, EXE_NAME);

// --wsl-tmp: do postject injection inside WSL's native /tmp to avoid
// cross-filesystem hangs when accessing /mnt/d/... from WSL2
const USE_WSL_TMP = args.includes('--wsl-tmp');

// ── Helpers ───────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Step 1: Type-check ────────────────────────────────────────────────────

console.log('\n═══ Step 1: Type-check ═══');
try {
  run('npx tsc --noEmit', { stdio: 'pipe' });
  console.log('  ✓ TypeScript compilation OK');
} catch (e) {
  console.error('  ✗ TypeScript errors found. Fix them before building SEA.');
  process.exit(1);
}

// ── Step 2: Bundle with esbuild ───────────────────────────────────────────

console.log('\n═══ Step 2: Bundle with esbuild ═══');
ensureDir(SEA_DIR);

// Use esbuild to bundle everything into a single CommonJS file.
// We mark @xenova/transformers as external since it's dynamically imported
// and won't work in SEA mode anyway (gracefully degrades).
// --banner suppresses the Node.js SEA require() warning (fired before
// execArgv takes effect; must be silenced from within the bundle).
//
// node-cron uses import.meta.url at module-load time to resolve its
// daemon.js helper path.  In the SEA runtime import.meta.url is undefined,
// so we replace it at bundle time with a valid absolute file:// URL.
// The daemon is never forked by this project but the resolution still
// runs eagerly, so we point it at the bundle itself to produce a harmless
// no-op daemonPath.
const fakeMetaUrl = pathToFileURL(BUNDLE_PATH).href;
run(
  `npx esbuild src/index.ts ` +
    `--bundle ` +
    `--platform=node ` +
    `--target=node20 ` +
    `--format=cjs ` +
    `--outfile="${BUNDLE_PATH}" ` +
    `--external:@xenova/transformers ` +
    `--external:pg-native ` +
    `--define:import.meta.url='"${fakeMetaUrl}"' ` +
    `--minify ` +
    `--keep-names`
);

// Verify the bundle exists
if (!fs.existsSync(BUNDLE_PATH)) {
  console.error('  ✗ Bundle failed — no output file.');
  process.exit(1);
}

const bundleSize = (fs.statSync(BUNDLE_PATH).size / 1024).toFixed(0);
console.log(`  ✓ Bundle created (${bundleSize} KB)`);

// ── Step 3: Copy runtime assets ───────────────────────────────────────────

console.log('\n═══ Step 3: Copy runtime assets ═══');

// Copy UI directory
const uiSrc = path.join(ROOT, 'ui');
const uiDest = path.join(SEA_DIR, 'ui');
if (fs.existsSync(uiDest)) fs.rmSync(uiDest, { recursive: true });
fs.cpSync(uiSrc, uiDest, { recursive: true });
console.log('  ✓ UI assets copied');

// Copy sql.js WASM file
const wasmSrc = path.join(ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmDest = path.join(SEA_DIR, 'sql-wasm.wasm');
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, wasmDest);
  console.log('  ✓ sql.js WASM copied');
} else {
  console.error('  ✗ sql-wasm.wasm not found in node_modules/sql.js/dist/');
  console.error('    Run "npm ci" first.');
  process.exit(1);
}

// ── Step 4: Generate SEA blob ─────────────────────────────────────────────

console.log('\n═══ Step 4: Generate SEA blob ═══');

const seaConfig = {
  main: BUNDLE_PATH,
  output: BLOB_PATH,
  disableExperimentalSEAWarning: true,
  // The bundle includes dynamic import() for optional embeddings support.
  // SEA code cache is incompatible with import(), so keep it disabled.
  useCodeCache: false,
  execArgv: ['--no-warnings'],
};

fs.writeFileSync(CONFIG_PATH, JSON.stringify(seaConfig, null, 2));
console.log(`  ✓ SEA config written to ${CONFIG_PATH}`);

run(`node --experimental-sea-config "${CONFIG_PATH}"`);

if (!fs.existsSync(BLOB_PATH)) {
  console.error('  ✗ Blob generation failed.');
  process.exit(1);
}
const blobSize = (fs.statSync(BLOB_PATH).size / 1024).toFixed(0);
console.log(`  ✓ SEA blob created (${blobSize} KB)`);

// ── Step 5: Create executable ─────────────────────────────────────────────

console.log('\n═══ Step 5: Create executable ═══');

// When running under WSL2, postject can hang when modifying binaries on
// cross-filesystem mounts (/mnt/d/...).  We copy the node binary and blob
// to /tmp (native Linux ext4), inject there, then copy the result back.
const INJECT_DIR = USE_WSL_TMP
  ? path.join(os.tmpdir(), 'sea-build')
  : SEA_DIR;
const injectExePath = path.join(INJECT_DIR, EXE_NAME);

if (USE_WSL_TMP) {
  ensureDir(INJECT_DIR);
}

// Copy the node binary
const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, injectExePath);
console.log(`  ✓ Node binary copied to ${injectExePath}`);

// On macOS/Windows, remove signature before postject
if (PLATFORM === 'darwin') {
  try { run(`codesign --remove-signature "${injectExePath}"`, { stdio: 'pipe' }); } catch { /* ok */ }
  console.log('  ✓ Signature removed (macOS)');
} else if (IS_WIN) {
  try { run(`signtool remove /s "${injectExePath}"`, { stdio: 'pipe' }); } catch {
    console.log('  ⚠ signtool not found — skipping signature removal (binary still works)');
  }
}

// Inject the blob with postject
const postjectArgs = IS_WIN
  ? `npx --no-install postject "${injectExePath}" NODE_SEA_BLOB "${BLOB_PATH}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
  : PLATFORM === 'darwin'
    ? `npx --no-install postject "${injectExePath}" NODE_SEA_BLOB "${BLOB_PATH}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`
    : `npx --no-install postject "${injectExePath}" NODE_SEA_BLOB "${BLOB_PATH}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`;

run(postjectArgs);

// If we injected in /tmp, copy the result back to dist/sea/ and clean up
if (USE_WSL_TMP) {
  fs.copyFileSync(injectExePath, EXE_PATH);
  // Make executable
  fs.chmodSync(EXE_PATH, 0o755);
  // Cleanup tmp
  fs.rmSync(INJECT_DIR, { recursive: true });
  console.log('  ✓ Binary copied back to dist/sea/ (WSL tmp cleaned)');
} else if (!IS_WIN) {
  fs.chmodSync(EXE_PATH, 0o755);
}

const exeSize = (fs.statSync(EXE_PATH).size / (1024 * 1024)).toFixed(1);
console.log(`\n  ✓ Single executable created: ${EXE_PATH} (${exeSize} MB)`);
console.log(`\n  To run:`);
console.log(`    ${EXE_PATH}`);
console.log(`\n  To distribute, ship these files together:`);
console.log(`    ${EXE_NAME}`);
console.log(`    ui/          (management UI)`);
console.log(`    sql-wasm.wasm (SQLite runtime)`);
console.log(`    intelligent-context.yaml  (optional — user config)`);
