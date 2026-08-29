/* Feed Riffle — a tiny Zotero plugin (bootstrapped, Zotero 7+).
 *
 * Tools → Riffle Feeds deals your unread feed items out one card at a time.
 * Left arrow discards, right arrow opens a fuzzy collection picker (preloaded
 * with the last one you used, so Enter alone files it), Tab from there adds
 * tags, Tab again a note. The point is to make a 2000-item backlog something
 * you can hold down an arrow key through.
 *
 * No storage of its own beyond two prefs: "discarded" is Zotero's own
 * per-item read flag, so the unread counts in the collections pane track what
 * you do here, and Zotero's existing feed cleanup eventually reaps the items.
 *
 * No build step: plain bootstrapped plugin. Zip the folder — see README.md.
 */

const LAST_PREF = "feedRiffle.lastCollection"; // collection id Enter defaults to
const STATE_PREF = "feedRiffle.state";         // window geometry
const SIZE_PREF = "feedRiffle.fontScale";      // your own +/- adjustment
const RECENT_PREF = "feedRiffle.recentCollections"; // most recently filed into
const STATS_PREF = "feedRiffle.summary";       // false: the finish summary stays off
const RT_PREF = "feedRiffle.readingTime";      // unset: ask once; then true or false
const RECENT_MAX = 9; // as many as there are number keys
const BASE_PX = 15;   // reading size at scale 1, before Zotero's own setting
// The text column, and the card's side padding, in rem. The stylesheet and the
// window sizer both read these: a window wider than the column it holds is
// dead space, which is exactly what a hardcoded default width produced.
const MEASURE_REM = 34;
const CARD_PAD_REM = 2.2;
// One fixed default, so the window is the same shape every time it opens. Wide
// enough for the column plus the card's padding and a scrollbar at the default
// font size; turn the font up and the column narrows inside this frame rather
// than the furniture moving. Nothing here depends on the item being shown.
const WIN_W = 640;
const WIN_H = 760;
// A collection deck answers to more keys and can show a page, so its window
// starts wider: the hint bar is what sets the floor, and it is measured rather
// than guessed — every key on one line at the reading size. The column of text
// stays the same measure inside it, centred.
const COLL_W = 930;
const COLL_H = 860;
const SIZE_MIN = 0.7, SIZE_MAX = 2.4, SIZE_STEP = 0.08;
const AHEAD = 25;   // items hydrated ahead of the cursor
const BEHIND = 50;  // and kept behind it, so undo does not have to refetch
// A formula longer than this is not a formula: a delimiter was mis-detected and
// the run has swallowed prose. Setting a paragraph as one equation reads far
// worse than leaving it as the text it is.
const MATH_CAP = 400;
const DROP_CAP = 60; // rows drawn in a picker dropdown

let menuID = null;
let feedMenuID = null;
let win = null;        // the one riffle window

let ids = [];          // unread feed item ids, newest first
let cursor = 0;        // index into ids of the card on screen
let total = 0;         // ids.length when the window opened, for the counter
const cache = new Map(); // itemID → Zotero.Item, filled a window at a time
let colls = [];        // [{ id, path }] every collection you can file into
let collRows = [];     // the same, with counts, for the picker on a collection deck
let allTags = [];      // every tag name in the library, for the tag picker
let undoStack = [];    // {id, revert} — revert absent for a discard or a skip
let scopeLib = null;   // feed libraryID to riffle, or null for every feed
let scopeColl = null;  // collection id to riffle instead, when riffling one
// Which deck is on screen. Everything around the cards — the window, the
// typography, the panel, undo, the animation — is the same either way; a mode
// is only the handful of places where a feed and a collection differ.
let mode = "feed";     // "feed" or "collection"
// Whether a collection deck reaches into what is filed below it. Starts from
// Zotero's own View setting, so a deck holds what its items list holds, and s
// changes it for this window without touching Zotero's.
let deep = false;
const isFeedMode = () => mode === "feed";
let libKeys = new Map(); // DOI/arXiv key → the { id, colls } already in the library
const RIFFLE_ATTR = "data-feed-riffle"; // marks our window, across installs
let fontScale = 1;     // multiplier on top of Zotero's font size, persisted

const oops = (e) => Zotero.logError(e);

// A gap longer than this was not reading, it was lunch, and counting it would
// turn a ten-minute sitting into an afternoon.
const IDLE_CAP = 5 * 60 * 1000;

// The sitting, not the deck: opening the window resets these, moving on to the
// next feed does not, so the summary covers everything you just did.
const stat = { kept: 0, dropped: 0, skipped: 0, spent: 0, last: 0, began: 0, banked: false };

function statReset() {
	const now = Date.now();
	Object.assign(stat, { kept: 0, dropped: 0, skipped: 0, spent: 0, last: now, began: now, banked: false });
}

// Called as each card leaves: the time it was on screen is time spent reading.
function statTick() {
	const now = Date.now();
	if (stat.last) stat.spent += Math.min(now - stat.last, IDLE_CAP);
	stat.last = now;
}

const summaryOn = () => safe(() => Zotero.Prefs.get(STATS_PREF) !== false, true);

// --- Reading Time ----------------------------------------------------------
//
// Reading Time is a separate plugin. If it is installed it publishes an object
// on Zotero, which is withdrawn again when it shuts down — so this looks it up
// at the moment of use rather than caching it: anything held onto could be a
// function whose scope has since been deleted. Not finding it is normal, and
// nothing here changes when it isn't there.
const readingTime = () => safe(() => {
	const api = Zotero.ReadingTime;
	return api && api.apiVersion === 1 && typeof api.addFeedSession === "function" ? api : null;
}, null);

// undefined until asked, then true or false, and never asked again either way.
const rtAnswer = () => safe(() => Zotero.Prefs.get(RT_PREF), undefined);

// One row for the whole sitting, banked as the window closes. Per-item seconds
// would be a fiction: most of a deck is items you discarded, and the ones you
// kept were read before they had somewhere to be filed. The deck's own clock is
// also the honest one — it stops counting after five idle minutes on a card,
// which a clock ticking in the other plugin has no way to know to do.
function bankTime() {
	if (!isFeedMode() || stat.banked || rtAnswer() !== true) return;
	statTick();
	const api = readingTime();
	if (api && api.addFeedSession(Math.round(stat.spent / 1000), stat.began)) {
		stat.banked = true;
	}
}

function safe(fn, fallback) {
	try { return fn(); }
	catch (e) {
		// typeof guard so the pure helpers stay runnable under node (test.js).
		if (typeof Zotero !== "undefined") oops(e);
		return fallback;
	}
}

// --- pure helpers (test.js checks these) -----------------------------------

// Lowercase and fold accents the way Zotero's own filters do.
function norm(s) {
	const f = typeof Zotero !== "undefined" && Zotero.Utilities.Internal.normalizeForSearch;
	return f ? f(s) : s.toLowerCase(); // plain lowercase under node (test.js)
}

const SEP = /[\s\-_/.,:;&()]/;
const SEPS = new RegExp(SEP.source + "+");

// First letter of each word: "rough path theory" -> "rpt".
function initials(name) {
	return name.split(SEPS).filter(Boolean).map((w) => w[0]).join("");
}

// Fuzzy score for one word: every char of `w` must appear in `name` in order.
// Returns null for no match, else a number — LOWER is better. Landing on a word
// boundary is nearly free, so "rp" prefers "Rough Paths" over "Probability";
// jumping into the middle of a word costs more the further it skips. Length
// breaks ties. Lifted from the Tag Fuzzy Search plugin, which ranks tags the
// same way — collection paths behave like tags for this purpose.
// ponytail: greedy leftmost match, not an optimal alignment. Swap in
// Smith-Waterman if a better-aligned match later in the string ever matters.
function wordScore(w, name) {
	let i = 0, first = -1, prev = -1, cost = 0;
	for (let j = 0; j < name.length && i < w.length; j++) {
		if (name[j] !== w[i]) continue;
		if (first < 0) first = j;
		else if (j !== prev + 1) {
			cost += SEP.test(name[j - 1]) ? 1 : 4 + (j - prev - 1);
		}
		prev = j;
		i++;
	}
	if (i < w.length) return null;
	const start = first <= 0 || SEP.test(name[first - 1]) ? 0 : first;
	const sub = start + cost + name.length / 100;
	// Acronyms, which the greedy scan misses whenever an earlier word contains
	// the letter. Scored just below a real prefix match, far above a gappy one.
	return w.length > 1 && initials(name).startsWith(w)
		? Math.min(sub, 0.5 + name.length / 100)
		: sub;
}

// One word of the query, which may be two words run together: "roughstoch" for
// "Stochastic analysis / Rough paths". A plain scan only ever reads left to
// right, so that one fails where "stochrough" succeeds — the word order is the
// only difference. When it fails, try every place the word could have been
// split and score the halves independently, which is order-blind. Only one
// split: two is a spelling of its own, and the halves stay long enough to mean
// something. Charged a point, so a match that needed no splitting stays ahead.
function splitScore(w, name) {
	const whole = wordScore(w, name);
	if (whole !== null) return whole;
	let best = null;
	// Both halves have to land at the start of a word and run without a gap —
	// what two run-together words look like. Anything looser turns every query
	// into a haystack: "paths" alone matched four times as many collections.
	const clean = 1 + name.length / 100;
	for (let i = 3; i <= w.length - 3; i++) {
		const a = wordScore(w.slice(0, i), name);
		if (a === null || a >= clean) continue;
		const b = wordScore(w.slice(i), name);
		if (b === null || b >= clean) continue;
		const sum = a + b + 1;
		if (best === null || sum < best) best = sum;
	}
	return best;
}

// Every word of the query has to match, but in any order, so "paths rough"
// finds "Rough Paths". Costs add, so the tightest overall match wins.
function score(q, name) {
	let sum = 0;
	for (const w of q.split(/\s+/)) {
		if (!w) continue;
		const s = splitScore(w, name);
		if (s === null) return null;
		sum += s;
	}
	return sum;
}

// Rank `items` (objects with a `path` or plain strings) against the query.
// An empty query keeps the given order, which is how the last-used collection
// stays on top until you type.
function rank(q, items, key = (x) => x) {
	const nq = norm(q.trim());
	if (!nq) return items.slice(0, DROP_CAP);
	return items
		.map((x) => [score(nq, norm(key(x))), x])
		.filter(([s]) => s !== null)
		.sort((a, b) => a[0] - b[0] || key(a[1]).localeCompare(key(b[1])))
		.slice(0, DROP_CAP)
		.map(([, x]) => x);
}

// Feed metadata comes straight off the wire, so author names still carry the
// source's LaTeX escapes ("Sch\"otz", "Jos\'e"). Zotero renders them as typed;
// on a card you are skimming at speed they are noise.
// ponytail: the accents that actually turn up in a maths feed, not a TeX parser.
const ACCENTS = {
	'"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü" },
	"'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ć", n: "ń", s: "ś", z: "ź", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" },
	"`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
	"^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
	"~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
	"c": { c: "ç", s: "ş", C: "Ç" },
	"v": { c: "č", s: "š", z: "ž", r: "ř", e: "ě", C: "Č", S: "Š", Z: "Ž" },
	"u": { a: "ă", g: "ğ" },
	".": { z: "ż", Z: "Ż" },
	"H": { o: "ő", u: "ű" },
	"k": { a: "ą", e: "ę", A: "Ą", E: "Ę" },
};
const LIGATURES = { ss: "ß", o: "ø", O: "Ø", l: "ł", L: "Ł", ae: "æ", AE: "Æ", aa: "å", AA: "Å" };

