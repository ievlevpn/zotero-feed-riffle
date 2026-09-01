// Self-check: node test.js  (exits non-zero on failure)
const assert = require("assert");
const { score, rank, deLatex, splitAbstract, authorLine, shortDate, splitTags,
	foldLibraryRows, heldPhrase, importerCut, imgMath, fmtSpan,
	summaryLine, deckLine, seenLine, randomAhead, prefOn, copyChoices, noteHTML, bankTime, stat, statReset, eatsTail } = require("./bootstrap.js");

// --- fuzzy scoring: lower is better, word starts are cheap -----------------
// Both of these match "rp"; the word-boundary one must win by a mile.
assert.ok(score("rp", "rough paths") < score("rp", "reciprocal"), "acronym beats mid-word");
assert.strictEqual(score("xq", "rough paths"), null, "no match -> null");
assert.strictEqual(score("rp", "probability"), null, "not a subsequence -> null, not a bad score");
assert.ok(score("paths rough", "rough paths") !== null, "words match in any order");
assert.ok(score("learn", "machine learning") < score("learn", "unlearnable"), "word start is cheaper");

// --- rank: empty query keeps the given order (last-used stays pinned) ------
const cs = [{ path: "Reading list" }, { path: "Probability / Rough paths" }, { path: "Probability / SPDEs" }];
assert.deepStrictEqual(rank("", cs).map((c) => c.path), cs.map((c) => c.path), "empty query preserves order");
assert.strictEqual(rank("rough", cs, (c) => c.path)[0].path, "Probability / Rough paths");
assert.deepStrictEqual(rank("zzz", cs, (c) => c.path), [], "no matches -> empty");
assert.strictEqual(rank("prs", cs, (c) => c.path)[0].path, "Probability / SPDEs", "acronym across the path");

// --- deLatex: the escapes a maths feed actually ships ----------------------
assert.strictEqual(deLatex('Sch\\"otz'), "Schötz");
assert.strictEqual(deLatex("Jos\\'e"), "José");
assert.strictEqual(deLatex("Ma\\~nas"), "Mañas");
assert.strictEqual(deLatex("Fran\\c{c}ois"), "François");
assert.strictEqual(deLatex("\\v{S}tep\\'an"), "Štepán");
assert.strictEqual(deLatex("Wei\\ss"), "Weiß");
assert.strictEqual(deLatex("Wi\\k{a}cek"), "Wiącek", "ogonek");
assert.strictEqual(deLatex("Bernt {\\O}ksendal"), "Bernt Øksendal", "braced ligature");
assert.strictEqual(deLatex("Ob{\\l}\\'oj"), "Obłój", "ligature + accent");
// Braces are what stop a leftover command eating the rest of the word, so they
// must outlive the command strip: this used to come out as "Wi".
assert.ok(!/[\\{}]/.test(deLatex("Mine \\c{C}a\\u{g}lar")), "no TeX left behind");
// A control word takes the longest run of letters, so "\\v" must not claim the
// "a" of "\\varepsilon". Getting this wrong turned \\varepsilon into "arepsilon",
// \\cdot into "dot" and \\cup into "up" in text-mode runs.
assert.strictEqual(deLatex("\\varepsilon"), "ε", "\\v does not eat \\varepsilon");
assert.strictEqual(deLatex("\\cdot"), "·", "\\c does not eat \\cdot");
assert.strictEqual(deLatex("\\underline"), "", "\\u does not eat \\underline");
// A symbol written into prose with no delimiters round it, which is how arXiv
// titles carry Greek. Deleting the command left the word a letter short.
assert.strictEqual(deLatex("and {\\phi}-divergences"), "and ϕ-divergences",
	"a braced symbol survives the braces coming off");
assert.strictEqual(deLatex("\\alpha-stable processes"), "α-stable processes");
assert.strictEqual(deLatex("\\alpha stable"), "α stable",
	"the space after a symbol stays, whatever TeX would do with it");
assert.strictEqual(deLatex("An \\emph{emphatic} title"), "An emphatic title",
	"a command that is not a symbol still goes, space and all");
assert.strictEqual(deLatex("\\vec x"), "x", "a spaced control-word accent still applies");
assert.strictEqual(deLatex("{Plain}"), "Plain", "braces stripped");
assert.strictEqual(deLatex("Nothing to do"), "Nothing to do", "untouched when no escapes");
assert.strictEqual(deLatex(""), "");
assert.strictEqual(deLatex(null), "");

