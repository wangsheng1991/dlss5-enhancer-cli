// Header parsing and output planning. The fixtures are hand-built headers, not real photos:
// the client only ever reads these bytes, and a fake keeps the test independent of any image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planOutput, readDimensions } from '../src/geometry.mjs';

function png(width, height) {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function jpeg(width, height) {
  // SOI, APP0 (length 16), SOF0 with the real 17-byte payload layout, then EOI.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function webpVp8l(width, height) {
  const buffer = Buffer.alloc(40);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(32, 4);
  buffer.write('WEBP', 8, 'latin1');
  buffer.write('VP8L', 12, 'latin1');
  buffer.writeUInt32LE(24, 16);
  buffer[20] = 0x2f;
  buffer.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return buffer;
}

test('reads PNG, JPEG and WebP dimensions', () => {
  assert.deepEqual(readDimensions(png(1200, 800)), { width: 1200, height: 800, format: 'png' });
  assert.deepEqual(readDimensions(jpeg(4032, 3024)), { width: 4032, height: 3024, format: 'jpeg' });
  assert.deepEqual(readDimensions(webpVp8l(640, 480)), { width: 640, height: 480, format: 'webp' });
});

test('refuses anything it cannot read instead of guessing', () => {
  assert.equal(readDimensions(Buffer.from('not an image at all')), null);
  assert.equal(readDimensions(Buffer.alloc(4)), null);
});

test('output follows the site: factor is a target, the 1536 px edge wins', () => {
  assert.deepEqual(planOutput(400, 300, 2), { width: 800, height: 608, factor: 2, clamped: false });
  const clamped = planOutput(1200, 800, 4);
  assert.equal(clamped.width, 1536);
  assert.equal(clamped.height, 1024);
  assert.equal(clamped.clamped, true);
  // Both edges stay multiples of 16, which is what the provider accepts.
  for (const [w, h, f] of [[4032, 3024, 2], [8192, 1000, 4], [17, 17, 2]]) {
    const plan = planOutput(w, h, f);
    assert.equal(plan.width % 16, 0);
    assert.equal(plan.height % 16, 0);
    assert.ok(plan.width <= 1536 && plan.height <= 1536);
  }
});