// Deliberately does not trim: this also cleans the plain-text runs between two
// bits of math, where the leading space of " elements." is load-bearing.
// Callers that want a tidy standalone string trim it themselves.
function deLatex(s) {
	let t = s || "";
	if (!t) return "";
	// A TeX tie is a space, and it shows up in runs carrying no other markup —
	// so handle it before the early exit. Skip a "~" behind a backslash (that is
	// the tilde accent of "Ma\~nas") or a slash (that is a URL).
	if (t.indexOf("~") >= 0) t = t.replace(/([^\\/])~/g, "$1 ");
	if (t.indexOf("\\") < 0 && t.indexOf("{") < 0) return t;
	return t
		// \"o, \'{e} — a control *symbol*, so the letter may abut it directly.
		.replace(/\\([`'"^~.])\s*\{?([A-Za-z])\}?/g,
			(m, acc, ch) => (ACCENTS[acc] && ACCENTS[acc][ch]) || ch)
		// \v{s}, \c c — a control *word*. TeX reads the longest run of letters,
		// so the argument has to be braced or separated: without that, "\varepsilon"
		// parses as \v + "arepsilon" and comes out as "arepsilon", and \cdot, \cup
		// and \underline lose their first letters the same way.
		.replace(/\\([cvuHk])(?:\{([A-Za-z])\}|[ \t]+([A-Za-z])\b)/g,
			(m, acc, a1, a2) => { const ch = a1 || a2; return (ACCENTS[acc] && ACCENTS[acc][ch]) || ch; })
		// \ss, \o, \aa and friends
		.replace(/\\(ss|ae|AE|aa|AA|[oOlL])\b\{?\}?/g, (m, k) => LIGATURES[k] || m)
		.replace(/\\\\/g, " ")           // a row break, in text, is just a space
		.replace(/\\[a-zA-Z]+\s?/g, "") // any leftover command, before the
		.replace(/[{}]/g, "");             // braces that keep it from over-eating
}

// Keys that identify the same work across a feed and the library. A DOI is
// definitive; an arXiv id is next best and survives the version suffix, so v1 in
// the library matches the v2 the feed is announcing; the bare URL is the
// fallback. Exported for test.js.
function refKeys(doi, url) {
	const out = [];
	for (const raw of [doi, url]) {
		const v = String(raw || "").trim().toLowerCase();
		if (!v) continue;
		// 2604.04661 — the version suffix is deliberately not part of the key.
		const ax = v.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/)
			|| v.match(/\barxiv:(\d{4}\.\d{4,5})/) || v.match(/^(\d{4}\.\d{4,5})$/);
		if (ax) out.push("arxiv:" + ax[1]);
		const d = v.match(/10\.\d{4,9}\/[^\s"<>]+/);
		if (d) out.push("doi:" + d[0].replace(/[.,;]+$/, ""));
		if (/^https?:\/\//.test(v)) {
			out.push("url:" + v.replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, ""));
		}
	}
	return out;
}

// One row per (item, field value, collection), so an item shows up once per
// collection it is in and once per DOI/URL it carries, each row repeating that
// item's note and annotation counts. Fold that into one entry per item,
// reachable by any of its keys. Exported for test.js.
function foldLibraryRows(rows) {
	const byItem = new Map();
	const keys = new Map();
	for (const r of rows) {
		let entry = byItem.get(r.itemID);
		if (!entry) {
			byItem.set(r.itemID, entry = { id: r.itemID, colls: new Set(),
				notes: r.notes || 0, annots: r.annots || 0 });
		}
		if (r.collectionID) entry.colls.add(r.collectionID);
		// ponytail: if the library already holds two copies of one DOI, the last
		// one wins. Zotero's Duplicate Items pane is where that gets sorted out.
		for (const k of refKeys(null, r.value)) keys.set(k, entry);
	}
	return keys;
}

// What became of the deck: "17 of 24 cleared, 3 skipped for later, 4 still
// unread." Clauses with nothing to report are left out. Exported for test.js.
function deckLine(cleared, total, skipped, left) {
	if (!total) return "Nothing unread.";
	const parts = [cleared + " of " + total + " cleared"];
	if (skipped) parts.push(skipped + " skipped for later");
	if (left) parts.push(left + " still unread");
	return parts.join(", ") + ".";
}

// The same, for a collection you were reading rather than clearing: "24 of 24
// seen." Exported for test.js.
function seenLine(seen, total, left) {
	if (!total) return "Nothing here.";
	const parts = [Math.min(seen, total) + " of " + total + " seen"];
	if (left) parts.push(left + " still to look at");
	return parts.join(", ") + ".";
}

// A span at a glance: "38 s", "6 min", "1 h 04 min". Exported for test.js.
function fmtSpan(ms) {
	const secs = Math.max(0, Math.round(ms / 1000));
	if (secs < 60) return secs + " s";
	const mins = Math.round(secs / 60);
	if (mins < 60) return mins + " min";
	return Math.floor(mins / 60) + " h " + String(mins % 60).padStart(2, "0") + " min";
}

// The sitting in one line, from [count, word] pairs — a feed deck keeps and
// discards, a collection deck changes and trashes. The pace is only worth
// printing once there are enough cards behind it to mean anything. Exported
// for test.js.
function summaryLine(counts, ms) {
	const done = counts.reduce((n, c) => n + c[0], 0);
	if (!done) return "";
	const bits = counts.filter(([n]) => n).map(([n, word]) => n + " " + word);
	bits.push(fmtSpan(ms));
	if (done >= 3 && ms >= 3000) bits.push(fmtSpan(ms / done) + " a card");
	return bits.join(" · ");
}

// "2 notes and 14 annotations" — what the old copy is worth keeping for, and
// the whole of what the question about it can tell you. Exported for test.js.
function heldPhrase(notes, annots) {
	const bits = [];
	if (notes) bits.push(notes + (notes === 1 ? " note" : " notes"));
	if (annots) bits.push(annots + (annots === 1 ? " annotation" : " annotations"));
	return bits.join(" and ") || "nothing of yours";
}

// arXiv puts a routing header on every abstract:
//   "arXiv:2506.13429v2 Announce Type: replace \nAbstract: <the actual text>"
// The announce type is worth a glance (a revision of something you already
// looked at reads differently from a new paper), the rest is chrome.
function splitAbstract(text) {
	const t = (text || "").trim();
	const m = t.match(/^arXiv:\S+\s+Announce Type:\s*([a-z-]+)\s*/i);
	let kind = m ? m[1].toLowerCase() : "";
	let body = m ? t.slice(m[0].length) : t;
	// arXiv labels the body "Abstract:", zbMATH labels it "Summary:" — on a card
	// that already knows what it is showing, both are pure noise.
	body = body.replace(/^(Abstract|Summary):\s*/i, "").trim();
	return { kind, body };
}

// --- LaTeX ------------------------------------------------------------------

// Formulas are typeset by KaTeX, which is bundled with this plugin. It is the
// real thing: environments, \left…\right that stretches, \begin{cases}, author
// macros — everything a feed's LaTeX can contain.
//
// It is loaded once into a plain object rather than into the riffle window.
// That is the target loadSubScript is happiest with — it is how Zotero loads
// plugin bootstraps — and it means KaTeX never needs a `document` of its own:
// renderToString gives back markup, which is then parsed into the card.
let rootURI = null;    // plugin root, set at startup
let katexLib = null;   // the library, once loaded
let katexCSS = null;   // its stylesheet, with the font URLs made absolute
let katexError = "";   // why it is missing, so a card can say so

// A replaced .xpi keeps its old entry in the platform's zip cache, so the first
// read out of the new one fails with "Error opening input stream". Reinstalling
// the same version is when this bites, since nothing else about the file changed.
// Dropping the stale entry is what the add-on manager itself does after it swaps
// a file in. Harmless when the plugin is installed from a directory instead.
function flushPluginCache() {
	safe(() => {
		const { interfaces: Ci } = Components;
		const jar = Services.io.newURI(rootURI)
			.QueryInterface(Ci.nsIJARURI).JARFile
			.QueryInterface(Ci.nsIFileURL).file;
		Services.obs.notifyObservers(jar, "flush-cache-entry");
	});
}

async function loadKatex() {
	if (katexLib || katexError || !rootURI) return;
	// Two goes: a first failure is usually the stale cache entry above, and the
	// read after flushing it succeeds.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			// Hand the bundle the CommonJS hooks its UMD header checks for
			// first: seeing `module` and `exports` as objects, it assigns to
			// module.exports. That is deterministic. The other branch assigns to
			// `globalThis`, and under loadSubScript the target object is only on
			// the scope chain — the global stays whatever compartment the script
			// was compiled in, so the library would land somewhere we never look.
			const scope = { module: { exports: {} } };
			scope.exports = scope.module.exports;
			Services.scriptloader.loadSubScript(rootURI + "katex.min.js", scope, "UTF-8");
			const lib = typeof scope.module.exports.renderToString === "function"
				? scope.module.exports
				: scope.katex;
			if (!lib || typeof lib.renderToString !== "function") {
				throw new Error("katex.min.js ran but exported no renderToString");
			}
			const css = await Zotero.File.getResourceAsync(rootURI + "katex.min.css");
			// The stylesheet is inlined, so its relative font URLs would
			// otherwise resolve against about:blank. Absolute against the
			// plugin root instead.
			katexCSS = css.replace(/url\(fonts\//g, "url(" + rootURI + "fonts/");
			katexLib = lib;
			return;
		}
		catch (e) {
			if (attempt === 0) { flushPluginCache(); continue; }
			oops(e);
			katexError = (e && e.message) || String(e);
		}
	}
}

// KaTeX's own stylesheet, injected once per document.
function ensureKatexCSS(w) {
	if (!katexCSS) return;
	safe(() => {
		const doc = w.document;
		if (doc.getElementById("katex-css")) return;
		const style = el(doc, "style", null, katexCSS);
		style.id = "katex-css";
		(doc.head || doc.documentElement).append(style);
	});
}

// KaTeX's output is markup we generated ourselves, so it is parsed straight in
// rather than sanitized — and it is built from `tex` with trust:false, which is
// what keeps a feed from smuggling anything through it.
// An equation number belongs beside the equation, not on top of it. KaTeX puts
// \tag inside .katex-html and pins it absolutely at the right edge, where any
// equation wide enough to reach it ends up underneath. Lift it out to sit as
// the display block's own last child, and the two become a flex row: maths in a
// strip that scrolls if it must, number parked at the margin.
function liftTag(frag) {
	safe(() => {
		for (const box of frag.querySelectorAll(".katex-display")) {
			const tag = box.querySelector(":scope > .katex > .katex-html > .tag");
			if (!tag) continue;
			// A number on one side only would shove the equation off centre, and
			// a numbered display would no longer line up with an unnumbered one.
			// An invisible copy on the other side is what keeps it centred on
			// the measure, the way it sits on a page.
			const spacer = tag.cloneNode(true);
			spacer.className = "tag spacer";
			spacer.setAttribute("aria-hidden", "true");
			box.prepend(spacer);
			box.append(tag);
			box.classList.add("tagged");
		}
	});
}

function katexFragment(doc, html) {
	return safe(() => {
		const parsed = new doc.defaultView.DOMParser().parseFromString(html, "text/html");
		const frag = doc.createDocumentFragment();
		for (const n of [...parsed.body.childNodes]) frag.append(doc.importNode(n, true));
		return frag;
	}, null);
}

// "\\color" means two different things and feeds contain both. MathJax reads
// "\\color{red}{x}" as two arguments and tints only x; LaTeX reads "\\color{red}"
// as a switch tinting the rest of the group. They are told apart by what follows
// the colour — a brace is the argument form — so rewrite that one to
// "\\textcolor", which is unambiguous, and leave the switch form for KaTeX to
// handle as LaTeX specifies. Supporting both beats choosing.
//
// ponytail: syntactic, so "{\\color{red} {x} y}" — a switch whose next token is
// a group — is read as the argument form and tints only x. Nothing in the
// delimiters can distinguish that case; TeX itself needs the macro definition.
function normalizeColor(tex) {
	return tex.replace(/\\color(?![a-zA-Z])(\s*\{[^{}]*\})\s*\{/g, "\\textcolor$1{");
}

// One formula, typeset into `parent`.
function mathInto(doc, parent, tex, display) {
	if (katexLib) {
		// throwOnError keeps one bad formula from taking out the card: KaTeX
		// renders what it can and marks the rest. trust:false refuses \href and
		// friends — this is a feed, and it does not get to inject links.
		// KaTeX's own \color stays a switch, as LaTeX specifies; normalizeColor
		// has already turned the argument form into \textcolor above.
		const html = safe(() => katexLib.renderToString(normalizeColor(tex), {
			displayMode: !!display, throwOnError: false, strict: false, trust: false,
		}), null);
		const frag = html && katexFragment(doc, html);
		if (frag) { liftTag(frag); parent.append(frag); return; }
	}
	// KaTeX missing or refused it: the source reads better than nothing.
	parent.append(typography(deLatex(tex)));
}

// --- reading what the feed actually stored ---------------------------------
//
// Zotero HTML-parses every feed abstract before storing it, so what comes back
// is serialised HTML — for arXiv and zbMATH too, which sent plain text. That has
// one destructive consequence: a "<" in maths ("$i<j$") was read as a tag, and
// the words following it were re-serialised as its attributes.
//
// So there is one honest way to read this back: hand it to the platform's own
// parser and decide from the resulting tree which kind of source it was. The
// parser already handles entities, malformed markup and nesting correctly;
// hand-written regexes for those only ever approximate it.

function parseHTML(doc, raw) {
	const view = doc.defaultView;
	const s = String(raw || "");
	if (!view || !view.DOMParser || !/[<&]/.test(s)) return null;
	return safe(() => new view.DOMParser().parseFromString(s, "text/html"), null);
}

// The inverse of what the importer did. In a plain-text feed nothing was ever
// markup, so every element the parser found here is damage: serialise it back
// to the characters it was made from. Not all of it returns — HTML lowercases
// attribute names and silently drops duplicates, so a word repeated inside the
// span is gone for good — but the formula and the sentence come back.
function unparse(node, out) {
	for (const c of node.childNodes) {
		if (c.nodeType === 3) { out.push(c.nodeValue); continue; }
		if (c.nodeType !== 1) continue;
		out.push("<" + c.localName);
		for (const a of c.attributes || []) {
			// The serialiser added this; the abstract never contained it.
			if (a.name === "xmlns") continue;
			out.push(" " + a.name + (a.value ? "=" + a.value : ""));
		}
		out.push(">");
		unparse(c, out);
	}
	return out;
}

// unparse() puts back most of what the importer's parser mangled, but not all:
// the words after a misread "<" were taken for attributes, and a sanitiser that
// drops attributes drops them with it — leaving the abstract stopped
// mid-sentence with no sign that anything is missing. Two marks together say so:
// a tag whose name is really a piece of the prose, and no closing punctuation.
// Across a 4,100-abstract library that is four items, every one of them
// genuinely mutilated; the fifteen misread tags whose sentences still finish are
// left alone. Exported for test.js.
function importerCut(raw) {
	const s = String(raw || "").trim();
	if (!s) return false;
	const tags = /<\/?([a-zA-Z][^\s>\/]*)/g;
	let bogus = false;
	for (let m; (m = tags.exec(s));) {
		if (!/^[a-z][a-z0-9-]*$/i.test(m[1])) { bogus = true; break; }
	}
	// A tag at the very end is the serialiser's, not the author's last word.
	return bogus && !/[.!?)\]}$"”]$/.test(s.replace(/<[^>]*>$/, "").trim());
}

// A feed cannot run MathJax, so a site that typesets on the page ships its
// formulas to the feed as pictures instead — with the LaTeX itself in the URL.
// Two conventions cover essentially all of them: CodeCogs puts the source
// straight in the query, WordPress and friends put it in a "latex" parameter.
// The sizing and colour macros are about the picture, not the maths.
// Exported for test.js.
function imgMath(src) {
	const u = String(src || "");
	const named = u.match(/[?&](?:latex|chl|math)=([^&]*)/i);
	const codecogs = u.match(/latex\.codecogs\.com\/[a-z]+\.[a-z]+\?(.*)$/i);
	const q = named ? named[1] : codecogs && codecogs[1];
	if (!q) return null;
	const tex = safe(() => decodeURIComponent(q.replace(/\+/g, " ")), null);
	if (!tex) return null;
	return tex.replace(/\\(?:dpi|bg|fg)\s*\{[^}]*\}/g, "")
		.replace(/\\(?:bg|fg)_[a-z]+/gi, "")
		.replace(/\\(?:inline|tiny|small|large|huge|LARGE|Huge)\b/g, "")
		.trim() || null;
}

// Those pictures, turned back into formulas before the sanitizer drops every
// <img> along with the tracking pixels. Nothing is fetched: the source was in
// the address all along, and it gets typeset like any other formula. An image
// standing alone in its paragraph was display maths on the page, and says so.
function inlineImgMath(doc, raw) {
	const s = String(raw || "");
	if (!/<img/i.test(s)) return s;
	return safe(() => {
		const parsed = parseHTML(doc, s);
		if (!parsed) return s;
		let hit = false;
		for (const img of parsed.querySelectorAll("img")) {
			const tex = imgMath(img.getAttribute("src"));
			if (!tex) continue;
			hit = true;
			const alone = !(img.parentNode.textContent || "").trim()
				&& img.parentNode.querySelectorAll("img").length === 1;
			const d = alone ? "$$" : "$";
			img.replaceWith(parsed.createTextNode(d + tex + d));
		}
		return hit ? parsed.body.innerHTML : s;
	}, s);
}

// Plain text, whatever the importer did to it on the way in.
function sourceText(doc, raw) {
	const parsed = parseHTML(doc, raw);
	return parsed ? unparse(parsed.body, []).join("") : String(raw || "");
}

// Split text into alternating plain and math runs. Three delimiter styles turn
// up across these feeds: arXiv writes $...$ and $$...$$, zbMATH writes \(...\)
// and \[...\] — and zbMATH is the larger feed, so both have to work. A "$"
// escaped as "\$" is a literal dollar and must not open math, and an unbalanced
// delimiter is left exactly as found rather than swallowing the rest of the text.
// Outside academic feeds a "$" is a currency sign far more often than a maths
// delimiter — "raised $5 million and $10 million" must not become an equation.
// So a $...$ run has to look like maths: a TeX command, a script or a group; or
// a single token; or something with no words in it. The \(...\) and \[...\]
// forms are unambiguous and skip the test.
function looksLikeMath(s) {
	if (/[\\^_{}]/.test(s)) return true; // a command, a script, a group
	if (!/\s/.test(s)) return true;       // one token: "$n$", "$x+y$"
	return !/[a-z]{3,}/.test(s);          // prose has words; "$x + y$" has none
}

// Display environments a feed may write with no delimiters around them at all.
// LaTeX needs none — \begin{align*} is already display maths — and MathJax on
// the arXiv page renders it, so an author has no reason to add any. Left as
// prose the run reaches deLatex(), which strips every command and turns the
// equation into "align* i _t u +2||^u".
const ENVS = /^\\begin\{(align|alignat|equation|eqnarray|gather|multline|split|flalign)(\*?)\}/;

// The length cap is there to catch a delimiter that never closed and swallowed
// the paragraph. An environment cannot do that — it was taken only because its
// own \end was found — so it is allowed to be as long as it is.
function fitsAsMath(tex) {
	return tex.length <= MATH_CAP || ENVS.test(tex);
}

function splitMath(text) {
	const s = text || "";
	const out = [];
	let plain = "";
	let i = 0;
	const flush = () => { if (plain) { out.push({ math: false, display: false, text: plain }); plain = ""; } };

	while (i < s.length) {
		const c = s[i];

		if (c === "\\") {
			// A bare environment is its own delimiter: take it whole, through to
			// the \end that closes it, and hand KaTeX the lot in display mode.
			const env = ENVS.exec(s.slice(i));
			if (env) {
				const tail = "\\end{" + env[1] + env[2] + "}";
				const end = s.indexOf(tail, i);
				if (end >= 0) {
					flush();
					out.push({ math: true, display: true, text: s.slice(i, end + tail.length) });
					i = end + tail.length;
					continue;
				}
			}
			const open = s[i + 1];
			const close = open === "(" ? "\\)" : open === "[" ? "\\]" : "";
			if (close) {
				const end = s.indexOf(close, i + 2);
				if (end < 0) { plain += s.slice(i); break; } // unbalanced
				flush();
				out.push({ math: true, display: open === "[", text: s.slice(i + 2, end) });
				i = end + 2;
				continue;
			}
			plain += s.slice(i, i + 2); // an escaped literal: \$ \% \\
			i += 2;
			continue;
		}

		if (c !== "$") { plain += s[i++]; continue; }

		const display = s[i + 1] === "$";
		const start = i;
		let j = i + (display ? 2 : 1);
		let body = "";
		let closed = false;
		let depth = 0;
		while (j < s.length) {
			if (s[j] === "\\" && j + 1 < s.length) { body += s.slice(j, j + 2); j += 2; continue; }
			const c = s[j];
			// A "$" inside a group belongs to the formula, not to its delimiters:
			// "$$\tag{$\ast$}...$$" is one run, and closing at the first bare "$"
			// left \tag{ as the whole equation and shredded the rest of the line.
			if (c === "{") depth++;
			else if (c === "}") depth = Math.max(0, depth - 1);
			// Display maths is closed by "$$", never by a single "$".
			else if (c === "$" && depth === 0 && (!display || s[j + 1] === "$")) {
				closed = true;
				break;
			}
			body += s[j++];
		}
		if (!closed) { plain += s.slice(start); break; } // unbalanced
		if (!display && !looksLikeMath(body)) {
			// Not maths: keep the "$" and rescan from just after it, so the one
			// that closed this run is free to open a real one.
			plain += s[start];
			i = start + 1;
			continue;
		}
		flush();
		out.push({ math: true, display, text: body });
		i = j + (display ? 2 : 1);
	}
	flush();
	return out;
}

// "Pabst, Hofert, Schötz" — but stop before the list eats the card.
function authorLine(creators, max = 8) {
	const names = creators.map((c) => deLatex(
		c.fieldMode === 1 ? c.lastName : [c.firstName, c.lastName].filter(Boolean).join(" ")
	).trim()).filter(Boolean);
	if (names.length <= max) return names.join(" · ");
	return names.slice(0, max).join(" · ") + " · +" + (names.length - max) + " more";
}

// Zotero dates are multipart ("2026-08-26 2026-08-26 04:00:00"); the leading
// token is the part worth showing.
function shortDate(d) {
	const m = (d || "").match(/\d{4}-\d{2}-\d{2}|\d{4}/);
	return m ? m[0] : (d || "").trim();
}

// Split a tag box into finished tags. Commas end a tag; the trailing fragment
// is what the user is still typing, so it is returned separately.
function splitTags(text) {
	const parts = (text || "").split(",");
	const partial = parts.pop();
	return { done: parts.map((s) => s.trim()).filter(Boolean), partial: partial.trim() };
}

// --- prefs -----------------------------------------------------------------

let geometry = { feed: null, collection: null }; // remembered per deck

function loadScale() {
	const v = parseFloat(Zotero.Prefs.get(SIZE_PREF));
	if (v >= SIZE_MIN && v <= SIZE_MAX) fontScale = v;
}

// Zotero's own font-size setting is the baseline, so the window starts out
// matching the rest of the app; +/- adjusts from there. Everything in the
// stylesheet is in rem, so this one number moves the card, the maths and the
// chrome together.
// The effective rem: Zotero's own font-size setting times your +/- adjustment.
function fontPx() {
	const z = parseFloat(safe(() => Zotero.Prefs.get("fontSize"), 1)) || 1;
	return BASE_PX * z * fontScale;
}

function applyFontSize(w) {
	const px = fontPx();
	safe(() => { w.document.documentElement.style.fontSize = px.toFixed(2) + "px"; });
	return px;
}

function loadState() {
	const was = safe(() => JSON.parse(Zotero.Prefs.get(STATE_PREF) || "null"), null);
	if (!was) return;
	// One deck, one geometry, is what the pref used to hold.
	if (was.geometry && was.geometry.w) geometry.feed = was.geometry;
	if (was.feed) geometry.feed = was.feed;
	if (was.collection) geometry.collection = was.collection;
}

function saveState(w) {
	safe(() => {
		if (w && !w.closed && w.outerWidth > 200) {
			geometry[mode] = { w: w.outerWidth, h: w.outerHeight, x: w.screenX, y: w.screenY };
		}
		Zotero.Prefs.set(STATE_PREF, JSON.stringify(geometry));
	});
}

// A window remembered on one screen can be off every screen on the next launch.
// Always WIN_W by WIN_H, shrunk only if the display is smaller than that.
function defaultSize(main) {
	const screen = safe(() => main.screen, null);
	const wide = isFeedMode() ? WIN_W : COLL_W;
	const tall = isFeedMode() ? WIN_H : COLL_H;
	const availW = (screen && screen.availWidth) || wide;
	const availH = (screen && screen.availHeight) || tall;
	return { w: Math.min(wide, availW - 40), h: Math.min(tall, availH - 60) };
}

function features(main) {
	const g = geometry[mode];
	if (!g || !(g.w > 200) || !(g.h > 200)) {
		const d = defaultSize(main);
		return `chrome,centerscreen,resizable,scrollbars,width=${d.w},height=${d.h}`;
	}
	let where = "centerscreen";
	const screen = safe(() => main.screen, null);
	if (screen && g.x > -g.w + 100 && g.y >= 0
		&& g.x < screen.availWidth - 100 && g.y < screen.availHeight - 100) {
		where = `screenX=${Math.round(g.x)},screenY=${Math.round(g.y)}`;
	}
	return `chrome,resizable,scrollbars,width=${Math.round(g.w)},height=${Math.round(g.h)},${where}`;
}

function lastCollectionID() {
	const id = parseInt(Zotero.Prefs.get(LAST_PREF), 10);
	return Number.isInteger(id) && safe(() => !!Zotero.Collections.get(id), false) ? id : null;
}

// --- data ------------------------------------------------------------------

// Unread feed items, newest first. Only the ids: hydrating 2000-odd items to
// show one card would make opening the window the slow part of the workflow.
async function loadIDs(libraryID) {
	const args = [];
	let sql = "SELECT i.itemID FROM feedItems fi "
		+ "JOIN items i ON i.itemID = fi.itemID "
		+ "LEFT JOIN itemData d ON d.itemID = i.itemID AND d.fieldID = "
		+ "(SELECT fieldID FROM fields WHERE fieldName = 'date') "
		+ "LEFT JOIN itemDataValues v ON v.valueID = d.valueID "
		+ "WHERE fi.readTime IS NULL";
	if (libraryID) {
		sql += " AND i.libraryID = ?";
		args.push(libraryID);
	}
	// The date field is stored ISO-first, so a lexical sort is a date sort.
	sql += " ORDER BY v.value DESC, i.itemID DESC";
	return (await Zotero.DB.columnQueryAsync(sql, args)) || [];
}

// The items of one collection, in the order the collections pane shows them:
// what is in the collection itself, not what is filed below it, and regular
// items only — an attachment or a note is not a card.
async function loadCollectionIDs(collectionID) {
	const c = safe(() => Zotero.Collections.get(collectionID), null);
	if (!c) return [];
	const from = [c];
	if (deep) {
		for (const d of safe(() => c.getDescendents(false, "collection"), [])) {
			const sub = safe(() => Zotero.Collections.get(d.id), null);
			if (sub) from.push(sub);
		}
	}
	// A set: an item filed in two of them is still one card.
	const ids = [...new Set(from.flatMap((coll) => safe(() => coll.getChildItems(true), [])))];
	const items = await Zotero.Items.getAsync(ids);
	await Zotero.Items.loadDataTypes(items, ["itemData"]);
	return items
		.filter((i) => safe(() => i.isRegularItem() && !i.deleted, false))
		.sort((a, b) => String(b.dateAdded || "").localeCompare(String(a.dateAdded || "")))
		.map((i) => i.id);
}

// Keep a window of items loaded around the cursor. Called on every advance;
// the ones already in `cache` cost nothing.
// Items outside the window around the cursor are dropped. Without this,
// riffling a 2,000-item backlog ends with every item ever shown still loaded —
// the sliding window was doing the fetching but none of the forgetting.
function evict(from) {
	if (cache.size <= AHEAD + BEHIND) return;
	const keep = new Set(ids.slice(Math.max(0, from - BEHIND), from + AHEAD));
	for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
}

async function hydrate(from) {
	evict(from);
	const want = ids.slice(from, from + AHEAD).filter((id) => !cache.has(id));
	if (!want.length) return;
	const items = await Zotero.Items.getAsync(want);
	// getAsync returns objects carrying only primary data. getField(),
	// getCreators() and getTags() each demand their own data type and throw
	// UnloadedDataException without it — which rendered a card with a working
	// header and nothing under it. Tags are needed even when a feed sends none:
	// Zotero.Item#clone reads them, so filing throws without this.
	// One bulk load per batch, not per item.
	await Zotero.Items.loadDataTypes(items, ["itemData", "creators", "tags"]);
	for (const it of items) cache.set(it.id, it);
}

// Every feed, plus an "all" row, ordered by how much is waiting in each. The
// counts are Zotero's own, so they agree with the collections pane.
function feedRows() {
	const feeds = safe(() => Zotero.Feeds.getAll(), [])
		.map((f) => ({ id: f.libraryID, name: f.name, n: safe(() => f.unreadCount, 0) }))
		.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
	const total = feeds.reduce((sum, f) => sum + f.n, 0);
	return [{ id: null, name: "All feeds", n: total }].concat(feeds);
}

// Every collection you could file into, flattened depth-first and carrying the
// path that makes it searchable: "Probability / Rough paths".
function flatCollections() {
	const out = [];
	const libs = safe(() => Zotero.Libraries.getAll(), [])
		.filter((l) => l.editable && !l.isFeed);
	for (const lib of libs) {
		const walk = (c, prefix) => {
			const path = prefix ? prefix + " / " + c.name : c.name;
			out.push({ id: c.id, path });
			for (const kid of safe(() => c.getChildCollections(), [])) walk(kid, path);
		};
		// A library name only earns a place in the path when there are several.
		const root = libs.length > 1 ? lib.name : "";
		for (const c of safe(() => Zotero.Collections.getByLibrary(lib.libraryID), [])) walk(c, root);
	}
	return out;
}

// Every DOI and URL already in the library, keyed the way a feed card is, and
// carrying the collections that copy sits in — those are the collections worth
// offering first when the card turns out to be something you already have. A
// few thousand rows, so it is read once and matched in memory rather than
// queried per card.
async function loadLibraryKeys() {
	const sql = "SELECT i.itemID AS itemID, v.value AS value, ci.collectionID AS collectionID, "
		// What the old copy is worth keeping for, if a revision turns up.
		+ "(SELECT COUNT(*) FROM itemNotes n WHERE n.parentItemID = i.itemID "
		+ "AND n.itemID NOT IN (SELECT itemID FROM deletedItems)) AS notes, "
		+ "(SELECT COUNT(*) FROM itemAnnotations an "
		+ "JOIN itemAttachments ia ON ia.itemID = an.parentItemID "
		+ "WHERE ia.parentItemID = i.itemID "
		+ "AND an.itemID NOT IN (SELECT itemID FROM deletedItems)) AS annots "
		+ "FROM itemData d "
		+ "JOIN itemDataValues v ON v.valueID = d.valueID "
		+ "JOIN items i ON i.itemID = d.itemID "
		+ "LEFT JOIN collectionItems ci ON ci.itemID = i.itemID "
		+ "WHERE d.fieldID IN (SELECT fieldID FROM fields WHERE fieldName IN ('DOI','url')) "
		// A PDF attachment carries the paper's own URL in itemData, so without
		// this the attachment wins the key: nothing to hoist (a child item is in
		// no collection) and filing would try to put a collection on the PDF.
		+ "AND i.itemTypeID NOT IN (SELECT itemTypeID FROM itemTypes "
		+ "WHERE typeName IN ('attachment','note','annotation')) "
		+ "AND i.libraryID NOT IN (SELECT libraryID FROM feeds) "
		+ "AND i.itemID NOT IN (SELECT itemID FROM deletedItems)";
	return foldLibraryRows((await Zotero.DB.queryAsync(sql)) || []);
}

// The library copy this card is a second announcement of, if there is one.
function libraryCopy(feedItem) {
	for (const k of refKeys(feedItem.getField("DOI"), feedItem.getField("url"))) {
		const hit = libKeys.get(k);
		if (hit) return hit;
	}
	return null;
}

// How many items each collection holds — regular items, nothing in the trash,
// which is what a deck of it would be. One query rather than one per row.
async function collectionCounts() {
	const sql = "SELECT ci.collectionID AS id, COUNT(*) AS n FROM collectionItems ci "
		+ "JOIN items i ON i.itemID = ci.itemID "
		+ "WHERE i.itemTypeID NOT IN (SELECT itemTypeID FROM itemTypes "
		+ "WHERE typeName IN ('attachment','note','annotation')) "
		+ "AND i.itemID NOT IN (SELECT itemID FROM deletedItems) "
		+ "GROUP BY ci.collectionID";
	const rows = (await Zotero.DB.queryAsync(sql)) || [];
	const out = new Map();
	for (const r of rows) out.set(r.id, r.n);
	return out;
}

// Collections you have filed into lately, most recent first — the ones the
// number keys reach.
function recentIDs() {
	const saved = safe(() => JSON.parse(Zotero.Prefs.get(RECENT_PREF) || "[]"), []);
	return (Array.isArray(saved) ? saved : []).filter((id) => Number.isInteger(id))
		.filter((id) => safe(() => !!Zotero.Collections.get(id), false))
		.slice(0, RECENT_MAX);
}

function pushRecent(id) {
	const next = [id].concat(recentIDs().filter((x) => x !== id)).slice(0, RECENT_MAX);
	safe(() => Zotero.Prefs.set(RECENT_PREF, JSON.stringify(next)));
}

async function loadTags() {
	const sql = "SELECT DISTINCT name FROM tags WHERE tagID IN ("
		+ "SELECT tagID FROM itemTags JOIN items USING (itemID) "
		+ "WHERE libraryID NOT IN (SELECT libraryID FROM feeds) "
		+ "AND itemID NOT IN (SELECT itemID FROM deletedItems)) ORDER BY name COLLATE locale";
	return (await Zotero.DB.columnQueryAsync(sql)) || [];
}

// --- actions ---------------------------------------------------------------

// "Discarded" is Zotero's own read flag, so the collections pane agrees with
// what you did here and Zotero's feed cleanup reaps the item on its own clock.
async function discard(item) {
	await item.toggleRead(true);
	undoStack.push({ id: item.id });
}

// A typed note as Zotero stores it: one paragraph a line, and nothing in the
// text taken for markup. Exported for test.js.
function noteHTML(text) {
	return String(text || "").split(/\n/).map((line) =>
		"<p>" + line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + "</p>"
	).join("");
}

// A local clone, not FeedItem#translate(). translate() loads the page in a
// hidden browser and runs translators — seconds per item, and a progress
// popup — which is exactly the clunkiness this plugin exists to avoid. The
// feed entry already carries title, authors, date, abstract, DOI and URL.
// ponytail: the PDF comes from the find-file resolvers below, but there is
// no web snapshot and no translator-grade metadata. Zotero's own "Add to My
// Library" is still there for the handful that deserve it.
async function keep(feedItem, collectionID, tags, note, dropOld) {
	const collection = Zotero.Collections.get(collectionID);
	// The picker was built from a snapshot; the collection can be gone by now.
	if (!collection) throw new Error("that collection no longer exists");
	const libraryID = collection.libraryID;
	const copy = libraryCopy(feedItem);

	// Zotero.FeedItem#clone saves immediately and hands back a plain summary
	// object, so go to the base implementation: it returns an unsaved item and
	// lets the tags go on before the first write.
	const item = Zotero.Item.prototype.clone.call(feedItem, libraryID);
	item.addToCollection(collectionID);
	for (const t of tags) item.addTag(t);
	await item.saveTx();

	// The PDF, by Zotero's own "Find Available PDF" route: the DOI and the
	// landing page, no hidden browser and no translator run. Deliberately not
	// awaited — the card has already flicked away and the file can land a few
	// seconds later. arXiv abs pages carry a citation_pdf_url, so the URL
	// resolver finds them without a DOI.
	// ponytail: no retry and no progress UI. Failures go to the error console.
	let filePromise = null;
	if (safe(() => Zotero.Libraries.get(libraryID).filesEditable, false)
		&& safe(() => Zotero.Attachments.canFindFileForItem(item), false)) {
		filePromise = Zotero.Attachments.addAvailableFile(item);
		filePromise.catch(oops);
	}

	// The copy you already had, when you said to let it go. Zotero's trash, not
	// erased: it keeps everything it held, undo brings it straight back, and
	// Zotero empties the trash on its own schedule if you never look again.
	let trashed = null;
	if (dropOld && copy) {
		const old = await Zotero.Items.getAsync(copy.id);
		if (old) {
			old.deleted = true;
			await old.saveTx();
			trashed = old;
		}
	}

	if (note) {
		const n = new Zotero.Item("note");
		n.libraryID = libraryID;
		n.parentItemID = item.id;
		n.setNote(noteHTML(note));
		await n.saveTx();
	}

	await feedItem.toggleRead(true);
	Zotero.Prefs.set(LAST_PREF, String(collectionID));
	pushRecent(collectionID);

	// The map is loaded once per reload, so keep it current as you file: a
	// cross-listed paper turns up twice in one sitting often enough, and the
	// newest copy is the one a second card should be pointed at.
	const keys = refKeys(item.getField("DOI"), item.getField("url"));
	const entry = { id: item.id, colls: new Set([collectionID]), notes: 0, annots: 0 };
	for (const k of keys) libKeys.set(k, entry);

	// Only this filing knows what it did, so it hands undo the way back.
	undoStack.push({
		id: feedItem.id,
		revert: async () => {
			// The download may still be in flight; take it back when it lands.
			if (filePromise) filePromise.then((att) => att && att.eraseTx()).catch(oops);
			const it = await Zotero.Items.getAsync(item.id);
			if (it) await it.eraseTx(); // takes the note and the PDF with it
			if (trashed) {
				trashed.deleted = false;
				await trashed.saveTx();
			}
			for (const k of keys) { if (copy) libKeys.set(k, copy); else libKeys.delete(k); }
		},
	});
	return !!trashed;
}

// Zotero paints a handful of tags a colour of their own and puts them ahead of
// the rest. A card that shows tags should show the same ones the same way, so
// "Important" is as red here as it is in the items list.
function tagColor(libraryID, name) {
	return safe(() => Zotero.Tags.getColor(libraryID, name), false) || null;
}

// Coloured first, in Zotero's own order — sort is stable, so everything else
// keeps the order it arrived in.
function orderTags(libraryID, names) {
	const at = (n) => {
		const c = tagColor(libraryID, n);
		return c && Number.isInteger(c.position) ? c.position : 999;
	};
	return names.slice().sort((a, b) => at(a) - at(b));
}

// The colour goes on as a wash rather than a block: these sit in running text
// and beside each other, and a row of solid colour would shout over the card.
function paintTag(node, color) {
	if (!color) return;
	node.style.borderColor = color;
	node.style.background = "color-mix(in srgb, " + color + " 20%, Canvas)";
	node.style.color = "color-mix(in srgb, " + color + " 70%, CanvasText)";
}

// pdf.js, the copy Zotero ships with its reader — loaded into the riffle
// window's own global, not the system one: importESModule loads a module beside
// Zotero's own code, where the built-in prototypes are frozen, and pdf.js
// installs a polyfill on Map.prototype as it loads. A module script in this
// document runs in this window, where they are not.
//
// Which means it belongs to the window, and is kept on it rather than here: a
// closed window takes its global with it, and a module reached for afterwards
// is a live object in a dead compartment — calls into it hang. Riffle, close
// the window, riffle again, and the first page never arrives.
const PDFJS_URL = "resource://zotero/reader/pdf/build/pdf.mjs";

function importPDFJS(w) {
	const doc = w.document;
	return new Promise((resolve, reject) => {
		const timer = w.setTimeout(() => reject(new Error("pdf.js did not load")), 15000);
		w.addEventListener("riffle-pdfjs", () => {
			w.clearTimeout(timer);
			const lib = w._rifflePDFJS;
			if (!lib || typeof lib.getDocument !== "function") {
				return reject(new Error("Zotero's pdf.js is not where it used to be"));
			}
			// Its own worker, from the same place. Without this pdf.js goes
			// looking for one relative to the document, which is about:blank.
			safe(() => {
				lib.GlobalWorkerOptions.workerSrc = PDFJS_URL.replace("pdf.mjs", "pdf.worker.mjs");
			});
			resolve(lib);
		}, { once: true });
		const tag = doc.createElement("script");
		tag.type = "module";
		// A module script cannot hand anything back, so it leaves the module on
		// the window and says when it is there.
		tag.textContent = 'import * as lib from "' + PDFJS_URL + '";'
			+ 'window._rifflePDFJS = lib;'
			+ 'window.dispatchEvent(new Event("riffle-pdfjs"));';
		tag.addEventListener("error", () => {
			w.clearTimeout(timer);
			reject(new Error("pdf.js would not load"));
		}, { once: true });
		(doc.head || doc.documentElement).append(tag);
	});
}

async function loadPDFJS() {
	const w = win;
	if (!w || w.closed) throw new Error("the window is gone");
	if (w._rifflePDFJS) return w._rifflePDFJS;
	// One load per window, however many pages are asked for at once.
	if (!w._rifflePDFJSLoad) {
		w._rifflePDFJSLoad = importPDFJS(w).catch((e) => {
			w._rifflePDFJSLoad = null;
			throw e;
		});
	}
	return w._rifflePDFJSLoad;
}

// The file a card could show a page of, if it has one. getBestAttachment is
// the same choice Zotero makes when you open an item from the items list, and
// it is async, so the answer is remembered and the card redrawn when it lands.
const attachments = new Map(); // itemID → attachment item, or null for none

function attachmentFor(item, redraw) {
	if (attachments.has(item.id)) return attachments.get(item.id);
	if (safe(() => item.isFeedItem, false)) {
		attachments.set(item.id, null);
		return null;
	}
	safe(() => item.getBestAttachment().then((att) => {
		// Only a PDF can be drawn as a page; anything else is opened with o.
		const pdf = att && safe(() => att.attachmentContentType === "application/pdf", false);
		attachments.set(item.id, pdf ? att : null);
		if (pdf && redraw) redraw();
	}).catch(oops));
	return undefined; // not known yet; the card draws without it
}

// --- managing a collection -------------------------------------------------

// The tags the item should end up with, rather than a list to add: a chip you
// took off the panel is a tag taken off the item. Undo restores exactly what
// was there before, types and all — an automatic tag stays automatic.
async function retag(item, wanted) {
	await Zotero.Items.loadDataTypes([item], ["tags"]);
	const before = item.getTags();
	const now = new Set(wanted);
	const gone = before.filter((t) => !now.has(t.tag));
	const fresh = wanted.filter((t) => !before.some((b) => b.tag === t));
	if (!gone.length && !fresh.length) return null;
	for (const t of gone) item.removeTag(t.tag);
	for (const t of fresh) item.addTag(t);
	await item.saveTx();
	return async () => {
		await Zotero.Items.loadDataTypes([item], ["tags"]);
		item.setTags(before);
		await item.saveTx();
	};
}

// A note of your own on an item you already own.
// The notes an item already has, in the order Zotero's own item pane lists
// them. getNotes() reads the child items and getNote() the text, and neither is
// loaded by getAsync — a card carries primary data and nothing else.
async function itemNotes(item) {
	await Zotero.Items.loadDataTypes([item], ["childItems"]);
	const notes = await Zotero.Items.getAsync(safe(() => item.getNotes(), []));
	if (notes.length) await Zotero.Items.loadDataTypes(notes, ["itemData", "note"]);
	return notes;
}

async function addNote(item, note) {
	const n = new Zotero.Item("note");
	n.libraryID = item.libraryID;
	n.parentItemID = item.id;
	n.setNote(noteHTML(note));
	await n.saveTx();
	return async () => { await safe(() => n.eraseTx(), null); };
}

// Out of the collection you are riffling and into another one. The item itself
// is untouched: a collection is a place it sits, not a copy of it.
async function moveTo(item, fromID, toID) {
	await Zotero.Items.loadDataTypes([item], ["collections"]);
	if (toID === fromID) return () => Promise.resolve();
	item.addToCollection(toID);
	if (fromID) item.removeFromCollection(fromID);
	await item.saveTx();
	return async () => {
		await Zotero.Items.loadDataTypes([item], ["collections"]);
		item.removeFromCollection(toID);
		if (fromID) item.addToCollection(fromID);
		await item.saveTx();
	};
}

// Zotero's trash, never erased: everything the item holds goes with it and
// comes back whole, and Zotero empties the trash on its own schedule.
async function trashItem(item) {
	item.deleted = true;
	await item.saveTx();
	return async () => {
		item.deleted = false;
		await item.saveTx();
	};
}

// One key on a keyboard-driven interface is one item gone from view, and at
// riffling speed a mis-hit is a matter of when, not if.
async function undo() {
	const last = undoStack.pop();
	if (!last) return null;
	if (last.revert) await last.revert();
	const feedItem = await Zotero.Items.getAsync(last.id);
	if (feedItem && safe(() => feedItem.isFeedItem, false)) {
		await feedItem.toggleRead(false);
		// getAsync alone carries primary data. Caching that as-is meant the card
		// undo stepped back to threw in getField() — the same trap as hydrate's.
		await Zotero.Items.loadDataTypes([feedItem], ["itemData", "creators", "tags"]);
		cache.set(feedItem.id, feedItem);
	}
	return last;
}

// --- window ----------------------------------------------------------------

const CSS = `
/* The page is built from system colours, and they only follow the app's theme
 * when the document says it handles both. Zotero's own HTML views do the same. */
:root { color-scheme: light dark; }
* { box-sizing: border-box; }

/* Every size below is in rem, and the rem is set from JS: Zotero's own font-size
 * setting times whatever you have nudged it to with +/-. So one number scales
 * the card, the maths and the chrome together. */
body { margin:0; height:100vh; display:flex; flex-direction:column; overflow:hidden;
	font:1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
	background:Canvas; color:CanvasText; }

/* Two faces, deliberately. The chrome is the system UI font because it is UI.
 * The title and description are set in a serif — it is what long-form reading
 * wants, and it sits with KaTeX's Computer Modern rather than against it: a
 * sans body beside serif formulas reads as two documents stapled together. */
.card h1, .abs { font-family:"Iowan Old Style", Charter, "Palatino Linotype",
	Palatino, Georgia, "Times New Roman", serif; }

.head { position:relative; display:flex; align-items:baseline; gap:.7rem;
	padding:.6rem 1.1rem;
	border-bottom:1px solid color-mix(in srgb, GrayText 35%, Canvas); }
/* The feed name is the scope control. Same colour as before — only a hit area
 * and a hover tint mark it as something you can press. */
.head .feed { font-size:.8rem; color:GrayText; overflow:hidden;
	text-overflow:ellipsis; white-space:nowrap; cursor:pointer;
	padding:.15em .4em; margin:-.15em -.4em; border-radius:4px;
	transition:background .12s; }
.head .feed:hover { background:color-mix(in srgb, GrayText 20%, Canvas); }
.head .feed::after { content:" ▾"; opacity:.65; }
/* The done screen clears the name; without this its caret hangs there alone. */
.head .feed:empty { padding:0; }
.head .feed:empty::after { content:none; }

/* Anchored under the feed name, and reuses .drop for the list itself. */
.feedpick { position:absolute; top:calc(100% + .3rem); left:.75rem; z-index:20;
	width:min(26rem, 78vw); padding:.4rem; background:Canvas; border-radius:7px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas);
	box-shadow:0 6px 22px rgba(0,0,0,.3); }
.feedpick input { width:100%; box-sizing:border-box;
	font:.88rem/1.45 system-ui, -apple-system, sans-serif;
	background:Canvas; color:CanvasText; padding:.25rem .5rem; border-radius:5px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas); }
.feedpick input:focus { outline:none; border-color:Highlight;
	box-shadow:0 0 0 2px color-mix(in srgb, Highlight 30%, transparent); }
/* Inside the popup the list is just a list: no second border or shadow, and it
 * drops downward rather than up like the filing panel's. */
.feedpick .drop { position:static; margin-top:.35rem; max-height:42vh;
	border:none; box-shadow:none; border-radius:4px; }
/* Rows carrying a trailing figure — an unread count, or a number-key hint. */
.drop div { display:flex; align-items:baseline; gap:.6rem; }
.drop div span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.drop b { font-weight:400; font-size:.78em; color:GrayText;
	font-variant-numeric:tabular-nums; }
.drop div.on b { color:HighlightText; }
.head .count { margin-left:auto; font-size:.74rem; color:GrayText;
	white-space:nowrap; font-variant-numeric:tabular-nums; }

.card { flex:1; min-height:0; overflow-y:auto;
	padding:2rem ${CARD_PAD_REM}rem 2.8rem; }
/* A measure, not the window width: past about 75 characters the eye loses the
 * start of the next line. rem, not em — em would resolve against each element's
 * own size, handing the 1.5rem title a column half again as wide as the prose
 * under it. */
/* Centred, so a window widened past the column reads as a deliberate reading
 * measure rather than text hugging the left edge. At the default size the
 * window is the column, so this changes nothing until you resize. */
.card > * { max-width:${MEASURE_REM}rem; margin-inline:auto; }

.card h1 { font-size:1.5rem; line-height:1.25; margin:0 auto .55rem; font-weight:600;
	letter-spacing:-.011em; text-wrap:balance; }

.meta { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem .7rem;
	margin-bottom:1.45rem; }
.meta .who { font-size:.86rem; color:color-mix(in srgb, CanvasText 78%, Canvas); }
.meta .when { font-size:.8rem; color:GrayText; font-variant-numeric:tabular-nums; }
.badge { font-size:.66rem; letter-spacing:.05em; text-transform:uppercase;
	padding:.1em .55em; border-radius:1em; color:GrayText;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas); }
.badge.replace { border-color:color-mix(in srgb, Highlight 55%, Canvas);
	color:color-mix(in srgb, Highlight 75%, CanvasText); }
.badge.have { border-color:color-mix(in srgb, Highlight 60%, Canvas);
	background:color-mix(in srgb, Highlight 16%, Canvas);
	color:color-mix(in srgb, Highlight 80%, CanvasText); }

/* Whatever tags the feed itself supplied. Scoped to the row: KaTeX gives an
 * equation number the class "tag" too, and a bare .tag rule dressed those up as
 * chips — a bordered pill sitting on top of the formula it numbers. */
.tags { display:flex; flex-wrap:wrap; gap:.3rem; margin:-.9rem auto 1.45rem; }
.tags .tag { font-size:.72rem; padding:.1em .5em; border-radius:1em; color:GrayText;
	background:color-mix(in srgb, GrayText 13%, Canvas);
	border:1px solid color-mix(in srgb, GrayText 28%, Canvas); }

/* Hyphenation earns its place at this measure: it takes the worst of the rag
 * out of a column this narrow. The limits keep it off short words. */
.abs { font-size:1rem; line-height:1.62; overflow-wrap:break-word;
	hyphens:auto; hyphenate-limit-chars:7 3 3; text-wrap:pretty; }
.abs.empty { color:GrayText; font-style:italic; }
/* The sanitizer hands back whatever the feed sent, so style the whole range of
 * ordinary prose markup rather than a private whitelist. */
.abs p, .abs ul, .abs ol, .abs blockquote, .abs pre, .abs table { margin:0 0 .85em; }
.abs > :last-child { margin-bottom:0; }
.abs h1, .abs h2, .abs h3, .abs h4, .abs h5, .abs h6 {
	font-size:1.02em; font-weight:600; margin:1.5em 0 .4em; line-height:1.3;
	letter-spacing:0; }
.abs blockquote { padding:.15em 0 .15em .9em; border-left:2px solid
	color-mix(in srgb, GrayText 45%, Canvas);
	color:color-mix(in srgb, CanvasText 72%, Canvas); }
.abs ul, .abs ol { padding-left:1.4em; }
.abs li { margin:.2em 0; }
.abs li > p { margin:0; }
.abs code, .abs kbd, .abs samp { font:.85em/1.4 ui-monospace, monospace;
	padding:.1em .3em; border-radius:3px;
	background:color-mix(in srgb, GrayText 18%, Canvas); }
.abs pre { padding:.6em .8em; border-radius:6px; overflow-x:auto;
	background:color-mix(in srgb, GrayText 14%, Canvas); }
.abs pre code { background:none; padding:0; }
.abs hr { border:none; margin:1.4em 0;
	border-top:1px solid color-mix(in srgb, GrayText 35%, Canvas); }
.abs table { border-collapse:collapse; font-size:.9em; display:block; overflow-x:auto; }
.abs th, .abs td { padding:.2em .5em; text-align:left;
	border:1px solid color-mix(in srgb, GrayText 35%, Canvas); }
.abs a { color:color-mix(in srgb, Highlight 72%, CanvasText); cursor:pointer;
	text-decoration:underline; text-underline-offset:.16em;
	text-decoration-thickness:from-font; }
.abs a:hover { color:Highlight; }
.abs sub, .abs sup { line-height:0; }

/* KaTeX ships its own stylesheet and it is linked after this one, so these have
 * to out-specify it rather than merely follow it. Its default 1.21em is tuned
 * for Computer Modern beside a sans body; against a serif with a larger
 * x-height that reads oversized, hence the smaller step. */
.abs .katex, .card h1 .katex { font-size:1.08em; }
/* A long equation scrolls in its own strip rather than widening the card. */
.abs .katex-display { margin:1em 0; overflow-x:auto; overflow-y:hidden;
	padding:.15em 0; }
/* Numbered: the number keeps its own column at the right margin — where a
 * paper puts it — and the maths scrolls inside what is left, so the two can
 * never collide however wide the equation is. liftTag() moved it out here. */
.abs .katex-display.tagged { display:flex; align-items:center; gap:1.2em;
	overflow:visible; }
.abs .katex-display.tagged > .katex { flex:1; min-width:0;
	overflow-x:auto; overflow-y:hidden; }
.abs .katex-display.tagged > .tag { flex:none; color:GrayText; }
.abs .katex-display.tagged > .tag.spacer { visibility:hidden; }
/* KaTeX marks what it could not parse with inline red; !important is what it
 * takes to override that. Muted rather than alarming: a feed's LaTeX is often
 * half-broken, and the source is still readable underneath. */
.katex-error { color:color-mix(in srgb, CanvasText 60%, Canvas) !important;
	border-bottom:1px dotted color-mix(in srgb, CanvasText 40%, Canvas);
	font-family:ui-monospace, monospace; font-size:.92em; }

.warn { margin-top:1.4rem; font-size:.78rem; overflow-wrap:anywhere;
	padding:.4rem .6rem; border-radius:5px;
	color:color-mix(in srgb, CanvasText 70%, Canvas);
	background:color-mix(in srgb, GrayText 14%, Canvas);
	border-left:2px solid color-mix(in srgb, GrayText 50%, Canvas); }
.url { display:block; margin-top:1.7rem; font-size:.78rem; color:GrayText;
	overflow-wrap:anywhere; text-decoration:none; cursor:pointer; }
.url:hover { color:color-mix(in srgb, Highlight 72%, CanvasText);
	text-decoration:underline; text-underline-offset:.16em; }

/* Entry: the new card arrives from the side you are travelling towards —
 * forward from the right, undo from the left. (These names used to be the wrong
 * way round: "from-left" ran the keyframe that enters from the right.) */
@keyframes inFromRight { from { opacity:0; transform:translateX(26px); } }
@keyframes inFromLeft  { from { opacity:0; transform:translateX(-26px); } }
.card.from-right { animation:inFromRight .13s ease-out; }
.card.from-left  { animation:inFromLeft .13s ease-out; }

/* Exit: the card you acted on leaves the way you sent it. A clone, so render()
 * goes on replacing the live card wholesale with no transition bookkeeping. */
/* Opaque, or the card underneath shows straight through the one leaving and
 * you read two abstracts at once. */
.ghost { position:fixed; z-index:5; pointer-events:none; overflow:hidden;
	background:Canvas; }
/* No fade. Fading it would dim its background too, so for the whole trip you
 * would be reading the outgoing abstract through the incoming one. Opaque and
 * travelling clear of the frame, it wipes away and reveals the next card. */
@keyframes outLeft  { to { transform:translateX(-105%); } }
@keyframes outRight { to { transform:translateX(105%); } }
.ghost.out-left  { animation:outLeft .18s cubic-bezier(.35,0,.9,1) forwards; }
.ghost.out-right { animation:outRight .18s cubic-bezier(.35,0,.9,1) forwards; }

/* The file's first page, in the space the description would have had, drawn
 * onto a canvas by the pdf.js Zotero ships with its reader. */
.preview { position:relative; margin-top:.4rem; min-height:12rem;
	border-radius:6px; overflow:hidden; background:Canvas;
	border:1px solid color-mix(in srgb, GrayText 30%, Canvas); }
.preview canvas { display:block; width:100%; height:auto; opacity:0;
	transition:opacity .12s ease-out; }
/* Only once there is something on it: a blank white rectangle in the middle of
 * a card is worse than the line it replaced. */
.preview.ready canvas { opacity:1; }
.preview .abs.empty { position:absolute; inset:0; display:flex;
	align-items:center; justify-content:center; margin:0; }
.preview.ready .abs.empty { display:none; }
/* Whatever went wrong is written in the box itself, so it wraps. */
.preview .abs.empty { padding:0 2rem; text-align:center; }

/* 3. A long description that continues past the fold says so, instead of
 * looking exactly like one that has ended. */
.card.more { mask-image:linear-gradient(to bottom, #000 calc(100% - 2.6rem), transparent); }
@media (prefers-reduced-motion:reduce) {
	.card, .ghost { animation:none !important; }
	.ghost { display:none; }
}

.done { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
	gap:8px; color:GrayText; }
.done .big { font-size:2.2rem; }
.done .next { margin-top:1.6rem; width:min(22rem, 80%); }
.done .nextlabel { font-size:.72rem; letter-spacing:.05em; text-transform:uppercase;
	color:GrayText; margin-bottom:.35rem; text-align:left; }
/* The list is the same one the feed picker shows, without the popup around it. */
/* The finish summary: figures first, then the way to be rid of them. Both are
 * quieter than anything else on the screen — you came here to be finished. */
.sum { margin-top:1.4rem; display:flex; flex-direction:column; align-items:center;
	gap:.3rem; }
.sum .figures { font-size:.82rem; color:GrayText; font-variant-numeric:tabular-nums; }
.quiet { border:none; background:none; cursor:pointer; font:inherit;
	font-size:.72rem; padding:.1rem .3rem; border-radius:4px;
	color:color-mix(in srgb, GrayText 55%, Canvas); }
.quiet:hover { color:GrayText; background:color-mix(in srgb, GrayText 12%, Canvas); }
.asks { display:flex; gap:.2rem; }
/* The message around it is grey because it is a message. This is a list you
 * pick from with the arrows, the same one the feed picker shows, so it reads in
 * ordinary text rather than looking switched off. */
.done .drop { position:static; max-height:none; box-shadow:none; color:CanvasText;
	border:1px solid color-mix(in srgb, GrayText 35%, Canvas); }

.bar { border-top:1px solid color-mix(in srgb, GrayText 35%, Canvas);
	padding:.5rem 1.1rem; display:flex; flex-wrap:wrap; gap:.35rem .65rem;
	font-size:.75rem; color:GrayText; }
.bar kbd { font:.72rem ui-monospace, monospace; padding:.05em .4em; border-radius:4px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas);
	background:color-mix(in srgb, GrayText 14%, Canvas); color:CanvasText; }
/* A hint that names a key you can also click. The key itself lights up, so a
 * "+ / −" pair still reads as two buttons rather than one. */
.bar .hit { cursor:pointer; }
.bar .hit:hover { color:CanvasText; }
.bar .hit:hover > kbd, .bar kbd.hit:hover {
	border-color:color-mix(in srgb, Highlight 60%, Canvas);
	background:color-mix(in srgb, Highlight 22%, Canvas); }

/* The filing panel replaces the hint bar rather than floating over the card:
 * you keep reading the description while you decide where it goes. */
.file { border-top:1px solid color-mix(in srgb, Highlight 55%, Canvas);
	background:color-mix(in srgb, Highlight 8%, Canvas); padding:.65rem 1.1rem .6rem; }
/* The question about the old copy: a list you answer, not a popup that hangs
 * over the row above it. */
.ask .drop { position:static; margin:.45rem 0 0 3.8rem; max-height:none;
	box-shadow:none; }
.ask:focus { outline:none; }
/* Said where the filing happens, not only on the card. */
.file .dupe { font-size:.74rem; margin:.4rem 0 0 3.8rem;
	color:color-mix(in srgb, Highlight 80%, CanvasText); }
.row { display:flex; align-items:center; gap:.6rem; margin-bottom:.45rem;
	position:relative; }
.row:last-of-type { margin-bottom:0; }
.row > label { font-size:.72rem; color:GrayText; width:3.2rem; flex:none;
	text-align:right; }
.row input, .row textarea { flex:1; min-width:0;
	font:.88rem/1.45 system-ui, -apple-system, sans-serif;
	background:Canvas; color:CanvasText; padding:.25rem .5rem; border-radius:5px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas); }
.row textarea { resize:vertical; min-height:3rem; }
/* The notes already on the item: one at a time, read-only, with the box you
 * would write a new one in taking the place of the last. */
.row .notes { flex:1; min-width:0; display:flex; flex-direction:column; gap:.3rem; }
.notehead { font-size:.72rem; color:GrayText; font-variant-numeric:tabular-nums; }
.notebody { max-height:9rem; overflow:auto; font-size:.85rem; line-height:1.45;
	background:Canvas; color:CanvasText; padding:.3rem .5rem; border-radius:5px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas); }
