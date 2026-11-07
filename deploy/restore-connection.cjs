// Pass the original URL to pg so sslmode/sslrootcert policy is never discarded.
// Error messages must not serialize this object: it contains credentials.
function restoreConnectionOptions(url) {
  if (typeof url !== 'string' || !url) throw new Error('RESTORE_CONNECTION_REQUIRED');
  return { connectionString: url, connectionTimeoutMillis: 10_000 };
}
module.exports = { restoreConnectionOptions };
