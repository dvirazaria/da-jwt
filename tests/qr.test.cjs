// The hand-written QR encoder (byte mode, level M, versions 1..10) behind the group invite card.
//
// A wrong QR is worse than no QR — it looks fine and never scans — so this suite does not just
// assert shapes. It checks the three layers that can silently be wrong:
//   1. GF(256) arithmetic and the generator polynomial;
//   2. Reed-Solomon: data+EC as a polynomial must be exactly divisible by the generator (that is
//      the defining property, independent of any table of "expected" codewords);
//   3. the symbol itself: function patterns in the right places, format information that decodes
//      back to level M plus the chosen mask, and — the end-to-end check — an independent decoder
//      below that unmasks, walks the placement in reverse, de-interleaves and reads the original
//      string back out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('kupa-sgura.html', 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end >= 0, `missing ${endMarker}`);
  return html.slice(start, end);
}

const qrSource = sourceBetween('  // ---------- qr (pure) ----------', '  // ---------- cloud mapping (pure) ----------');

function load() {
  const context = vm.createContext({});
  vm.runInContext(qrSource, context);
  return context;
}
const ctx = load();
const call = (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, ctx));

// ---------- 1. GF(256) ----------

test('the exponent/log tables use the QR primitive polynomial 0x11d', () => {
  const exp = call('QR_EXP');
  assert.equal(exp[0], 1);
  assert.equal(exp[1], 2);
  assert.equal(exp[7], 128);
  assert.equal(exp[8], 0x1d, 'x^8 folds to x^4+x^3+x^2+1');
  assert.equal(exp[254], call('QR_EXP')[254]);
  assert.equal(exp.length, 512, 'doubled so log(a)+log(b) never wraps');
  assert.equal(exp[255], 1, 'the multiplicative group has order 255');
  const log = call('QR_LOG');
  for (let i = 1; i < 255; i++) assert.equal(log[exp[i]], i);
});

test('qrMul is the field multiplication, with zero absorbing', () => {
  assert.equal(call('qrMul(0, 123)'), 0);
  assert.equal(call('qrMul(123, 0)'), 0);
  assert.equal(call('qrMul(1, 123)'), 123);
  assert.equal(call('qrMul(2, 0x80)'), 0x1d, '0x80 doubled folds by 0x11d');
  // commutative and associative over a sample
  for (const [a, b, c] of [[3, 7, 11], [200, 13, 99], [255, 255, 2]]) {
    assert.equal(call(`qrMul(${a}, ${b})`), call(`qrMul(${b}, ${a})`));
    assert.equal(call(`qrMul(qrMul(${a}, ${b}), ${c})`), call(`qrMul(${a}, qrMul(${b}, ${c}))`));
  }
});

test('the generator polynomial for n EC codewords has degree n and is monic', () => {
  for (const n of [10, 16, 18, 22, 24, 26]) {
    const g = call(`qrGeneratorPoly(${n})`);
    assert.equal(g.length, n + 1);
    assert.equal(g[0], 1);
    assert.ok(g.every(v => v >= 0 && v <= 255));
  }
});

// ---------- 2. Reed-Solomon ----------

test('data followed by its EC codewords is divisible by the generator polynomial', () => {
  // Dividing the full codeword sequence again must leave a zero remainder — the property every
  // Reed-Solomon decoder relies on.
  const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
  for (const ecLen of [10, 18, 26]) {
    const ec = call(`qrEcCodewords(${JSON.stringify(data)}, ${ecLen})`);
    assert.equal(ec.length, ecLen);
    const zero = call(`qrEcCodewords(${JSON.stringify(data.concat(ec))}, ${ecLen})`);
    assert.deepEqual(zero, new Array(ecLen).fill(0));
  }
});

test('EC codewords actually depend on the data (not a constant)', () => {
  const a = call('qrEcCodewords([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 10)');
  const b = call('qrEcCodewords([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,17], 10)');
  assert.notDeepEqual(a, b);
});

// ---------- version selection ----------

test('the level-M block table is internally consistent with the total codeword counts', () => {
  const versions = call('QR_M_VERSIONS');
  assert.equal(versions.length, 10);
  versions.forEach(([version, total, ecPerBlock, groups]) => {
    const blocks = groups.reduce((n, g) => n + g[0], 0);
    const data = groups.reduce((n, g) => n + g[0] * g[1], 0);
    assert.equal(data + blocks * ecPerBlock, total, `version ${version} block table`);
  });
});

test('qrVersionForByteLength picks the smallest version that fits', () => {
  assert.equal(call('qrVersionForByteLength(1)')[0], 1);
  assert.equal(call('qrVersionForByteLength(14)')[0], 1, 'v1-M holds 16 data codewords, 2 of them header/terminator');
  assert.equal(call('qrVersionForByteLength(15)')[0], 2);
  assert.equal(call('qrVersionForByteLength(50)')[0], 4);
  assert.equal(call('qrVersionForByteLength(213)')[0], 10);
  assert.equal(call('qrVersionForByteLength(400)'), null, 'beyond version 10 there is simply no QR');
});

test('an invite link comfortably fits', () => {
  const link = 'https://poker-tau-pink.vercel.app/?join=ABCD2345';
  const q = call(`qrModules(${JSON.stringify(link)})`);
  assert.ok(q.version <= 4, `expected a small symbol, got version ${q.version}`);
  assert.equal(q.size, q.version * 4 + 17);
});

