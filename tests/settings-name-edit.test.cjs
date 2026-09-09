const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const appScript = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

test('settings places a touch-sized inline name editor beside the displayed name', () => {
  const settings = html.slice(html.indexOf('<div class="login" id="settings"'), html.indexOf('<div class="login" id="groupSettings"'));
  assert.match(settings, /class="set-name-edit" id="setNameEdit" aria-label="עריכת השם"/);
  assert.match(settings, /class="set-name-editor" id="setNameEditor" hidden/);
  assert.match(settings, /id="setNameInput" maxlength="40" autocomplete="name" aria-label="שם"/);
  assert.match(html, /\.set-name-edit \{\s*width: 44px; min-height: 44px;/);
});

test('the inline editor reuses the existing local name persistence and never opens a blocking dialog', () => {
  const start = appScript.indexOf('function saveSetName()');
  const close = appScript.indexOf('\n  document.getElementById("setNameEdit")', start);
  const body = appScript.slice(start, close);
  assert.match(body, /const name = input\.value\.trim\(\)/);
  assert.match(body, /me = name;\s*saveMe\(\);/);
  assert.match(body, /refreshSettings\(\);\s*render\(\);/);
  assert.doesNotMatch(body, /\b(alert|confirm)\s*\(/);
});

test('signed-in accounts keep sign-out while only the supported local-name model exposes editing', () => {
  const start = appScript.indexOf('function refreshSettings()');
  const close = appScript.indexOf('\n  }', start);
  const body = appScript.slice(start, close);
  assert.match(body, /const canEditName = !authUser/);
  assert.match(body, /setNameEdit"\)\.hidden = !canEditName/);
  assert.match(body, /setNameEditor"\)\.hidden = !canEditName \|\| !setNameEditing/);
});
