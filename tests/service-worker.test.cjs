// Service worker: app-shell precache + fetch strategy (see CLAUDE.md — sw.js is hand-maintained;
// build.py only regex-replaces the CACHE version string inside it). Static text analysis only,
// no ServiceWorker runtime — same style as the other offline-analysis suites in this folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sw = fs.readFileSync('sw.js', 'utf8');
const buildPy = fs.readFileSync('build.py', 'utf8');

test('the CACHE constant matches the exact regex build.py uses to bump the version, exactly once', () => {
  // Derive the regex from build.py itself instead of copying it, so this test breaks if build.py's
  // replace pattern and sw.js's declaration shape ever drift apart from each other.
  const source = buildPy.match(/sw = re\.sub\(r'([^']+)'/);
  assert.ok(source, "could not find build.py's `sw = re.sub(r'...'` CACHE replacement");
  const cacheRegex = new RegExp(source[1]);
  assert.match(sw, cacheRegex, 'sw.js must declare `const CACHE = "kupa-vNN"` in the exact shape build.py replaces');
  const occurrences = sw.match(new RegExp(source[1], 'g')) || [];
  assert.equal(occurrences.length, 1, 'CACHE should be declared exactly once, so build.py never touches a second copy');
});

test('the precache list includes the full app shell: manifest, icons, and the legal pages', () => {
  for (const file of ['./', 'index.html', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'privacy.html', 'terms.html']) {
    assert.ok(sw.includes(`"${file}"`), `PRECACHE_URLS should include "${file}"`);
  }
});

test('every precached path exists on disk and ships in the Vercel deploy (not excluded by .vercelignore)', () => {
  const listMatch = sw.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(listMatch, 'sw.js should define a PRECACHE_URLS array');
  const urls = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6, 'PRECACHE_URLS looks too short for the full app shell');

  const ignoreRules = fs.readFileSync('.vercelignore', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/\/$/, ''));

  for (const url of urls) {
    const file = url === './' ? 'index.html' : url;
    assert.ok(fs.existsSync(file), `precached path "${url}" does not exist on disk`);
    const excludedBy = ignoreRules.find((rule) => file === rule || file.startsWith(`${rule}/`));
    assert.ok(!excludedBy, `precached path "${url}" is excluded from the Vercel deploy by .vercelignore rule "${excludedBy}"`);
  }
});

test('the fetch handler ignores non-GET requests', () => {
  const fetchHandler = sw.slice(sw.indexOf('addEventListener("fetch"'));
  assert.match(fetchHandler, /if\s*\(e\.request\.method !== "GET"\)\s*return;/);
});

test('the fetch handler excludes the Supabase origin (and every cross-origin request) from caching', () => {
  const fetchHandler = sw.slice(sw.indexOf('addEventListener("fetch"'));
  assert.match(fetchHandler, /supabase/i, 'the fetch handler should call out the Supabase origin explicitly');
  assert.match(fetchHandler, /url\.origin !== self\.location\.origin/, 'cross-origin GET requests must bypass the cache entirely');
});

test('install caches app-shell entries individually, so one missing file cannot empty the whole precache', () => {
  const installHandler = sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf('addEventListener("activate"'));
  assert.doesNotMatch(installHandler, /\.addAll\(/, 'addAll() fails atomically — a single 404 would abort the whole install');
  assert.match(installHandler, /allSettled/, 'each precache entry should be added independently and tolerate its own failure');
});
