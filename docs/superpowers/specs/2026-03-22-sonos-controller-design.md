# Sonos Controller — Design Spec
_Date: 2026-03-22_

## Overview

A locally-hosted web controller for a Sonos system. Runs as a Node.js server on the same machine as the user, accessible from any browser on the local network. No cloud dependency, no Sonos account required — communicates directly with Sonos devices via their UPnP/SOAP HTTP API on port 1400.

## Goals

- Full playback control: play, pause, skip, seek
- Per-room volume control
- Room grouping (join/unjoin)
- Now-playing display with album art, track/artist/album
- Playback queue: view and clear
- Real-time updates pushed to the browser (no manual refresh)
- Dark Premium visual style (dark background, yellow-green accents, inspired by Spotify/Apple Music)

## Non-Goals

- No Sonos account / cloud API integration
- No mobile-native app
- No multi-user authentication
- No playlist/library browsing (queue management only)
- No queue reorder (view and clear only)
- No music source switching (Apple Music, Spotify, Radio — display only)

## Architecture

### Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla JS + CSS (no framework, no build step)
- **Real-time:** Server-Sent Events (SSE) — server polls Sonos devices every 2s, pushes state changes to all connected browser clients
- **Sonos communication:** Direct HTTP/SOAP calls to each device on port 1400

### File Structure

```
sonos-controller/
├── server.js          # Express server: static files, REST API, SSE, Sonos SOAP proxy
├── package.json
└── public/
    ├── index.html     # Single-page app shell (two-column dashboard layout)
    ├── style.css      # Dark Premium theme
    └── app.js         # All frontend logic
```

### Device Discovery

On startup, `server.js` discovers Sonos devices via mDNS by browsing the `_sonos._tcp` service type (using the `multicast-dns` npm package). This is verified working — Sonos devices advertise this service alongside SSDP. Discovered devices are stored in memory with their IP, port 1400, RINCON ID (e.g. `RINCON_000E58830A96`), room name, and model. Discovery re-runs every 60s to handle devices coming online/offline.

The server also calls `GetZoneGroupState` on any online device (via `ZoneGroupTopology:1` SOAP service) to determine group topology — which devices are coordinators and which are members. Transport state and track metadata are polled from coordinators only; volume is polled from every device individually (each speaker has its own independent volume).

### Backend API

All endpoints return JSON. The `:id` parameter is the RINCON ID of the device (e.g. `RINCON_000E58830A96`). All outbound SOAP calls have a 3s timeout; if a device doesn't respond within that window it is marked `offline`. Sonos SOAP errors are mapped to appropriate HTTP status codes.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/rooms` | List all rooms with current state (transport, track, volume, group membership) |
| `POST` | `/api/rooms/:id/play` | Resume playback |
| `POST` | `/api/rooms/:id/pause` | Pause playback |
| `POST` | `/api/rooms/:id/next` | Skip to next track |
| `POST` | `/api/rooms/:id/prev` | Skip to previous track |
| `POST` | `/api/rooms/:id/seek` | Seek — body: `{ position: "HH:MM:SS" }` |
| `POST` | `/api/rooms/:id/volume` | Set volume — body: `{ volume: 0-100 }` |
| `POST` | `/api/rooms/:id/group` | Join/unjoin group — body: `{ coordinatorId: string \| null }` |
| `GET` | `/api/rooms/:id/queue` | Fetch current queue (track list) — `:id` must be a coordinator; server returns 400 if a member ID is provided |
| `DELETE` | `/api/rooms/:id/queue` | Clear queue — same coordinator requirement |
| `GET` | `/events` | SSE stream — emits `state` events with full room state JSON |

### SSE State Push

The server maintains a poll loop (2s interval) that queries every discovered Sonos coordinator for transport state, current track metadata, and volume. When any value changes, it broadcasts a `state` event to all connected SSE clients containing the full room state array.

**Room state object schema** (emitted per room in the `state` event payload):
```json
{
  "id": "RINCON_000E58830A96",
  "name": "Living Room",
  "model": "Sonos Play:5",
  "online": true,
  "isCoordinator": true,
  "groupCoordinatorId": "RINCON_000E58830A96",
  "state": "PLAYING",
  "volume": 75,
  "track": {
    "title": "Track Title",
    "artist": "Artist Name",
    "album": "Album Name",
    "artUri": "http://192.168.1.133:1400/getaa?...",
    "duration": "0:03:45",
    "position": "0:01:20"
  }
}
```
`track` is `null` when no media is loaded (state `STOPPED` or `NO_MEDIA_PRESENT`).
```
```

The browser `EventSource` will reconnect automatically after a disconnect with a fixed 3s delay (per the SSE spec). No additional reconnect logic is needed.

### Frontend

`index.html` defines the two-column dashboard shell. `app.js` is responsible for all behaviour:

1. **Init:** `GET /api/rooms` → render all room cards
2. **Real-time:** `EventSource('/events')` → on each `state` event, store the received state in a JS object keyed by RINCON ID, then update only the DOM elements whose values have changed (track title, progress bar, volume, play/pause icon). For member rooms (`isCoordinator: false`), track and progress data is read from the state entry whose `id` matches `groupCoordinatorId`; volume is read from the member's own state entry.
3. **Controls:** each button/slider fires a `fetch` POST/DELETE to the relevant API endpoint; apply an optimistic UI update immediately, then the next SSE tick reconciles to ground truth. On fetch error (non-2xx), show a brief error toast and revert the optimistic update
4. **Seek bar:** `mousedown` → capture, `mousemove` → scrub preview, `mouseup` → POST seek
5. **Volume:** `input` event on range slider → debounced POST (100ms) to avoid flooding the device

### UI Layout (Two-Column Dashboard)

```
┌─────────────────────────────────────────────┐
│  ◈ Sonos                          3 rooms   │  ← header
├───────────────────┬─────────────────────────┤
│  Now Playing      │  Rooms                  │
│  [album art]      │  Living Room  ████░ 75  │
│  Track / Artist   │  Master Bed   ████░ 40  │
│  [progress bar]   ├─────────────────────────┤
│  ⏮  ⏸  ⏭       │  Grouping               │
├───────────────────│  Living Room  [on]      │
│  Queue            │  Master Bed   [off]     │
│  ▶ Current track  │                         │
│    Next track     │                         │
│    ...            │                         │
└───────────────────┴─────────────────────────┘
```

_Source switching is out of scope (Non-Goals)._

## Data Flow

```
Browser ──SSE──► server.js ──poll(2s)──► Sonos devices
Browser ──REST─► server.js ──SOAP──────► Sonos devices
```

## Error Handling

- Device unreachable / SOAP timeout (3s): mark room as `offline` in state, show greyed-out card in UI
- SOAP fault: log server-side, return `502` with human-readable message
- Control POST failure (4xx/5xx): revert optimistic UI update, show brief error toast
- SSE disconnect: browser `EventSource` auto-reconnects after a fixed 3s delay (per SSE spec)

## Dependencies (npm)

- `express` — HTTP server and static file serving
- `multicast-dns` — mDNS browsing for `_sonos._tcp` device discovery
- `xml2js` — parse Sonos SOAP XML responses

## Running

```bash
npm install
node server.js
# Open http://localhost:3000
```

Port defaults to `3000`. Override with the `PORT` environment variable: `PORT=8080 node server.js`.
