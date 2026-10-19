// Reads the family names out of a WOFF2 file's name table, so a spec can check which typeface a page really
// loads instead of the CSS family alias (next/font/local names the face after the variable, e.g. "publicSans").
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

/** The name table's bytes. The decompressed stream holds the tables back to back, in directory order. */
function nameTable(buf: Buffer): Buffer {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("Not a WOFF2 file.");
  if (buf.toString("latin1", 4, 8) === "ttcf") throw new Error("WOFF2 font collections are not read here.");
  const numTables = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  let at = 48;
  let offset = 0;
  let found: [number, number] | null = null;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[at++];
    const tag = flags & 0x3f;
    const name = tag === 63 ? buf.toString("latin1", at, at + 4) : null;
    if (tag === 63) at += 4;
    const version = (flags >> 6) & 3;
    let length: number;
    [length, at] = base128(buf, at);
    // glyf (10) and loca (11) are untransformed at version 3; every other table at version 0.
    const transformed = tag === 10 || tag === 11 ? version !== 3 : version !== 0;
    if (transformed) [length, at] = base128(buf, at);
    // Known tag 5 is "name" (WOFF2 spec, Known Table Tags).
    if (tag === 5 || name === "name") found = [offset, length];
    offset += length;
  }
  if (!found) throw new Error("The WOFF2 file has no name table.");
  const data = brotliDecompressSync(buf.subarray(at, at + compressed));
  return data.subarray(found[0], found[0] + found[1]);
}

/** Family names (name IDs 1 and 16) from the font's name table. */
export function woff2Families(buf: Buffer): string[] {
  const table = nameTable(buf);
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const out = new Set<string>();
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    const platform = table.readUInt16BE(rec);
    const nameId = table.readUInt16BE(rec + 6);
    if (nameId !== 1 && nameId !== 16) continue;
    const bytes = table.subarray(strings + table.readUInt16BE(rec + 10), strings + table.readUInt16BE(rec + 10) + table.readUInt16BE(rec + 8));
    // Unicode (0) and Windows (3) records are UTF-16BE; Mac (1) records are single-byte.
    out.add(platform === 1 ? bytes.toString("latin1") : Buffer.from(bytes).swap16().toString("utf16le"));
  }
  return [...out];
}

/** True when the font's family name (name ID 1 or 16) is exactly `name`. */
export function woff2HasName(buf: Buffer, name: string): boolean {
  return woff2Families(buf).includes(name);
}
