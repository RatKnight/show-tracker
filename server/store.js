// JSON-file persistence. One small file is plenty for a single user's list.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_SERVICES } from '../app/js/core.js';

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    // A missing file is a first run. Anything else (corrupt file, no permission)
    // should stop the server rather than silently start from an empty list.
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  const data = {
    shows: {},
    alerts: [],
    alerted: [],
    discover: null,
    seenSequels: [],
    dismissed: [],
    watched: [],
    muted: [],
    outbox: [],
    reminded: [],
    lastDigestDay: null,
    lastRefresh: 0,
    lastError: null,
    auth: null,
    secret: randomBytes(32).toString('hex'),
    feedToken: randomBytes(18).toString('hex'),
    ...saved,
    settings: {
      services: [...DEFAULT_SERVICES],
      ntfyUrl: '',
      discordWebhook: '',
      alertMode: 'instant', // or 'digest'
      digestHour: 8,
      quietStart: null,
      quietEnd: null,
      remindMinutes: 0,
      timeZone: '',
      ...saved.settings,
    },
  };
  const store = {
    data,
    save() {
      const tmp = file + '.tmp';
      // Holds the password hash, signing secret and webhook URLs: owner-only.
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
  store.save();
  return store;
}