.notebody:focus { outline:none; border-color:Highlight;
	box-shadow:0 0 0 2px color-mix(in srgb, Highlight 30%, transparent); }
.notebody > :first-child { margin-top:0; }
.notebody > :last-child { margin-bottom:0; }
.row input:focus, .row textarea:focus { outline:none; border-color:Highlight;
	box-shadow:0 0 0 2px color-mix(in srgb, Highlight 30%, transparent); }

.drop { position:absolute; bottom:calc(100% + .3rem); left:3.8rem; right:0; z-index:9;
	max-height:44vh; overflow:auto; background:Canvas; border-radius:6px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas);
	box-shadow:0 -6px 20px rgba(0,0,0,.28); }
.drop div { padding:.22rem .55rem; cursor:pointer; overflow:hidden;
	text-overflow:ellipsis; white-space:nowrap; font-size:.88rem; }
.drop div.on { background:Highlight; color:HighlightText; }
.drop .none { color:GrayText; font-style:italic; cursor:default; }

/* One control that happens to contain chips: they flow with the box you type
 * in and wrap onto a new line together, and the box keeps a usable width by
 * dropping to a line of its own rather than being squeezed to nothing. */
.row .field { flex:1; min-width:0; display:flex; flex-wrap:wrap;
	align-items:center; gap:.25rem; padding:.18rem .25rem; border-radius:5px;
	background:Canvas; border:1px solid color-mix(in srgb, GrayText 45%, Canvas); }
