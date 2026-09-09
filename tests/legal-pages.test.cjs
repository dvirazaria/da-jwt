const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Static legal pages required to move the Google OAuth consent screen out of
// "Testing": an application home page (the app itself), a privacy policy and
// a terms of service page, both shipped as standalone files next to
// index.html (no build step, see CLAUDE.md / build.py).

const CONTACT_EMAIL = 'dvirazaria1@gmail.com';
const PAGES = ['privacy.html', 'terms.html'];
// Only the Google Fonts hosts already used by the app, and the app's own
// (relative) links, are allowed — no analytics, no third-party scripts.
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function readPage(name) {
  assert.ok(fs.existsSync(name), `${name} should exist at the repo root`);
  return fs.readFileSync(name, 'utf8');
}

function externalUrls(html) {
  return html.match(/https?:\/\/[^\s"'<>)]+/g) || [];
}

for (const page of PAGES) {
  test(`${page} exists as a standalone Hebrew RTL document with a title`, () => {
    const html = readPage(page);
    assert.ok(html.includes('<html lang="he" dir="rtl">'), `${page} must declare lang="he" dir="rtl"`);
    assert.match(html, /<title>[^<]+<\/title>/, `${page} must have a <title>`);
  });

  test(`${page} mentions the contact email`, () => {
    const html = readPage(page);
    assert.ok(html.includes(CONTACT_EMAIL), `${page} should mention ${CONTACT_EMAIL}`);
  });

  test(`${page} has no <script> tag`, () => {
    const html = readPage(page);
    assert.doesNotMatch(html, /<script[\s>]/i, `${page} must not contain a <script> tag`);
  });

  test(`${page} has no external URLs beyond the Google Fonts hosts already used by the app`, () => {
    const html = readPage(page);
    for (const url of externalUrls(html)) {
      const host = url.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
      assert.ok(ALLOWED_HOSTS.includes(host), `${page} references a disallowed external host: ${host} (${url})`);
    }
  });

  test(`${page} carries a "last updated" date and links back to the app`, () => {
    const html = readPage(page);
    assert.match(html, /עודכן לאחרונה/);
    assert.match(html, /סוגרים קופה/);
  });

  test(`${page} includes an English summary for reviewers who do not read Hebrew`, () => {
    const html = readPage(page);
    assert.match(html, /class="en"/);
  });
}

test('privacy.html describes the real data flow: Supabase, Vercel and Google', () => {
  const html = readPage('privacy.html');
  assert.match(html, /Supabase/);
  assert.match(html, /Vercel/);
  assert.match(html, /Google/);
});

test('the settings overlay in kupa-sgura.html links to both legal pages, opening in a new tab', () => {
  const kupa = fs.readFileSync('kupa-sgura.html', 'utf8');
  const settings = kupa.slice(
    kupa.indexOf('<div class="login" id="settings"'),
    kupa.indexOf('<div class="login" id="groupSettings"')
  );
  assert.ok(settings.length > 0, 'the #settings overlay markup should be found');
  assert.match(settings, /<a[^>]+href="\.\/privacy\.html"[^>]*>[^<]*<\/a>/, 'missing a link to privacy.html');
  assert.match(settings, /<a[^>]+href="\.\/terms\.html"[^>]*>[^<]*<\/a>/, 'missing a link to terms.html');
  const privacyLink = settings.match(/<a[^>]+href="\.\/privacy\.html"[^>]*>/)[0];
  const termsLink = settings.match(/<a[^>]+href="\.\/terms\.html"[^>]*>/)[0];
  for (const tag of [privacyLink, termsLink]) {
    assert.match(tag, /target="_blank"/, `${tag} should open in a new tab`);
    assert.match(tag, /rel="noopener/, `${tag} should carry rel="noopener"`);
  }
});
