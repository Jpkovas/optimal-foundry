/**
 * Byte-level helpers of the converter worker: nothing here needs a browser API, so `node --test` covers them.
 */

/** How much of a file is read to find its image header (a JPEG frame header sits after its EXIF and ICC blocks). */
export const HEADER_BYTES = 1 << 20;

/**
 * Pixel size of a PNG, JPEG, GIF or BMP, read from the start of the file. The header costs a few bytes; the decode
 * it lets the converter refuse costs 4 bytes per pixel. JPEG sizes ignore the EXIF rotation, which changes neither
 * the pixel count nor the longest side.
 * @param {Uint8Array} bytes  The first bytes of the file (HEADER_BYTES is plenty)
 * @returns {{width: number, height: number}|null}  null for any other format, or when the header is not in `bytes`
 */
export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.byteLength;
  // PNG: 8-byte signature, then the IHDR chunk (length, "IHDR", width, height).
  if ( (length >= 24) && (view.getUint32(0) === 0x89504E47) && (view.getUint32(4) === 0x0D0A1A0A) ) {
    return dimensions(view.getUint32(16), view.getUint32(20));
  }
  // GIF: "GIF8", then the logical screen size.
  if ( (length >= 10) && (view.getUint32(0) === 0x47494638) ) {
    return dimensions(view.getUint16(6, true), view.getUint16(8, true));
  }
  // BMP: "BM", then a 12-byte core header (16-bit sizes) or an info header (signed 32-bit; negative is top-down).
  if ( (length >= 26) && (view.getUint16(0) === 0x424D) ) {
    if ( view.getUint32(14, true) === 12 ) return dimensions(view.getUint16(18, true), view.getUint16(20, true));
    return dimensions(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
  }
  if ( (length >= 4) && (view.getUint16(0) === 0xFFD8) ) return jpegDimensions(view);
  return null;
}

/** Walk the JPEG segments up to the frame header (SOFn), which holds the size. */
function jpegDimensions(view) {
  let offset = 2;
  while ( offset + 4 <= view.byteLength ) {
    if ( view.getUint8(offset) !== 0xFF ) return null;
    const marker = view.getUint8(offset + 1);
    // 0xFF fill bytes may precede a marker; RSTn and TEM carry no length.
    if ( marker === 0xFF ) { offset += 1; continue; }
    if ( ((marker >= 0xD0) && (marker <= 0xD7)) || (marker === 0x01) ) { offset += 2; continue; }
    // Image data (SOS) or the end (EOI) before any frame header: not a file a decoder would accept either.
    if ( (marker === 0xDA) || (marker === 0xD9) ) return null;
    // SOF0-SOF15, minus the three codes in that range that are tables (DHT, JPG, DAC).
    const frame = (marker >= 0xC0) && (marker <= 0xCF) && (marker !== 0xC4) && (marker !== 0xC8) && (marker !== 0xCC);
    if ( frame ) {
      if ( offset + 9 > view.byteLength ) return null;
      return dimensions(view.getUint16(offset + 7), view.getUint16(offset + 5));
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

const dimensions = (width, height) => ((width > 0) && (height > 0) ? { width, height } : null);

/* -------------------------------------------- */
/*  Ogg Opus end trimming                       */
/* -------------------------------------------- */

const OGG_CAPTURE = 0x4F676753; // "OggS"
const OGG_HEADER_BYTES = 27;
const OGG_END_OF_STREAM = 0x04;

/** Ogg page checksum table: CRC-32, polynomial 0x04C11DB7, most significant bit first, no inversion. */
const OGG_CRC = new Uint32Array(256).map((_, index) => {
  let r = index << 24;
  for ( let bit = 0; bit < 8; bit++ ) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1);
  return r >>> 0;
});

/** Checksum of one Ogg page (computed with its own checksum field set to zero). */
export function oggCrc(bytes) {
  let crc = 0;
  for ( let i = 0; i < bytes.length; i++ ) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ bytes[i]) & 0xFF]) >>> 0;
  return crc;
}

/**
 * Make an Ogg Opus file decode to exactly `frames` samples (48 kHz), in place.
 *
 * Opus is coded in whole 20 ms packets after a "pre-skip" of encoder delay, so the last packet ends in padding
 * the source never had. The browser's encoder and Mediabunny's muxer leave that padding in: measured in Chromium,
 * the output decodes 0 to 20 ms longer than its source (13.5 ms for a 3.000 s sound), which ticks every time a
 * looped sound restarts. RFC 7845 section 4.5 has the cure: when the granule position of the last page is lower
 * than the samples its packets hold, the decoder drops the rest. Decoders also drop `pre-skip` samples at the
 * start, so the position that keeps `frames` samples is pre-skip + frames.
 *
 * @param {ArrayBuffer} buffer  The whole file: one Opus stream, as Mediabunny writes it
 * @param {number} frames       Samples that went into the encoder
 * @returns {boolean}  true when the last page was rewritten; false when the file is not what is expected, already
 *                     ends there, or would lose more than its last page holds (the format cannot express that)
 */
export function trimOggOpus(buffer, frames) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let preSkip = null;
  let last = null;
  // Granule position of the last page before `last` on which a packet ended (-1 marks a page with none).
  let previous = 0;
  for ( let offset = 0; (offset + OGG_HEADER_BYTES <= bytes.length) && (view.getUint32(offset) === OGG_CAPTURE); ) {
    const segments = bytes[offset + 26];
    const body = offset + OGG_HEADER_BYTES + segments;
    let size = OGG_HEADER_BYTES + segments;
    for ( let i = 0; i < segments; i++ ) size += bytes[offset + OGG_HEADER_BYTES + i];
    if ( offset + size > bytes.length ) return false;
    if ( offset === 0 ) {
      // First page: "OpusHead", version, channel count, then the 16-bit pre-skip.
      if ( (size < OGG_HEADER_BYTES + segments + 12) || (view.getUint32(body) !== 0x4F707573) ) return false;
      preSkip = view.getUint16(body + 10, true);
    }
    if ( last && (last.granule >= 0) ) previous = last.granule;
    last = { offset, size, granule: Number(view.getBigInt64(offset + 6, true)), flags: bytes[offset + 5] };
    offset += size;
  }
  if ( (preSkip === null) || !(last.flags & OGG_END_OF_STREAM) ) return false;
  const granule = preSkip + Math.round(frames);
  if ( !(granule >= previous) || !(granule < last.granule) ) return false;

  view.setBigInt64(last.offset + 6, BigInt(granule), true);
  view.setUint32(last.offset + 22, 0, true);
  view.setUint32(last.offset + 22, oggCrc(bytes.subarray(last.offset, last.offset + last.size)), true);
  return true;
}