// --- splitAbstract: strip arXiv's routing header, keep the announce type ---
const a = splitAbstract("arXiv:2506.13429v2 Announce Type: replace \nAbstract: Random complexes are nice.");
assert.deepStrictEqual(a, { kind: "replace", body: "Random complexes are nice." });
const b = splitAbstract("arXiv:2508.00001v1 Announce Type: new\nAbstract: Fresh work.");
assert.deepStrictEqual(b, { kind: "new", body: "Fresh work." });
assert.deepStrictEqual(splitAbstract("A plain abstract."), { kind: "", body: "A plain abstract." });
assert.deepStrictEqual(splitAbstract(""), { kind: "", body: "" });
assert.deepStrictEqual(splitAbstract(null), { kind: "", body: "" });

// --- authorLine: de-LaTeXed, dot-separated, truncated ----------------------
const cre = (first, last) => ({ firstName: first, lastName: last, fieldMode: 0 });
assert.strictEqual(authorLine([cre("Marius", "Hofert"), cre("Zhiyuan", "Pang")]), "Marius Hofert · Zhiyuan Pang");
assert.strictEqual(authorLine([cre("Christof", 'Sch\\"otz')]), "Christof Schötz");
assert.strictEqual(authorLine([{ lastName: "CERN", fieldMode: 1 }]), "CERN", "single-field name");
assert.strictEqual(authorLine([], 8), "");
const many = Array.from({ length: 11 }, (_, i) => cre("A", "N" + i));
assert.ok(authorLine(many, 3).endsWith("· +8 more"), authorLine(many, 3));

// --- shortDate: pull the ISO part out of Zotero's multipart date ----------
assert.strictEqual(shortDate("2026-08-26 2026-08-26 04:00:00"), "2026-08-26");
assert.strictEqual(shortDate("2024"), "2024");
assert.strictEqual(shortDate(""), "");

// --- splitTags: commas close a tag, the tail is still being typed ---------
assert.deepStrictEqual(splitTags("alpha, beta, ga"), { done: ["alpha", "beta"], partial: "ga" });
assert.deepStrictEqual(splitTags("alpha,"), { done: ["alpha"], partial: "" });
assert.deepStrictEqual(splitTags("solo"), { done: [], partial: "solo" });
assert.deepStrictEqual(splitTags(""), { done: [], partial: "" });
assert.deepStrictEqual(splitTags("  ,  , x "), { done: [], partial: "x" }, "blank tags dropped");



// --- LaTeX ----------------------------------------------------------------
// Formula rendering itself is KaTeX's job and KaTeX has its own test suite; what
// is ours is deciding which spans of text are formulas at all.
const { splitMath, looksLikeMath } = require("./bootstrap.js");

// --- splitMath: three delimiter styles, and malformed input left alone -----
const bare = (r) => ({ math: r.math, text: r.text });
assert.deepStrictEqual(splitMath("a $x$ b").map(bare),
	[{ math: false, text: "a " }, { math: true, text: "x" }, { math: false, text: " b" }]);
assert.deepStrictEqual(splitMath("a \\(x\\) b").map(bare),
	[{ math: false, text: "a " }, { math: true, text: "x" }, { math: false, text: " b" }],
	"zbMATH delimiters");
assert.strictEqual(splitMath("\\[x\\]")[0].display, true, "\\[..\\] is display math");
assert.strictEqual(splitMath("$$x$$")[0].display, true, "$$..$$ is display math");
// A "$" inside a group belongs to the formula. MathJax writes tags this way, and
// closing at the first bare "$" left "\\tag{" as the entire equation.
assert.deepStrictEqual(
	splitMath("eq $$\\tag{$\\ast$}{N \\choose n}$$ end").map((r) => r.text),
	["eq ", "\\tag{$\\ast$}{N \\choose n}", " end"],
	"a nested $ inside braces does not close the run");
assert.strictEqual(splitMath("$$\\tag{$x$}a$$")[0].display, true, "and it stays display maths");
assert.strictEqual(splitMath("$$a$b$$")[0].text, "a$b", "a lone $ does not close $$");
assert.strictEqual(splitMath("$\\text{a $b$ c}$")[0].text, "\\text{a $b$ c}", "inline nests too");
assert.strictEqual(splitMath("$x$")[0].display, false, "$..$ is inline");
assert.deepStrictEqual(splitMath("costs \\$5").map(bare), [{ math: false, text: "costs \\$5" }],
	"an escaped dollar is not math");
