// Minimal structured logger that never prints secrets.
const redact = (s) => String(s)
  .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '[BOT_TOKEN]')
  .replace(/postgres(ql)?:\/\/[^\s]+/g, '[DATABASE_URL]');
function out(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg: redact(msg) };
  if (extra !== undefined) line.extra = redact(extra instanceof Error ? (extra.stack || extra.message) : typeof extra === 'string' ? extra : JSON.stringify(extra));
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}
export const log = {
  info: (m, e) => out('info', m, e),
  warn: (m, e) => out('warn', m, e),
  error: (m, e) => out('error', m, e),
};
