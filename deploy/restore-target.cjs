// Refuse the common operator error of comparing production with itself.
// Different hostnames are necessary for this isolated-cluster drill, but do
// not by themselves certify firewall containment or backup integrity.
function endpoint(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw coded('RESTORE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw coded('RESTORE_URL_INVALID');
  }
  return parsed.hostname.toLowerCase();
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function assertIsolatedRestoreTarget(productionUrl, restoreUrl) {
  if (endpoint(productionUrl) === endpoint(restoreUrl)) throw coded('RESTORE_TARGET_HOST_MATCHES_PRODUCTION');
}

module.exports = { assertIsolatedRestoreTarget };
