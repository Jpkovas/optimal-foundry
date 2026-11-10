import { test } from "node:test";
import assert from "node:assert/strict";
import { imageDimensions, trimOggOpus, oggCrc, HEADER_BYTES } from "../scripts/media/converter-bytes.mjs";

/**
 * The byte-level helpers of the converter worker: reading an image's pixel size from its header (so an oversized
 * map is refused before the browser decodes it) and end-trimming an Ogg Opus file (so a converted loop keeps the
 * exact length of its source).
 */

const bytes = (...parts) => {
  const flat = parts.flatMap(p => (typeof p === "string" ? [...Buffer.from(p, "latin1")] : [...p]));
  return Uint8Array.from(flat);
};
const be16 = v => [(v >> 8) & 255, v & 255];
const be32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le16 = v => [v & 255, (v >> 8) & 255];
const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

/* -------------------------------------------- */
/*  imageDimensions                             */
/* -------------------------------------------- */

test("imageDimensions reads a PNG header", () => {
  const png = bytes([0x89], "PNG", [0x0D, 0x0A, 0x1A, 0x0A], be32(13), "IHDR", be32(12000), be32(9000), [8, 6, 0, 0, 0]);
  assert.deepEqual(imageDimensions(png), { width: 12000, height: 9000 });
  assert.equal(imageDimensions(png.subarray(0, 23)), null, "a header cut short gives no answer");
});

test("imageDimensions reads GIF and BMP headers", () => {
  assert.deepEqual(imageDimensions(bytes("GIF89a", le16(640), le16(480), [0, 0, 0])), { width: 640, height: 480 });
  const info = bytes("BM", le32(0), le32(0), le32(54), le32(40), le32(1920), le32(-1080 >>> 0), le16(1), le16(24));
  assert.deepEqual(imageDimensions(info), { width: 1920, height: 1080 }, "a top-down BMP stores a negative height");
  const core = bytes("BM", le32(0), le32(0), le32(26), le32(12), le16(320), le16(200), le16(1), le16(24), [0, 0]);
  assert.deepEqual(imageDimensions(core), { width: 320, height: 200 });
});

