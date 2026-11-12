// Backups: a portable export of one person's list, and daily copies of the
// whole (encrypted) data file.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_SNAPSHOTS = 14;

/**
 * Everything needed to rebuild one person's list. Deliberately leaves out the
 * password, session keys, feed/share addresses and alert channel addresses, so
 * the file is safe to keep in a chat channel or cloud drive.
 */
export function buildBackup(user, catalog, now = Date.now()) {
  const { ntfyUrl, discordWebhook, ...settings } = user.settings;
  return {
    app: 'show-tracker',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    shows: Object.entries(user.shows)
      .filter(([key]) => catalog[key])
      .map(([key, { addedAt }]) => ({ source: catalog[key].source, id: catalog[key].id, title: catalog[key].title, addedAt })),
    watched: user.watched,
    progress: user.progress,
    muted: user.muted,
    dismissed: user.dismissed,
    settings,
  };
}

/** Checks a restore file and returns its usable parts, or throws with a reason. */
export function readBackup(input) {
  if (!input || input.app !== 'show-tracker' || !Array.isArray(input.shows)) throw new Error('That file is not a Show Tracker backup.');
  const strings = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, max) : []);
  return {
    shows: input.shows
      .filter((s) => s && ['anilist', 'tvmaze', 'tmdb'].includes(s.source) && Number.isInteger(s.id) && s.id > 0)
      .slice(0, 1000)
      .map((s) => ({ source: s.source, id: s.id, addedAt: Number.isFinite(s.addedAt) ? s.addedAt : null })),
    watched: strings(input.watched, 5000),
    progress: Object.fromEntries(
      Object.entries(input.progress && typeof input.progress === 'object' ? input.progress : {})
        .filter(([k, n]) => /^anilist:\d+$/.test(k) && Number.isInteger(n) && n > 0 && n <= 10000)
        .slice(0, 1000),
    ),
    muted: strings(input.muted, 1000),
    dismissed: strings(input.dismissed, 2000),
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
  };
}

/**
 * Copy the data file into <dir>/backups as today's snapshot and prune old ones.
 * The copy is exactly what is on disk, so it is encrypted whenever the store is.
 */
export function writeSnapshot(store, day) {
  const folder = join(store.dir, 'backups');
  mkdirSync(folder, { recursive: true });
  const name = `state-${day}.json`;
  copyFileSync(store.file, join(folder, name));
  const all = readdirSync(folder);
  const old = all.filter((f) => /^state-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -KEEP_SNAPSHOTS);
  // Once encryption is on, nothing readable may be left behind: neither the
  // list exports from before accounts existed, nor snapshots taken without a key.
  const readable = store.encrypted
    ? all.filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f) || (/^state-/.test(f) && f !== name && !readFileSync(join(folder, f), 'utf8').startsWith('{"encrypted":true')))
    : [];
  for (const f of new Set([...old, ...readable])) unlinkSync(join(folder, f));
  return name;
}
