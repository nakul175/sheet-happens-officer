// Regenerate existing app icons from the maintained SHO-3136 vector master.
// sharp is installed by Next.js; this script is authoring-only, never a request handler.
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";

const master = await readFile(new URL("../public/logo-icon.svg", import.meta.url), "utf8");
const artwork = master.slice(master.indexOf("  <g"), master.lastIndexOf("</svg>"));
function iconSvg(maskable = false, tiny = false) {
  // Maskable artwork lies inside the central 80% safe area. Keep a white centre
  // even on the navy tile; tiny variants omit only age creases and the mouth crease.
  const art = tiny ? artwork.replace(/<path d="m82 135[^>]+\/>/, "") : artwork;
  const transform = maskable ? "translate(128 151) scale(.8)" : "translate(24 68) scale(1.45)";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="#2C2F71"/><g transform="${transform}">${art}</g></svg>`;
}
for (const [name, size, maskable] of [["icon-192.png",192,false],["icon-512.png",512,false],["apple-touch-icon.png",180,false],["maskable-512.png",512,true]]) {
  await sharp(Buffer.from(iconSvg(maskable))).resize(size,size).png().toFile(fileURLToPath(new URL(`../public/icons/${name}`,import.meta.url)));
}
const sizes = [16,32,48];
const pngs = await Promise.all(sizes.map(size => sharp(Buffer.from(iconSvg(false,true))).resize(size,size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1,2); header.writeUInt16LE(sizes.length,4);
let offset = header.length;
sizes.forEach((size,i) => {
  const p = 6 + i*16;
  header[p] = size; header[p+1] = size;
  header.writeUInt16LE(1,p+4); header.writeUInt16LE(32,p+6);
  header.writeUInt32LE(pngs[i].length,p+8); header.writeUInt32LE(offset,p+12);
  offset += pngs[i].length;
});
await writeFile(new URL("../src/app/favicon.ico",import.meta.url),Buffer.concat([header,...pngs]));
console.log("Generated 192/512px icons, maskable, Apple icon and 16/32/48px favicon from the vector master.");
