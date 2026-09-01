#!/usr/bin/env bash
# Cut a release: build the .xpi, regenerate update.json from manifest.json,
# commit, push, and publish a GitHub release with the .xpi attached.
# Bump "version" in manifest.json first, then run ./release.sh [note...]
# Each note becomes a changelog bullet — needed for work this script commits
# itself, which has no commit subject of its own to be read off.
set -euo pipefail
cd "$(dirname "$0")"

# Anything still uncommitted gets swept into the release commit, and that
# commit's subject is bookkeeping the changelog throws away — so without a note
# the work would ship undescribed. Which is exactly what happened to v0.5.0.
DIRTY=$(git status --porcelain -- . ":!manifest.json" ":!update.json")
if [ -n "$DIRTY" ] && [ $# -eq 0 ]; then
	echo "Uncommitted changes, and no release note to describe them:" >&2
	echo "$DIRTY" >&2
	echo >&2
	echo "Commit them first, or: ./release.sh 'what changed' ['and this too']" >&2
	exit 1
fi

REPO="ievlevpn/zotero-feed-riffle"
XPI="feed-riffle.xpi"
VER=$(node -p "require('./manifest.json').version")

node test.js
rm -f "$XPI"
zip -q -r "$XPI" manifest.json bootstrap.js icon.svg toolbar.svg locale katex.min.js katex.min.css fonts LICENSE-KaTeX

# Regenerate update.json so update_link always points at this version's asset.
REPO="$REPO" node -e '
const fs = require("fs");
const m = require("./manifest.json");
const z = m.applications.zotero;
const repo = process.env.REPO;
const out = { addons: { [z.id]: { updates: [{
  version: m.version,
  update_link: `https://github.com/${repo}/releases/download/v${m.version}/feed-riffle.xpi`,
  applications: { zotero: {
    strict_min_version: z.strict_min_version,
    ...(z.strict_max_version ? { strict_max_version: z.strict_max_version } : {}),
  } },
}] } } };
fs.writeFileSync("update.json", JSON.stringify(out, null, 2) + "\n");
'

git add manifest.json bootstrap.js release.sh test.js README.md update.json locale icon.svg toolbar.svg katex.min.js katex.min.css fonts
# The notes ride along in the commit body, as bullets, where the changelog below
# reads them back out. An array, because an unquoted ${BODY:+...} would split a
# note on its spaces into one -m argument per word.
MSG=(-m "Release v$VER")
if [ $# -gt 0 ]; then MSG+=(-m "$(printf -- '- %s\n' "$@")"); fi
git commit "${MSG[@]}" || echo "(nothing to commit)"
git push

# Changelog = commits since the previous tag (drop the "Release vX" commits).
# Fetch tags first: gh creates tags remotely, so local tags go stale and
# git describe would pick an old one, repeating already-shipped changes.
git fetch --tags -q || true
PREV=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
RANGE=${PREV:+$PREV..HEAD}
# Subjects, plus any body line already written as a bullet — which is how the
# release commit's own notes get in. Everything else in a body is prose for
# readers of the log, not a changelog line.
CHANGES=$(git log --no-merges --pretty='- %s%n%b' $RANGE | grep '^- ' | grep -v '^- Release v' || true)
[ -z "$CHANGES" ] && CHANGES="- Initial release"

NOTES="## What's changed
$CHANGES

---
Install: download \`feed-riffle.xpi\` below → Zotero → Tools → Plugins → ⚙ → Install Plugin From File…
Existing installs update automatically."

gh release create "v$VER" "$XPI" -t "v$VER" -n "$NOTES"

echo "released v$VER"