test("imageDimensions walks the JPEG segments up to the frame header", () => {
  const app0 = bytes([0xFF, 0xE0], be16(16), "JFIF", new Array(10).fill(0));
  const exif = bytes([0xFF, 0xE1], be16(2 + 300), new Array(300).fill(0x41));
  const dqt = bytes([0xFF, 0xDB], be16(2 + 65), new Array(65).fill(1));
  const dht = bytes([0xFF, 0xC4], be16(2 + 20), new Array(20).fill(2));
  const sof = marker => bytes([0xFF, marker], be16(17), [8], be16(3000), be16(4000), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = bytes([0xFF, 0xDA], be16(12), new Array(10).fill(0));

  const baseline = bytes([0xFF, 0xD8], app0, exif, dqt, sof(0xC0), dht, sos);
  assert.deepEqual(imageDimensions(baseline), { width: 4000, height: 3000 });
  // Progressive files use SOF2, and a Huffman table (0xC4, inside the SOF range) may come first.
  const progressive = bytes([0xFF, 0xD8], app0, dht, [0xFF, 0xFF], sof(0xC2), sos);
  assert.deepEqual(imageDimensions(progressive), { width: 4000, height: 3000 });

  assert.equal(imageDimensions(bytes([0xFF, 0xD8], app0, exif)), null, "the frame header is beyond these bytes");
  assert.equal(imageDimensions(bytes([0xFF, 0xD8], app0, sos, sof(0xC0))), null, "image data before any frame header");
  assert.equal(imageDimensions(bytes([0xFF, 0xD8], [0x12, 0x34, 0x56, 0x78])), null, "not at a marker");
});

test("imageDimensions answers null for anything else", () => {
  assert.equal(imageDimensions(bytes("RIFF", le32(100), "WEBPVP8 ")), null);
  assert.equal(imageDimensions(bytes("II*", [0], le32(8))), null, "TIFF is left to the decoder");
  assert.equal(imageDimensions(new Uint8Array(0)), null);
  assert.equal(imageDimensions(bytes("GIF89a", le16(0), le16(480), [0, 0, 0])), null, "a zero size is not a size");
  assert.ok(HEADER_BYTES >= 65536 * 4, "enough to pass an EXIF block and an ICC profile");
});

test("imageDimensions honours the view's offset into a larger buffer", () => {
  const whole = bytes([1, 2, 3], "GIF89a", le16(64), le16(32), [0, 0, 0]);
  assert.deepEqual(imageDimensions(whole.subarray(3)), { width: 64, height: 32 });
});

/* -------------------------------------------- */
/*  trimOggOpus                                 */
/* -------------------------------------------- */

/** One Ogg page holding `packets` (arrays of bytes, each shorter than 255), with a valid checksum. */
function oggPage({ granule, flags = 0, sequence, packets }) {
  const header = bytes("OggS", [0, flags], le32(Number(BigInt.asUintN(32, BigInt(granule)))),
    le32(Number(BigInt.asUintN(32, BigInt(granule) >> 32n))), le32(0x1234), le32(sequence), le32(0),
    [packets.length], packets.map(p => p.length));
  const page = bytes(header, ...packets);
  new DataView(page.buffer).setUint32(22, oggCrc(page), true);
  return page;
}

/** A minimal Ogg Opus file: head, tags, one page of ten 960-sample packets and a last page of five. */
function oggOpus({ preSkip = 312, lastFlags = 4, lastGranule = 14400 } = {}) {
  const head = bytes("OpusHead", [1, 2], le16(preSkip), le32(48000), le16(0), [0]);
  const packet = [0xFC, 1, 2, 3];
  const file = bytes(
    oggPage({ granule: 0, flags: 2, sequence: 0, packets: [head] }),
    oggPage({ granule: 0, sequence: 1, packets: [bytes("OpusTags", le32(0), le32(0))] }),
    oggPage({ granule: 9600, sequence: 2, packets: new Array(10).fill(packet) }),
    oggPage({ granule: lastGranule, flags: lastFlags, sequence: 3, packets: new Array(5).fill(packet) })
  );
  return file.buffer;
}

/** Offsets and granule positions of every page, and whether each checksum is right. */
function pages(buffer) {
  const u = new Uint8Array(buffer), v = new DataView(buffer), list = [];
  for ( let offset = 0; offset < u.length; ) {
    const segments = u[offset + 26];
    let size = 27 + segments;
    for ( let i = 0; i < segments; i++ ) size += u[offset + 27 + i];
    const copy = u.slice(offset, offset + size);
    copy.fill(0, 22, 26);
    list.push({ granule: Number(v.getBigInt64(offset + 6, true)), crcOk: oggCrc(copy) === v.getUint32(offset + 22, true) });
    offset += size;
  }
  return list;
}

test("oggCrc is the Ogg checksum (CRC-32, polynomial 04C11DB7, no reflection, no inversion)", () => {
  assert.equal(oggCrc(bytes("123456789")), 0x89A1897F);
  assert.equal(oggCrc(new Uint8Array(0)), 0);
});

test("trimOggOpus moves the last page's granule position to pre-skip + frames", () => {
  const buffer = oggOpus();
  const untouched = new Uint8Array(buffer.slice(0));
  // 13000 samples went into the encoder; the packets hold 14400 - 312 = 14088.
  assert.equal(trimOggOpus(buffer, 13000), true);
  const list = pages(buffer);
  assert.deepEqual(list.map(p => p.granule), [0, 0, 9600, 13312]);
  assert.ok(list.every(p => p.crcOk), "every page still has a valid checksum");
  // Only the granule position and the checksum of the last page changed.
  const now = new Uint8Array(buffer);
  const changed = [];
  for ( let i = 0; i < now.length; i++ ) if ( now[i] !== untouched[i] ) changed.push(i);
  const lastPage = now.length - (27 + 5 + 20);
  assert.ok(changed.every(i => (i >= lastPage + 6) && (i < lastPage + 26)), `changed bytes: ${changed}`);
});

test("trimOggOpus leaves alone what it cannot or need not trim", () => {
  const same = buf => { const copy = buf.slice(0); return [copy, new Uint8Array(buf)]; };
  const cases = [
    ["already ends there", oggOpus(), 14088],
    ["more samples than the packets hold", oggOpus(), 20000],
    ["would cut into the page before the last", oggOpus(), 9000],
    ["last page is not an end of stream", oggOpus({ lastFlags: 0 }), 13000],
    ["not an Ogg file", bytes("RIFF", new Array(60).fill(0)).buffer, 100],
    ["empty", new ArrayBuffer(0), 100]
  ];
  for ( const [label, buffer, frames] of cases ) {
    const [copy, before] = same(buffer);
    assert.equal(trimOggOpus(copy, frames), false, label);
    assert.deepEqual(new Uint8Array(copy), before, `${label}: bytes untouched`);
  }
  const truncated = oggOpus().slice(0, -3);
  assert.equal(trimOggOpus(truncated, 13000), false, "a cut-off last page");
  const vorbis = oggOpus();
  new Uint8Array(vorbis).set(Buffer.from("\x01vorbis\0", "latin1"), 28);
  assert.equal(trimOggOpus(vorbis, 13000), false, "another codec in the Ogg container");
});

test("trimOggOpus keeps a sound that ends exactly on the previous page boundary", () => {
  const buffer = oggOpus();
  // pre-skip + frames === 9600: nothing of the last page survives, which the format can still express.
  assert.equal(trimOggOpus(buffer, 9600 - 312), true);
  assert.equal(pages(buffer).at(-1).granule, 9600);
});
