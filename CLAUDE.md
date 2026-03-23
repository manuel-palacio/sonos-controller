# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
node server.js          # start the server (default port 3000, override with PORT=)
npm test                # run all Jest tests
npm test -- --testPathPattern=<file>  # run a single test file
```

There is no build or lint step.

## Architecture

The server discovers Sonos devices on the local network and exposes a REST + SSE API consumed by a single-page browser UI.

### Request flow

```
Browser ←──SSE──── server.js ←── StateStore (polls every 2s)
Browser ──REST──→  server.js ──→ lib/sonos.js ──→ lib/soap.js ──→ Sonos device :1400
```

**`lib/soap.js`** — raw UPnP SOAP transport. All Sonos communication goes through `soapCall(ip, servicePath, action, bodyXml)`. Sonos returns HTTP 500 for errors; the module reads the `s:Fault` body and rejects with the UPnP error description + code.

**`lib/discovery.js`** — mDNS discovery via `_sonos._tcp.local` PTR records, re-queried every 15 s. On each new IP it fetches `/xml/device_description.xml` to get the device's RINCON UUID (`UDN` field, with `uuid:` prefix stripped — **do not truncate this further**).

**`lib/sonos.js`** — typed wrappers over SOAP for AVTransport, RenderingControl, ContentDirectory, and ZoneGroupTopology services. Key subtleties:
- `parseTrackMetadata` extracts `artUri` from the *raw* (not URI-decoded) metadata string to preserve percent-encoding needed by the Sonos `/getaa` endpoint, then decodes XML entities (`&amp;` → `&`).
- `playPlaylist(ip, rinconId, sqId, resUri, title)` uses the sequence: `RemoveAllTracksFromQueue` → `AddURIToQueue` (with `file:///jffs/settings/savedqueues.rsq#N` URI) → `SetAVTransportURI` (`x-rincon-queue:RINCON#0`) → `Seek TRACK_NR 1` → `Play`. Using `x-rincon-cpcontainer` directly returns error 714 ("Illegal MIME type") and must not be used for saved queues.

**`lib/state.js`** — `StateStore` extends `EventEmitter`. It maintains device registry (`_devices` Map keyed by RINCON UUID) and room state (`_state` Map). The poll loop: fetch ZoneGroupTopology from any reachable device → update `isCoordinator`/`groupCoordinatorId` for all members → fetch volume + transport state + position for each device. Emits `'state'` with the full rooms array after every poll cycle.

**`server.js`** — Express app. SSE clients subscribe at `GET /events` and receive the rooms array on every `'state'` event. The `/api/art` route proxies album art from Sonos devices server-side (browser cannot reach `device-ip:1400` directly). Playlist routes enforce `sqId` format `SQ:\d+`.

**`public/`** — vanilla JS SPA (`app.js`) + CSS (`style.css`). Uses `EventSource` for live updates. DOM is built with the `mk()` helper (no template-literal HTML) to avoid XSS. `secToHms` always returns `H:MM:SS` (three segments) because the server's seek endpoint validates that exact format.

### Sonos ContentDirectory object IDs

| ID | Contents |
|----|----------|
| `SQ:` | Saved queues / playlists |
| `Q:0` | Current play queue |
| `FV:2` | Sonos Favorites |
| `A:PLAYLIST` | Local music library playlists |

Use `sonos.browseRaw(ip, objectId)` to inspect raw ContentDirectory responses during development.
