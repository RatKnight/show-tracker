// Backups: a portable export of the list, daily snapshots on disk, and an
// optional weekly copy posted to Discord.
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_SNAPSHOTS = 14;

/**
 * Everything needed to rebuild the list. Deliberately leaves out the password,
 * session secret, feed address and alert channel addresses, so the file is safe
 * to keep in a chat channel or cloud drive.
 */
export function buildBackup(data, now = Date.now()) {
  const { ntfyUrl, discordWebhook, ...settings } = data.settings;
  return {
    app: 'show-tracker',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    shows: Object.values(data.shows).map((s) => ({ source: s.source, id: s.id, title: s.title, addedAt: s.addedAt })),
    watched: data.watched,
    muted: data.muted,
    dismissed: data.dismissed,
    settings,
  };
}

/** Checks a restore file and returns its usable parts, or throws with a reason. */
export function readBackup(input) {
  if (!input || input.app !== 'show-tracker' || !Array.isArray(input.shows)) throw new Error('That file is not a Show Tracker backup.');
  const strings = (v, max) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, max) : []);
  return {
    shows: input.shows
      .filter((s) => s && ['anilist', 'tvmaze'].includes(s.source) && Number.isInteger(s.id) && s.id > 0)
      .slice(0, 1000)
      .map((s) => ({ source: s.source, id: s.id, addedAt: Number.isFinite(s.addedAt) ? s.addedAt : null })),
    watched: strings(input.watched, 5000),
    muted: strings(input.muted, 1000),
    dismissed: strings(input.dismissed, 2000),
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
  };
}

/** Write today's snapshot into <dir>/backups and prune old ones. Returns the file name. */
export function writeSnapshot(dir, data, day, now = Date.now()) {
  const folder = join(dir, 'backups');
  mkdirSync(folder, { recursive: true });
  const name = `backup-${day}.json`;
  writeFileSync(join(folder, name), JSON.stringify(buildBackup(data, now)), { mode: 0o600 });
  const old = readdirSync(folder).filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -KEEP_SNAPSHOTS);
  for (const f of old) unlinkSync(join(folder, f));
  return name;
}
