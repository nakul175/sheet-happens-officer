// SHO-US-14.12 AC1: the Compact choice is saved per person. Server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com.
import { describe, expect, it } from "vitest";
import { account, Client } from "./helpers";

describe("compact rows setting (14.12)", () => {
  it("starts off, saves for the person, and does not change anyone else", async () => {
    const a = await account("dense");
    const b = await account("roomy");
    expect((await a.c.get("/api/profile/density")).json).toEqual({ compact: false });
    expect((await a.c.put("/api/profile/density", { compact: true })).json).toEqual({ compact: true });
    expect((await a.c.get("/api/profile/density")).json).toEqual({ compact: true });
    expect((await b.c.get("/api/profile/density")).json).toEqual({ compact: false });
    // it follows the person to another device (a fresh sign-in)
    const again = new Client();
    expect((await again.post("/api/auth/signin", { email: a.email, password: "correct-horse-9" })).status).toBe(200);
    expect((await again.get("/api/profile/density")).json).toEqual({ compact: true });
    expect((await a.c.put("/api/profile/density", { compact: false })).json).toEqual({ compact: false });
  });
  it("refuses a bad value and a signed-out caller", async () => {
    const a = await account("dense");
    expect((await a.c.put("/api/profile/density", { compact: "yes" })).status).toBe(400);
    expect((await a.c.put("/api/profile/density", {})).status).toBe(400);
    expect((await new Client().put("/api/profile/density", { compact: true })).status).toBe(401);
  });
});