.row .field:focus-within { border-color:Highlight;
	box-shadow:0 0 0 2px color-mix(in srgb, Highlight 30%, transparent); }
.row .field input { flex:1 1 9rem; min-width:9rem; border:none; background:none;
	padding:.07rem .25rem; }
.row .field input:focus { outline:none; border:none; box-shadow:none; }
.chip { font-size:.75rem; padding:.05em .25em .05em .5em; border-radius:1em;
	display:flex; align-items:center; gap:.15em;
	background:color-mix(in srgb, Highlight 22%, Canvas);
	border:1px solid color-mix(in srgb, Highlight 45%, Canvas); }
.chip button { border:none; background:none; cursor:pointer; color:inherit;
	font-size:.9rem; line-height:1; padding:0 .2em; opacity:.7; }
.chip button:hover { opacity:1; }
/* Armed by Backspace: the next one takes it off. */
.chip.on { background:Highlight; border-color:Highlight; color:HighlightText; }

.flash { position:fixed; left:50%; bottom:4.6rem; transform:translateX(-50%);
	z-index:20; font-size:.8rem; padding:.35rem .9rem; border-radius:1em;
	pointer-events:none; font-variant-numeric:tabular-nums;
	background:color-mix(in srgb, CanvasText 82%, Canvas); color:Canvas;
	animation:fade 1.5s ease-out forwards; }
