// Self-check: node test.js  (exits non-zero on failure)
const assert = require("assert");
const { score, rank, deLatex, splitAbstract, authorLine, shortDate, splitTags,
	foldLibraryRows, heldPhrase, importerCut, imgMath } = require("./bootstrap.js");

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
assert.strictEqual(deLatex("\\varepsilon"), "", "\\v does not eat \\varepsilon");
assert.strictEqual(deLatex("\\cdot"), "", "\\c does not eat \\cdot");
assert.strictEqual(deLatex("\\underline"), "", "\\u does not eat \\underline");
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

console.log("ok");

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