assert.deepStrictEqual(splitMath("a $x b").map(bare), [{ math: false, text: "a $x b" }],
	"unbalanced: left exactly as found, never swallowed");
assert.deepStrictEqual(splitMath(""), []);
assert.deepStrictEqual(splitMath(null), []);

// The space around math must survive — "\\(n\\) elements" is not "nelements".
assert.strictEqual(
	splitMath("on \\(n\\) elements").map((r) => r.math ? "N" : deLatex(r.text)).join(""),
	"on N elements", "deLatex must not trim a mid-sentence run");

// --- splitAbstract also drops zbMATH's "Summary:" -------------------------
assert.deepStrictEqual(splitAbstract("Summary: The result."), { kind: "", body: "The result." });



// --- description rendering -------------------------------------------------
const { typography, paragraphs, unparse } = require("./bootstrap.js");

// TeX ligatures must not reach the reader; a "$" is left alone because outside
// an academic feed it is money.
assert.strictEqual(typography("Hua--Pickrell"), "Hua–Pickrell", "en dash");
assert.strictEqual(typography("a---b"), "a—b", "em dash");
assert.strictEqual(typography("``quoted''"), "\u201cquoted\u201d", "curly quotes");
assert.strictEqual(typography("a  \t b"), "a b", "runs of whitespace collapse");
assert.strictEqual(typography("we evaluate \\[ x"), "we evaluate x", "orphan \\[ dropped");
assert.strictEqual(typography("raised $5m"), "raised $5m", "a dollar sign is not litter");

assert.deepStrictEqual(paragraphs("one\n\ntwo"), ["one", "two"]);
assert.deepStrictEqual(paragraphs("only one"), ["only one"]);
assert.deepStrictEqual(paragraphs("  \n\n  "), [], "blank input yields no paragraphs");

// A "$" only opens maths when what follows reads as maths. This is what keeps a
// news feed's "raised $5 million and $10 million" out of the maths renderer.
assert.ok(looksLikeMath("\\beta"), "a command is maths");
assert.ok(looksLikeMath("x_1"), "a script is maths");
assert.ok(looksLikeMath("n"), "a single token is maths");
assert.ok(looksLikeMath("x + y"), "symbols with no words are maths");
assert.ok(!looksLikeMath("5 million and "), "prose between dollars is money, not maths");
assert.deepStrictEqual(
	splitMath("raised $5 million and $10 million").map((r) => r.math),
	[false], "currency stays one plain run");
assert.deepStrictEqual(splitMath("about $x_1$ here").map((r) => r.math),
	[false, true, false], "real maths still splits");

// unparse: the inverse of the importer HTML-parsing plain text. Nothing in a
// plain-text feed was ever markup, so every element found is damage.
const El = (tag, attrs, kids) => ({
	nodeType: 1, localName: tag, childNodes: kids || [],
	attributes: Object.entries(attrs || {}).map(([name, value]) => ({ name, value })),
});
const Tx = (v) => ({ nodeType: 3, nodeValue: v });
const un = (kids) => unparse({ childNodes: kids }, []).join("");

assert.strictEqual(un([Tx("plain")]), "plain");
// "$i<j$ if and only $x$" read as a tag, then serialised back.
assert.strictEqual(
	un([Tx("$i"), El("j$", { xmlns: "http://www.w3.org/1999/xhtml", if: "", and: "", only: "" },
		[Tx("1/2$.")])]),
	"$i<j$ if and only>1/2$.".replace(">", ">"),
	"element re-serialised to the text it was made from");
// A word after "=" came back as a quoted value: '$m="2$"' was "$m=2$".
assert.strictEqual(un([El("x", { "$m": "2$" }, [])]), "<x $m=2$>", "valued attribute restored");
assert.strictEqual(un([El("x", { xmlns: "http://www.w3.org/1999/xhtml" }, [])]), "<x>",
	"the serialiser's xmlns is not part of the text");



// --- \color, which means two different things ------------------------------
const { normalizeColor } = require("./bootstrap.js");
const C = normalizeColor;
// MathJax's argument form: a brace follows the colour, so it becomes \textcolor
// and tints only its argument.
assert.strictEqual(C("\\color{red}{x} y"), "\\textcolor{red}{x} y");
assert.strictEqual(C("\\color {green}{g}"), "\\textcolor {green}{g}", "space before the colour");
assert.strictEqual(C("\\color{#ff0000}{x}"), "\\textcolor{#ff0000}{x}", "hex colours too");
// LaTeX's switch form: nothing braced follows, so it is left for KaTeX to
// switch on and tints to the end of the group.
assert.strictEqual(C("\\color{red} \\begin{bmatrix} a \\end{bmatrix}"),
	"\\color{red} \\begin{bmatrix} a \\end{bmatrix}", "switch form untouched");
