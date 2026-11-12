// Persistence: one JSON document holding every account, encrypted on disk when
// a DATA_KEY is configured.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_SERVICES } from '../app/js/core.js';

const token = (bytes = 18) => randomBytes(bytes).toString('hex');

const settingsDefaults = () => ({
  services: [...DEFAULT_SERVICES],
  region: 'US', // country used for streaming availability and premieres
  ntfyUrl: '',
  discordWebhook: '',
  alertMode: 'instant', // or 'digest'
  digestHour: 8,
  quietStart: null,
  quietEnd: null,
  remindMinutes: 0,
  timeZone: '',
  backupToDiscord: false,
  autoTrackSeasons: true, // new seasons of tracked anime join the list by themselves
  cinemaAlerts: true, // tell me when an anime film gets a US cinema date
});

/** A complete user record: defaults, overlaid with whatever is given. */
export function makeUser(fields) {
  return {
    id: `u${token(6)}`,
    username: '',
    admin: false,
    auth: null,
    sessionKey: token(16), // changing it signs every device out
    createdAt: Date.now(),
    feedToken: token(),
    shareToken: null,
    email: '', // confirmed address for password recovery, optional
    pendingEmail: null, // { address, hash, expiresAt } until its link is clicked
    passkeys: [], // { id, name, publicKey, alg, signCount, transports, createdAt }
    recoveryCodes: [], // sha256 of each unused one-time code
    apiTokens: [], // { id, name, hash, createdAt, lastUsedAt } for the browser extension
    extSeen: {}, // shows seen on a streaming site but not tracked: normalised title -> { title, provider, from, at, tried, show }
    shows: {}, // show key -> { addedAt }; the show itself lives in the shared catalog
    alerts: [],
    alerted: [],
    watched: [],
    progress: {}, // anime show key -> every episode up to this number is watched
    muted: [],
    dismissed: [],
    outbox: [],
    reminded: [],
    seenSequels: [],
    seenCinema: null, // cinema listings already announced; null until the first look
    discover: null,
    lastDigestDay: null,
    lastDiscordBackup: 0,
    lastError: null,
    ...fields,
    settings: { ...settingsDefaults(), ...fields?.settings },
  };
}

/** Version 1 was a single unnamed account at the top level of the file. */
function migrateV1(old) {
  const catalog = {};
  const shows = {};
  for (const [key, { addedAt, ...show }] of Object.entries(old.shows || {})) {
    catalog[key] = show;
    shows[key] = { addedAt: addedAt || Date.now() };
  }
  const users = {};
  if (old.auth) {
    const u = makeUser({
      id: 'u1',
      username: 'admin',
      admin: true,
      auth: old.auth,
      shows,
      ...Object.fromEntries(
        ['feedToken', 'alerts', 'alerted', 'watched', 'muted', 'dismissed', 'outbox', 'reminded', 'seenSequels', 'discover', 'lastDigestDay', 'lastDiscordBackup', 'settings']
          .filter((k) => old[k] != null)
          .map((k) => [k, old[k]]),
      ),
    });
    users[u.id] = u;
  }
  return { version: 2, secret: old.secret, users, catalog, lastRefresh: old.lastRefresh || 0 };
}

// ---- encryption at rest (AES-256-GCM, key derived from DATA_KEY with scrypt)

function seal(plain, key, salt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    encrypted: true,
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  });
}

function unseal(envelope, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Open (or create) the store in `dir`. With `dataKey`, the file is encrypted;
 * a plain file found while a key is set is encrypted on the first save.
 */
export function openStore(dir, { dataKey = '' } = {}) {
  if (dataKey && dataKey.length < 32) throw new Error('DATA_KEY must be at least 32 characters long.');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  let saved = {};
  let salt = randomBytes(16);
  let key = null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw.encrypted) {
      if (!dataKey) throw new Error('the data is encrypted; set DATA_KEY to the key it was encrypted with');
      salt = Buffer.from(raw.salt, 'base64');
      key = scryptSync(dataKey, salt, 32);
      try {
        saved = JSON.parse(unseal(raw, key));
      } catch {
        throw new Error('DATA_KEY does not match the key the data was encrypted with');
      }
    } else {
      saved = raw;
    }
  } catch (e) {
    // A missing file is a first run. Anything else (corrupt file, wrong key, no
    // permission) must stop the server rather than start from an empty list.
    if (e.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${e.message}`);
  }
  if (dataKey) key ||= scryptSync(dataKey, salt, 32);

  if (saved.version !== 2 && (saved.shows || saved.auth || saved.settings)) {
    // Keep the pre-accounts file (sealed when a key is set) in case the upgrade needs undoing.
    const original = JSON.stringify(saved);
    writeFileSync(file + '.v1', key ? seal(original, key, salt) : original, { mode: 0o600 });
    saved = migrateV1(saved);
  }
  const data = {
    version: 2,
    secret: token(32),
    users: {},
    catalog: {}, // show key -> schedule data, shared by everyone tracking it
    availability: {}, // show key -> { tmdbId, byRegion: { US: [service names] }, links, at }: where it streams
    franchise: {}, // anime show key -> { root, offset, index, count, at }: its place among its seasons
    invites: {}, // sha256(token) -> { expiresAt }
    resets: {}, // sha256(token) -> { userId, expiresAt }
    lastRefresh: 0,
    lastError: null,
    lastSnapshotDay: null,
    lastBackupEmail: 0,
    staleAlerted: false, // admins have been told that schedule updates are failing
    ...saved,
    site: { backupEmail: true, healthAlerts: true, ...saved.site },
  };
  for (const [id, u] of Object.entries(data.users)) data.users[id] = makeUser(u);

  const store = {
    dir,
    file,
    data,
    encrypted: Boolean(key),
    save() {
      const tmp = file + '.tmp';
      const json = JSON.stringify(data);
      // Holds password hashes, signing secrets and webhook URLs: owner-only.
      writeFileSync(tmp, key ? seal(json, key, salt) : json, { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
  store.save();
  return store;
}
