// PWA install-experience checks: the manifest's any/maskable icon split, the icon files
// themselves, the generated page head, the iOS install hint's standalone-mode guard, and the
// "no new localStorage key" rule from CLAUDE.md. Offline, regex/JSON-only — no browser involved.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const buildPy = fs.readFileSync('build.py', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
const vercelignore = fs.readFileSync('.vercelignore', 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return html.slice(start, end);
}

// Minimal PNG header reader: signature + the mandatory-first IHDR chunk (width/height at a
// fixed offset). No image library involved, matching the rest of this offline suite.
function pngDimensions(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), 'missing PNG signature');
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', 'first chunk is not IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('the manifest declares "any" and "maskable" icon purposes as separate entries', () => {
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.icons missing');
  const combinedPurpose = manifest.icons.filter(i => (i.purpose || '').trim().split(/\s+/).length > 1);
  assert.deepEqual(combinedPurpose, [], 'no single icon entry should claim more than one purpose');
  const anySrcs = new Set(manifest.icons.filter(i => i.purpose === 'any').map(i => i.src));
  const maskableSrcs = new Set(manifest.icons.filter(i => i.purpose === 'maskable').map(i => i.src));
  assert.ok(anySrcs.size > 0, 'no icon declares purpose "any"');
  assert.ok(maskableSrcs.size > 0, 'no icon declares purpose "maskable"');
  maskableSrcs.forEach(src => assert.ok(!anySrcs.has(src), `${src} is declared both "any" and "maskable"`));
});

test('every manifest icon exists on disk as a real PNG matching its declared size', () => {
  manifest.icons.forEach(icon => {
    assert.ok(fs.existsSync(icon.src), `${icon.src} referenced in the manifest does not exist`);
    const { width, height } = pngDimensions(fs.readFileSync(icon.src));
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(width, w, `${icon.src} width is ${width}, manifest declares ${w}`);
    assert.equal(height, h, `${icon.src} height is ${height}, manifest declares ${h}`);
  });
});

test('the generated page head links the manifest and the iOS apple-touch-icon, with a dark first paint', () => {
  assert.match(buildPy, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(buildPy, /<link rel="apple-touch-icon" sizes="180x180" href="\.\/icon-180\.png">/);
  assert.match(buildPy, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  // Paints the UA's own dark canvas before any CSS loads, instead of the default white.
  assert.match(buildPy, /<meta name="color-scheme" content="dark">/);
});

test('manifest fields match what the app actually ships (lang, dir, start_url, scope, display, orientation)', () => {
  assert.equal(manifest.lang, 'he');
  assert.equal(manifest.dir, 'rtl');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'portrait');
  assert.match(buildPy, /<html lang="he" dir="rtl">/);
  // Same dark ground on both, so the manifest/Android splash and the app's own body background agree.
  assert.equal(manifest.background_color, manifest.theme_color);
  assert.match(html, new RegExp(`--bg:\\s*${manifest.background_color}`, 'i'));
});

test('the iOS install hint only appears outside standalone mode, for iOS Safari', () => {
  const init = sourceBetween('  function initIosInstallHint() {', '  // ---------- boot ----------');
  assert.match(init, /isStandaloneDisplay\(\)/, 'initIosInstallHint should consult the standalone guard');
  assert.match(init, /isIosSafari\(\)/, 'initIosInstallHint should consult the iOS Safari check');
  const standalone = sourceBetween('  function isStandaloneDisplay() {', '  function dismissIosInstallHint() {');
  assert.match(standalone, /navigator\.standalone === true/);
  assert.match(standalone, /matchMedia\("\(display-mode: standalone\)"\)\.matches/);
});

test('new PWA assets are not excluded from the Vercel deploy', () => {
  ['manifest.webmanifest', 'icon-maskable-512.png', 'icon-512.png', 'icon-192.png', 'icon-180.png']
    .forEach(name => assert.ok(!vercelignore.includes(name), `${name} should not be in .vercelignore`));
});

test('no new localStorage key was introduced for the install hint', () => {
  const keysUsed = new Set([...html.matchAll(/localStorage\.setItem\(\s*([A-Za-z_]+)\s*,/g)].map(m => m[1]));
  assert.deepEqual(
    [...keysUsed].sort(),
    ['CONTACT_KEY', 'KEY', 'ME_KEY', 'PROFILE_DEBT_SEEN_KEY', 'THEME_KEY'].sort(),
    'the set of localStorage keys written by the app must stay exactly as documented in CLAUDE.md'
  );
  // The dismissal flag rides inside the existing state document instead.
  assert.match(html, /iosInstallHintDismissed/);
});
