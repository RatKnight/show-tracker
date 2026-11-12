// iCalendar feed so releases can be subscribed to from Google Calendar, Outlook, etc.

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const pad = (n) => String(n).padStart(2, '0');
const utc = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/** Fold lines at 75 octets as RFC 5545 requires. */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 74) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function buildIcs(shows, now = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//show-tracker//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Show Tracker', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const show of shows) {
    for (const ep of show.episodes) {
      const where = show.streams.map((s) => s.name).join(', ');
      lines.push('BEGIN:VEVENT', `UID:${esc(ep.id)}@show-tracker`, `DTSTAMP:${utc(now)}`);
      if (ep.dateOnly) {
        const d = new Date(ep.airsAt);
        const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        lines.push(`DTSTART;VALUE=DATE:${dateOnly(d)}`, `DTEND;VALUE=DATE:${dateOnly(next)}`);
      } else {
        lines.push(`DTSTART:${utc(ep.airsAt)}`, `DTEND:${utc(ep.airsAt + 30 * 60 * 1000)}`);
      }
      lines.push(`SUMMARY:${esc(`${show.title} – ${ep.label}`)}`);
      const desc = [ep.name, where && `Streams on: ${where}`].filter(Boolean).join('\n');
      if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
      if (/^https?:\/\/[^\s]+$/.test(show.url || '')) lines.push(`URL:${show.url}`);
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
