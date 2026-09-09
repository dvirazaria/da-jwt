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

test('signed-in accounts can edit their persisted profile name without losing the sign-out action', () => {
  const start = appScript.indexOf('function refreshSettings()');
  const close = appScript.indexOf('\n  }', start);
  const body = appScript.slice(start, close);
  assert.match(body, /setNameEdit"\)\.hidden = false/);
  assert.match(body, /setNameEditor"\)\.hidden = !setNameEditing/);

  const updateStart = appScript.indexOf('async function updateProfileDisplayName(name)');
  const updateClose = appScript.indexOf('\n  }', updateStart);
  const updateBody = appScript.slice(updateStart, updateClose);
  assert.ok(updateStart >= 0, 'the signed-in profile update helper is missing');
  assert.match(updateBody, /if \(!supabase \|\| !authUser\) return false/);
  assert.match(updateBody, /\.from\("profiles"\)[\s\S]*?\.update\(\{ display_name: name \}\)[\s\S]*?\.eq\("id", authUser\.id\)/);
  assert.match(updateBody, /authUser\.displayName = name/);

  const saveStart = appScript.indexOf('async function saveSetName()');
  const saveClose = appScript.indexOf('\n  document.getElementById("setNameEdit")', saveStart);
  const saveBody = appScript.slice(saveStart, saveClose);
  assert.match(saveBody, /if \(authUser && !\(await updateProfileDisplayName\(name\)\)\)/);
  assert.ok(saveBody.indexOf('await updateProfileDisplayName(name)') < saveBody.indexOf('me = name'),
    'the cloud profile must succeed before the visible local identity changes');
});
