# da-jwt
## קופה סגורה — Poker Cash Game Settlement

Static web app served from `index.html` plus PWA assets
(`manifest.webmanifest`, `sw.js`, icons). Deployed to Vercel from `main`;
every push to `main` redeploys automatically.

### Release process

1. Edit `kupa-sgura.html` (the single source of the app).
2. Bump `VERSION` in `build.py` and run `python3 build.py` — it stamps the
   version into the settings screen and the service worker cache name, and
   regenerates the deployable `index.html`.
3. Commit and push `main`; Vercel deploys automatically. `.vercelignore`
   keeps server code and legacy files out of the public deployment.

`poker-settle.html` is a frozen legacy version kept only for an old
published artifact URL — do not edit it.

### Archive

`archive/all-in-cash/` holds an earlier, unrelated Vite prototype ("ALL IN") kept
for reference only. It is git-ignored and excluded from the Vercel deployment.
