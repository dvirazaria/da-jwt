const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

// Minimal reader for exactly the PNG shape both marks use: 8-bit RGBA, non-interlaced.
// It exists so the optical-centring nudge below is checked against the artwork itself rather
// than against a number someone once wrote in the stylesheet.
function decodeAlpha(base64) {
  const buf = Buffer.from(base64, 'base64');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.equal(buf[24], 8, 'expected an 8-bit PNG');
  assert.equal(buf[25], 6, 'expected an RGBA PNG');
  assert.equal(buf[28], 0, 'expected a non-interlaced PNG');
  const idat = [];
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i);
    if (buf.toString('ascii', i + 4, i + 8) === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  const zero = Buffer.alloc(stride);
  for (let y = 0, p = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : zero;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const est = a + b - c;
        const pa = Math.abs(est - a), pb = Math.abs(est - b), pc = Math.abs(est - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, alpha: (x, y) => out[y * stride + x * bpp + 3] };
}

// The four suits, as the columns of ink they actually occupy.
function glyphs(img) {
  const inked = [];
  for (let x = 0; x < img.w; x++) {
    let on = false;
    for (let y = 0; y < img.h && !on; y++) if (img.alpha(x, y) > 32) on = true;
    inked.push(on);
  }
  const out = [];
  for (let x = 0, start = -1; x <= img.w; x++) {
    if (x < img.w && inked[x] && start < 0) start = x;
    else if ((x === img.w || !inked[x]) && start >= 0) { out.push([start, x]); start = -1; }
  }
  return out.map(([a, b]) => {
    let total = 0, sum = 0;
    for (let x = a; x < b; x++) for (let y = 0; y < img.h; y++) {
      const al = img.alpha(x, y);
      if (al) { total += al; sum += al * (x + 0.5); }
    }
    return { a, b, centroid: sum / total, total, sum };
  });
}

test('the suit mark is nudged by exactly the offset its own ink is out by', () => {
  const width = Number(html.match(/\.suits-mark img \{ display: block; width: (\d+)px;/)[1]);
  const shift = Number(html.match(/\.suits-mark img \{[^}]*transform: translateX\((-?[\d.]+)px\)/)[1]);

  for (const cls of ['suits-mark-dark', 'suits-mark-light']) {
    const b64 = html.match(new RegExp(`class="${cls}" src="data:image/png;base64,([A-Za-z0-9+/=]+)"`))[1];
    const img = decodeAlpha(b64);
    const marks = glyphs(img);
    assert.equal(marks.length, 4, `${cls}: expected spade/diamond/club/heart as four separate glyphs`);

    const scale = width / img.w;
    const middle = img.w / 2;

    // The outer edges are already symmetric — this is why the box looked centred all along.
    const edgeCentre = (marks[0].a + marks[3].b) / 2;
    assert.ok(Math.abs(edgeCentre - middle) * scale < 0.25,
      `${cls}: outer edges should be symmetric, off by ${((edgeCentre - middle) * scale).toFixed(2)}px`);

    // What the eye weighs is ink, not glyph boxes. The four suits grow left→right
    // (67/71/76/79px wide), so more ink sits on the end side and the row reads end-heavy even
    // though its bounding box is centred. The alpha-weighted centroid of the whole row is that
    // lean, and it is what translateX cancels — a plain mean of the four glyph centres points the
    // other way, because it gives the narrow start glyph and the wide end glyph equal say.
    const totalInk = marks.reduce((s, m) => s + m.total, 0);
    const inkCentre = marks.reduce((s, m) => s + m.sum, 0) / totalInk;
    const offset = (inkCentre - middle) * scale;
    assert.ok(offset > 0, `${cls}: the ink should lean to the end edge, got ${offset.toFixed(2)}px`);
    assert.ok(Math.abs(shift + offset) < 0.25,
      `${cls}: translateX(${shift}px) should cancel the measured ${offset.toFixed(2)}px lean`);
  }
});

test('the nudge is a static transform, so reduced motion and the flex centring are untouched', () => {
  assert.match(html, /\.suits-mark \{[^}]*justify-content: center[^}]*\}/s);
  // the global reduced-motion rule only kills animation/transition, and must stay last
  const reduced = html.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduced > html.indexOf('.suits-mark img'), 'the reduced-motion rule must stay last in the stylesheet');
  assert.match(html.slice(reduced, reduced + 160), /\* \{ animation: none !important; transition: none !important; \}/);
  assert.doesNotMatch(html, /\.suits-mark img \{[^}]*(transition|animation):/);
});
