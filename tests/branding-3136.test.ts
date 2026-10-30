import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
describe("SHO-3136 approved identity", () => {
  it("uses identical transparent vector masters on light and dark surfaces, without concept-board text", async () => {
    const a = await readFile(new URL("public/logo-icon.svg",root),"utf8");
    const b = await readFile(new URL("public/logo-icon-reversed.svg",root),"utf8");
    expect(a).toBe(b);
    expect(a).toContain('fill="#fff"');
    expect(a).toContain('#D99D29');
    expect(a).toContain('#2C2F71');
    expect(a).not.toMatch(/<image|<script|EVIL GENIUS|THE MAVERICK|data:/i);
    const { data, info } = await sharp(Buffer.from(a)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    expect(data[3]).toBe(0); // Outside the sheet stays transparent.
    const centre = (60 * info.width + 150) * 4;
    expect([...data.subarray(centre,centre+4)]).toEqual([255,255,255,255]);
  });
  it("ships all existing raster sizes and a multi-size favicon", async () => {
    for (const [name,size] of [["icon-192.png",192],["icon-512.png",512],["maskable-512.png",512],["apple-touch-icon.png",180]] as const) {
      const metadata = await sharp(fileURLToPath(new URL(`public/icons/${name}`,root))).metadata();
      expect([metadata.width,metadata.height]).toEqual([size,size]);
    }
    const ico = await readFile(new URL("src/app/favicon.ico",root));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    expect([ico[6],ico[22],ico[38]]).toEqual([16,32,48]);
  });
});
