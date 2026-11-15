// Languages. English is the source text: every other language is a table from
// the English sentence to its translation (app/js/lang/<code>.js), and anything
// missing from a table is simply shown in English.
//
// The language is settled before the app starts (this module waits for the
// table to load), so changing it reloads the page.

export const LANGUAGES = { en: 'English', fr: 'Français', de: 'Deutsch', nb: 'Norsk', es: 'Español', pt: 'Português', it: 'Italiano' };

/** The language code we have for a browser language tag ("pt-BR" -> "pt", "no" -> "nb"), or ''. */
export function matchLanguage(tag) {
  const base = String(tag || '').toLowerCase().split('-')[0];
  const code = base === 'no' || base === 'nn' ? 'nb' : base;
  return Object.hasOwn(LANGUAGES, code) ? code : '';
}

function choose() {
  try {
    // What this person picked in Settings, remembered on this device.
    const saved = localStorage.getItem('lang');
    if (saved && Object.hasOwn(LANGUAGES, saved)) return saved;
  } catch {
    /* storage unavailable: go by the browser */
  }
  for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
    const code = matchLanguage(tag);
    if (code) return code;
  }
  return 'en';
}

export const LANG = choose();
/** For dates and numbers: the browser's own regional flavour of the language where it has one. */
export const LOCALE = LANG === 'en' ? undefined : matchLanguage(navigator.language) === LANG ? navigator.language : LANG;

let table = {};
if (LANG !== 'en') {
  try {
    table = (await import(`./lang/${LANG}.js`)).default;
  } catch {
    /* the table could not be loaded: English it is */
  }
}
document.documentElement.lang = LANG;

// Text that arrives with a number or a name inside it (labels stored with a show, countdowns).
const PATTERNS = [
  [/^Episode (\d+)$/, 'Episode {0}'],
  [/^Season (\d+)$/, 'Season {0}'],
  [/^New season of (.+)$/, 'New season of {0}'],
  [/^in (\d+[dhm](?: \d+[hm])?)$/, 'in {0}'],
];

const fill = (text, values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? '');

/** The translation of an English sentence; the sentence itself when there is none. */
export function tr(text) {
  if (typeof text !== 'string' || LANG === 'en' || !text) return text;
  if (Object.hasOwn(table, text)) return table[text];
  for (const [shape, key] of PATTERNS) {
    const hit = shape.exec(text);
    if (hit && Object.hasOwn(table, key)) return fill(table[key], hit.slice(1));
  }
  return text;
}

/**
 * For sentences with values in them: T`Signed in as ${name}` looks up
 * "Signed in as {0}", so a translation can put the values where its grammar
 * wants them. Values that are themselves text (a label, a season name) are
 * translated too.
 */
export function T(strings, ...values) {
  const key = strings.map((s, i) => s + (i < values.length ? `{${i}}` : '')).join('');
  return fill(LANG !== 'en' && Object.hasOwn(table, key) ? table[key] : key, values.map((v) => (typeof v === 'string' ? tr(v) : v)));
}

const plural = new Intl.PluralRules(LANG);
/** One of two sentences by count: tn(3, '{0} show', '{0} shows'). */
export const tn = (count, one, many) => fill(tr(plural.select(count) === 'one' ? one : many), [count]);

/** Translate the text and labels already in the page (index.html is written in English). */
export function translatePage(root = document.body) {
  if (LANG === 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && tr(text) !== text) node.nodeValue = node.nodeValue.replace(text, tr(text));
  }
  for (const el of root.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const attr of ['title', 'placeholder', 'aria-label']) if (el.hasAttribute(attr)) el.setAttribute(attr, tr(el.getAttribute(attr)));
  }
}
