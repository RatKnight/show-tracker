// Alert delivery: ntfy (phone/desktop push) and a Discord webhook.
import { lookup } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';

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

/** Loopback, private-network, link-local and similar addresses. */
export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * A DNS lookup that refuses private addresses. Handed to the connection itself,
 * so the address that is checked is the address that is connected to: a host
 * name cannot answer "public" for the check and "internal" a moment later.
 */
export function publicLookup(hostname, options, callback) {
  lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const all = Array.isArray(address) ? address : [{ address, family }];
    if (!all.length || all.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error('that address is on a private network and is not allowed'), { code: 'EPRIVATE' }));
    }
    callback(null, address, family);
  });
}

/**
 * POST JSON to an address a user chose (their ntfy server), never following
 * redirects and never reaching into this server's own network.
 */
function postPublic(url, body, what) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    // A literal IP address skips DNS, so it is checked directly.
    if (isIP(host) && isPrivateAddress(host)) return reject(new Error('that address is on a private network and is not allowed'));
    const payload = JSON.stringify(body);
    const req = request(
      target,
      { method: 'POST', lookup: publicLookup, timeout: 15000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        res.resume();
        res.on('error', reject);
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`${what} replied ${res.statusCode}`))));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${what} did not answer in time`)));
    req.on('error', (e) => reject(e.code === 'ENOTFOUND' ? new Error('address not found') : e));
    req.end(payload);
  });
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
      for (const p of ntfyPayloads(settings.ntfyUrl, messages)) await postPublic(server, p, 'ntfy');
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

/** Post a small file to a Discord webhook (used for the weekly backup). */
export async function sendDiscordFile(webhook, filename, content, message) {
  const form = new FormData();
  form.set('payload_json', JSON.stringify({ username: 'Show Tracker', content: message }));
  form.set('files[0]', new Blob([content], { type: 'application/json' }), filename);
  const res = await fetch(webhook, { method: 'POST', body: form, signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!res.ok) throw new Error(`Discord replied ${res.status}`);
}