assert.strictEqual(C("{\\color{red} text}"), "{\\color{red} text}", "switch form untouched");
// Neighbours that merely start with the same letters must not be rewritten.
assert.strictEqual(C("\\colorbox{red}{x}"), "\\colorbox{red}{x}", "\\colorbox is a different command");
assert.strictEqual(C("\\textcolor{red}{x}"), "\\textcolor{red}{x}", "already unambiguous");
assert.strictEqual(C("no colour here"), "no colour here");

// --- a bare "#", which MathJax forgives and KaTeX does not ------------------
const { normalizeTex } = require("./bootstrap.js");
const T = normalizeTex;
// The character the author meant. Unescaped, KaTeX reads it as a macro
// parameter and refuses the whole formula, which then shows as raw source.
assert.strictEqual(T("\\text{# of $j$-cycles}"), "\\text{\\# of $j$-cycles}");
assert.strictEqual(T("a \\# b"), "a \\# b", "already escaped");
// KaTeX's own syntax, and TeX's, both of which have to survive.
assert.strictEqual(T("\\color{#ff0000}{x}"), "\\textcolor{#ff0000}{x}", "hex colour kept");
assert.strictEqual(T("\\textcolor{#fff}{x}"), "\\textcolor{#fff}{x}", "short hex kept");
assert.strictEqual(T("\\def\\f#1{#1+1}"), "\\def\\f#1{#1+1}", "macro parameter kept");
assert.strictEqual(T("x^2"), "x^2");



// --- recognising the same work across a feed and the library ---------------
const { refKeys } = require("./bootstrap.js");
const K = (d, u) => refKeys(d, u);
// The version suffix must not be part of the key: the feed announces v2 of the
// v1 already sitting in the library.
assert.deepStrictEqual(K(null, "https://arxiv.org/abs/2604.04661"), ["arxiv:2604.04661", "url:arxiv.org/abs/2604.04661"]);
assert.ok(K(null, "https://arxiv.org/abs/2604.04661v2").includes("arxiv:2604.04661"), "version ignored");
assert.ok(K(null, "https://arxiv.org/pdf/2604.04661").includes("arxiv:2604.04661"), "pdf url too");
assert.ok(K("10.1007/s00440-024-01234-5", null).includes("doi:10.1007/s00440-024-01234-5"), "doi");
assert.ok(K("https://doi.org/10.1007/S00440-X", null).includes("doi:10.1007/s00440-x"), "doi inside a url, lowercased");
assert.ok(K(null, "https://www.example.org/a/").includes("url:example.org/a"), "www and trailing slash dropped");
assert.deepStrictEqual(K(null, null), []);
assert.deepStrictEqual(K("", "   "), []);
// A bare non-arXiv number must not be mistaken for an id.
assert.deepStrictEqual(K(null, "some title 1234"), []);



// --- feeds that mark maths with a class instead of delimiters --------------
const { markClassMath } = require("./bootstrap.js");
const span = (t) => ({ textContent: t, getAttribute: () => "math-container" });
const rootOf = (els) => ({ querySelectorAll: () => els });
const mark = (t) => { const e = span(t); markClassMath(rootOf([e])); return e.textContent; };

assert.strictEqual(mark("x + y"), "$x + y$", "plain content becomes inline maths");
// KaTeX refuses an environment inline — "{equation} can be used only in display
// mode" — so the delimiters we invent have to say which kind it is.
assert.strictEqual(mark("\\begin{equation}a\\end{equation}"),
	"$$\\begin{equation}a\\end{equation}$$", "an environment is display maths");
assert.strictEqual(mark("\\begin {align}a\\end{align}"),
	"$$\\begin {align}a\\end{align}$$", "even with a space after \\begin");
assert.strictEqual(mark("\\tag{1}x"), "$$\\tag{1}x$$", "\\tag is display-only too");
assert.strictEqual(mark("$x$"), "$x$", "content that already has delimiters is left alone");
assert.strictEqual(mark("   "), "   ", "blank content is left alone");



