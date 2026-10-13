import { promises as fs } from 'node:fs';

export interface ImageDimensions { width: number; height: number }

/** Read only a small encoded header; opening a paper should not decode every image. */
export async function readImageDimensions(filename: string): Promise<ImageDimensions | undefined> {
  const file = await fs.open(filename, 'r');
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return dimensionsFromHeader(header.subarray(0, bytesRead));
  } finally { await file.close(); }
}

export function dimensionsFromHeader(bytes: Uint8Array): ImageDimensions | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number): ImageDimensions | undefined =>
    width > 0 && height > 0 && width <= 100000 && height <= 100000 ? { width, height } : undefined;
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.toString('ascii', 12, 16) === 'IHDR') {
    return size(data.readUInt32BE(16), data.readUInt32BE(20));
  }
  if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) {
    return size(data.readUInt16LE(6), data.readUInt16LE(8));
  }
  if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') return size(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
    if (kind === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
      return size(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
    }
    if (kind === 'VP8L' && data[20] === 0x2f) {
      const packed = data.readUInt32LE(21);
      return size(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff));
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < data.length) {
      if (data[offset] !== 0xff) return undefined;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return size(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
      }
      offset += length;
    }
  }
  return undefined;
}
