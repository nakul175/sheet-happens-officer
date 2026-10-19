// Reads the font names out of a WOFF2 file, so a spec can check which typeface a page really loads
// instead of the CSS family alias (next/font/local names the face after the variable, e.g. "publicSans").
import { brotliDecompressSync } from "node:zlib";

function base128(buf: Buffer, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[at + i];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, at + i + 1];
  }
  throw new Error("Bad UIntBase128 in the WOFF2 table directory.");
}

/** The decompressed font tables of a WOFF2 file. */
function tables(buf: Buffer): Buffer {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("Not a WOFF2 file.");
  if (buf.toString("latin1", 4, 8) === "ttcf") throw new Error("WOFF2 font collections are not read here.");
  const numTables = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let at = 48;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++];
    const tag = flags & 0x3f;
    if (tag === 63) at += 4;
    const version = (flags >> 6) & 3;
    [, at] = base128(buf, at);
    // glyf (10) and loca (11) are untransformed at version 3; every other table at version 0.
    const transformed = tag === 10 || tag === 11 ? version !== 3 : version !== 0;
    if (transformed) [, at] = base128(buf, at);
  }
  return brotliDecompressSync(buf.subarray(at, at + compressed));
}

/** True when the font's name table carries `name` (UTF-16BE, as Windows and Unicode name records store it, or Mac Roman). */
export function woff2HasName(buf: Buffer, name: string): boolean {
  const data = tables(buf);
  const utf16be = Buffer.from(name, "utf16le").swap16();
  return data.includes(utf16be) || data.includes(Buffer.from(name, "latin1"));
}