// --- foldLibraryRows: the library index the "in library" badge and the ------
// filing panel both read. One row per (item, value, collection).
const idx = foldLibraryRows([
	{ itemID: 7, value: "10.1000/Xyz", collectionID: 3, notes: 2, annots: 14 },
	{ itemID: 7, value: "10.1000/Xyz", collectionID: 4, notes: 2, annots: 14 },
	{ itemID: 7, value: "https://arxiv.org/abs/2604.04661v1", collectionID: 3, notes: 2, annots: 14 },
	{ itemID: 7, value: "https://arxiv.org/abs/2604.04661v1", collectionID: 4, notes: 2, annots: 14 },
	{ itemID: 9, value: "https://example.org/paper", collectionID: null, notes: 0, annots: 0 },
]);
assert.strictEqual(idx.get("doi:10.1000/xyz").id, 7);
assert.strictEqual(idx.get("arxiv:2604.04661"), idx.get("doi:10.1000/xyz"),
	"every key of one item points at the same entry");
assert.deepStrictEqual([...idx.get("doi:10.1000/xyz").colls].sort(), [3, 4],
	"collections gathered across rows, not overwritten");
assert.deepStrictEqual([...idx.get("url:example.org/paper").colls], [],
	"an item in no collection still gets an entry (LEFT JOIN gives null)");
assert.strictEqual(idx.get("doi:10.1000/nope"), undefined);
assert.deepStrictEqual(
	[idx.get("doi:10.1000/xyz").notes, idx.get("doi:10.1000/xyz").annots], [2, 14],
	"the counts the panel asks about, repeated on every row, counted once");
assert.deepStrictEqual(
	[idx.get("url:example.org/paper").notes, idx.get("url:example.org/paper").annots], [0, 0]);

// --- heldPhrase: the whole of what the question about the old copy says ----
assert.strictEqual(heldPhrase(2, 14), "2 notes and 14 annotations");
assert.strictEqual(heldPhrase(1, 1), "1 note and 1 annotation", "singulars");
assert.strictEqual(heldPhrase(0, 3), "3 annotations", "no empty half");
assert.strictEqual(heldPhrase(0, 0), "nothing of yours",
	"the case where trashing it is the obvious answer");

// --- one token that runs two words together, either way round -------------
// "stochrough" always worked: a plain scan reads left to right. "roughstoch"
// is the same words in the other order, and used to match nothing at all.
const sc = [{ path: "Stochastic analysis / Rough paths" }, { path: "Stochastic geometry" }];
assert.strictEqual(rank("roughstoch", sc, (c) => c.path)[0].path,
	"Stochastic analysis / Rough paths", "matches with the words the other way round");
assert.ok(score("stochrough", "stochastic analysis / rough paths")
	< score("roughstoch", "stochastic analysis / rough paths"),
	"but reading straight through still wins where it can");
assert.strictEqual(score("hspa", "rough paths"), null,
	"halves under three letters never split: too little to mean anything");
assert.strictEqual(score("pathsough", "rough paths"), null,
	"and a split only counts when both halves start a word");

// --- importerCut: an abstract the importer truncated, and nothing else -----
assert.ok(importerCut('the domain G(T)=(-T<ti<t,tj xmlns="http://www.w3.org/1999/xhtml">0 if j</ti<t,tj>'),
	"a tag named out of the prose, and the sentence never finishes");
assert.ok(!importerCut("sub-diffusive $(0<H<1/2)$ or super-diffusive $(1/2<H<1)$."),
	"the same misreading, but the text came back whole: not a loss");
assert.ok(!importerCut("<p>Ordinary feed HTML, ending as it should.</p>"),
	"real markup is not damage");
assert.ok(!importerCut("An abstract that just has no full stop"),
	"and neither is a missing full stop on its own");
// The other shape: the bogus tag ran to the end of the input, so the parser
// dropped it whole and left no "<" behind at all. Only the half-cut "$" is left
// to go on. (arXiv 2607.21374, as Zotero's feed importer stored it.)
assert.ok(importerCut("Abstract: We consider a fractional Brownian motion $B$ "
	+ "with Hurst index $0"),
	"a delimiter with nothing to close it, and the sentence never finishes");
assert.ok(!importerCut("A tilted variant of $B$ yields a different tangent law."),
	"balanced delimiters and a full stop: whole");
assert.ok(!importerCut("The grant was worth $2 million"),
	"one dollar sign is a currency sign, not a cut");

