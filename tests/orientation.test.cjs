const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return html.slice(start, end);
}

test('the installed PWA declares portrait orientation', () => {
  assert.equal(manifest.orientation, 'portrait');
});

test('portrait lock is attempted only in standalone mode and quietly handles unsupported browsers', () => {
  const boot = sourceBetween('  // ---------- boot ----------', '  // Auth first:');
  assert.match(boot, /typeof screen\.orientation\?\.lock === "function"/);
  assert.match(boot, /matchMedia\("\(display-mode: standalone\)"\)\.matches/);
  assert.match(boot, /try \{/);
  assert.match(boot, /screen\.orientation\.lock\("portrait"\)\.catch\(\(\) => \{\}\)/);
  assert.match(boot, /catch \(e\) \{\}/);
});

test('landscape notice is limited to a short coarse-pointer landscape viewport', () => {
  assert.match(html, /id="rotateNotice"/);
  assert.match(html, /האפליקציה עובדת במצב אנכי/);
  assert.match(html, /סובבו את הטלפון חזרה/);
  assert.match(html, /@media \(orientation: landscape\) and \(max-height: 500px\) and \(pointer: coarse\)/);
});
