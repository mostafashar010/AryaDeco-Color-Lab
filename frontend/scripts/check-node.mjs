// Fails fast with a readable message instead of the cryptic
// "require() of ES Module .../@exodus/bytes/encoding-lite.js ... not supported"
// that jsdom's dependencies throw on Node < 22.12 (require(esm) is off by default there).
const [major, minor] = process.versions.node.split('.').map(Number);
const hasFlag = Boolean(process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes('--experimental-require-module'));
const supported = major > 22 || (major === 22 && minor >= 12) || (major === 22 && hasFlag);

if (!supported) {
  console.error(
    `Node ${process.versions.node} is too old to run the frontend tests.\n` +
    'Use Node 22.12 or newer (see frontend/.nvmrc), e.g. `nvm use`.\n' +
    'Temporary workaround on 22.0-22.11: NODE_OPTIONS=--experimental-require-module npm test',
  );
  process.exit(1);
}