// --- imgMath: a feed's formulas arrive as pictures, source and all ---------
assert.strictEqual(imgMath("https://latex.codecogs.com/png.latex?%5Clambda"), "\\lambda",
	"CodeCogs keeps the LaTeX in the query itself");
assert.strictEqual(imgMath("https://s0.wp.com/latex.php?latex=%5Csqrt%7B5%7D&bg=ffffff&s=0"),
	"\\sqrt{5}", "WordPress puts it in a parameter, among others");
assert.strictEqual(imgMath("https://latex.codecogs.com/gif.latex?%5Cdpi%7B110%7D%20%5Cbg_white%20x%5E2"),
	"x^2", "sizing and colour are about the picture, not the maths");
assert.strictEqual(imgMath("https://i0.wp.com/math.ucr.edu/home/baez/meson_nonet.png"), null,
	"a real picture stays a picture, and pictures are dropped");
assert.strictEqual(imgMath(""), null);

// --- the finish summary ---------------------------------------------------
assert.strictEqual(fmtSpan(38000), "38 s");
assert.strictEqual(fmtSpan(6 * 60 * 1000), "6 min");
assert.strictEqual(fmtSpan(65 * 60 * 1000), "1 h 05 min", "padded, so the column lines up");
assert.strictEqual(summaryLine([[8, "kept"], [4, "discarded"], [3, "skipped"]], 6 * 60 * 1000),
	"8 kept · 4 discarded · 3 skipped · 6 min · 24 s a card");
assert.strictEqual(summaryLine([[2, "kept"], [0, "discarded"]], 30000), "2 kept · 30 s",
	"a count of nothing is not printed, and two cards set no pace");
assert.strictEqual(summaryLine([[0, "kept"], [0, "discarded"]], 0), "",
	"a window opened and closed again has nothing to say");
assert.strictEqual(summaryLine([[6, "changed"], [1, "trashed"]], 5 * 60 * 1000),
	"6 changed · 1 trashed · 5 min · 43 s a card",
	"a collection deck counts what it did, in its own words");
assert.strictEqual(deckLine(21, 24, 3, 0), "21 of 24 cleared, 3 skipped for later.",
	"the deck ran out: nothing is left unread");
assert.strictEqual(deckLine(17, 24, 3, 4),
	"17 of 24 cleared, 3 skipped for later, 4 still unread.", "stopped part-way");
assert.strictEqual(deckLine(24, 24, 0, 0), "24 of 24 cleared.",
	"clauses with nothing to report are left out");
assert.strictEqual(deckLine(0, 0, 0, 0), "Nothing unread.");

// --- a display environment with no delimiters around it -------------------
// LaTeX needs none and MathJax renders it, so arXiv abstracts contain it bare.
// Left as prose it reached deLatex(), which stripped every command and left
// "align* i _t u +2||^u" in the middle of a sentence.
{
	const runs = splitMath("torus $[0,L]$: \\begin{align*} i \\partial_t u = 0. \\end{align*} Our focus");
	const env = runs.find((r) => r.math && r.display);
	assert.ok(env, "the environment is a maths run");
	assert.ok(env.text.startsWith("\\begin{align*}") && env.text.endsWith("\\end{align*}"),
		"taken whole, delimiters and all, which is what KaTeX wants");
	assert.strictEqual(runs[runs.length - 1].text, " Our focus",
		"and the sentence after it is still prose");
	assert.ok(runs.some((r) => r.math && !r.display && r.text === "[0,L]"),
		"ordinary inline maths alongside it is untouched");
}
assert.deepStrictEqual(
	splitMath("half an \\begin{align*} equation").map((r) => r.math), [false],
	"an environment that never ends is left alone rather than swallowing the rest");

// --- riffling a collection is reading, so the sentence counts differently --
assert.strictEqual(seenLine(24, 24, 0), "24 of 24 seen.");
assert.strictEqual(seenLine(6, 24, 18), "6 of 24 seen, 18 still to look at.");
assert.strictEqual(seenLine(0, 0, 0), "Nothing here.");

// --- random ahead: always a card you have not been dealt yet ---------------
assert.strictEqual(randomAhead(4, 5), null, "last card -> nowhere to go");
assert.strictEqual(randomAhead(0, 1), null, "one-card deck -> nowhere to go");
assert.strictEqual(randomAhead(3, 5, () => 0), 4, "floor of the range is the next card");
assert.strictEqual(randomAhead(0, 10, () => 0.999999), 9, "top of the range is the last card");
for (let i = 0; i < 200; i++) {
	const j = randomAhead(2, 10);
	assert.ok(j >= 3 && j <= 9, "stays ahead of the cursor and inside the deck");
}

