/** APL-2521 forbids IP on work events; APL-2742 AC4 explicitly adds verification security events.
 * Keep the exceptions exact: a prefix or arbitrary authentication-looking name is not permission to store IP. */
const CLIENT_IP_EVENTS = new Set(["SIGN_IN", "SIGN_IN_FAILED", "SIGN_IN_LOCKED", "SIGN_IN_REFUSED", "EMAIL_VERIFIED", "VERIFY_EMAIL_REQUESTED"]);
export const auditEventMayCarryIp = (event: string) => CLIENT_IP_EVENTS.has(event);
