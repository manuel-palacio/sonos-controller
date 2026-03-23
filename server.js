const express = require('express');
const http = require('http');
const path = require('path');
const sonos = require('./lib/sonos');
const { startDiscovery } = require('./lib/discovery');
const { StateStore } = require('./lib/state');

const app = express();
const store = new StateStore();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SSE
const sseClients = new Set();
app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (rooms) => res.write(`data: ${JSON.stringify(rooms)}\n\n`);
  sseClients.add(send);
  send(store.getRooms());
  req.on('close', () => sseClients.delete(send));
});
store.on('state', (rooms) => { for (const s of sseClients) s(rooms); });

// Helpers
function getDevice(req, res) {
  const d = store.getDeviceByRincon(req.params.id);
  if (!d) { res.status(404).json({ error: 'Room not found' }); return null; }
  return d;
}
function getCoordinator(req, res) {
  const room = store.getRooms().find((r) => r.id === req.params.id);
  if (!room) { res.status(404).json({ error: 'Room not found' }); return null; }
  if (!room.isCoordinator) { res.status(400).json({ error: 'Room is not a group coordinator' }); return null; }
  return store.getDeviceByRincon(req.params.id);
}
async function wrap(res, fn) {
  try { await fn(); } catch (e) { console.error(e.message); if (!res.headersSent) res.status(502).json({ error: e.message }); }
}

// Routes
app.get('/api/rooms', (req, res) => res.json(store.getRooms()));
app.post('/api/rooms/:id/play',  async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.play(d.ip); res.json({ok:true}); }); });
app.post('/api/rooms/:id/pause', async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.pause(d.ip); res.json({ok:true}); }); });
app.post('/api/rooms/:id/next',  async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.next(d.ip); res.json({ok:true}); }); });
app.post('/api/rooms/:id/prev',  async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.previous(d.ip); res.json({ok:true}); }); });

app.post('/api/rooms/:id/seek', async (req, res) => {
  const d = getDevice(req,res); if(!d) return;
  const positionRe = /^\d+:\d{2}:\d{2}$/;
  if (!req.body.position || !positionRe.test(req.body.position))
    return res.status(400).json({ error: 'position must be H:MM:SS or HH:MM:SS' });
  await wrap(res, async () => { await sonos.seek(d.ip, req.body.position); res.json({ok:true}); });
});

app.post('/api/rooms/:id/volume', async (req, res) => {
  const d = getDevice(req,res); if(!d) return;
  const { volume } = req.body;
  if (typeof volume !== 'number' || volume < 0 || volume > 100)
    return res.status(400).json({ error: 'volume must be 0-100' });
  await wrap(res, async () => { await sonos.setVolume(d.ip, volume); res.json({ok:true}); });
});

app.post('/api/rooms/:id/group', async (req, res) => {
  const d = getDevice(req,res); if(!d) return;
  await wrap(res, async () => {
    if (req.body.coordinatorId) await sonos.joinGroup(d.ip, req.body.coordinatorId);
    else await sonos.leaveGroup(d.ip);
    res.json({ok:true});
  });
});

app.get('/api/rooms/:id/queue',    async (req, res) => { const d = getCoordinator(req,res); if(!d) return; await wrap(res, async () => res.json(await sonos.getQueue(d.ip))); });
app.delete('/api/rooms/:id/queue', async (req, res) => { const d = getCoordinator(req,res); if(!d) return; await wrap(res, async () => { await sonos.clearQueue(d.ip); res.json({ok:true}); }); });

// Playlists (Sonos saved queues)
app.get('/api/playlists', async (req, res) => {
  const device = store.getRooms().find((r) => r.isCoordinator && r.online);
  if (!device) return res.status(503).json({ error: 'No online coordinator' });
  const d = store.getDeviceByRincon(device.id);
  await wrap(res, async () => {
    const playlists = await sonos.getSavedQueues(d.ip);
    // Rewrite relative art URIs through our proxy
    playlists.forEach((p) => {
      if (p.artUri && p.artUri.startsWith('/'))
        p.artUri = `/api/art?url=${encodeURIComponent(`http://${d.ip}:1400${p.artUri}`)}`;
    });
    res.json(playlists);
  });
});

app.post('/api/rooms/:id/playlist', async (req, res) => {
  const d = getCoordinator(req, res); if (!d) return;
  const { sqId, resUri, title } = req.body;
  if (!sqId || !/^SQ:\d+$/.test(sqId)) return res.status(400).json({ error: 'invalid sqId' });
  if (!resUri) return res.status(400).json({ error: 'resUri required' });
  await wrap(res, async () => { await sonos.playPlaylist(d.ip, d.id, sqId, resUri, title || ''); res.json({ ok: true }); });
});

// Album art proxy — fetches from Sonos device server-side to avoid browser 404s
app.get('/api/art', (req, res) => {
  const url = req.query.url;
  if (!url || !/^http:\/\/[\d.]+:1400\//.test(url)) return res.status(400).end();
  http.get(url, (sonosRes) => {
    console.log(`Art proxy ${url} → ${sonosRes.statusCode}`);
    if (sonosRes.statusCode !== 200) { sonosRes.resume(); return res.status(sonosRes.statusCode).end(); }
    res.set('Content-Type', sonosRes.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=60');
    sonosRes.pipe(res);
  }).on('error', (e) => { console.error('Art proxy error:', e.message); res.status(502).end(); });
});

// Startup
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const stop = startDiscovery((device) => {
    console.log(`Discovered: ${device.name} (${device.model}) at ${device.ip}`);
    store.registerDevice(device);
  });
  store.startPolling(2000);
  app.listen(PORT, () => console.log(`Sonos controller on http://localhost:${PORT}`));
  process.on('SIGTERM', () => { stop(); store.stopPolling(); process.exit(0); });
}

module.exports = app;
