// When alerts may go out: the user's local hour, quiet hours and the daily digest.

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

/** { hour: 0-23, day: 'YYYY-MM-DD' } of a timestamp in a time zone (UTC if unset or invalid). */
export function localClock(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimeZone(tz) ? tz : 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { hour: Number(get('hour')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

/** Is `hour` inside quiet hours? The range may wrap past midnight (22 -> 7). */
export function inQuietHours(hour, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Fold many alert messages into one. */
export function summarize(messages) {
  const lines = messages.slice(0, 15).map((m) => `• ${m.title} — ${m.body}`);
  if (messages.length > 15) lines.push(`…and ${messages.length - 15} more`);
  return { title: `${messages.length} new on your list`, body: lines.join('\n'), at: messages.at(-1).at };
}
