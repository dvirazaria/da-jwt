const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');
const appScript = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
const between = (start, end) => appScript.slice(appScript.indexOf(start), appScript.indexOf(end, appScript.indexOf(start)));

test('a local account edits its contact details inline: read-only until the pencil, then save or cancel', () => {
  const settings = html.slice(html.indexOf('<div class="login" id="settings"'), html.indexOf('<div class="login" id="groupSettings"'));
  // the values render as text, and the inputs only exist inside a hidden editor
  assert.match(settings, /<p class="set-contact-line" id="setPhoneText" dir="ltr">/);
  assert.match(settings, /<p class="set-contact-line" id="setEmailText" dir="ltr">/);
  assert.match(settings, /class="set-name-edit set-contact-edit" id="setContactEdit" aria-label="עריכת פרטי קשר"/);
  assert.match(settings, /<div class="set-contact-editor" id="setContactEditor" hidden>/);
  assert.match(settings, /id="setContactSave">שמור<\/button>/);
  assert.match(settings, /id="setContactCancel">ביטול<\/button>/);
  // the pencil keeps the shared 44px touch target
  assert.match(html, /\.set-name-edit \{\s*width: 44px; min-height: 44px;/);

  const refresh = between('function refreshContact()', 'function closeSetContactEditor()');
  assert.match(refresh, /setContactView"\)\.hidden = setContactEditing/);
  assert.match(refresh, /setContactEditor"\)\.hidden = !setContactEditing/);

  const save = between('function saveContact()', 'document.getElementById("setContactEdit")');
  assert.match(save, /localStorage\.setItem\(CONTACT_KEY/);
  assert.match(save, /setContactEditing = false;\s*refreshContact\(\);/);
  assert.doesNotMatch(save, /\b(alert|confirm)\s*\(/);

  // cancel re-reads storage instead of keeping whatever was typed
  const cancel = between('function closeSetContactEditor()', 'function saveContact()');
  assert.match(cancel, /setContactEditing = false;\s*refreshContact\(\)/);

  // no second store: the block still writes only the pre-existing contact key
  assert.equal(appScript.match(/localStorage\.setItem\(CONTACT_KEY/g).length, 1);
  assert.match(appScript, /const CONTACT_KEY = "poker-settle-contact"/);
});

test('a Google-linked account is shown its contact details read-only, with no way in', () => {
  const context = vm.createContext({});
  vm.runInContext(between('function isGoogleAccount(user)', 'function refreshSettings()'), context);
  const isGoogle = (user) => {
    context.candidate = user;
    return vm.runInContext('isGoogleAccount(candidate)', context);
  };

  // both shapes Supabase uses
  assert.equal(isGoogle({ app_metadata: { provider: 'google' } }), true);
  assert.equal(isGoogle({ app_metadata: { providers: ['email', 'google'] } }), true);
  assert.equal(isGoogle({ identities: [{ provider: 'google' }] }), true);
  // and everything that is not Google
  assert.equal(isGoogle({ app_metadata: { provider: 'email' } }), false);
  assert.equal(isGoogle({ identities: [{ provider: 'email' }] }), false);
  assert.equal(isGoogle({}), false);
  assert.equal(isGoogle(null), false);

  // the pencil is hidden and the editor is forced shut for them
  const refresh = between('function refreshContact()', 'function closeSetContactEditor()');
  assert.match(refresh, /const locked = isGoogleAccount\(authUser\)/);
  assert.match(refresh, /if \(locked\) setContactEditing = false/);
  assert.match(refresh, /setContactEdit"\)\.hidden = setContactEditing \|\| locked/);
  assert.match(refresh, /setContactNote"\)\.hidden = !locked/);

  // and the write path refuses even if the button is reached some other way
  assert.match(between('function saveContact()', 'document.getElementById("setContactEdit")'),
    /if \(isGoogleAccount\(authUser\)\) return/);
  assert.match(between('document.getElementById("setContactEdit").addEventListener', 'setContactSave'),
    /if \(isGoogleAccount\(authUser\)\) return/);

  // the account address itself is never rewritten from here
  assert.doesNotMatch(between('function saveContact()', 'document.getElementById("setContactEdit")'),
    /authUser\.email\s*=|from\("profiles"\)/);
});
