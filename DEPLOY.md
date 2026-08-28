# Deploying the checkout

The site itself needs none of this. `index.html` runs on GitHub Pages on its
own, and with `API_BASE` left empty every button falls back to the email link.

Do this when you want people to pay themselves and spots to mark themselves
sold. It takes about twenty minutes, all of it on free tiers.

## What lives where

| Piece | Where it runs | Holds secrets? |
|---|---|---|
| `index.html` | GitHub Pages, `brandourjersey.com` | No. Never. |
| `worker/index.js` | Cloudflare Workers | Yes — API key, webhook key |
| `claims` table | Cloudflare D1 | Who bought which spot |

The browser only ever sends a spot number and a website address. Prices live
in the Worker, so nobody can talk us into a cheaper chest.

## Steps

**1. Get the tools.** A free Cloudflare account, then:

```
npm install -g wrangler
wrangler login
```

**2. Make the database.**

```
wrangler d1 create brandourjersey
```

It prints a `database_id`. Paste it into `wrangler.toml`, replacing
`PASTE_DATABASE_ID_FROM_WRANGLER_D1_CREATE`. Then create the table:

```
wrangler d1 execute brandourjersey --remote --file=worker/schema.sql
```

**3. Add the secrets.** Each command prompts for the value and stores it
encrypted — none of these ever touch the repo.

```
wrangler secret put DODO_API_KEY
wrangler secret put DODO_PRODUCT_ID
wrangler secret put DODO_WEBHOOK_KEY
```

`DODO_PRODUCT_ID` is one product in Dodo covering all six spots — the Worker
sets the price per checkout, so you do not need six products. Leave
`DODO_WEBHOOK_KEY` blank for now; step 5 gives you the value.

**4. Deploy.**

```
wrangler deploy
```

Already deployed and answering at:

```
https://brandourjersey-api.dortmundwolves.workers.dev
```

Put that in `index.html` as `API_BASE` — but only once step 5 and 6 are done,
or a visitor could buy a spot against test mode.

**5. Point Dodo at the webhook.** In the Dodo dashboard add an endpoint:

```
https://brandourjersey-api.dortmundwolves.workers.dev/api/webhooks/dodo
```

Subscribe it to `payment.succeeded`. Copy the signing secret it shows you and
run `wrangler secret put DODO_WEBHOOK_KEY` again with that value. Without this
the Worker rejects every webhook — which is the point, but it also means spots
never mark themselves sold until you do it.

**6. Test before going live.** `wrangler.toml` ships with
`DODO_ENVIRONMENT = "test_mode"`. Buy a spot with a Dodo test card and check
that it turns Taken on the site. Then switch to `"live_mode"`, swap in the
live API key and webhook secret, and `wrangler deploy` again.

## The day Dodo approves the account

Test mode and live mode share nothing. The product, the API key and the
webhook all have to be made again on the live side, and the test rows have to
go — otherwise a test purchase shows up as a real sponsor on the shirt.

In order:

**1. Rebuild the product in live mode.** Switch the dashboard to live, create
the product again ("Jersey sponsor spot (one season)", EUR 35, one time, Pay
What You Want on so the Worker can set each spot's price). Copy the new
`pdt_...` — the test one does not exist here.

**2. Add the webhook again in live mode.** Same URL:
`https://brandourjersey-api.dortmundwolves.workers.dev/api/webhooks/dodo`,
event `payment.succeeded`. Copy the new signing secret.

**3. Replace all three secrets with their live values.**

```
npx.cmd wrangler secret put DODO_API_KEY
npx.cmd wrangler secret put DODO_PRODUCT_ID
npx.cmd wrangler secret put DODO_WEBHOOK_KEY
```

**4. Flip the mode and deploy.** In `wrangler.toml` set
`DODO_ENVIRONMENT = "live_mode"`, then `npx.cmd wrangler deploy`.

**5. Wipe the test data**, or last week's test buys appear as sponsors:

```
npx.cmd wrangler d1 execute brandourjersey --remote --command "DELETE FROM claims"
```

**6. Turn the site's checkout on.**

```
node build.js --live
git add index.html && git commit -m "Switch checkout on" && git push
```

**7. Buy one spot yourself, with a real card.** This is the only way to know
the live keys work, and it costs the price of the cheapest spot. Check the
amount is right, the spot flips to Taken, and the logo upload works. Then
refund it from the Dodo dashboard and delete the row.

Only after that is the page safe to send anywhere.

## Two things that will bite you

**Prices exist twice.** The number a buyer is charged comes from `SPOTS` in
`worker/index.js`. The number they *see* comes from the `.spot-card` markup in
`index.html`. Change one, change the other.

**A spot sold offline needs a manual line.** The Worker only knows about
payments that went through Dodo. If someone pays you by transfer, add them to
`SPONSORS` in `index.html`. That block also overrides the Worker, so it is how
you swap a blurry favicon for a real logo.

## Watching it

```
wrangler tail                                    # live logs
wrangler d1 execute brandourjersey --remote --command "SELECT * FROM claims"
```

To free a spot again (a refund, a test purchase):

```
wrangler d1 execute brandourjersey --remote --command "DELETE FROM claims WHERE spot_id = 3"
```