@keyframes fade { 0%,64% { opacity:1; } 100% { opacity:0; } }
`;

function el(doc, tag, cls, text) {
	const n = doc.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

// Text with its inline math rendered: a fragment of text nodes and sup/sub
// elements. Built node by node — nothing here goes near innerHTML.
function mathFragment(doc, text) {
	const frag = doc.createDocumentFragment();
	for (const run of splitMath(sourceText(doc, text))) {
		// An over-long "math" run means an unbalanced delimiter, usually in an
		// abstract the importer already mangled. Rendering it as math nests the
		// rest of the paragraph inside a subscript, where MathML's scriptlevel
		// shrinks it to unreadable. Falling back to text is the honest failure.
		if (run.math && fitsAsMath(run.text)) mathInto(doc, frag, run.text, run.display);
		else frag.append(deLatex(run.text)); // text-mode accents and escapes
	}
	return frag;
}

// Same, as a fresh element. Titles only — the abstract goes through
// abstractNode() below, which gives it real block structure.
function mathEl(doc, tag, cls, text) {
	const node = el(doc, tag, cls);
	node.append(mathFragment(doc, text));
	return node;
}

// --- the description -------------------------------------------------------

// The abstract is what you actually read on a card, so it gets built as real
// structure rather than one pre-wrapped blob: paragraphs, quotes and lists as
// elements, prose typeset as prose, and formulas as MathML.

// TeX ligatures and quotes are still in the source; a reader should not show
// them raw. Runs of whitespace go too — blocks carry the structure now, so the
// source's line wrapping is noise.
function typography(s) {
	return (s || "")
		.replace(/---/g, "—")
		.replace(/--/g, "–")
		.replace(/``/g, "“")
		.replace(/''/g, "”")
		// An orphaned TeX delimiter is litter — nobody writes "\[" in prose. A
		// stray "$" is left alone: it is far more often a currency sign.
		.replace(/\\[[\]()]/g, "")
		.replace(/[ \t ]{2,}/g, " ");
}

// arXiv sends one plain-text blob; a blank line is the only paragraph signal
// it ever gives.
function paragraphs(text) {
	return String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

// Text with its formulas typeset, appended into `parent`.
function inlineInto(doc, parent, text) {
	for (const run of splitMath(text)) {
		// An over-long "math" run means an unbalanced delimiter, usually in an
		// abstract the importer already mangled. Rendering it as math nests the
		// rest of the paragraph inside a subscript, where MathML's scriptlevel
		// shrinks it to unreadable. Falling back to prose is the honest failure.
		if (run.math && fitsAsMath(run.text)) mathInto(doc, parent, run.text, run.display);
		else parent.append(typography(deLatex(run.text)));
	}
}

// Feeds that really send HTML get it rendered, not flattened — but a feed is
// untrusted input, so it goes through Gecko's own sanitizer rather than
// anything hand-written here. nsIParserUtils is the same service Zotero uses to
// handle untrusted note and annotation HTML.
//
// Dropping media is deliberate as well as safe: a remote <img> in an RSS item is
// as often a tracking pixel as a picture, and this window should not be phoning
// home for every card you flick past.
function sanitizedFragment(doc, raw, baseURL) {
	// All of it inside safe(): if the service is ever missing the card falls back
	// to the plain-text path instead of failing to draw at all.
	return safe(() => {
		const { classes: Cc, interfaces: Ci } = Components;
		const PU = Ci.nsIParserUtils;
		const flags = PU.SanitizerDropForms | PU.SanitizerDropMedia
			| PU.SanitizerDropNonCSSPresentation;
		// No SanitizerAllowStyle: the card keeps its own typography, and a feed
		// does not get to restyle it.
		const base = baseURL ? safe(() => Services.io.newURI(baseURL), null) : null;
		return Cc["@mozilla.org/parserutils;1"].getService(PU)
			.parseFragment(String(raw || ""), flags, false, base, doc.documentElement);
	}, null);
}

// Block elements are the tell that a feed really sent HTML; a "<" that came out
// of a formula never produces one.
const BLOCKS = "p, div, blockquote, ul, ol, li, pre, h1, h2, h3, h4, h5, h6, table";

// Typeset the formulas inside already-parsed markup. Only text nodes are
// touched, so the feed's own structure is left exactly as the sanitizer left it.
function typesetInto(doc, root) {
	const texts = [];
	const walk = (n) => {
		for (const c of n.childNodes) {
			if (c.nodeType === 3) texts.push(c);
			// Preformatted text is quoted verbatim; it is not maths.
			else if (c.nodeType === 1 && c.localName !== "pre" && c.localName !== "code") walk(c);
		}
	};
	walk(root);
	for (const t of texts) {
		const frag = doc.createDocumentFragment();
		inlineInto(doc, frag, t.nodeValue);
		t.replaceWith(frag);
	}
}

// Some feeds mark maths with a class instead of delimiters (the Stack Exchange
// network does, and MathJax's convention is the same). Give those the
// delimiters splitMath needs, before the text nodes are typeset.
function markClassMath(root) {
	for (const el of root.querySelectorAll('[class*="math"]')) {
		const body = el.textContent || "";
		if (!body.trim() || body.includes("$")) continue;
		// An environment or a \tag is display maths and KaTeX refuses it inline —
		// "{equation} can be used only in display mode" — so the delimiters we
		// invent have to say which kind it is.
		const display = /\\begin\s*\{|\\tag\b/.test(body);
		const d = display ? "$$" : "$";
		el.textContent = d + body + d;
	}
}

// The whole description, as an element.
function abstractNode(doc, raw, baseURL) {
	const box = el(doc, "div", "abs");
	raw = inlineImgMath(doc, raw);

	const frag = /[<&]/.test(String(raw || "")) ? sanitizedFragment(doc, raw, baseURL) : null;
	if (frag && frag.querySelector && frag.querySelector(BLOCKS)) {
		markClassMath(frag);
		typesetInto(doc, frag);
		box.append(frag);
		return box;
	}

	// Otherwise it was prose all along, and any markup in it is the importer's.
	for (const t of paragraphs(sourceText(doc, raw))) {
		const p = el(doc, "p");
		inlineInto(doc, p, t);
		box.append(p);
	}
	return box;
}


// A riffle window outlives the plugin that opened it. Its listeners are bound
// to a sandbox that no longer exists, so every keypress in it throws — and
// openDialog reuses a window by name rather than replacing it, so the next
// install inherits the wreck instead of a clean window. Close them on the way in.
function closeOrphanWindows() {
	safe(() => {
		const e = Services.wm.getEnumerator(null);
		while (e.hasMoreElements()) {
			const w = e.getNext();
			if (w === win) continue;
			safe(() => {
				const root = w.document && w.document.documentElement;
				if (root && root.hasAttribute(RIFFLE_ATTR)) w.close();
			});
		}
	});
}

function openCollection(collectionID) {
	if (!collectionID) return;
	mode = "collection";
	scopeColl = collectionID;
	scopeLib = null;
	deep = safe(() => !!Zotero.Prefs.get("recursiveCollections"), false);
	return openWindow();
}

function open(libraryID) {
	mode = "feed";
	scopeColl = null;
	scopeLib = libraryID || null;
	return openWindow();
}

function openWindow() {
	const main = Zotero.getMainWindow();
	if (!main) return;
	if (win && !win.closed) {
		// Already riffling: the tally carries on across feeds.
		win.focus();
		return reload();
	}
	statReset();
	// about:blank rather than a packaged XHTML: opened from a chrome window it
	// inherits chrome privileges, and the whole document is built here anyway.
	// Before opening: anything still around under our name belongs to a previous
	// install and would be reused rather than replaced.
	closeOrphanWindows();
	win = main.openDialog("about:blank", "feed-riffle", features(main));
	if (!win) return;
	// Only save geometry here. This fires for the *initial* about:blank document
	// too, when the real one loads — nulling `win` from it killed the load.
	// Parked on the window so a later install can unhook this one.
	safe(() => { if (win._riffleUnload) win.removeEventListener("unload", win._riffleUnload); });
	win._riffleUnload = () => safe(() => { saveState(win); bankTime(); });
	win.addEventListener("unload", win._riffleUnload);
	const go = () => reload().catch(oops);
	if (win.document.readyState === "complete") go();
	else win.addEventListener("load", go, { once: true });
}

// The document an about:blank window starts with can be swapped out from under
// us as the real one loads, taking anything already written with it. So never
// hold a `doc` across an await: re-read it, and put the stylesheet back if this
// is a document that has not seen it.
function ensureCSS(w) {
	const doc = w.document;
	doc.title = "Feed Riffle";
	// Marks the window as ours so a later install of this plugin can recognise
	// one left behind by an earlier one.
	safe(() => doc.documentElement.setAttribute(RIFFLE_ATTR, "1"));
	applyFontSize(w);
	ensureKatexCSS(w);
	if (!doc.getElementById("riffle-css")) {
		const style = el(doc, "style", null, CSS);
		style.id = "riffle-css";
		(doc.head || doc.documentElement).append(style);
	}
	return doc;
}

// Whole-window message — loading, errors, and the empty deck all land here.
function paint(w, text) {
	if (!w || w.closed) return;
	const doc = ensureCSS(w);
	if (doc.body) doc.body.replaceChildren(el(doc, "div", "done", text));
}

async function reload() {
	const w = win;
	if (!w || w.closed) return;
	paint(w, "Loading…");
	try {
		await loadKatex();
		ids = isFeedMode() ? await loadIDs(scopeLib) : await loadCollectionIDs(scopeColl);
		total = ids.length;
		cursor = 0;
		cache.clear();
		attachments.clear();
		undoStack = [];
		colls = flatCollections();
		// Only the deck that offers them pays for the counts.
		if (isFeedMode()) collRows = [];
		else {
			const counts = await collectionCounts();
			collRows = colls.map((c) => ({ id: c.id, name: c.path, n: counts.get(c.id) || 0 }));
		}
		allTags = await loadTags();
		libKeys = await loadLibraryKeys();
		await hydrate(0);
	}
	catch (e) {
		oops(e);
		// A blank window tells you nothing; the message names the failure.
		return paint(w, "Error: " + ((e && e.message) || String(e)));
	}
	if (w.closed) return; // closed while loading
	build(w);
}

// One keydown listener on the document, dispatching on which layer is up.
// The panel's own inputs stop propagation for plain typing, so the card
// shortcuts below can stay single-letter.
function build(w) {
	const doc = ensureCSS(w);
	if (!doc.body) return;
	doc.body.replaceChildren();

	const head = el(doc, "div", "head");
	// The feed name doubles as the scope control: it already says which feed you
	// are in, so it is the obvious place to change it.
	const feedName = el(doc, "span", "feed");
	const count = el(doc, "span", "count");
	head.append(feedName, count);
	let menu = null; // the feed picker, when open

	const closeFeeds = () => {
		if (!menu) return;
		safe(() => doc.removeEventListener("mousedown", menu._onDown, true));
		menu.remove();
		menu = null;
		w.focus();
	};

	// The same list either way: what else this window could be riffling. Feeds
	// carry what is unread in them, collections what is in them.
	const openFeeds = () => {
		if (menu) return closeFeeds();
		const feed = isFeedMode();
		const rows = feed ? feedRows() : collRows;
		if (rows.length < 2) return flash(feed ? "No feeds" : "No collections");
		menu = el(doc, "div", "feedpick");
		const input = doc.createElement("input");
		input.type = "text";
		input.placeholder = feed ? "Search feeds…" : "Search collections…";
		const drop = el(doc, "div", "drop");
		menu.append(input, drop);
		head.append(menu);

		let shown = rows;
		// Opens on whichever one you are already riffling.
		const here = feed ? scopeLib : scopeColl;
		let sel = Math.max(0, rows.findIndex((r) => r.id === here));

		const paint = () => {
			drop.replaceChildren();
			if (!shown.length) {
				drop.append(el(doc, "div", "none",
					feed ? "No matching feed" : "No matching collection"));
				return;
			}
			shown.forEach((r, i) => {
				const row = el(doc, "div", i === sel ? "on" : null);
				row.append(el(doc, "span", null, r.name),
					el(doc, "b", null, r.n === null ? "" : String(r.n)));
				row.addEventListener("mousedown", (e) => { e.preventDefault(); sel = i; choose(); });
				drop.append(row);
			});
			const on = drop.querySelector(".on");
			if (on) on.scrollIntoView({ block: "nearest" });
		};

		const choose = () => {
			const r = shown[sel];
			closeFeeds();
			if (!r || r.id === here) return;
			if (feed) scopeLib = r.id;
			else scopeColl = r.id;
			reload().catch(oops);
		};

		menu.addEventListener("keydown", (e) => {
			if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return closeFeeds(); }
			if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); return choose(); }
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault(); e.stopPropagation();
				if (!shown.length) return;
				sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
				return paint();
			}
			e.stopPropagation(); // ordinary typing stays in the box
		});
		input.addEventListener("input", () => {
			shown = rank(input.value, rows, (r) => r.name);
			sel = 0;
			paint();
		});
		// Clicking anywhere else dismisses it, the way a menu should.
		menu._onDown = (e) => {
			if (!menu.contains(e.target) && e.target !== feedName) closeFeeds();
		};
		doc.addEventListener("mousedown", menu._onDown, true);

		paint();
		input.focus();
	};

	feedName.addEventListener("click", openFeeds);

	const cardBox = el(doc, "div", "card");
	// Links open in the real browser: this window is the riffle UI, and
	// navigating it away would end the session. Delegated from the card, which
	// outlives each render, so it covers the description and the item URL both.
	const openLinks = (e) => {
		const a = e.target && e.target.closest && e.target.closest("a[href]");
		if (!a) return;
		e.preventDefault();
		safe(() => Zotero.launchURL(a.href));
	};
	cardBox.addEventListener("click", openLinks);
	const bar = el(doc, "div", "bar");
	doc.body.append(head, cardBox, bar);

	let panel = null;      // the filing panel, or null when just riffling
	let dir = "from-right"; // which way the last card came in
	let ghost = null;       // the outgoing card, mid-flight
	let nextFeeds = [];     // feeds still waiting, offered on the done screen
	let nextSel = 0;
	let nextDrop = null;    // that list, so moving the selection need not redraw

	// Moving the selection repaints the rows in place. Going through render()
	// would re-enter draw(), which rebuilds the list and resets nextSel — so the
	// selection could never actually move.
	const paintNext = () => {
		if (!nextDrop) return;
		[...nextDrop.children].forEach((row, i) => row.classList.toggle("on", i === nextSel));
	};

	// The card you just acted on flies off the way you sent it: left for
	// discard, right for keep. Cloned and thrown away rather than retained, and
	// never more than one in the air however fast you riffle.
	const flick = (way) => {
		const reduce = safe(() => w.matchMedia("(prefers-reduced-motion: reduce)").matches, false);
		if (reduce) return;
		const drop = () => { if (ghost) { ghost.remove(); ghost = null; } };
		drop();
		const r = cardBox.getBoundingClientRect();
		if (!r.height) return;
		ghost = cardBox.cloneNode(true);
		ghost.className = "card ghost out-" + way; // keeps the card's own styling
		ghost.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;`
			+ `width:${r.width}px;height:${r.height}px;`;
		doc.body.append(ghost);
		ghost.scrollTop = cardBox.scrollTop; // leave from where you were reading
		ghost.addEventListener("animationend", drop, { once: true });
		w.setTimeout(drop, 500); // in case the event never lands
	};

	// Fade the bottom edge while there is more description below.
	const paintFade = () => {
		const more = cardBox.scrollTop + cardBox.clientHeight < cardBox.scrollHeight - 4;
		cardBox.classList.toggle("more", more);
	};
	cardBox.addEventListener("scroll", paintFade);
	// Held-down arrow keys repeat far faster than a saveTx round-trip. Without
	// this, two presses read the same card, marked it read once, and advanced
	// the cursor twice — the item in between was never shown.
	let busy = false;
	let skipped = 0; // this session, for the count on the done screen
	let ending = false; // showing the summary on the way out
	let previewAtt = 0; // the attachment it is for, so a late one can be dropped
	let previewing = false; // p, and only for the card you pressed it on
	let previewAll = false; // P: pages rather than descriptions, until told otherwise
	const guard = (p) => {
		busy = true;
		return p.finally(() => { busy = false; });
	};

	const flash = (text) => {
		const f = el(doc, "div", "flash", text);
		doc.body.append(f);
		w.setTimeout(() => f.remove(), 1600);
	};

	const current = () => cache.get(ids[cursor]);

	// Third element of a hint: what its key does. With one, the whole hint —
	// key and words — becomes a button; with an array, each key in a "+/−"
	// pair gets its own. mousedown, not click, so a panel input keeps focus and
	// the keyboard still works the moment after you use the mouse.
	const arm = (node, fn) => {
		node.classList.add("hit");
		node.addEventListener("mousedown", (e) => { e.preventDefault(); fn(); });
	};
	const hint = (triples) => {
		bar.replaceChildren();
		for (const [k, what, act] of triples) {
			const span = el(doc, "span");
			const many = Array.isArray(act);
			k.split("/").forEach((key, i) => {
				if (i) span.append(" / ");
				const kb = el(doc, "kbd", null, key);
				if (many && act[i]) arm(kb, act[i]);
				span.append(kb);
			});
			span.append(" " + what);
			if (act && !many) arm(span, act);
			bar.append(span);
		}
	};

	// The numbers file into recent collections without the panel; clicking that
	// hint opens the panel, which is where those same collections are listed.
	// Every key the card answers to, on one line — which is what the window is
	// sized to hold rather than the other way round.
	const cardHints = () => hint(isFeedMode()
		? [["←", "discard", doDiscard], ["→", "keep", () => openPanel()],
			["s", "skip", doSkip], ["u", "undo", doUndo],
			["1–9", "recent", () => openPanel()], ["f", "feed", openFeeds],
			["o", "open", openURL],
			["+/−", "size", [() => setScale(fontScale + SIZE_STEP),
				() => setScale(fontScale - SIZE_STEP)]],
			["Esc", "close", stop]]
		: [["←/→", "browse", [prev, next]],
			["t", "tags", () => openPanel(manageJob("tags", current()))],
			["n", "note", () => openNotes()],
			["m", "move", () => openPanel(manageJob("move", current()))],
			["x", "trash", doTrash], ["p/P", "page", [doPreview, doPreviewAll]],
			["u", "undo", doUndo], ["s", "subcollections", doDeep],
			["f", "switch", openFeeds], ["o", "open", openURL],
			["+/−", "size", [() => setScale(fontScale + SIZE_STEP),
				() => setScale(fontScale - SIZE_STEP)]],
			["Esc", "close", stop]]);

	// --- the card ---------------------------------------------------------

	function render() {
		try { draw(); }
		catch (e) {
			oops(e);
			cardBox.className = "card";
			cardBox.replaceChildren(el(doc, "div", "done",
				"Error drawing this item: " + ((e && e.message) || String(e))));
			hint([["→", "skip"], ["Esc", "close"]]);
		}
	}

	// What the sitting came to. Quiet by design — it is the last thing between
	// you and the door, not a scoreboard — and it can be turned off from
	// itself, with the way back in the same place and nowhere else.
	function summaryBox(stopped) {
		const line = summaryLine(isFeedMode()
			? [[stat.kept, "kept"], [stat.dropped, "discarded"], [stat.skipped, "skipped"]]
			: [[stat.kept, "changed"], [stat.dropped, "trashed"]], stat.spent);
		if (!line) return null;
		const quiet = (label, on) => {
			const b = el(doc, "button", "quiet", label);
			b.addEventListener("mousedown", (e) => {
				e.preventDefault();
				safe(() => Zotero.Prefs.set(STATS_PREF, on));
				render();
			});
			return b;
		};
		const box = el(doc, "div", "sum");
		if (summaryOn()) {
			box.append(el(doc, "div", "figures", line));
			// Switched off where it interrupts you. On a screen you reached by
			// finishing the deck there is nothing to switch off: it was going to
			// be here anyway.
			if (stopped) box.append(quiet("Don't show this summary again", false));
			return box;
		}
		// Off, so Esc now closes without stopping here — which leaves the finish
		// screen as the one place to change your mind.
		if (stopped) return null;
		box.append(quiet("Show the summary again", true));
		return box;
	}

	// Asked once, the first time a sitting ends with something worth logging and
	// Reading Time is there to log it to. Either answer is remembered, so this
	// is a question you see once and then never again.
	function askBox() {
		if (!isFeedMode() || rtAnswer() !== undefined || !readingTime()) return null;
		statTick();
		if (stat.spent < 60000) return null;
		const box = el(doc, "div", "sum");
		box.append(el(doc, "div", "figures", `Keep ${fmtSpan(stat.spent)} in Reading Time?`));
		const answer = (label, on) => {
			const b = el(doc, "button", "quiet", label);
			b.addEventListener("mousedown", (e) => {
				e.preventDefault();
				safe(() => Zotero.Prefs.set(RT_PREF, on));
				render();
			});
			return b;
		};
		const row = el(doc, "div", "asks");
		row.append(answer("Yes, and from now on", true), answer("No", false));
		box.append(row);
		return box;
	}

	// Where riffling ends. `stopped` only says how you got here: by pressing Esc
	// on a card, rather than by running the deck out.
	function endScreen(stopped) {
		cardBox.className = "card";
		const done = el(doc, "div", "done");
		const left = Math.max(0, ids.length - cursor);
		done.append(
			el(doc, "div", "big", total ? "✓" : "—"),
			el(doc, "div", null, isFeedMode()
				? deckLine(Math.max(0, cursor - skipped), total, skipped, left)
				: seenLine(cursor, total, left)),
		);

		const sum = summaryBox(stopped);
		if (sum) done.append(sum);

		const ask = askBox();
		if (ask) done.append(ask);

		// Reaching the end of one feed is the moment you are most likely to want
		// another, so the ones still waiting are offered here rather than left
		// for you to go and find.
		nextFeeds = isFeedMode()
			? feedRows().filter((r) => r.id !== null && r.n > 0 && r.id !== scopeLib)
			: [];
		nextSel = 0;
		nextDrop = null;
		if (nextFeeds.length) {
			const box = el(doc, "div", "next");
			box.append(el(doc, "div", "nextlabel", "Still waiting"));
			const drop = el(doc, "div", "drop");
			nextFeeds.forEach((r, i) => {
				const row = el(doc, "div", i === nextSel ? "on" : null);
				row.append(el(doc, "span", null, r.name), el(doc, "b", null, String(r.n)));
				row.addEventListener("mousedown", (e) => {
					e.preventDefault();
					nextSel = i;
					goNext();
				});
				drop.append(row);
			});
			box.append(drop);
			done.append(box);
			nextDrop = drop;
		}

		cardBox.append(done);
		const pickNext = () => {
			nextSel = (nextSel + 1) % nextFeeds.length;
			paintNext();
		};
		const resume = () => { ending = false; render(); };
		hint([]
			.concat(nextFeeds.length
				? [["⏎", "next feed", () => goNext()], ["↑↓", "pick", pickNext]]
				: [["⏎", "close", () => w.close()]])
			.concat(stopped && left ? [["←→", "keep riffling", resume]] : [])
			.concat([["u", "undo", () => { ending = false; doUndo(); }]])
			.concat(nextFeeds.length || stopped
				? [] : [["r", "reload", () => reload().catch(oops)]])
			.concat([["Esc", "close", () => w.close()]]));
		feedName.textContent = "";
		count.textContent = "";
	}

	// Zotero's own reader, drawing the file's first page — the one the item pane
	// previews with. A card at a time: the reader is torn down before the next
	// card is drawn, so riffling never carries one along.
	// The first page, drawn here rather than by the reader. Zotero ships pdf.js
	// with its reader, so the page can go straight onto a canvas: no frame to
	// wait on, no reader UI to hide again, and nothing to tear down when the
	// card changes — a picture costs nothing to keep.
	// The whole file, for a small one or where ranges are not on offer.
	async function readWhole(path) {
		if (typeof IOUtils !== "undefined") return IOUtils.read(path);
		const str = await Zotero.File.getBinaryContentsAsync(path);
		return new Uint8Array([...str].map((c) => c.charCodeAt(0)));
	}

	// The first page is a few hundred kilobytes of a file that can be a hundred
	// megabytes, so the file is read in pieces: pdf.js asks for the ranges it
	// needs — the trailer, then the objects page one refers to — and each is a
	// read from disk of that much. The opening bytes go in as the transport's
	// own initial data, and it is told the stream is done, or pdf.js waits for
	// more to arrive by itself and nothing ever draws.
	async function rangeSource(pdf, path, length) {
		const head = await IOUtils.read(path, { offset: 0, maxBytes: Math.min(length, 65536) });
		const source = new pdf.PDFDataRangeTransport(length, head, true);
		source.requestDataRange = (begin, end) => {
			IOUtils.read(path, { offset: begin, maxBytes: end - begin })
				.then((bytes) => source.onDataRange(begin, bytes))
				.catch((e) => { oops(e); safe(() => source.abort()); });
		};
		return source;
	}

	// Ranges are an optimisation, so they are never the reason a page fails to
	// appear: if one does not answer quickly the file is read whole instead.
	async function openDoc(pdf, path, size) {
		const whole = async () => pdf.getDocument({
			data: await readWhole(path), isEvalSupported: false,
		}).promise;
		if (!(size > 256 * 1024) || typeof IOUtils === "undefined") return whole();
		const task = pdf.getDocument({
			range: await rangeSource(pdf, path, size), isEvalSupported: false,
		});
		let timer = null;
		try {
			return await Promise.race([
				task.promise,
				new Promise((_, no) => {
					timer = w.setTimeout(() => no(new Error("ranged read timed out")), 6000);
				}),
			]);
		}
		catch (e) {
			oops(e);
			safe(() => task.destroy());
			return whole();
		}
		finally { if (timer) w.clearTimeout(timer); }
	}

	async function renderPage(att, canvas, width) {
		const path = await att.getFilePathAsync();
		if (!path) throw new Error("the file has not been downloaded");
		const pdf = await loadPDFJS();
		const size = typeof IOUtils !== "undefined"
			&& await IOUtils.stat(path).then((st) => st.size).catch(() => 0);
		const file = await openDoc(pdf, path, size);
		try {
			const page = await file.getPage(1);
			const unit = page.getViewport({ scale: 1 });
			// Fit the card's column, then draw at the screen's own resolution so
			// the type is as sharp as the rest of the card.
			const scale = (width / unit.width) * (w.devicePixelRatio || 1);
			const view = page.getViewport({ scale: Math.max(0.2, Math.min(6, scale)) });
			canvas.width = Math.round(view.width);
			canvas.height = Math.round(view.height);
			await page.render({ canvasContext: canvas.getContext("2d"), viewport: view }).promise;
		}
		finally { safe(() => file.destroy()); }
	}

	function previewNode(att) {
		const box = el(doc, "div", "preview");
		const note = el(doc, "div", "abs empty", "Drawing the first page…");
		const canvas = doc.createElement("canvas");
		box.append(canvas, note);
		const mine = att.id;
		// A page that never arrives should stop saying it is on its way: pdf.js
		// can be waiting on something of its own, and "Drawing…" for ever reads
		// as a plugin that has hung rather than a file that will not open.
		const late = w.setTimeout(() => {
			if (previewAtt === mine && !box.classList.contains("ready")) {
				note.textContent = "This page is taking too long — o opens the file.";
			}
		}, 20000);
		// Not inside safe(): a failure here is what the box is for, and it says
		// so on the card rather than only in the error console.
		renderPage(att, canvas, Math.max(320, cardBox.clientWidth - 60)).then(() => {
			if (previewAtt === mine) box.classList.add("ready");
		}).catch((e) => {
			oops(e);
			note.textContent = "Could not draw the page: " + ((e && e.message) || String(e));
		}).then(() => w.clearTimeout(late));
		return box;
	}

	function draw() {
		if (panel) { panel.remove(); panel = null; }
		cardBox.className = "card " + dir;
		cardBox.replaceChildren();
		cardBox.scrollTop = 0;

		// One screen either way: the deck ran out, or you stopped. The figures,
		// the feeds still waiting and the way out are the same — what differs is
		// only that a summary can be switched off where it interrupted you.
		if (ending || cursor >= ids.length) return endScreen(ending);

		nextFeeds = [];
		nextDrop = null;

		const item = current();
		if (!item) { // hydration hasn't caught up; it will, then re-render
			cardBox.append(el(doc, "div", "done", "Loading…"));
			const at = cursor;
			hydrate(at).then(() => {
				if (!win || win.closed || cursor !== at) return;
				// Still missing after a fetch means the id is gone — Zotero's feed
				// cleanup can reap an item while the window sits open. Skip it,
				// rather than asking for it again forever.
				if (!current()) return advance();
				render();
			}).catch(oops);
			return;
		}

		feedName.title = isFeedMode() ? "Switch feed" : "Switch collection";
		const collName = safe(() => Zotero.Collections.get(scopeColl).name, "");
		feedName.textContent = isFeedMode()
			? safe(() => Zotero.Libraries.get(item.libraryID).name, "")
			: collName + (deep ? " + subcollections" : "");
		count.textContent = `${cursor + 1} / ${total}`;

		// hyphens:auto does nothing without a language to hyphenate by. Feeds
		// write this field freely ("en-US", "English", ""), so take a BCP-47
		// looking prefix if there is one and fall back to English.
		const tag = (item.getField("language") || "").trim()
			.match(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?/);
		doc.documentElement.lang = tag ? tag[0] : "en";

		const title = item.getField("title");
		cardBox.append(title
			? mathEl(doc, "h1", null, title)
			: el(doc, "h1", null, "(untitled)"));

		const { kind, body } = splitAbstract(item.getField("abstractNote"));
		const meta = el(doc, "div", "meta");
		const who = authorLine(safe(() => item.getCreators(), []));
		if (who) meta.append(el(doc, "span", "who", who));
		const when = shortDate(item.getField("date"));
		if (when) meta.append(el(doc, "span", "when", when));
		if (kind && isFeedMode()) meta.append(el(doc, "span", "badge " + kind, kind));
		// Matched on DOI or arXiv id, so a v2 announcement finds the v1 you
		// already saved. Worth knowing before you decide what to do with it.
		if (isFeedMode() && libraryCopy(item)) {
			const have = el(doc, "span", "badge have", "in library");
			have.title = "Filing this adds the copy you already have to the collection";
			meta.append(have);
		}
		if (meta.childNodes.length) cardBox.append(meta);

		// The item's own tags: what the feed put there, or what you just did with
		// t. Nothing inferred from the title, the collection or anything else.
		const feedTags = orderTags(item.libraryID,
			safe(() => item.getTags(), []).map((t) => t.tag).filter(Boolean));
		if (feedTags.length) {
			const row = el(doc, "div", "tags");
			for (const t of feedTags) {
				const chip = el(doc, "span", "tag", t);
				const c = tagColor(item.libraryID, t);
				paintTag(chip, c && c.color);
				row.append(chip);
			}
			cardBox.append(row);
		}

		// The page of the file instead of the description: always when there is
		// no description to show, and on p when there is.
		// P says which of the two a card opens on; p is the other one, for the
		// card you are looking at. With no description there is nothing to
		// choose between.
		const att = attachmentFor(item, render);
		const wantPage = previewAll ? !previewing : previewing;
		previewAtt = (att && (wantPage || !body)) ? att.id : 0;
		if (previewAtt) cardBox.append(previewNode(att));
		else if (body) cardBox.append(abstractNode(doc, body, item.getField("url")));
		else if (att === undefined) cardBox.append(el(doc, "div", "abs empty", "Looking for a file…"));
		else cardBox.append(el(doc, "div", "abs empty", "No abstract."));

		// Said plainly, because nothing else on the card would give it away: the
		// text simply stops, reading like a short abstract rather than a lost one.
		if (importerCut(item.getField("abstractNote"))) {
			cardBox.append(el(doc, "div", "warn",
				"Zotero's feed importer read a \u201c<\u201d in this abstract as the start of "
				+ "an HTML tag and dropped what followed, so it breaks off early. "
				+ "The whole thing is at the link below \u2014 o opens it."));
		}

		if (katexError) {
			cardBox.append(el(doc, "div", "warn",
				"Formulas are shown as LaTeX source — KaTeX did not load: " + katexError));
		}

		const url = item.getField("url");
		if (url) {
			const a = el(doc, "a", "url", url);
			a.href = url;
			cardBox.append(a);
		}

		cardHints();
		paintFade();
		hydrate(cursor).catch(oops);
	}

	// --- moving through the deck ------------------------------------------

	// entry: "" when a card is flying off, since the next one is simply revealed
	// underneath. Skip and undo have no ghost, so they get a slide of their own.
	const advance = (entry) => {
		dir = entry === undefined ? "from-right" : entry;
		previewing = false;
		cursor++;
		render();
	};

	// The deck turns in the same frame the ghost starts moving, not when the
	// write lands. Waiting made the two directions look different: filing does
	// more database work than discarding, so its ghost slid clear of a card
	// that was still the one it had just taken away, and the swap came after.
	// Now the ghost always uncovers the next card, whichever way you sent it.
	const step = (way) => { flick(way); advance(""); };
	// Nothing is lost when a write fails — the feed item stays unread — but the
	// card you were on has already left, so put it back.
	const stepBack = (e, what) => {
		oops(e);
		// The card is coming back, so it is not on the tally either.
		const kind = what === "Discard" ? "dropped" : "kept";
		stat[kind] = Math.max(0, stat[kind] - 1);
		flash(what + " failed — see the error console");
		dir = "from-left";
		cursor = Math.max(0, cursor - 1);
		render();
	};

	// Riffling a collection is reading, not deciding: the arrows only move.
	const prev = () => {
		if (busy || cursor <= 0) return;
		statTick();
		dir = "from-left";
		previewing = false;
		cursor--;
		render();
	};
	const next = () => {
		if (busy || cursor >= ids.length) return;
		statTick();
		advance();
	};

	// The file's first page, for the card you are on. It goes back to the
	// description when you move on: a reader for every card would be the thing
	// that made riffling feel slow.
	const doPreview = () => {
		const item = current();
		if (!item || busy) return;
		const att = attachmentFor(item, render);
		if (att === undefined) return flash("Still looking for a file…");
		if (!att) return flash("No PDF on this item");
		previewing = !previewing;
		render();
	};

	// What is filed below this collection, in the deck or not. Zotero's own
	// setting decides to begin with; this is the same switch, for this window.
	const doDeep = () => {
		if (busy) return;
		deep = !deep;
		flash(deep ? "With subcollections" : "This collection only");
		reload().catch(oops);
	};

	// The same, for every card from here on.
	const doPreviewAll = () => {
		previewAll = !previewAll;
		previewing = false;
		flash(previewAll ? "Pages" : "Descriptions");
		render();
	};

	// Zotero's trash, so nothing is destroyed and undo puts it back in place.
	const doTrash = () => {
		const item = current();
		if (!item || busy) return;
		const at = cursor;
		stat.dropped++;
		statTick();
		flick("left");
		ids.splice(at, 1);
		cache.delete(item.id);
		render();
		guard(trashItem(item).then((back) => {
			undoStack.push({
				id: item.id,
				at,
				revert: async () => { await back(); ids.splice(at, 0, item.id); },
			});
			flash("Trashed");
		})).catch((e) => {
			oops(e);
			flash("Trash failed — see the error console");
			ids.splice(at, 0, item.id);
			cursor = at;
			render();
		});
	};

	const doDiscard = () => {
		const item = current();
		if (!item || busy) return;
		stat.dropped++;
		statTick();
		step("left");
		guard(discard(item)).catch((e) => stepBack(e, "Discard"));
	};

	// Most items go to a handful of places, so the handful get a number each.
	// The panel is still there for everything else.
	const fileRecent = (n) => {
		const item = current();
		if (!item || busy || !isFeedMode()) return;
		const id = recentIDs()[n - 1];
		if (!id) return flash("No recent collection " + n);
		const path = (colls.find((c) => c.id === id) || {}).path;
		if (!path) return flash("That collection is gone");
		stat.kept++;
		statTick();
		step("right");
		guard(keep(item, id, [], "").then(() => flash("→ " + path)))
			.catch((e) => stepBack(e, "Save"));
	};

	// The third outcome. Deciding on every single card is what turns a backlog
	// into a wall; this leaves the item unread so it comes back another day.
	const doSkip = () => {
		const item = current();
		if (!item || busy || !isFeedMode()) return;
		// Nothing to undo about a skip, but it still takes a place on the stack:
		// without one, u would un-read an older item while stepping back to this
		// card. toggleRead(false) on an item that was never read is a no-op.
		undoStack.push({ id: item.id, skip: true });
		skipped++;
		stat.skipped++;
		statTick();
		advance();
	};

	// Esc stops riffling: the summary first, and Esc again to be gone. With the
	// summary turned off, or nothing done to summarise, it just closes.
	const stop = () => {
		if (ending || cursor >= ids.length || !summaryOn()
			|| !(stat.kept + stat.dropped + stat.skipped)) return w.close();
		ending = true;
		render();
	};

	const doUndo = () => {
		if (busy) return;
		guard(undo().then((was) => {
			if (!was) return flash("Nothing to undo");
			// Take it off the tally as well: an undone card was never read.
			const kind = was.skip ? "skipped" : was.revert ? "kept" : "dropped";
			stat[kind] = Math.max(0, stat[kind] - 1);
			if (was.skip) skipped = Math.max(0, skipped - 1);
			// A card taken out of the deck goes back where it was.
			if (was.at !== undefined) {
				dir = "from-left";
				cursor = was.at;
				render();
				return flash("Undone");
			}
			dir = "from-left";
			// The undone item is the one before the cursor, unless we already
			// ran off the end — then it is the last card.
			cursor = Math.max(0, Math.min(cursor, ids.length) - 1);
			render();
			flash("Undone");
		})).catch(oops);
	};

	// Font size. Steps are multiplicative so each press feels the same size at
	// either end of the range, and the result is shown as a percentage because
	// "115%" means something to a reader where "16.8px" does not.
	const setScale = (v) => {
		const next = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(v * 100) / 100));
		if (next === fontScale) return;
		fontScale = next;
		safe(() => Zotero.Prefs.set(SIZE_PREF, String(fontScale)));
		applyFontSize(w);
		flash(Math.round(fontScale * 100) + "%");
	};

	// Carry on into whichever feed is selected on the done screen.
	const goNext = () => {
		const r = nextFeeds[nextSel];
		if (!r) return;
		nextFeeds = [];
		nextDrop = null;
		scopeLib = r.id;
		reload().catch(oops);
	};

	// The item itself when there is one to open — Zotero's own reader, on the
	// attachment it would open from the items list — and the link only when
	// there is no file. A feed card never has one, so it always takes the link.
	const openURL = () => {
		const item = current();
		if (!item) return;
		const url = item.getField("url");
		const link = () => { if (url) safe(() => Zotero.launchURL(url)); };
		if (safe(() => item.isFeedItem, false)) return link();
		guard(item.getBestAttachment().then((att) => {
			if (!att) return link();
			const pane = safe(() => Zotero.getMainWindow().ZoteroPane, null);
			if (pane) return pane.viewAttachment(att.id);
			link();
		})).catch((e) => { oops(e); link(); });
	};

	// --- the filing panel --------------------------------------------------

	// Filing a feed card: pick a collection, tags and a note, then keep it.
	const fileJob = {
		label: "File to",
		pick: true,
		start: 0,
		run: (item, c, tags, note, dropOld) => {
			stat.kept++;
			statTick();
			step("right");
			guard(keep(item, c.id, tags, note, dropOld)
				.then((dropped) =>
					flash("→ " + c.path + (dropped ? " (old one trashed)" : ""))))
				.catch((e) => stepBack(e, "Save"));
		},
	};

	// The same rows over a collection: what is on the card stays where it is
	// unless you name somewhere else for it to go.
	// One panel, one purpose: tags, a note, or a move. Each shows its own row
	// and nothing else — a note box with a tag box sitting on top of it was
	// only ever the feed's tab-through-everything flow.
	const manageJob = (kind, item, notes) => ({
		label: "Move to",
		pick: kind === "move",
		only: true,
		start: kind === "tags" ? 1 : kind === "note" ? 2 : 0,
		notes: notes || [],
		// The tags it already has, so the panel is what the item looks like
		// rather than a list of additions.
		tags: kind === "tags"
			? orderTags(item.libraryID, safe(() => item.getTags(), []).map((t) => t.tag))
			: [],
		run: (card, c, tags, note) => {
			const at = cursor;
			guard((async () => {
				const undos = [];
				if (kind === "tags") undos.push(await retag(card, tags));
				if (note) undos.push(await addNote(card, note));
				if (c) undos.push(await moveTo(card, scopeColl, c.id));
				const back = undos.filter(Boolean);
				if (!back.length) return;
				stat.kept++;
				statTick();
				undoStack.push({
					id: card.id,
					at: c ? at : undefined,
					revert: async () => { for (const undo of back.reverse()) await undo(); },
				});
				flash(c ? "→ " + c.path : kind === "note" ? "Note added" : "Tags saved");
				// A moved card has left this collection, so the deck closes over
				// it; anything else redraws the card you are still on, which is
				// how a tag you just took off disappears from it.
				if (c) { ids.splice(at, 1); cache.delete(card.id); }
				render();
			})()).catch((e) => { oops(e); flash("Failed — see the error console"); });
		},
	});

	// Reading the notes is a database trip, so the panel opens after it rather
	// than filling in behind your back. Failing to read them is not a reason to
	// refuse the panel: writing a new one still works.
	function openNotes() {
		const item = current();
		if (!item || panel || busy) return;
		itemNotes(item)
			.catch((e) => { oops(e); return []; })
			.then((notes) => { if (!panel) openPanel(manageJob("note", item, notes)); });
	}

	function openPanel(job) {
		const item = current();
		if (!item || panel || busy) return;
		const work = isFeedMode() ? null : (job || manageJob("move", item));
		// Only a job that files somewhere needs somewhere to file to.
		if ((!work || work.pick) && !colls.length) {
			return flash("No collections to file into");
		}
		if (work) return filer(item, null, false, work);
		const copy = libraryCopy(item);
		// Filing a paper you already have leaves you with two records, and only
		// you know whether the old one is worth anything. A hidden toggle would
		// never be found, so it is a question you answer before the picker opens.
		if (copy) return askOld(item, copy);
		filer(item, null, false, fileJob);
	}

	// "You already have this. What happens to the copy you have?"
	function askOld(item, copy) {
		panel = el(doc, "div", "file ask");
		panel.tabIndex = -1; // so the keys land here and not on the card
		doc.body.insertBefore(panel, bar);
		const held = heldPhrase(copy.notes, copy.annots);
		panel.append(el(doc, "div", "dupe",
			"Already in your library. The copy you have holds " + held
			+ ", and filing this announcement makes a second item."));

		const choices = [
			{ label: "Keep both — file the new version alongside", drop: false },
			{ label: "Trash the old one — it holds " + held, drop: true },
		];
		let sel = 0;
		const drop = el(doc, "div", "drop");
		const paint = () => {
			drop.replaceChildren();
			choices.forEach((c, i) => {
				const row = el(doc, "div", i === sel ? "on" : null);
				row.append(el(doc, "span", null, c.label));
				row.addEventListener("mousedown", (e) => {
					e.preventDefault();
					sel = i;
					choose();
				});
				drop.append(row);
			});
		};
		const choose = () => {
			const c = choices[sel];
			panel.remove();
			panel = null;
			filer(item, copy, c.drop, fileJob);
		};
		const back = () => {
			panel.remove();
			panel = null;
			cardHints();
			w.focus();
		};
		const move = (d) => {
			sel = (sel + d + choices.length) % choices.length;
			paint();
		};
		panel.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") { e.preventDefault(); return back(); }
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				return move(e.key === "ArrowDown" ? 1 : -1);
			}
			if (e.key === "Enter") { e.preventDefault(); return choose(); }
		});
		panel.append(drop);
		paint();
		panel.focus();
		hint([["↑↓", "pick", () => move(1)], ["⏎", "choose", choose], ["Esc", "back", back]]);
	}

	// Built once per right-arrow and thrown away on Escape or save. Three rows,
	// revealed one Tab at a time: collection, then tags, then a note. Enter
	// files the item from wherever you are.
	// job: what the panel is for. `label` names the first row, `pick` says
	// whether a collection is part of the job at all, `start` is the row it
	// opens on, and `run` is what Enter finally does. Feed and collection decks
	// hand it different jobs and share every row.
	function filer(item, copy, dropOld, job) {
		panel = el(doc, "div", "file");
		doc.body.insertBefore(panel, bar);

		const already = copy ? copy.colls : new Set();
		// A reminder of what you just chose, where you can still change your
		// mind with Escape.
		const dupeLine = copy ? el(doc, "div", "dupe", dropOld
			? "The old item (" + heldPhrase(copy.notes, copy.annots)
				+ ") goes to the trash when this is filed."
			: "Keeping the old item (" + heldPhrase(copy.notes, copy.annots)
				+ ") — this files a second one.") : null;

		// Last collection first, so Enter alone repeats the previous filing.
		// Recents first, most recent first — so Enter still repeats the last
		// filing, and the rows the number keys reach are the rows on top.
		// Where the copy already sits comes first of all: that is the shelf it
		// belongs on, and seeing it saves you filing it somewhere it is already.
		const recent = recentIDs();
		const place = (c) => {
			if (already.has(c.id)) return -1;
			const i = recent.indexOf(c.id);
			return i < 0 ? recent.length : i;
		};
		const ordered = colls.slice().sort((a, b) => place(a) - place(b));

		const tags = (job.tags || []).slice();
		// Two different things, and conflating them was a trap: reach is how far
		// the rows have been revealed, stage is which one has the focus. Click
		// back into the collection box after tabbing on to tags and the stage
		// follows you there — its dropdown used to stay shut, with no way left
		// to reopen it — while the tag row you already opened stays put.
		let stage = 0; // 0 collection, 1 tags, 2 note
		let reach = 0;

		// -- collection row
		const cRow = el(doc, "div", "row");
		cRow.append(el(doc, "label", null, job.label));
		if (!job.pick) cRow.style.display = "none";
		const cIn = doc.createElement("input");
		cIn.type = "text";
		cIn.placeholder = "Fuzzy search collections…";
		const cDrop = el(doc, "div", "drop");
		cRow.append(cIn, cDrop);
		panel.append(cRow);
		// Under the input, not over it: the dropdown opens upward and would
		// cover anything above the row.
		if (dupeLine) panel.append(dupeLine);

		let shown = [];
		let sel = 0;

		const paintDrop = () => {
			cDrop.replaceChildren();
			if (!shown.length) {
				cDrop.append(el(doc, "div", "none", "No matching collection"));
				return;
			}
			const numbered = !cIn.value.trim();
			shown.forEach((c, i) => {
				const row = el(doc, "div", i === sel ? "on" : null);
				row.append(el(doc, "span", null, c.path));
				if (already.has(c.id)) row.append(el(doc, "b", null, "already in"));
				// By recent position, not row position: the copy's own
				// collections are hoisted above them.
				const n = numbered ? recent.indexOf(c.id) : -1;
				if (n >= 0) row.append(el(doc, "b", null, String(n + 1)));
				row.addEventListener("mousedown", (e) => {
					e.preventDefault();
					sel = i;
					commit();
				});
				cDrop.append(row);
			});
			const on = cDrop.querySelector(".on");
			if (on) on.scrollIntoView({ block: "nearest" });
		};

		const filter = () => {
			shown = rank(cIn.value, ordered, (c) => c.path);
			sel = 0;
			paintDrop();
		};

		const chosen = () => shown[sel] || null;

		// Tabbing on is accepting the row you are on: the box then reads the
		// collection you picked rather than the letters you typed at it.
		const takeCollection = () => {
			const c = chosen();
			if (!c) return;
			cIn.value = c.path;
			shown = [c];
			sel = 0;
			paintDrop();
		};

		// -- tags row (revealed on the first Tab)
		const tRow = el(doc, "div", "row");
		tRow.style.display = "none";
		tRow.append(el(doc, "label", null, "Tags"));
		// The chips and the box you type in are one field, so they wrap
		// together: as its own flex item the box kept whatever sliver was left
		// at the end of the last chip, which on a well-tagged paper was a
		// letter wide.
		const field = el(doc, "div", "field");
		const tIn = doc.createElement("input");
		tIn.type = "text";
		tIn.placeholder = "tag, another tag…";
		const tDrop = el(doc, "div", "drop");
		field.append(tIn);
		tRow.append(field, tDrop);
		panel.append(tRow);

		let tShown = [];
		let tSel = 0;
		// Which chip is under the cursor: -1 is the box you type in, and any
		// other value is a tag picked out for removal. Backspace on an empty box
		// takes aim at the one nearest the caret before it removes it — a key
		// held a moment too long costs you a look rather than a tag — and the
		// arrows walk from there to any other tag on the item.
		let armed = -1;

		const paintChips = () => {
			for (const old of [...field.querySelectorAll(".chip")]) old.remove();
			tags.forEach((name, i) => {
				const chip = el(doc, "span", armed === i ? "chip on" : "chip", name);
				// Not on the armed one: that is wearing the highlight that says
				// Backspace will take it off.
				if (armed !== i) {
					const c = tagColor(item.libraryID, name);
					paintTag(chip, c && c.color);
				}
				// Clicking the tag itself picks it out, the way the arrows do.
				chip.addEventListener("mousedown", (e) => {
					e.preventDefault();
					armed = armed === i ? -1 : i;
					paintChips();
					panelHints();
					tIn.focus();
				});
				const x = el(doc, "button", null, "×");
				x.title = "Remove";
				x.addEventListener("mousedown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					tags.splice(i, 1);
					armed = -1;
					paintChips();
					panelHints();
					tIn.focus();
				});
				chip.append(x);
				// Before the box, so the caret stays at the end of the line the
				// way it does in every other tag field.
				field.insertBefore(chip, tIn);
			});
		};

		const paintTagDrop = () => {
			tDrop.replaceChildren();
			const { partial } = splitTags(tIn.value);
			if (!partial) { tDrop.style.display = "none"; return; }
			tShown = rank(partial, allTags.filter((t) => !tags.includes(t)));
			if (!tShown.length) { tDrop.style.display = "none"; return; }
			tDrop.style.display = "";
			tShown.forEach((name, i) => {
				const row = el(doc, "div", i === tSel ? "on" : null, name);
				const c = i === tSel ? null : tagColor(item.libraryID, name);
				if (c && c.color) row.style.color = c.color;
				row.addEventListener("mousedown", (e) => {
					e.preventDefault();
					tSel = i;
					takeTag();
				});
				tDrop.append(row);
			});
			const on = tDrop.querySelector(".on");
			if (on) on.scrollIntoView({ block: "nearest" });
		};

		// Move whatever is typed (or highlighted in the dropdown) into a chip.
		const rubOut = () => {
			if (!tags.length) return;
			if (armed < 0) armed = tags.length - 1;
			else {
				tags.splice(armed, 1);
				// Stay where the removed one was, so a second press carries on
				// through the row rather than starting again from the end.
				armed = Math.min(armed, tags.length - 1);
			}
			paintChips();
			panelHints();
		};

		// Left walks back along the tags, right walks towards the box you type
		// in and stops there — where a bare arrow means the caret again.
		const walkTags = (d) => {
			if (!tags.length) return;
			if (armed < 0) { if (d < 0) armed = tags.length - 1; }
			else if (d < 0) armed = Math.max(0, armed - 1);
			else armed = armed + 1 > tags.length - 1 ? -1 : armed + 1;
			paintChips();
			panelHints();
		};

		// Enter takes the highlighted suggestion; Shift+Enter (literal) takes the
		// words as they stand, which is how you make a tag that merely looks
		// like one you already have.
		const takeTag = (literal) => {
			const { done, partial } = splitTags(tIn.value);
			for (const t of done) if (!tags.includes(t)) tags.push(t);
			const pick = (!literal && tShown[tSel]) || partial;
			if (pick && !tags.includes(pick)) tags.push(pick);
			tIn.value = "";
			tSel = 0;
			armed = -1;
			paintChips();
			paintTagDrop();
		};

		// -- note row (revealed on the second Tab)
		//
		// What the item already has, read-only, one at a time — there are rarely
		// enough for a list to earn its space, and the arrows walk them. Past the
		// last one is the empty box: writing a note is somewhere you go, not
		// where the panel drops you.
		const notes = job.notes || [];
		let nSel = Math.max(0, notes.length - 1);   // the last one, or the box
		const nRow = el(doc, "div", "row");
		nRow.style.display = "none";
		nRow.append(el(doc, "label", null, "Note"));
		const nWrap = el(doc, "div", "notes");
		const nHead = el(doc, "div", "notehead");
		// Focusable so the panel's own keys keep working while you read: this is
		// where the arrows land when nothing is being typed into.
		const nBody = el(doc, "div", "notebody");
		nBody.tabIndex = -1;
		const nIn = doc.createElement("textarea");
		nIn.rows = 2;
		nIn.placeholder = "Why this one…";
		nWrap.append(nHead, nBody, nIn);
		nRow.append(nWrap);
		panel.append(nRow);
		panel.addEventListener("click", openLinks);

		const onNote = () => notes[nSel] || null;

		const paintNotes = () => {
			const on = onNote();
			nHead.style.display = notes.length ? "" : "none";
			nBody.style.display = on ? "" : "none";
			nIn.style.display = on ? "none" : "";
			if (on) {
				const when = safe(() => Zotero.Date.sqlToDate(on.dateModified, true)
					.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), "");
				nHead.textContent = `${nSel + 1} of ${notes.length}${when ? " · " + when : ""}`;
				// The same sanitizer the cards use. It drops images, which in a
				// note are usually pasted figures — this is a place to find the
				// note again, not a second note editor.
				const frag = sanitizedFragment(doc, safe(() => on.getNote(), "") || "");
				nBody.replaceChildren(frag || doc.createTextNode(""));
				nBody.scrollTop = 0;
			}
			else if (notes.length) nHead.textContent = "New note";
		};

		// Down off the last note is the box; up out of the box is the last note,
		// but only from the very start of it — anywhere else the arrows are
		// editing the text you are typing.
		const walkNotes = (d) => {
			const next = Math.max(0, Math.min(notes.length, nSel + d));
			if (next === nSel) return;
			nSel = next;
			paintNotes();
			(onNote() ? nBody : nIn).focus();
			panelHints();
		};

		// Escape means "back one row", and only closes from the first one — same
		// as the key does. It puts the row away, rather than only leaving it.
		const back = () => {
			if (stage === 0 || (!job.pick && stage === job.start)) return closePanel();
			reach = stage - 1;
			setStage(stage - 1);
		};
		const pick = () => {
			if (!shown.length) return;
			sel = (sel + 1) % shown.length;
			paintDrop();
		};
		const done = job.only ? "save" : "file";
		const panelHints = () => {
			if (stage === 0) {
				hint([["⏎", job.only ? "move here" : "file here", () => commit()]]
					.concat(job.only
						? [] : [["⇥", "add tags", () => { takeCollection(); setStage(1); }]])
					.concat([["↑↓", "pick", pick], ["Esc", "back", back]]));
			} else if (stage === 1) {
				const typed = !!tIn.value.trim();
				hint([["⏎", typed ? "add tag" : done,
					() => (typed ? takeTag() : commit())]]
					.concat(typed ? [["⇧⏎", "as new tag", () => takeTag(true)]] : [])
					.concat(!typed && tags.length
						? [["⌫", armed >= 0 ? "remove it" : "last tag", rubOut],
							["←/→", "pick tag", [() => walkTags(-1), () => walkTags(1)]]] : [])
					// ⇥ finishes the tag just as ⏎ does; it only earns a place in
					// the bar once the box is empty and it means something else.
					.concat(typed || job.only ? [] : [["⇥", "add note", () => setStage(2)]])
					.concat(job.only ? [] : [["⇧⇥", "back", () => setStage(0)]])
					.concat([["Esc", "cancel", back]]));
			} else if (onNote()) {
				hint([["↑↓", "browse", () => walkNotes(1)],
					["⏎", "new note", () => walkNotes(notes.length - nSel)],
					["Esc", "back", back]]);
			} else {
				// Nothing to click about a modifier: ⇧⏎ describes the key alone.
				hint([["⏎", done, () => commit()], ["⇧⏎", "newline"]]
					.concat(notes.length ? [["↑", "notes", () => walkNotes(-1)]] : [])
					.concat(job.only ? [] : [["⇧⇥", "back", () => setStage(1)]])
					.concat([["Esc", "cancel", back]]));
			}
		};

		const setStage = (s) => {
			stage = Math.max(0, Math.min(2, s));
			reach = Math.max(reach, stage);
			armed = -1;
			// A job with one purpose shows one row: a note box does not want a
			// tag box sitting on top of it.
			tRow.style.display = (job.only ? stage === 1 : reach >= 1) ? "" : "none";
			nRow.style.display = (job.only ? stage === 2 : reach >= 2) ? "" : "none";
			cDrop.style.display = stage === 0 ? "" : "none";
			(stage === 0 ? cIn : stage === 1 ? tIn : onNote() ? nBody : nIn).focus();
			panelHints();
		};
		// Clicking straight into a box is the same as tabbing to it.
		[cIn, tIn, nIn].forEach((box, i) =>
			box.addEventListener("focus", () => {
				if (stage !== i) setStage(i);
				// Tab accepted a whole path into this box; typing over it should
				// search afresh rather than append to something that matches
				// nothing.
				if (box === cIn) cIn.select();
			}));

		const closePanel = () => {
			if (!panel) return;
			panel.remove();
			panel = null;
			cardHints();
			w.focus();
		};

		function commit() {
			const c = job.pick ? chosen() : null;
			if (job.pick && !c) return flash("Pick a collection first");
			const rest = splitTags(tIn.value);
			const finalTags = tags.concat(rest.done, rest.partial ? [rest.partial] : [])
				.filter((t, i, a) => t && a.indexOf(t) === i);
			const note = nIn.value.trim();
			closePanel();
			job.run(item, c, finalTags, note, dropOld);
		}

		// Keys inside the panel never reach the card handler: stopPropagation on
		// everything the panel handles, and plain typing has to stay plain.
		const panelKeys = (e) => {
			if (e.key === "Escape") {
				e.preventDefault(); e.stopPropagation();
				return back();
			}
			if (e.key === "Tab") {
				e.preventDefault(); e.stopPropagation();
				// A single-purpose panel has nowhere to tab to, but Tab still
				// finishes the tag you are part-way through typing.
				if (job.only) {
					if (stage === 1 && tIn.value.trim()) takeTag();
					return;
				}
				if (e.shiftKey) return setStage(stage - 1);
				// Tab takes the row you are on with you: the highlighted
				// collection, or the tag you are part-way through typing. Only an
				// empty tag box means you are done here and want the note.
				if (stage === 0) takeCollection();
				if (stage === 1 && tIn.value.trim()) return takeTag();
				return setStage(stage + 1);
			}
			// Only with the box empty: with anything in it, these are editing.
			if (stage === 1 && !tIn.value && tags.length) {
				if (e.key === "Backspace" || (e.key === "Delete" && armed >= 0)) {
					e.preventDefault(); e.stopPropagation();
					return rubOut();
				}
				if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
					e.preventDefault(); e.stopPropagation();
					return walkTags(e.key === "ArrowLeft" ? -1 : 1);
				}
			}
			if (e.key === "Enter") {
				if (stage === 2 && e.shiftKey) return; // newline in the note
				e.preventDefault(); e.stopPropagation();
				// In the tag box a bare Enter finishes a tag — the highlighted
				// suggestion if there is one — and Shift+Enter takes the words as
				// typed instead. An empty box means you are done tagging.
				if (stage === 1 && tIn.value.trim()) return takeTag(e.shiftKey);
				// Reading a note, not writing one: Enter is the way to the box.
				if (onNote()) return walkNotes(notes.length - nSel);
				return commit();
			}
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				const d = e.key === "ArrowDown" ? 1 : -1;
				if (stage === 0) {
					e.preventDefault(); e.stopPropagation();
					if (!shown.length) return;
					sel = (sel + d + shown.length) % shown.length;
					return paintDrop();
				}
				if (stage === 1 && tShown.length) {
					e.preventDefault(); e.stopPropagation();
					tSel = (tSel + d + tShown.length) % tShown.length;
					return paintTagDrop();
				}
				if (stage === 2 && notes.length
					&& (onNote() || (d < 0 && !nIn.selectionStart && !nIn.selectionEnd))) {
					e.preventDefault(); e.stopPropagation();
					return walkNotes(d);
				}
				return; // note box: let the caret move
			}
			// Any other key means you have moved on from that chip.
			if (armed >= 0) { armed = -1; paintChips(); panelHints(); }
			e.stopPropagation(); // ordinary typing stays in the box
		};

		panel.addEventListener("keydown", panelKeys);
		cIn.addEventListener("input", filter);
		// panelHints too: at this row the hint names what Enter will do with what
		// is in the box, and that changes with every keystroke.
		tIn.addEventListener("input", () => {
			tSel = 0;
			armed = -1;
			paintChips();
			paintTagDrop();
			panelHints();
		});

		filter();
		paintChips();
		paintTagDrop();
		paintNotes();
		setStage(job.start);
	}

	// --- card-level keys ---------------------------------------------------

	// build() runs again on reload, so without this the document collects a
	// handler per build and every copy fires — one arrow press would discard
	// two items. Kept on the window rather than in this scope: after a
	// reinstall the new sandbox still has to be able to unhook the old one.
	safe(() => { if (w._riffleKey) doc.removeEventListener("keydown", w._riffleKey); });
	const keyHandler = (e) => {
		if (panel || menu) return; // the panel or feed picker handled it
		if (e.metaKey || e.ctrlKey) {
			if (e.key === "z") { e.preventDefault(); doUndo(); }
			// The shortcut every reader tries first.
			else if (e.key === "+" || e.key === "=") { e.preventDefault(); setScale(fontScale + SIZE_STEP); }
			else if (e.key === "-") { e.preventDefault(); setScale(fontScale - SIZE_STEP); }
			else if (e.key === "0") { e.preventDefault(); setScale(1); }
			return;
		}
		// Stopped by mistake: an arrow puts you back on the card you were on,
		// rather than acting on it sight unseen.
		if (ending && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			e.preventDefault();
			ending = false;
			return render();
		}
		// A collection deck acts on different keys: the arrows only move through
		// it, and everything that changes an item says so by name.
		if (!isFeedMode()) {
			switch (e.key) {
				case "ArrowLeft": e.preventDefault(); return prev();
				case "ArrowRight": e.preventDefault(); return next();
				case "m": e.preventDefault(); return openPanel(manageJob("move", current()));
				case "t": e.preventDefault(); return openPanel(manageJob("tags", current()));
				case "n": e.preventDefault(); return openNotes();
				case "x": e.preventDefault(); return doTrash();
				case "p": e.preventDefault(); return doPreview();
				case "P": e.preventDefault(); return doPreviewAll();
				case "s": e.preventDefault(); return doDeep();
				default: break;
			}
		}
		switch (e.key) {
			case "ArrowLeft": e.preventDefault(); doDiscard(); break;
			case "ArrowRight": e.preventDefault(); openPanel(); break;
			case "s": e.preventDefault(); doSkip(); break;
			case "u": e.preventDefault(); doUndo(); break;
			case "+": case "=": e.preventDefault(); setScale(fontScale + SIZE_STEP); break;
			case "-": case "_": e.preventDefault(); setScale(fontScale - SIZE_STEP); break;
			case "0": e.preventDefault(); setScale(1); break;
			case "o": e.preventDefault(); openURL(); break;
			case "f": e.preventDefault(); openFeeds(); break;
			case "r": if (cursor >= ids.length) { e.preventDefault(); reload().catch(oops); } break;
			case "Escape": e.preventDefault(); (ending ? w.close() : stop()); break;
			case "Enter":
				if (nextFeeds.length) { e.preventDefault(); goNext(); }
				else if (ending || cursor >= ids.length) { e.preventDefault(); w.close(); }
				break;
			case "ArrowDown": case "ArrowUp": {
				e.preventDefault();
				const d = e.key === "ArrowDown" ? 1 : -1;
				if (nextFeeds.length) {
					nextSel = (nextSel + d + nextFeeds.length) % nextFeeds.length;
					paintNext();
				}
				else cardBox.scrollBy({ top: 60 * d });
				break;
			}
			case " ":
				e.preventDefault();
				cardBox.scrollBy({ top: cardBox.clientHeight * (e.shiftKey ? -0.85 : 0.85) });
				break;
			default:
				if (e.key >= "1" && e.key <= "9") {
					e.preventDefault();
					fileRecent(Number(e.key));
				}
				break;
		}
	};
	w._riffleKey = keyHandler;
	doc.addEventListener("keydown", keyHandler);

	render();
	w.focus();
}

