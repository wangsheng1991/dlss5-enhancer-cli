/**
 * Read the pixel size of a JPEG / PNG / WebP straight from its header, and plan the output size.
 *
 * No dependency is pulled in for this: the client must run from `npx` without a build step or a
 * native module, and the three formats it accepts each announce their size in a fixed, documented
 * place. Anything unreadable returns null and the caller refuses the file instead of guessing.
 */
import { MAX_EDGE } from './config.mjs';

const roundTo16 = (value) => Math.max(16, Math.round(value / 16) * 16);

/** @returns {{width:number,height:number,format:string}|null} */
export function readDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  const png = readPng(buffer);
  if (png) return png;
  const jpeg = readJpeg(buffer);
  if (jpeg) return jpeg;
  const webp = readWebp(buffer);
  if (webp) return webp;
  return null;
}

function readPng(buffer) {
  // 89 50 4E 47 0D 0A 1A 0A, then the IHDR chunk: length(4) 'IHDR'(4) width(4) height(4), big endian.
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
}

function readJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0..SOF15 except the four that are not frame headers (DHT=C4, JPG=C8, DAC=CC).
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
        format: 'jpeg'
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebp(buffer) {
  if (buffer.length < 30) return null;
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = buffer.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, then the 3-byte start code, then two 14-bit sizes.
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      format: 'webp'
    };
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
  }
  if (chunk === 'VP8X') {
    return {
      width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
      format: 'webp'
    };
  }
  return null;
}

/**
 * The output geometry the server will ask the model for. Kept identical to `enhanceOutput` on the
 * site so `--dry-run` tells the truth: the factor is a target, and the 1536 px edge wins when the
 * two disagree.
 */
export function planOutput(width, height, factor) {
  const scale = Math.min(factor, MAX_EDGE / width, MAX_EDGE / height);
  return {
    width: roundTo16(width * scale),
    height: roundTo16(height * scale),
    factor: Math.round(scale * 100) / 100,
    clamped: scale < factor
  };
}
