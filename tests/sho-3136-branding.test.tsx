import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("SHO-3136 approved branding", () => {
  it("ships a maintainable white-sheet, navy-outline, gold-glasses SVG mascot", () => {
    for (const file of ["public/logo-icon.svg", "public/logo-icon-reversed.svg"]) {
      const svg = read(file);
      expect(svg).toContain('fill="#fff"');
      expect(svg).toContain("#2C2F71");
      expect(svg).toContain("#D99D29");
      expect(svg).toContain("round gold spectacles");
      expect(svg).not.toContain("EVIL GENIUS");
      expect(svg).not.toContain("data:image");
    }
  });

  it("ships the exact product name in the horizontal vector lockup", () => {
    const lockup = read("public/logo-mark.svg");
    expect(lockup).toContain("Sheet Happens");
    expect(lockup).toContain("Officer");
    expect(lockup).not.toContain("EVIL GENIUS");
  });

  it("keeps one meaningful Home name while decorative brand content stays silent", () => {
    const shell = read("src/app/(app)/Shell.tsx");
    expect(shell.match(/aria-label="Sheet Happens Officer home"/g)).toHaveLength(1);
    expect(shell).toContain('aria-label="Sheet Happens Officer home (SHO)"');
    expect(shell).toContain('<img src="/logo-icon-reversed.svg" alt="" />');
    expect(shell).toContain('aria-hidden="true">Sheet Happens Officer');
  });

  it("preserves the compact 40px desktop and mascot-only phone header", () => {
    const css = read("src/app/(app)/nav-header.css");
    expect(css).toContain(".shell .brand img { width: 40px; height: 40px;");
    expect(css).toContain(".shell .top-brand span { display: none;");
    expect(css).toContain("outline: 3px solid #D99D29");
  });
});