// --- plugin lifecycle ------------------------------------------------------

// Is the row this menu was opened on a feed? Anything else — a collection, a
// library, the Feeds header — is not something to riffle.
function isFeedRow(ctx) {
	const row = ((ctx && ctx.collectionTreeRows) || [])[0];
	return !!(row && row.isFeed && row.isFeed());
}

// A collection, rather than a feed, a saved search or a library root.
function isCollectionRow(ctx) {
	const row = ((ctx && ctx.collectionTreeRows) || [])[0];
	return !!(row && row.isCollection && row.isCollection());
}

function startup({ id, rootURI: uri }) {
	rootURI = uri;
	closeOrphanWindows(); // left by a previous install of this plugin
	loadState();
	loadScale();
	menuID = Zotero.MenuManager.registerMenu({
		menuID: "feed-riffle",
		pluginID: id,
		target: "main/menubar/tools",
		menus: [{ menuType: "menuitem", l10nID: "feed-riffle-menu", onCommand: () => safe(() => open(null)) }],
	});
	feedMenuID = Zotero.MenuManager.registerMenu({
		menuID: "feed-riffle-feed",
		pluginID: id,
		target: "main/library/collection",
		menus: [{
			menuType: "menuitem",
			l10nID: "feed-riffle-feed-menu",
			// "Riffle this feed" has nothing to say about a collection, so it is
			// only there on a feed. This target is registered without an event,
			// which is what makes Zotero run the hook on every popupshowing
			// rather than once when the item is built.
			onShowing: (ev, ctx) => safe(() => ctx.setVisible(isFeedRow(ctx))),
			// The row you right-clicked arrives in the menu's context.
			onCommand: (ev, ctx) => safe(() => {
				open(isFeedRow(ctx) ? ctx.collectionTreeRows[0].ref.libraryID : null);
			}),
		}, {
			menuType: "menuitem",
			l10nID: "feed-riffle-collection-menu",
			onShowing: (ev, ctx) => safe(() => ctx.setVisible(isCollectionRow(ctx))),
			onCommand: (ev, ctx) => safe(() => {
				if (isCollectionRow(ctx)) openCollection(ctx.collectionTreeRows[0].ref.id);
			}),
		}],
	});
	for (const w of Zotero.getMainWindows()) onMainWindowLoad({ window: w });
}

function onMainWindowLoad({ window }) {
	safe(() => window.MozXULElement.insertFTLIfNeeded("feed-riffle.ftl"));
}

function onMainWindowUnload() {}

function shutdown() {
	if (menuID) safe(() => Zotero.MenuManager.unregisterMenu(menuID));
	if (feedMenuID) safe(() => Zotero.MenuManager.unregisterMenu(feedMenuID));
	menuID = feedMenuID = null;
	if (win && !win.closed) { safe(() => saveState(win)); safe(() => win.close()); }
	win = null;
	ids = [];
	cache.clear();
	colls = [];
	allTags = [];
	undoStack = [];
}

function install() {}
function uninstall() {}

// node-only: lets test.js import the pure helpers; no-op inside Zotero.
if (typeof module !== "undefined") {
	module.exports = { score, rank, deLatex, splitAbstract, authorLine, shortDate,
		splitTags, splitMath, typography, paragraphs, abstractNode, unparse,
		looksLikeMath, normalizeColor, refKeys, markClassMath, foldLibraryRows,
		heldPhrase, importerCut, imgMath, fmtSpan, summaryLine, deckLine, seenLine,
		noteHTML, bankTime, stat, statReset };
}
