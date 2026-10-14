#!/bin/sh
# Usage: ./share.sh path/to/booklet.pdf ["Optional title"]
# Copies the PDF into docs/ under a random slug, pushes, and prints the client link.
set -e
cd "$(dirname "$0")"
[ -f "$1" ] || { echo "usage: $0 file.pdf [title]"; exit 1; }
base=$(basename "$1" .pdf | tr -cs 'A-Za-z0-9' '-' | tr 'A-Z' 'a-z' | sed 's/^-//;s/-$//')
slug="$(openssl rand -hex 4)-$base"
cp "$1" "docs/$slug.pdf"
git add "docs/$slug.pdf"
git commit -qm "Share $slug"
git push -q
title="${2:-$base}"
enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$title")
url="https://labmasd.github.io/page-lab/?client=1&pdf=docs/$slug.pdf&title=$enc"
echo "$url" | pbcopy
echo "Client link (copied to clipboard, live in ~1 minute):"
echo "$url"
