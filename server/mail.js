// Outgoing e-mail through Resend (https://resend.com). Used only for confirming
// an address and for password-reset links.

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

/** A trimmed, plausible address of sane length, or null. */
export function cleanEmail(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

/**
 * Mail is on only when all three settings are present. `publicUrl` is where the
 * links in messages point; it is configured rather than taken from the request,
 * so a forged Host header cannot redirect a reset link to someone else's site.
 */
export function createMailer({ apiKey = '', from = '', publicUrl = '' } = {}) {
  let base = '';
  try {
    const u = new URL(publicUrl);
    if (u.protocol === 'https:' || u.hostname === 'localhost') base = u.origin;
  } catch {
    /* not configured */
  }
  const enabled = Boolean(apiKey && from && base);
  return {
    enabled,
    /** Absolute link to a one-time page of the app, e.g. link('reset', token). */
    link: (kind, token) => `${base}/#${kind}=${token}`,
    async send({ to, subject, text }) {
      if (!enabled) throw new Error('E-mail is not configured.');
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`The mail service replied ${res.status}`);
    },
  };
}
