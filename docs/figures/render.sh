#!/usr/bin/env bash
# Re-render experiments-3-4.html to one PNG per figure.
# Chrome headless only paints ~80% of --window-size, so render tall and crop to the
# measured figure height (top-anchored) afterwards.
set -euo pipefail
cd "$(dirname "$0")"
CH="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SCALE=2

isolate() {  # $1 = figure number, $2 = "measure" to append the height probe
  python3 - "$1" "${2:-}" <<'PY'
import sys
n, mode = int(sys.argv[1]), sys.argv[2]
s = open('experiments-3-4.html').read()
s = s.replace('</style>',
  'header, footer, details, figure:nth-of-type(%d) { display:none !important; }\n' % (2 if n == 1 else 1) +
  'html,body{padding:0;background:var(--surface)}\n.page{max-width:none;gap:0}\n'
  'figure{border:0;border-radius:0;padding:30px 34px 34px;gap:16px}\n</style>')
if mode == 'measure':
    s += ("\n<script>document.fonts.ready.then(()=>setTimeout(()=>{"
          "const f=[...document.querySelectorAll('figure')].find(x=>x.getBoundingClientRect().height>0);"
          "document.title=String(Math.ceil(f.getBoundingClientRect().bottom))},800))<" + "/script>")
open('/tmp/reducer-fig.html', 'w').write(s)
PY
}

render() {  # $1 = figure number, $2 = output png
  isolate "$1" measure
  local h
  h=$("$CH" --headless=new --disable-gpu --no-sandbox --force-device-scale-factor=$SCALE \
        --window-size=1080,3000 --virtual-time-budget=8000 --dump-dom "file:///tmp/reducer-fig.html" 2>/dev/null \
      | sed -n 's/.*<title>\([0-9]*\)<\/title>.*/\1/p' | head -1)
  isolate "$1"
  "$CH" --headless=new --disable-gpu --no-sandbox --force-device-scale-factor=$SCALE \
        --window-size=1080,$(( h * 100 / 78 )) --screenshot="$2" --virtual-time-budget=6000 \
        "file:///tmp/reducer-fig.html" >/dev/null 2>&1
  # sips centres the crop when cropOffset is 0, but treats any nonzero offset as
  # absolute from the top edge, so 1 is the top-anchored crop
  sips -c $(( h * SCALE )) $(( 1080 * SCALE )) --cropOffset 1 0 "$2" >/dev/null
  echo "$2  ${h}px tall"
}

render 1 exp3-lazy-oci.png
render 2 exp4-longtail.png
