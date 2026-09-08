#!/usr/bin/env python3
"""Release build for the "סוגרים קופה" app.

Single source of truth for the version number: bumps it into the app's
settings screen and the service worker cache name, then generates the
deployable index.html (standalone PWA wrapper around kupa-sgura.html).

Usage: python3 build.py
"""
import re

VERSION = 47

HEAD = """<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070A">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="./icon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="./icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="סוגרים קופה">
"""

TAIL = """<script>
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
</script>
</body>
</html>
"""


def main():
    src = open("kupa-sgura.html", encoding="utf-8").read()
    src = re.sub(r"גרסה \d+", f"גרסה {VERSION}", src)
    open("kupa-sgura.html", "w", encoding="utf-8").write(src)

    sw = open("sw.js", encoding="utf-8").read()
    sw = re.sub(r'const CACHE = "kupa-v\d+"', f'const CACHE = "kupa-v{VERSION}"', sw)
    open("sw.js", "w", encoding="utf-8").write(sw)

    head_end = src.index("</style>") + len("</style>")
    out = HEAD + src[:head_end] + "\n</head>\n<body>\n" + src[head_end:] + TAIL
    open("index.html", "w", encoding="utf-8").write(out)
    print(f"built version {VERSION}: kupa-sgura.html, sw.js, index.html")


if __name__ == "__main__":
    main()
