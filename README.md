# Brand Our Jersey

Seven ad spots on a student football team's jersey in Dortmund, sold for the
season. Pick a spot, pay, and your logo lands on the shirt graphic straight
away — then on the printed kit before the first whistle.

Live at **[brandourjersey.com](https://brandourjersey.com)**.

## How it is put together

| Piece | What it does |
|---|---|
| `src/page.html` | The whole site. Edit this, never `index.html`. |
| `build.js` | Builds `index.html` from it. `--local` for a test copy, `--live` to switch checkout on. |
| `worker/index.js` | Cloudflare Worker: checkout, webhook, logo upload, view counter. |
| `worker/schema.sql` | The D1 tables behind it. |

The page is one static file on GitHub Pages, so it stays up whatever happens
to the backend. The Worker holds the prices, the spot reservations and the
secrets; the page never sees a key.

```
node build.js --local   # build, with checkout wired to the Worker
node build.js           # build for the live site, checkout off
```

`DEPLOY.md` has the setup and the go-live sequence.

## Selling a spot

Spots mark themselves sold when a payment comes through. To add one by hand —
a sponsor who paid by transfer, or a better logo than the one they uploaded —
add a line to `SPONSORS` at the bottom of `src/page.html` and rebuild. That
block always wins over what the Worker says.
