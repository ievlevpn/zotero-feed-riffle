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
const WIN_W = 600;
const WIN_H = 760;
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
let allTags = [];      // every tag name in the library, for the tag picker
let undoStack = [];    // {feedItem, itemID} — itemID null for a plain discard
let scopeLib = null;   // feed libraryID to riffle, or null for every feed
let libKeys = new Set(); // DOI/arXiv keys already in the library, for the badge
const RIFFLE_ATTR = "data-feed-riffle"; // marks our window, across installs
let fontScale = 1;     // multiplier on top of Zotero's font size, persisted

const oops = (e) => Zotero.logError(e);

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

// Every word of the query has to match, but in any order, so "paths rough"
// finds "Rough Paths". Costs add, so the tightest overall match wins.
function score(q, name) {
	let sum = 0;
	for (const w of q.split(/\s+/)) {
		if (!w) continue;
		const s = wordScore(w, name);
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

async function loadKatex() {
	if (katexLib || katexError || !rootURI) return;
	try {
		// Hand the bundle the CommonJS hooks its UMD header checks for first:
		// seeing `module` and `exports` as objects, it assigns to module.exports.
		// That is deterministic. The other branch assigns to `globalThis`, and
		// under loadSubScript the target object is only on the scope chain — the
		// global stays whatever compartment the script was compiled in, so the
		// library would land somewhere we never look.
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
		// The stylesheet is inlined, so its relative font URLs would otherwise
		// resolve against about:blank. Absolute against the plugin root instead.
		katexCSS = css.replace(/url\(fonts\//g, "url(" + rootURI + "fonts/");
		katexLib = lib;
	}
	catch (e) {
		oops(e);
		katexError = (e && e.message) || String(e);
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
		if (frag) { parent.append(frag); return; }
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

function splitMath(text) {
	const s = text || "";
	const out = [];
	let plain = "";
	let i = 0;
	const flush = () => { if (plain) { out.push({ math: false, display: false, text: plain }); plain = ""; } };

	while (i < s.length) {
		const c = s[i];

		if (c === "\\") {
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
		while (j < s.length) {
			if (s[j] === "\\" && j + 1 < s.length) { body += s.slice(j, j + 2); j += 2; continue; }
			if (s[j] === "$") { closed = true; break; }
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
		i = j + (display && s[j + 1] === "$" ? 2 : 1);
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

let geometry = null;

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
	if (was && was.geometry) geometry = was.geometry;
}

function saveState(w) {
	safe(() => {
		if (w && !w.closed && w.outerWidth > 200) {
			geometry = { w: w.outerWidth, h: w.outerHeight, x: w.screenX, y: w.screenY };
		}
		Zotero.Prefs.set(STATE_PREF, JSON.stringify({ geometry }));
	});
}

// A window remembered on one screen can be off every screen on the next launch.
// Always WIN_W by WIN_H, shrunk only if the display is smaller than that.
function defaultSize(main) {
	const screen = safe(() => main.screen, null);
	const availW = (screen && screen.availWidth) || WIN_W;
	const availH = (screen && screen.availHeight) || WIN_H;
	return { w: Math.min(WIN_W, availW - 40), h: Math.min(WIN_H, availH - 60) };
}

function features(main) {
	const g = geometry;
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

// Every DOI and URL already in the library, as keys. A few thousand rows, so it
// is read once and matched in memory rather than queried per card.
async function loadLibraryKeys() {
	const sql = "SELECT v.value FROM itemData d "
		+ "JOIN itemDataValues v ON v.valueID = d.valueID "
		+ "JOIN items i ON i.itemID = d.itemID "
		+ "WHERE d.fieldID IN (SELECT fieldID FROM fields WHERE fieldName IN ('DOI','url')) "
		+ "AND i.libraryID NOT IN (SELECT libraryID FROM feeds) "
		+ "AND i.itemID NOT IN (SELECT itemID FROM deletedItems)";
	const rows = (await Zotero.DB.columnQueryAsync(sql)) || [];
	const set = new Set();
	for (const v of rows) for (const k of refKeys(null, v)) set.add(k);
	return set;
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
	undoStack.push({ id: item.id, itemID: null });
}

// A local clone, not FeedItem#translate(). translate() loads the page in a
// hidden browser and runs translators — seconds per item, and a progress
// popup — which is exactly the clunkiness this plugin exists to avoid. The
// feed entry already carries title, authors, date, abstract, DOI and URL.
// ponytail: no snapshot and no translator-grade metadata. Zotero's own
// "Add to My Library" is still there for the handful that deserve it.
async function keep(feedItem, collectionID, tags, note) {
	const collection = Zotero.Collections.get(collectionID);
	// The picker was built from a snapshot; the collection can be gone by now.
	if (!collection) throw new Error("that collection no longer exists");
	const libraryID = collection.libraryID;
	// Zotero.FeedItem#clone saves immediately and hands back a plain summary
	// object, so go to the base implementation: it returns an unsaved item and
	// lets the tags go on before the first write.
	const item = Zotero.Item.prototype.clone.call(feedItem, libraryID);
	item.addToCollection(collectionID);
	for (const t of tags) item.addTag(t);
	await item.saveTx();

	if (note) {
		const n = new Zotero.Item("note");
		n.libraryID = libraryID;
		n.parentItemID = item.id;
		n.setNote(note.split(/\n/).map((line) =>
			"<p>" + line.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + "</p>"
		).join(""));
		await n.saveTx();
	}

	await feedItem.toggleRead(true);
	Zotero.Prefs.set(LAST_PREF, String(collectionID));
	pushRecent(collectionID);
	undoStack.push({ id: feedItem.id, itemID: item.id });
}

// One key on a keyboard-driven interface is one item gone from view, and at
// riffling speed a mis-hit is a matter of when, not if.
async function undo() {
	const last = undoStack.pop();
	if (!last) return null;
	if (last.itemID) {
		const saved = await Zotero.Items.getAsync(last.itemID);
		if (saved) await saved.eraseTx();
	}
	const feedItem = await Zotero.Items.getAsync(last.id);
	if (feedItem) {
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

/* Whatever tags the feed itself supplied. */
.tags { display:flex; flex-wrap:wrap; gap:.3rem; margin:-.9rem auto 1.45rem; }
.tag { font-size:.72rem; padding:.1em .5em; border-radius:1em; color:GrayText;
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

/* 3. A long description that continues past the fold says so, instead of
 * looking exactly like one that has ended. */
.card.more { mask-image:linear-gradient(to bottom, #000 calc(100% - 2.6rem), transparent); }
@media (prefers-reduced-motion:reduce) {
	.card, .ghost { animation:none !important; }
	.ghost { display:none; }
}

.done { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
	gap:8px; color:GrayText; }
.done .big { font-size:34px; }

.bar { border-top:1px solid color-mix(in srgb, GrayText 35%, Canvas);
	padding:.5rem 1.1rem; display:flex; flex-wrap:wrap; gap:.35rem 1rem;
	font-size:.75rem; color:GrayText; }
.bar kbd { font:.72rem ui-monospace, monospace; padding:.05em .4em; border-radius:4px;
	border:1px solid color-mix(in srgb, GrayText 45%, Canvas);
	background:color-mix(in srgb, GrayText 14%, Canvas); color:CanvasText; }

/* The filing panel replaces the hint bar rather than floating over the card:
 * you keep reading the description while you decide where it goes. */
.file { border-top:1px solid color-mix(in srgb, Highlight 55%, Canvas);
	background:color-mix(in srgb, Highlight 8%, Canvas); padding:.65rem 1.1rem .6rem; }
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

.chips { display:flex; flex-wrap:wrap; gap:.25rem; }
.chip { font-size:.75rem; padding:.05em .25em .05em .5em; border-radius:1em;
	display:flex; align-items:center; gap:.15em;
	background:color-mix(in srgb, Highlight 22%, Canvas);
	border:1px solid color-mix(in srgb, Highlight 45%, Canvas); }
.chip button { border:none; background:none; cursor:pointer; color:inherit;
	font-size:.9rem; line-height:1; padding:0 .2em; opacity:.7; }
.chip button:hover { opacity:1; }

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
		if (run.math && run.text.length <= MATH_CAP) mathInto(doc, frag, run.text, run.display);
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
		if (run.math && run.text.length <= MATH_CAP) mathInto(doc, parent, run.text, run.display);
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
		if (body.trim() && !body.includes("$")) el.textContent = "$" + body + "$";
	}
}

// The whole description, as an element.
function abstractNode(doc, raw, baseURL) {
	const box = el(doc, "div", "abs");

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

function open(libraryID) {
	const main = Zotero.getMainWindow();
	if (!main) return;
	scopeLib = libraryID || null;
	if (win && !win.closed) {
		win.focus();
		return reload();
	}
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
	win._riffleUnload = () => safe(() => saveState(win));
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
		ids = await loadIDs(scopeLib);
		total = ids.length;
		cursor = 0;
		cache.clear();
		undoStack = [];
		colls = flatCollections();
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
	feedName.title = "Switch feed";
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

	const openFeeds = () => {
		if (menu) return closeFeeds();
		const rows = feedRows();
		if (rows.length < 2) return flash("No feeds");
		menu = el(doc, "div", "feedpick");
		const input = doc.createElement("input");
		input.type = "text";
		input.placeholder = "Search feeds…";
		const drop = el(doc, "div", "drop");
		menu.append(input, drop);
		head.append(menu);

		let shown = rows;
		// Opens on whichever feed you are already riffling.
		let sel = Math.max(0, rows.findIndex((r) => r.id === scopeLib));

		const paint = () => {
			drop.replaceChildren();
			if (!shown.length) {
				drop.append(el(doc, "div", "none", "No matching feed"));
				return;
			}
			shown.forEach((r, i) => {
				const row = el(doc, "div", i === sel ? "on" : null);
				row.append(el(doc, "span", null, r.name), el(doc, "b", null, String(r.n)));
				row.addEventListener("mousedown", (e) => { e.preventDefault(); sel = i; choose(); });
				drop.append(row);
			});
			const on = drop.querySelector(".on");
			if (on) on.scrollIntoView({ block: "nearest" });
		};

		const choose = () => {
			const r = shown[sel];
			closeFeeds();
			if (!r || r.id === scopeLib) return;
			scopeLib = r.id;
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
	cardBox.addEventListener("click", (e) => {
		const a = e.target && e.target.closest && e.target.closest("a[href]");
		if (!a) return;
		e.preventDefault();
		safe(() => Zotero.launchURL(a.href));
	});
	const bar = el(doc, "div", "bar");
	doc.body.append(head, cardBox, bar);

	let panel = null;      // the filing panel, or null when just riffling
	let dir = "from-right"; // which way the last card came in
	let ghost = null;       // the outgoing card, mid-flight

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

	const hint = (pairs) => {
		bar.replaceChildren();
		for (const [k, what] of pairs) {
			const span = el(doc, "span");
			for (const key of k.split("/")) {
				if (span.childNodes.length) span.append(" / ");
				span.append(el(doc, "kbd", null, key));
			}
			span.append(" " + what);
			bar.append(span);
		}
	};

	const cardHints = () => hint([
		["←", "discard"], ["→", "keep"], ["s", "skip"], ["u", "undo"],
		["1–9", "recent"], ["f", "feed"], ["o", "open"], ["+/−", "size"],
		["Esc", "close"],
	]);

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

	function draw() {
		if (panel) { panel.remove(); panel = null; }
		cardBox.className = "card " + dir;
		cardBox.replaceChildren();
		cardBox.scrollTop = 0;

		if (cursor >= ids.length) {
			cardBox.className = "card";
			const done = el(doc, "div", "done");
			done.append(
				el(doc, "div", "big", total ? "✓" : "—"),
				el(doc, "div", null, total
					? `${total - skipped} of ${total} cleared`
						+ (skipped ? `, ${skipped} skipped for later.` : ".")
					: "Nothing unread."),
			);
			cardBox.append(done);
			hint([["u", "undo"], ["r", "reload"], ["Esc", "close"]]);
			feedName.textContent = "";
			count.textContent = "";
			return;
		}

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

		feedName.textContent = safe(() => Zotero.Libraries.get(item.libraryID).name, "");
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
		if (kind) meta.append(el(doc, "span", "badge " + kind, kind));
		// Matched on DOI or arXiv id, so a v2 announcement finds the v1 you
		// already saved. Worth knowing before you file a second copy.
		if (refKeys(item.getField("DOI"), item.getField("url")).some((k) => libKeys.has(k))) {
			const have = el(doc, "span", "badge have", "in library");
			have.title = "A copy of this is already in your library";
			meta.append(have);
		}
		if (meta.childNodes.length) cardBox.append(meta);

		// Only what the feed itself put on the item — nothing inferred from the
		// title, the collection or anything else.
		const feedTags = safe(() => item.getTags(), []).map((t) => t.tag).filter(Boolean);
		if (feedTags.length) {
			const row = el(doc, "div", "tags");
			for (const t of feedTags) row.append(el(doc, "span", "tag", t));
			cardBox.append(row);
		}

		cardBox.append(body
			? abstractNode(doc, body, item.getField("url"))
			: el(doc, "div", "abs empty", "No abstract."));

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
	const advance = (entry) => { dir = entry === undefined ? "from-right" : entry; cursor++; render(); };

	const doDiscard = () => {
		const item = current();
		if (!item || busy) return;
		flick("left");
		guard(discard(item).then(() => advance(""))).catch(oops);
	};

	// Most items go to a handful of places, so the handful get a number each.
	// The panel is still there for everything else.
	const fileRecent = (n) => {
		const item = current();
		if (!item || busy) return;
		const id = recentIDs()[n - 1];
		if (!id) return flash("No recent collection " + n);
		const path = (colls.find((c) => c.id === id) || {}).path;
		if (!path) return flash("That collection is gone");
		flick("right");
		guard(keep(item, id, [], "").then(() => { flash("→ " + path); advance(""); }))
			.catch((e) => { oops(e); flash("Save failed — see the error console"); });
	};

	// The third outcome. Deciding on every single card is what turns a backlog
	// into a wall; this leaves the item unread so it comes back another day.
	const doSkip = () => {
		const item = current();
		if (!item || busy) return;
		// Nothing to undo about a skip, but it still takes a place on the stack:
		// without one, u would un-read an older item while stepping back to this
		// card. toggleRead(false) on an item that was never read is a no-op.
		undoStack.push({ id: item.id, itemID: null, skip: true });
		skipped++;
		advance();
	};

	const doUndo = () => {
		if (busy) return;
		guard(undo().then((was) => {
			if (!was) return flash("Nothing to undo");
			if (was.skip) skipped = Math.max(0, skipped - 1);
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

	const openURL = () => {
		const item = current();
		const url = item && item.getField("url");
		if (url) safe(() => Zotero.launchURL(url));
	};

	// --- the filing panel --------------------------------------------------

	// Built once per right-arrow and thrown away on Escape or save. Three rows,
	// revealed one Tab at a time: collection, then tags, then a note. Enter
	// files the item from wherever you are.
	function openPanel() {
		const item = current();
		if (!item || panel || busy) return;
		if (!colls.length) return flash("No collections to file into");

		panel = el(doc, "div", "file");
		doc.body.insertBefore(panel, bar);

		// Last collection first, so Enter alone repeats the previous filing.
		// Recents first, most recent first — so Enter still repeats the last
		// filing, and the rows the number keys reach are the rows on top.
		const recent = recentIDs();
		const place = (c) => {
			const i = recent.indexOf(c.id);
			return i < 0 ? recent.length : i;
		};
		const ordered = colls.slice().sort((a, b) => place(a) - place(b));

		const tags = [];
		let stage = 0; // 0 collection, 1 + tags, 2 + note

		// -- collection row
		const cRow = el(doc, "div", "row");
		cRow.append(el(doc, "label", null, "File to"));
		const cIn = doc.createElement("input");
		cIn.type = "text";
		cIn.placeholder = "Fuzzy search collections…";
		const cDrop = el(doc, "div", "drop");
		cRow.append(cIn, cDrop);
		panel.append(cRow);

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
				// Only while unfiltered, when row order and key order agree.
				if (numbered && i < recent.length) row.append(el(doc, "b", null, String(i + 1)));
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

		// -- tags row (revealed on the first Tab)
		const tRow = el(doc, "div", "row");
		tRow.style.display = "none";
		tRow.append(el(doc, "label", null, "Tags"));
		const chips = el(doc, "div", "chips");
		const tIn = doc.createElement("input");
		tIn.type = "text";
		tIn.placeholder = "tag, another tag…";
		const tDrop = el(doc, "div", "drop");
		tRow.append(chips, tIn, tDrop);
		panel.append(tRow);

		let tShown = [];
		let tSel = 0;

		const paintChips = () => {
			chips.replaceChildren();
			tags.forEach((name, i) => {
				const chip = el(doc, "span", "chip", name);
				const x = el(doc, "button", null, "×");
				x.title = "Remove";
				x.addEventListener("mousedown", (e) => {
					e.preventDefault();
					tags.splice(i, 1);
					paintChips();
					tIn.focus();
				});
				chip.append(x);
				chips.append(chip);
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
		const takeTag = () => {
			const { done, partial } = splitTags(tIn.value);
			for (const t of done) if (!tags.includes(t)) tags.push(t);
			const pick = (tShown[tSel] && partial) ? tShown[tSel] : partial;
			if (pick && !tags.includes(pick)) tags.push(pick);
			tIn.value = "";
			tSel = 0;
			paintChips();
			paintTagDrop();
		};

		// -- note row (revealed on the second Tab)
		const nRow = el(doc, "div", "row");
		nRow.style.display = "none";
		nRow.append(el(doc, "label", null, "Note"));
		const nIn = doc.createElement("textarea");
		nIn.rows = 2;
		nIn.placeholder = "Why this one…";
		nRow.append(nIn);
		panel.append(nRow);

		const panelHints = () => {
			if (stage === 0) {
				hint([["⏎", "file here"], ["⇥", "add tags"], ["↑↓", "pick"], ["Esc", "back"]]);
			} else if (stage === 1) {
				hint([["⏎", tIn.value.trim() ? "add tag" : "file"], ["⇥", "add note"],
					["⇧⇥", "back"], ["Esc", "cancel"]]);
			} else {
				hint([["⏎", "file"], ["⇧⏎", "newline"], ["⇧⇥", "back"], ["Esc", "cancel"]]);
			}
		};

		const setStage = (s) => {
			stage = Math.max(0, Math.min(2, s));
			tRow.style.display = stage >= 1 ? "" : "none";
			nRow.style.display = stage >= 2 ? "" : "none";
			cDrop.style.display = stage === 0 ? "" : "none";
			(stage === 0 ? cIn : stage === 1 ? tIn : nIn).focus();
			panelHints();
		};

		const closePanel = () => {
			if (!panel) return;
			panel.remove();
			panel = null;
			cardHints();
			w.focus();
		};

		function commit() {
			const c = chosen();
			if (!c) return flash("Pick a collection first");
			const rest = splitTags(tIn.value);
			const finalTags = tags.concat(rest.done, rest.partial ? [rest.partial] : [])
				.filter((t, i, a) => t && a.indexOf(t) === i);
			const feedItem = item;
			closePanel();
			flick("right");
			guard(keep(feedItem, c.id, finalTags, nIn.value.trim())
				.then(() => { flash("→ " + c.path); advance(""); }))
				.catch((e) => { oops(e); flash("Save failed — see the error console"); });
		}

		// Keys inside the panel never reach the card handler: stopPropagation on
		// everything the panel handles, and plain typing has to stay plain.
		const panelKeys = (e) => {
			if (e.key === "Escape") {
				e.preventDefault(); e.stopPropagation();
				if (stage > 0) return setStage(stage - 1);
				return closePanel();
			}
			if (e.key === "Tab") {
				e.preventDefault(); e.stopPropagation();
				return setStage(stage + (e.shiftKey ? -1 : 1));
			}
			if (e.key === "Enter") {
				if (stage === 2 && e.shiftKey) return; // newline in the note
				e.preventDefault(); e.stopPropagation();
				// In the tag box a bare Enter means "finish this tag"; an empty
				// box means you are done tagging and want the item filed.
				if (stage === 1 && tIn.value.trim()) return takeTag();
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
				return; // note box: let the caret move
			}
			e.stopPropagation(); // ordinary typing stays in the box
		};

		panel.addEventListener("keydown", panelKeys);
		cIn.addEventListener("input", filter);
		tIn.addEventListener("input", () => { tSel = 0; paintChips(); paintTagDrop(); });

		filter();
		paintChips();
		paintTagDrop();
		setStage(0);
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
			case "Escape": e.preventDefault(); w.close(); break;
			case "ArrowDown": e.preventDefault(); cardBox.scrollBy({ top: 60 }); break;
			case "ArrowUp": e.preventDefault(); cardBox.scrollBy({ top: -60 }); break;
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
			// The row you right-clicked arrives in the menu's context.
			onCommand: (ev, ctx) => safe(() => {
				const row = ((ctx && ctx.collectionTreeRows) || [])[0];
				open(row && row.isFeed && row.isFeed() ? row.ref.libraryID : null);
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
		looksLikeMath, normalizeColor, refKeys };
}
