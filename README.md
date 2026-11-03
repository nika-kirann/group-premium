# 💎 GROUP PREMIUM

Telegram **Stars subscription bot + website + admin dashboard** for Telegram supergroups.

* Free members: **text only**.
* Premium members (**99 ⭐ / 30 days**, auto-renewing until cancelled): **text + photos** and the native **`PREMIUM` member tag**.
* When a membership expires or is revoked: photos off, text stays, tag removed, DB status `EXPIRED`/`REVOKED`.

Single Node.js 22 process (Express + grammY + PostgreSQL) that runs as **one Koyeb free Web Service** — no worker, no local storage, webhooks only.

> Verified against the official Bot API docs (https://core.telegram.org/bots/api, **Bot API 10.3**, checked Nov 2026): `createInvoiceLink.subscription_period`, `SuccessfulPayment.subscription_expiration_date / is_recurring / is_first_recurring`, `editUserStarSubscription`, `setChatMemberTag`, `ChatAdministratorRights.can_manage_tags`, `ChatPermissions.can_edit_tag`, `use_independent_chat_permissions`. Installed grammY **1.46** includes these methods.

---

## 1. Project structure

```
group-premium/
├── Dockerfile
├── .dockerignore / .gitignore
├── .env.example
├── package.json
├── README.md
├── migrations/
│   └── 001_init.sql            # users, subscriptions, payments, bot_settings, admin_sessions, admin_credentials
├── public/                     # website + dashboard (vanilla HTML/CSS/JS, no secrets)
│   ├── index.html              # landing page (hero, plan card, comparison, FAQ)
│   ├── admin.html              # protected dashboard shell (data only via authenticated API)
│   ├── favicon.svg
│   ├── css/styles.css          # dark glassmorphism, violet/electric-blue theme, mobile-first
│   └── js/
│       ├── home.js             # wires Subscribe / Join buttons from /api/public-config
│       └── admin.js            # dashboard logic
├── src/
│   ├── server.js               # Express app, /healthz, webhook, /internal/maintenance, boot + migrations
│   ├── config.js               # env var loading + validation
│   ├── logger.js               # JSON logs with secret redaction
│   ├── db.js                   # pg pool, transactions, settings helpers
│   ├── migrate.js              # idempotent migration runner (advisory-locked)
│   ├── botInstance.js          # shared grammY Bot (webhook mode)
│   ├── bot.js                  # commands, payment handlers, group events
│   ├── permissions.js          # default/premium permissions, restrictChatMember, setChatMemberTag
│   ├── subscriptions.js        # invoices, payment verification, idempotent activation, cancel, expiry sync
│   ├── auth.js                 # scrypt passwords, DB sessions, signed httpOnly cookies, CSRF header
│   └── routes/admin.js         # protected admin API
└── test/payments.test.js       # integration tests (needs a throwaway Postgres)
```

## 2. How it works

### Payments (Telegram Stars subscription)
1. `/subscribe` (private chat) → `createInvoiceLink` with `currency: "XTR"`, `provider_token: ""`, **exactly one** price item `{amount: 99}`, `subscription_period: 2592000`. The invoice payload is `gp1:<user_id>:<group_id>:<price>:<nonce>:<HMAC>` — signed with `SESSION_SECRET`, so it cannot be forged or reused by another account.
2. `pre_checkout_query` → verifies currency `XTR`, amount `== PRICE_STARS`, payload signature, that the payload's user id equals the payer and the group matches; otherwise answers `ok=false` with a reason.
3. `successful_payment` → verified **again**, then inside one DB transaction: `INSERT … ON CONFLICT (telegram_payment_charge_id) DO NOTHING`. Only if the row is new is the subscription extended → fully **idempotent** (Telegram redeliveries or duplicate updates never extend twice). Expiry = `subscription_expiration_date` from Telegram when present, else `max(now, current_expiry) + 30 days`.
4. Renewals arrive as new `successful_payment` messages with `is_recurring=true` (no `is_first_recurring`) and a new charge id → same path, new expiry.
5. Premium is **never** granted from a button click — only from a verified `successful_payment` (or an explicit admin grant in the dashboard).
6. `refunded_payment` updates mark the payment `REFUNDED` and revoke premium.
7. If the DB fails while processing a `successful_payment`, the webhook returns HTTP 500 so Telegram redelivers it later.

### Cancel
`/cancel_subscription` → confirmation → `editUserStarSubscription(user_id, telegram_payment_charge_id, is_canceled=true)`. Telegram stops future charges; the user keeps premium until `expires_at`. `/status` offers “Re-enable auto-renewal” (`is_canceled=false`).

### Group permissions
* `/setup` (admins only) checks: chat is a **supergroup**, bot is **administrator** with **can_restrict_members** and **can_manage_tags**. It then shows a **confirmation** explaining that regular members are affected, and on confirm calls `setChatPermissions(…, use_independent_chat_permissions: true)` with: messages ✅, photos/videos/audios/documents/voice/video notes/polls/other ❌, `can_edit_tag: false` (so members can’t give themselves the PREMIUM tag). Admin permissions are never touched (setChatPermissions does not affect admins; per-user calls skip `creator`/`administrator`).
* On payment: `restrictChatMember(user, {messages ✅, photos ✅, rest ❌}, use_independent_chat_permissions: true, until_date = expires_at)` + `setChatMemberTag(tag: "PREMIUM")`.
* When `until_date` passes, Telegram lifts the per-user exception by itself → user falls back to the text-only group defaults (works even if the server is asleep).
* Expiry sync then removes the tag (`setChatMemberTag` with an empty tag), explicitly re-applies text-only permissions and sets `EXPIRED`.
* New members joining (`chat_member` update) get text-only permissions, or their premium re-applied if they paid before joining.

### Expiry synchronisation (no in-memory timers)
`syncExpirations()` is idempotent and guarded by a Postgres advisory lock. It runs:
* on every boot,
* opportunistically on bot updates and dashboard API traffic (throttled through a DB timestamp, at most once per 60–120 s),
* via `POST /internal/maintenance` from an external cron (recommended every 10–15 min),
* via the dashboard “Run sync” button.

It also retries failed grants/revokes (e.g. user joined the group after paying, temporary API error).

## 3. Telegram setup

1. **Create the bot**: open [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token → `BOT_TOKEN`.
2. In BotFather → your bot → *Bot Settings* → *Allow Groups* = on. Privacy mode can stay **on** (the bot only needs commands, payments and member updates).
3. **Stars payments** need no provider token. (Optional) set `/setdescription` and a profile picture.
4. **Make the group a supergroup** (any group with a public link or with “chat history visible” is a supergroup; groups are converted automatically when you change these settings).
5. **Add the bot to the group and promote it to administrator** with at least:
   * ✅ **Ban users / Restrict members** (`can_restrict_members`)
   * ✅ **Manage member tags** / “Edit tags” (`can_manage_tags`)
   * ✅ Delete messages (only if `PHOTO_MODE=guard`)
   Leave everything else off. Never give the bot “Add new admins”.
6. **GROUP_ID**: after deployment, forward any group message to [@RawDataBot](https://t.me/RawDataBot) or open the group in Telegram Web (`web.telegram.org/a/#-100…`) — the number starting with `-100` is the id.
7. **ADMIN_TELEGRAM_IDS**: send `/start` to [@userinfobot](https://t.me/userinfobot) to get your numeric id.
8. Each admin must open a **private chat** with the bot and send `/start` (so Telegram allows the bot to message them).
9. Set the dashboard password: in the private chat send `/setpassword <12+ character password>`. The message is deleted, only a scrypt hash is stored.
10. In the group (or private chat) run `/setup` and press **✅ Apply permissions**.

### Bot commands
| Command | Who | What |
|---|---|---|
| `/start` | everyone | Welcome, free vs premium |
| `/subscribe` | everyone (private) | Offer + **⭐ Subscribe for 99 Stars** button (invoice link) |
| `/status` | everyone (private) | Status, expiry date, remaining time, auto-renew state |
| `/cancel_subscription` | everyone (private) | Cancel future renewals, keep access until period end |
| `/help` | everyone | Commands + support |
| `/paysupport`, `/terms` | everyone | Payment support / terms (recommended by Telegram for Stars bots) |
| `/setup` | admins | Verify group & rights, confirm and apply default permissions |
| `/stats` | admins | Member + subscription statistics |
| `/premium` | admins | Plan & enforcement info |
| `/setpassword` | admins (private) | Set dashboard password |

## 4. Environment variables

| Variable | Where it comes from |
|---|---|
| `BOT_TOKEN` | @BotFather → `/newbot` (or `/token`). Keep secret. |
| `GROUP_ID` | Numeric supergroup id, starts with `-100` (see Telegram setup step 6). |
| `ADMIN_TELEGRAM_IDS` | Comma-separated numeric user ids of people allowed to run admin commands and use the dashboard (@userinfobot). |
| `DATABASE_URL` | Connection string of your Postgres: Koyeb → *Databases* → your DB → *Connection details* (or Neon / Supabase “connection string”). Include `?sslmode=require` if the provider shows it. |
| `WEBHOOK_SECRET` | You generate: `openssl rand -hex 32` (32–256 chars, `A-Z a-z 0-9 _ -`). Sent by Telegram in `X-Telegram-Bot-Api-Secret-Token`. |
| `SESSION_SECRET` | You generate: `openssl rand -hex 48`. Signs session cookies and invoice payloads. Changing it invalidates unpaid invoice links and sessions. |
| `BASE_URL` | Public URL of the Koyeb service, e.g. `https://group-premium-yourname.koyeb.app` (no trailing slash). The webhook becomes `${BASE_URL}/telegram/webhook`. |
| `PRICE_STARS` | `99`. |
| `SUBSCRIPTION_PERIOD` | `2592000` – Telegram currently only accepts 30 days. |
| `MAINTENANCE_SECRET` | You generate: `openssl rand -hex 32`. Used by the external cron. |
| `PORT` | Set automatically by Koyeb (leave empty there; defaults to 8000). |
| `GROUP_INVITE_LINK` *(optional)* | Group → Invite links (e.g. `https://t.me/+abc…`). Used by the website’s “Join Telegram” button. |
| `PHOTO_MODE` *(optional)* | `native` (default) or `guard` – see Limitations. |
| `DATABASE_SSL` *(optional)* | `true` (default). Use `false` only for a local Postgres without TLS. |

## 5. Deploy on Koyeb (free)

1. **Database**: Koyeb → *Databases* → *Create Database Service* (free Postgres) → copy the connection string. (Neon’s free tier works too.)
2. Push this folder to a GitHub repository.
3. Koyeb → *Create Service* → *Web Service* → GitHub → select the repo. Builder: **Dockerfile** (auto-detected). Instance: **Free**.
4. *Exposed port*: `8000`, protocol HTTP, route `/`. *Health check*: HTTP `GET /healthz` on port 8000.
5. Add all environment variables (use Koyeb **Secrets** for `BOT_TOKEN`, `DATABASE_URL`, `WEBHOOK_SECRET`, `SESSION_SECRET`, `MAINTENANCE_SECRET`). For `BASE_URL`, use the service URL Koyeb shows (you can deploy once, copy the URL, set `BASE_URL`, redeploy).
6. Deploy. On boot the app: runs migrations → `getMe` → `setWebhook(BASE_URL/telegram/webhook, secret_token, allowed_updates=[message, callback_query, pre_checkout_query, chat_member, my_chat_member])` → registers commands → runs an expiry sync. Check logs for `Bot @… ready`.
7. Verify: `https://<app>/healthz` → `{"status":"ok","db":true,"bot":true,"webhook":true,…}`.

Restarts are safe: all state is in Postgres, migrations are idempotent, the webhook is re-registered on every boot, and Telegram retries updates that arrive while the instance is starting (the webhook answers 503 until ready). The free instance may sleep when idle; an incoming webhook wakes it, and the `until_date` on each premium restriction makes photo access expire inside Telegram even while asleep.

## 6. External scheduler (cron-job.org, free)

1. Sign up at https://cron-job.org → *Create cronjob*.
2. URL: `https://<your-app>.koyeb.app/internal/maintenance`
3. Schedule: every **10 minutes** (or 15).
4. *Advanced* → Request method **POST**; add header `Authorization: Bearer <MAINTENANCE_SECRET>`.
5. Save → *Test run* → expect HTTP 200 with JSON like `{"ok":true,"expired":0,"retriedRevokes":0,"retriedGrants":0,…}`.

curl equivalent:
```bash
curl -X POST -H "Authorization: Bearer $MAINTENANCE_SECRET" https://<app>.koyeb.app/internal/maintenance
```
(The header `X-Maintenance-Secret: <secret>` is also accepted.) This also keeps the free instance warm.

## 7. Website & dashboard

* `/` — landing page (hero, 99 ⭐ / 30 days plan card, comparison table, FAQ, **Subscribe** → `t.me/<bot>?start=subscribe`, **Join Telegram** → `GROUP_INVITE_LINK`).
* `/admin` — sign in with your Telegram id + password from `/setpassword`. Shows group members, active premium, expired, successful payments, Stars earned, auto-renew count, group configuration status, bot/webhook status, last sync, recent payments, subscriber search/filter, user details (incl. live group status & tag), manual **Grant** (1–365 days) / **Revoke**, and a manual sync button.

Security: scrypt password hashes, 5 failed logins → 15 min lock, rate limits on login/API/maintenance/public endpoints, DB-stored sessions (only SHA-256 of the token is stored) in `HttpOnly; Secure; SameSite=Strict` `__Host-` cookies, CSRF header check on all writes, Helmet + strict CSP (no inline scripts), parameterised SQL everywhere, constant-time secret comparisons, logs redact the bot token and DB URL. The browser only receives bot username, invite link and price.

## 8. Local development & testing

```bash
cp .env.example .env    # fill in values; DATABASE_SSL=false for local Postgres
npm install
set -a; . ./.env; set +a
npm run check           # syntax check of every file
npm test                # integration tests (USE A THROWAWAY DATABASE)
npm start               # http://localhost:8000
```
For real Telegram testing locally, expose the port with an HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:8000`) and use that URL as `BASE_URL`. Don’t run two instances with different `BASE_URL`s for the same bot — the last one to boot owns the webhook.

**End-to-end test checklist (real Telegram)**
1. `/healthz` returns `db:true, bot:true, webhook:true`.
2. As admin: `/setup` → all ✅ → Apply. A non-admin test account can now send text but not photos.
3. Test account: `/subscribe` → pay 99 ⭐ (Stars can be bought in Telegram. The dashboard has no refund button; refunds use the Bot API `refundStarPayment` method, and the bot handles the resulting `refunded_payment` update by revoking premium). Expect the “Welcome to Premium” message, photo sending enabled, `PREMIUM` tag visible, a row in *Recent payments*.
4. `/status` shows expiry, remaining time, auto-renew ON. `/cancel_subscription` → confirm → auto-renew OFF, access kept.
5. Dashboard → Revoke → photos disabled, tag removed, status REVOKED. Grant 1 day → enabled again.
6. Expiry: in a test DB run `UPDATE subscriptions SET expires_at = now() - interval '1 minute' WHERE telegram_id = <id>;` then call `/internal/maintenance` → status EXPIRED, tag removed, photos off, user notified.
7. Replay: re-sending the same `successful_payment` (same charge id) does not extend the expiry (covered by `npm test`).
8. Webhook security: `curl -X POST https://<app>/telegram/webhook` without the secret header → 401.

## 9. Limitations & honest notes

* **Per-user permissions vs. group defaults (important).** The Bot API lets `restrictChatMember` set `can_send_photos: true` for a user, but in Telegram clients a member’s effective rights are generally capped by the group’s default permissions (exceptions can only *further restrict*). If, in your group, premium users still can’t send photos while the group default is “photos off”, switch to **`PHOTO_MODE=guard`**: `/setup` then leaves photos enabled in the defaults (everything else still off), and the bot instantly deletes photos from non-premium members (requires *Delete messages*) and replies with a Subscribe button. Premium users still get the `restrictChatMember` (with `until_date`) and the `PREMIUM` tag. Test once in your group after setup to see which mode you need.
* **`setChatMemberTag` / `can_manage_tags` are new (Bot API 9.x/10.x era).** They only work for *regular members* (not admins/owner), require the bot to have *Manage tags*, the tag is max 16 characters, no emoji. Admins who subscribe are recorded as premium but their tag/permissions are not changed (by design). Old Telegram clients may not show tags.
* **Tags don’t expire on their own.** Unlike permissions (`until_date`), Telegram has no timer for tags, so tag removal happens in the expiry sync — on any bot activity, dashboard use, boot, or the external cron. Use the cron for timely removal.
* **Stars subscriptions**: `subscription_period` must be exactly 2592000 and price ≤ 10000 Stars. The invoice **link** is used (subscriptions are created via `createInvoiceLink`; `sendInvoice` has no `subscription_period`). Users can also cancel from Telegram’s own *Settings → My Stars*; Telegram does not send the bot an update for that, so `/status` may show auto-renew ON until the period ends without a renewal payment — expiry then happens normally.
* **Which charge id cancels?** `editUserStarSubscription` needs “the Telegram payment identifier for the subscription”. The bot stores the first and latest charge ids and tries both.
* `until_date` more than 366 days away = forever in Telegram; manual grants are capped at 365 days.
* **Group member count** comes from `getChatMemberCount`; the Bot API cannot list all members, so the dashboard only lists users who interacted with the bot, paid or joined while the bot was admin.
* Users must have started the bot in a private chat to receive notifications; payments always come through the private chat.