// ---------- 3. the symbol ----------

function symbol(text) {
  return call(`qrModules(${JSON.stringify(text)})`);
}

test('function patterns land where the standard puts them', () => {
  const { size, modules } = symbol('HELLO');
  assert.equal(size, 21, 'a short string is a version 1 symbol');
  // finder rings: dark corner 7x7 border, light separator around it
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(modules[r0][c0 + i], 1);
      assert.equal(modules[r0 + 6][c0 + i], 1);
      assert.equal(modules[r0 + i][c0], 1);
      assert.equal(modules[r0 + i][c0 + 6], 1);
    }
    assert.equal(modules[r0 + 1][c0 + 1], 0, 'light ring');
    assert.equal(modules[r0 + 3][c0 + 3], 1, 'dark 3x3 core');
  }
  // timing patterns alternate, starting dark at index 6
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0);
  }
  // the always-dark module
  assert.equal(modules[size - 8][8], 1);
});

test('format information decodes to level M and the chosen mask, in both copies', () => {
  const { size, modules, mask } = symbol('HELLO');
  const bit = (r, c) => modules[r][c];
  let copyA = 0;
  for (let i = 0; i <= 5; i++) copyA |= bit(8, i) << i;
  copyA |= bit(8, 7) << 6; copyA |= bit(8, 8) << 7; copyA |= bit(7, 8) << 8;
  for (let i = 9; i <= 14; i++) copyA |= bit(14 - i, 8) << i;
  let copyB = 0;
  for (let i = 0; i <= 7; i++) copyB |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i <= 14; i++) copyB |= bit(8, size - 15 + i) << i;
  assert.equal(copyA, copyB, 'the two format copies must be identical');
  // Undo the 0x5412 mask; the top 5 bits are (EC level, mask), the low 10 the BCH remainder.
  const raw = copyA ^ 0x5412;
  const data = raw >> 10;
  assert.equal(data >> 3, 0, 'EC level M is 0b00');
  assert.equal(data & 7, mask);
  // BCH(15,5) with generator 0x537: re-encoding the 5 data bits reproduces the 15-bit word.
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) ? 0x537 : 0);
  assert.equal(((data << 10) | (rem & 0x3ff)), raw);
});

// An independent decoder: rebuild the function-module map, unmask, walk the placement in reverse,
// de-interleave the blocks and read the byte-mode payload back.
function decode(text) {
  const q = symbol(text);
  const { size, version, mask, modules } = q;
  const fn = [];
  for (let r = 0; r < size; r++) fn.push(new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true; };
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([r0, c0]) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
  });
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }
  const centers = call('QR_ALIGN')[version];
  centers.forEach(r => centers.forEach(c => {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) return;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }));
  for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const row = upward ? size - 1 - k : k;
      for (let d = 0; d < 2; d++) {
        const c = col - d;
        if (fn[row][c]) continue;
        bits.push(modules[row][c] ^ (maskFns[mask](row, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const interleaved = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    interleaved.push(v);
  }
  // de-interleave the data half back into blocks
  const spec = call('QR_M_VERSIONS').find(v => v[0] === version);
  const sizes = [];
  spec[3].forEach(g => { for (let b = 0; b < g[0]; b++) sizes.push(g[1]); });
  const blocks = sizes.map(() => []);
  let at = 0;
  const widest = Math.max(...sizes);
  for (let i = 0; i < widest; i++) {
    for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) blocks[b].push(interleaved[at++]);
  }
  const data = [].concat(...blocks);
  // byte mode: 4 mode bits, then the character count, then the payload
  const stream = [];
  data.forEach(w => { for (let i = 7; i >= 0; i--) stream.push((w >> i) & 1); });
  const take = (n, from) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[from + i]; return v; };
  const mode = take(4, 0);
  const countBits = version < 10 ? 8 : 16;
  const count = take(countBits, 4);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(take(8, 4 + countBits + i * 8));
  return { mode, bytes: Buffer.from(bytes).toString('utf8') };
}

test('a placed symbol decodes back to the original payload', () => {
  for (const text of ['HELLO', 'https://poker-tau-pink.vercel.app/?join=ABCD2345', 'x']) {
    const out = decode(text);
    assert.equal(out.mode, 4, 'byte mode');
    assert.equal(out.bytes, text);
  }
});

test('a longer payload spanning several EC blocks still decodes', () => {
  // ~120 characters forces a multi-block version, exercising the interleaving.
  const text = 'https://poker-tau-pink.vercel.app/some/deeper/path/that/is/long/enough/to/need/more/blocks/?join=ABCD2345&extra=padding';
  const q = symbol(text);
  assert.ok(q.version >= 6, `expected a multi-block version, got ${q.version}`);
  assert.equal(decode(text).bytes, text);
});

test('UTF-8 payloads survive the byte mode round-trip', () => {
  assert.equal(decode('קופה').bytes, 'קופה');
});

test('an oversized payload returns null instead of a broken symbol', () => {
  assert.equal(call(`qrModules(${JSON.stringify('x'.repeat(400))})`), null);
});

// ---------- wiring ----------

test('the invite card renders a real QR with an accessible label', () => {
  assert.match(html, /aria-label", "קוד QR להזמנה"/);
  assert.match(html, /qrSvgElement\(/);
  assert.ok(!/QR placeholder/.test(html), 'the placeholder wording is gone');
});
