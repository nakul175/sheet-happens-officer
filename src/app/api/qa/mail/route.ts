import { qaMailResponse } from "@/lib/mail-sink";
import { handle } from "@/lib/http";

// Staging test mailbox (APL-2681). 404 unless the sink is active for this host.
export const GET = handle(async (req: Request) => qaMailResponse(req));
