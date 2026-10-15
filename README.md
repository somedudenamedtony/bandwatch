# Band Watch

**Live site:** https://somedudenamedtony.github.io/bandwatch/

A static web app that shows ham band conditions for any location, built from [PSK Reporter](https://pskreporter.info) reception reports.

Enter a Maidenhead grid (`FN31`), US ZIP (`06103`) or city (`Denver, CO`). For that 4-character grid square, the app lists every band with:

- **Local TX / RX**: distinct stations in the square that were active
- **Heard by / Stns heard**: distinct stations worldwide that heard the area, or that the area heard
- **Spots**, **DXCC entities**, **best DX** (farthest station) and **median SNR**
- **Modes**: distinct stations per mode

It also shows a band × mode heat table and a map of every station involved. Click a band to filter the map and list its farthest stations and top countries.

There are two directions:

- **Stations in the area being heard**: transmitters in the square, and who decoded them. This shows which bands are open *from* there.
- **What stations in the area hear**: receivers in the square, and what they decoded.

Links are shareable, for example `?q=FN31&dir=tx&win=3600`.

## How it works

Everything runs in the browser, so there is no server and no API keys.

- PSK Reporter's `retrieve.pskreporter.info/query` is called with `modify=grid` to match every station in the grid square. That endpoint sends no CORS headers, so the app uses its JSONP `callback` parameter. The callback name must be alphanumeric because the server strips other characters.
- Locations are geocoded with OpenStreetMap Nominatim. The map uses Leaflet with OSM tiles.
- PSK Reporter asks clients to wait at least 5 minutes between queries. Results are cached per tab for 5 minutes, and Refresh stays locked until then.

## Deploy to GitHub Pages

1. Create an empty public repo on GitHub, for example `band-watch`.
2. From this folder, run:
   ```bash
   git init -b main
   git add .
   git commit -m "Band Watch"
   git remote add origin https://github.com/<you>/band-watch.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, then select `main` and `/ (root)`.
4. The site goes live at `https://<you>.github.io/band-watch/` within a minute or two.

## Run locally

Serve the folder with any static server:

```bash
npx http-server@14.1.1 . -p 8642
```

Opening `index.html` directly from disk also mostly works, but Nominatim may reject requests that have no referrer.
