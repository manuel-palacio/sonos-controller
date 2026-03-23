# Sonos Controller

A locally-hosted web controller for Sonos. No cloud, no account — talks directly to your devices over the local network.

## Features

- Play, pause, skip, seek
- Per-room volume control
- Room grouping (join/unjoin)
- Now-playing display with album art
- Queue view and clear
- Real-time updates via Server-Sent Events

## Requirements

- Node.js 18+
- Sonos devices on the same local network

## Setup

```bash
npm install
node server.js
```

Open http://localhost:3000 in your browser.

Override the default port:

```bash
PORT=8080 node server.js
```

## How it works

On startup, the server discovers Sonos devices via mDNS (`_sonos._tcp`) and polls them every 2 seconds for state changes. The browser receives live updates over SSE — no manual refresh needed.

All communication goes directly to Sonos devices on port 1400 via UPnP/SOAP. No internet connection required.

## Development

```bash
npm test
```
