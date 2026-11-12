// Alert delivery: ntfy (phone/desktop push) and a Discord webhook.

const DISCORD_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

/** Returns an error message for a bad settings value, or null if it is fine. */
export function validateChannels({ ntfyUrl, discordWebhook }) {
  if (ntfyUrl) {
    if (!parseNtfy(ntfyUrl)) return 'The ntfy address should look like https://ntfy.sh/your-topic-name';
  }
  if (discordWebhook && !DISCORD_RE.test(discordWebhook)) {
    return 'The Discord webhook should look like https://discord.com/api/webhooks/…';
  }
  return null;
}

export function parseNtfy(url) {
  try {
    const u = new URL(url);
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    if (u.protocol !== 'https:' || !/^[\w-]{1,64}$/.test(topic)) return null;
    return { server: u.origin, topic };
  } catch {
    return null;
  }
}

/** messages: [{ title, body, url, image, at }] */
export function ntfyPayloads(ntfyUrl, messages) {
  const { topic } = parseNtfy(ntfyUrl);
  return messages.map((m) => ({
    topic,
    title: m.title,
    message: m.body,
    tags: ['tv'],
    ...(m.url ? { click: m.url } : {}),
    ...(m.image ? { icon: m.image } : {}),
  }));
}

export function discordPayloads(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += 10) {
    out.push({
      username: 'Show Tracker',
      embeds: messages.slice(i, i + 10).map((m) => ({
        title: m.title.slice(0, 250),
        description: m.body.slice(0, 2000),
        ...(m.url ? { url: m.url } : {}),
        ...(m.image ? { thumbnail: { url: m.image } } : {}),
        ...(m.at ? { timestamp: new Date(m.at).toISOString() } : {}),
        color: 0x8f75ff,
      })),
    });
  }
  return out;
}

async function post(url, body, what) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    // Never follow a redirect to some other host with the alert contents.
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${what} replied ${res.status}`);
}

/**
 * Send messages to every configured channel.
 * Returns a list of error strings (empty when everything was delivered).
 */
export async function sendAlerts(settings, messages) {
  const errors = [];
  if (!messages.length) return errors;
  if (settings.ntfyUrl) {
    try {
      const { server } = parseNtfy(settings.ntfyUrl);
      for (const p of ntfyPayloads(settings.ntfyUrl, messages)) await post(server, p, 'ntfy');
    } catch (e) {
      errors.push(`ntfy: ${e.message}`);
    }
  }
  if (settings.discordWebhook) {
    try {
      for (const p of discordPayloads(messages)) await post(settings.discordWebhook, p, 'Discord');
    } catch (e) {
      errors.push(`Discord: ${e.message}`);
    }
  }
  return errors;
}