// Swapping the pick up to cursor+1 and stepping on is Fisher-Yates dealt one
// card at a time: a whole run is a permutation, so no card comes round twice.
for (let trial = 0; trial < 200; trial++) {
	const deck = [0, 1, 2, 3, 4, 5, 6, 7];
	const dealt = [deck[0]];
	for (let cursor = 0; ; cursor++) {
		const j = randomAhead(cursor, deck.length);
		if (j === null) break;
		const at = cursor + 1;
		[deck[at], deck[j]] = [deck[j], deck[at]];
		dealt.push(deck[at]);
	}
	assert.deepStrictEqual([...dealt].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7],
		"every card dealt exactly once");
}
// And every card can reach every position, so it is a shuffle, not a rotation.
const seen = new Set();
for (let trial = 0; trial < 2000; trial++) {
	const deck = [0, 1, 2, 3];
	for (let cursor = 0; ; cursor++) {
		const j = randomAhead(cursor, deck.length);
		if (j === null) break;
		const at = cursor + 1;
		[deck[at], deck[j]] = [deck[j], deck[at]];
	}
	seen.add(deck.join(""));
}
assert.strictEqual(seen.size, 6, "all 3! orders of the tail turn up");
assert.strictEqual(noteHTML("one\ntwo <b> & three"),
	"<p>one</p><p>two &lt;b&gt; &amp; three</p>", "a typed note is text, never markup");

// …but the handful of marks worth typing do come through, as the note editor's
// own HTML: bold, italics, code, and maths the way Zotero stores maths.
assert.strictEqual(noteHTML("**lalala**"), "<p><strong>lalala</strong></p>");
assert.strictEqual(noteHTML("a **bold** and *slanted* line"),
	"<p>a <strong>bold</strong> and <em>slanted</em> line</p>");
assert.strictEqual(noteHTML("_this_ one"), "<p><em>this</em> one</p>");
assert.strictEqual(noteHTML("$x^2$ here"),
	'<p><span class="math">$x^2$</span> here</p>');
assert.strictEqual(noteHTML("  $$\\int_0^1 f$$  "),
	'<pre class="math">$$\\int_0^1 f$$</pre>', "a line of nothing but maths is a block");
assert.strictEqual(noteHTML("$a<b$"), '<p><span class="math">$a&lt;b$</span></p>',
	"escaped first: the editor reads the text back, angle bracket and all");

// What must NOT be marked up.
assert.strictEqual(noteHTML("snake_case_name stays"), "<p>snake_case_name stays</p>");
assert.strictEqual(noteHTML("a * b * c"), "<p>a * b * c</p>", "spaced stars are arithmetic");
assert.strictEqual(noteHTML("costs $5 and $10 a year"), "<p>costs $5 and $10 a year</p>",
	"prose between dollars is a price, not a formula");
assert.strictEqual(noteHTML("`a*b*c` and $a*b*c$"),
	'<p><code>a*b*c</code> and <span class="math">$a*b*c$</span></p>',
	"emphasis is not read inside code or maths");

// --- the one thing the parse cannot survive --------------------------------
// Everything the importer mangled comes back through parseHTML + unparse: the
// words it re-serialised as a tag's attributes are still in the tree. What is
// not in the tree is an unclosed tag at the very end of the input, which the
// parser drops whole — so only that shape is kept away from the parser.
assert.ok(eatsTail("at most $i<j$."), "a maths \"<\" with no \">\" after it anywhere");
assert.ok(eatsTail("bounded by $n<N"), "even with nothing following it");
assert.ok(!eatsTail("constants $0<c<c'<1$ xmlns=\"http://www.w3.org/1999/xhtml\" "
	+ "so=\"\" that=\"\" there=\"\" is=\"\" a=\"\" pair=\"\">rest of it</c<c'<1$>"),
	"the importer's own damage closes, and unparse gets it back");
assert.ok(!eatsTail("<p>Ordinary feed HTML.</p>"), "real markup");
assert.ok(!eatsTail("no angle brackets at all"), "and prose is not held back");
assert.ok(!eatsTail("a < b in prose"), "a \"<\" that opens nothing tag-like");
assert.ok(!eatsTail(""), "");

