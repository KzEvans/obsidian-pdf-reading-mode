import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dimensionsFromHeader, readImageDimensions } from '../src/image-size';

test('image layout dimensions are available without decoding PNG pixels', async () => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write('IHDR', 12); header.writeUInt32BE(1400, 16); header.writeUInt32BE(900, 20);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-image-'));
  try {
    const filename = path.join(directory, 'image.png');
    await fs.writeFile(filename, Buffer.concat([header, Buffer.alloc(1024 * 1024)]));
    assert.deepEqual(await readImageDimensions(filename), { width: 1400, height: 900 });
  } finally { await fs.rm(directory, { recursive: true }); }
});

test('JPEG dimensions skip metadata segments and accept progressive frames', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 4, 1, 2, 0xff, 0xc2, 0, 11, 8, 0x02, 0x58, 0x03, 0x20, 1, 1, 0x11, 0]);
  assert.deepEqual(dimensionsFromHeader(jpeg), { width: 800, height: 600 });
  assert.equal(dimensionsFromHeader(jpeg.subarray(0, 15)), undefined);
});

test('GIF and lossless/extended WebP headers preserve their aspect ratios', () => {
  const gif = Buffer.alloc(10); gif.write('GIF89a'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
  assert.deepEqual(dimensionsFromHeader(gif), { width: 320, height: 200 });
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP', 8); webp.write('VP8X', 12);
  webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(dimensionsFromHeader(webp), { width: 800, height: 600 });
  webp.write('VP8L', 12); webp[20] = 0x2f; webp.writeUInt32LE(799 | (599 << 14), 21);
  assert.deepEqual(dimensionsFromHeader(webp), { width: 800, height: 600 });
});

test('unrecognized or truncated headers do not supply invented dimensions', () => {
  for (const header of [Buffer.alloc(0), Buffer.from('not an image'), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1])]) {
    assert.equal(dimensionsFromHeader(header), undefined);
  }
});
