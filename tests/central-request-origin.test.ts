import { describe, expect, it } from "vitest";
import { centralRequestOrigin } from "@/lib/central-client";

describe("Tasks SSO request origin", () => {
    it.each([
        ["tasks.aplyd.org", "https://tasks.aplyd.org"],
        ["sheethappensofficer.aplyd.org", "https://sheethappensofficer.aplyd.org"],
        ["tasks.aplyd.org.example.net", "https://sheethappensofficer.aplyd.org"],
    ])("resolves %s without trusting the forwarded origin", (host, expected) => {
        const request = new Request("http://localhost:3000/api/auth/aplyd/start", {
            headers: { host, "x-forwarded-host": "attacker.example.net" },
        });
        expect(centralRequestOrigin(request)).toBe(expected);
    });
});