// --- what there is to copy off a card ---------------------------------------
// A feed fills in what it feels like, so the menu is only ever the fields that
// are actually there — an empty row is a row that does nothing when picked.
const full = copyChoices({
	title: "Rough paths and SPDEs", authors: "A Lyons, B Gubinelli", year: "2026",
	doi: "10.1234/rp", url: "https://arxiv.org/abs/2601.00001", abstract: "We show that…",
});
assert.deepStrictEqual(full.map((c) => c.name),
	["Reference", "Link", "DOI", "Title", "Abstract"], "all five, most useful first");
assert.strictEqual(full[0].text, "A Lyons, B Gubinelli (2026) Rough paths and SPDEs.",
	"the reference reads as one you could paste");
assert.strictEqual(full[1].text, "https://arxiv.org/abs/2601.00001",
	"the item's own URL is the link when it has one");

// The DOI resolver stands in as the link only when there is no URL, and the
// bare DOI keeps its own row either way.
const noUrl = copyChoices({ title: "T", doi: "10.1234/rp" });
assert.deepStrictEqual(noUrl.map((c) => [c.name, c.text]),
	[["Reference", "T."], ["Link", "https://doi.org/10.1234/rp"],
		["DOI", "10.1234/rp"], ["Title", "T"]]);

assert.deepStrictEqual(copyChoices({}), [], "a card with nothing on it offers nothing");
assert.deepStrictEqual(copyChoices({ url: "http://x" }).map((c) => c.name), ["Link"],
	"a link and no metadata is one row, not five");
assert.strictEqual(copyChoices({ title: "Ends in a question?" })[0].text,
	"Ends in a question?", "a reference already punctuated gains no second stop");
assert.strictEqual(copyChoices({ authors: "A", year: "2026" })[0].text, "A (2026).",
	"and a title-less one still reads as a line");

// --- banking the sitting into Reading Time ---------------------------------
// The other plugin is optional: absent, declined, or unanswered all mean the
// same thing here — write nothing, say nothing.
const banked = [];
let answer;
global.Zotero = {
	logError: (e) => { throw e; },
	Prefs: { get: (k) => (k === "feedRiffle.readingTime" ? answer : undefined), set: () => {} },
};
const withAPI = (v) => {
	global.Zotero.ReadingTime = v;
	statReset();
	stat.spent = 900000;   // 15 minutes counted
	stat.last = 0;         // and no card on screen, so statTick() adds nothing
	bankTime();
};
const real = { apiVersion: 1, addFeedSession: (s, at, n) => (banked.push([s, at, n]), true) };

answer = undefined;
withAPI(real);
assert.strictEqual(banked.length, 0, "nothing is logged before the question is answered");
answer = false;
withAPI(real);
assert.strictEqual(banked.length, 0, "and nothing after it is declined");

answer = true;
withAPI(undefined);
assert.strictEqual(banked.length, 0, "Reading Time not installed: no error, no row");
withAPI({ apiVersion: 2, addFeedSession: () => true });
assert.strictEqual(banked.length, 0, "nor for an API we do not know how to call");

withAPI(real);
assert.deepStrictEqual(banked, [[900, stat.began, null]], "accepted: one row, in seconds, from when it began");
assert.ok(stat.banked, "and it is not written twice");
bankTime();
assert.strictEqual(banked.length, 1);

// --- prefOn: never set is not the same as set to false ---------------------
// The three settings in the help sheet lean on this: unset means "follow
// Zotero" for subcollections and "ask me once" for Reading Time, and reading
// either as a plain false would silently answer a question nobody had.
let prefs = {};
const realGet = global.Zotero.Prefs.get;
global.Zotero.Prefs.get = (k) => prefs[k];
assert.strictEqual(prefOn("x", true), true, "unset falls back to the default");
assert.strictEqual(prefOn("x", false), false, "whichever the default is");
prefs = { x: false };
assert.strictEqual(prefOn("x", true), false, "an explicit false beats the default");
prefs = { x: true };
assert.strictEqual(prefOn("x", false), true, "and so does an explicit true");
global.Zotero.Prefs.get = realGet;

// A note typed on the end screen rides along on the same row.
banked.length = 0;
withAPI(real);          // banks once, noteless
stat.banked = false;
stat.note = "arXiv math.PR";
bankTime();
assert.deepStrictEqual(banked[1], [900, stat.began, "arXiv math.PR"],
	"the note is banked with the sitting");
statReset();
assert.strictEqual(stat.note, null, "and a new sitting starts without one");

console.log("ok");
