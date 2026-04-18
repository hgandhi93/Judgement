# Render recovery steps

The current repository contains an older `server.js` that tries to unzip `app.html.b64` too aggressively.
If Render shows `{\"error\":\"incorrect data check\"}`, switch the service to the safer entrypoint added in this repo.

## Recommended Render setup

1. Open your Render dashboard.
2. Open the `judgement` web service.
3. Go to **Settings**.
4. Under **Build & Deploy**, set **Start Command** to:

```bash
node fixed-server.js
```

5. Keep the **Build Command** empty.
6. Save changes.
7. Click **Manual Deploy** and choose **Deploy latest commit**.
8. Wait for the deploy to finish.
9. Open the service URL.
10. Create a room and test joining from a second phone or browser.

## What this uses

- `fixed-server.js`: safer server entrypoint for Render
- `app.html.b64`: existing bundled live frontend
- `rooms-store.json`: runtime room storage file

## Important note about persistence

Render free web services do not guarantee durable local disk storage across restarts or redeploys.
That means room state may reset if the service restarts.
If you want rooms to survive restarts, move room state to a database such as Render Postgres.

## Local network option

If you do not want to deploy yet, you can also run locally with:

```bash
node server.js
```

Then open the LAN URL shown in the terminal from other devices on the same Wi-Fi network.
