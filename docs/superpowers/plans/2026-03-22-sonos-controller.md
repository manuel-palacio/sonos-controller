# Sonos Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally-hosted Node.js web server with a dark-premium browser UI to fully control a Sonos system over the local network via UPnP/SOAP.

**Architecture:** Express serves a single-page vanilla JS dashboard. A backend poll loop queries Sonos devices every 2s via direct HTTP/SOAP calls and broadcasts state changes over SSE. A thin REST API proxies all control commands (play, pause, seek, volume, grouping, queue) to the appropriate Sonos device. Device discovery uses mDNS (`_sonos._tcp`).

**Tech Stack:** Node.js, Express, multicast-dns, xml2js, Jest, nock, supertest

---

## File Map

| File | Responsibility |
|------|----------------|
| `package.json` | Project metadata and npm dependencies |
| `lib/soap.js` | Raw HTTP SOAP call with 3s timeout; XML response parser |
| `lib/sonos.js` | All Sonos operations (play, pause, next, prev, seek, volume, queue, grouping, state queries, metadata parsing) |
| `lib/discovery.js` | mDNS discovery via `_sonos._tcp`; fetches device_description.xml to get RINCON ID + room name |
| `lib/state.js` | In-memory device store + 2s poll loop; emits `state` events via EventEmitter |
| `server.js` | Express app: static files, all REST routes, SSE endpoint, startup wiring |
| `public/index.html` | Two-column dashboard HTML shell |
| `public/style.css` | Dark Premium theme |
| `public/app.js` | Frontend: SSE listener, render loop, all UI controls |
| `tests/soap.test.js` | SOAP helper unit tests (nock) |
| `tests/sonos.test.js` | Sonos operations unit tests (jest.mock soap) |
| `tests/discovery.test.js` | Discovery unit tests (nock) |
| `tests/state.test.js` | State store + poller unit tests (jest.mock sonos) |
| `tests/routes.test.js` | REST API integration tests (supertest + jest.mock) |

---

## Task 1: Project Setup

**Files:** `package.json`, `.gitignore`, `lib/`, `tests/`, `public/`, `server.js` stub

- [ ] **Step 1: Initialise git repo**
```bash
cd /Users/manuel.palacio/Code/sonos-controller && git init
```

- [ ] **Step 2: Create `.gitignore`**
```
node_modules/
.superpowers/
```

- [ ] **Step 3: Create `package.json`**
```json
{
  "name": "sonos-controller",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "express": "^4.19.2",
    "multicast-dns": "^7.2.5",
    "xml2js": "^0.6.2"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "nock": "^13.5.4",
    "supertest": "^7.0.0"
  },
  "jest": { "testEnvironment": "node" }
}
```

- [ ] **Step 4: Install dependencies**
```bash
npm install
```
Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Create directories**
```bash
mkdir -p lib tests public
```

- [ ] **Step 6: Create stub `server.js`**
```js
const express = require('express');
const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
if (require.main === module) {
  app.listen(process.env.PORT || 3000,
    () => console.log(`Sonos controller running on http://localhost:${process.env.PORT || 3000}`));
}
module.exports = app;
```

- [ ] **Step 7: Verify**
Start in background, test, stop: `node server.js & sleep 1 && curl http://localhost:3000/health && kill %1`
Expected: `{"ok":true}`

- [ ] **Step 8: Commit**
```bash
git add package.json package-lock.json .gitignore server.js && git commit -m "chore: project setup"
```

---

## Task 2: SOAP Helper (`lib/soap.js`)

**Files:** `lib/soap.js`, `tests/soap.test.js`

`★ Insight ─────────────────────────────────────`
Sonos uses UPnP SOAP: each call is an HTTP POST with a `SOAPAction` header and an XML body in `<s:Envelope>`. `xml2js` with `explicitArray: false` converts single-child elements to plain strings rather than arrays, making response field access much cleaner throughout.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write failing tests** — create `tests/soap.test.js`:
```js
const nock = require('nock');
const { soapCall } = require('../lib/soap');
afterEach(() => nock.cleanAll());

test('sends correct headers and returns parsed XML', async () => {
  nock('http://192.168.1.1:1400')
    .post('/MediaRenderer/AVTransport/Control', (b) => b.includes('<u:Play'))
    .matchHeader('SOAPAction', '"urn:schemas-upnp-org:service:AVTransport:1#Play"')
    .reply(200, `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"/></s:Body></s:Envelope>`);
  const result = await soapCall('192.168.1.1', '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#Play',
    '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>');
  expect(result['s:Envelope']['s:Body']['u:PlayResponse']).toBeDefined();
});

test('rejects when device does not respond within timeout', async () => {
  nock('http://192.168.1.1:1400').post('/path').delayConnection(500).reply(200, '');
  await expect(soapCall('192.168.1.1', '/path', 'action', '<body/>', 100)).rejects.toThrow();
}, 2000);

test('rejects when host is unreachable', async () => {
  nock('http://192.168.1.99:1400').post('/path').replyWithError('ECONNREFUSED');
  await expect(soapCall('192.168.1.99', '/path', 'action', '<body/>')).rejects.toThrow();
});
```

- [ ] **Step 2: Run — verify FAIL**
```bash
npx jest tests/soap.test.js --no-coverage
```
Expected: FAIL — `Cannot find module '../lib/soap'`

- [ ] **Step 3: Implement `lib/soap.js`**
```js
const http = require('http');
const xml2js = require('xml2js');

function soapCall(ip, service, action, body, timeoutMs = 3000) {
  const envelope = '<?xml version="1.0"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body>${body}</s:Body></s:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: ip, port: 1400, path: service, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${action}"`,
        'Content-Length': Buffer.byteLength(envelope),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        xml2js.parseString(data, { explicitArray: false }, (err, result) => {
          if (err) return reject(new Error(`XML parse error: ${err.message}`));
          resolve(result);
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`SOAP timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

module.exports = { soapCall };
```

- [ ] **Step 4: Run — verify PASS**
```bash
npx jest tests/soap.test.js --no-coverage
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**
```bash
git add lib/soap.js tests/soap.test.js && git commit -m "feat: add SOAP helper with timeout and XML parsing"
```

---

## Task 3: Sonos Operations (`lib/sonos.js`)

**Files:** `lib/sonos.js`, `tests/sonos.test.js`

`★ Insight ─────────────────────────────────────`
Sonos encodes track metadata as a URL-encoded DIDL-Lite XML string inside the SOAP `TrackMetaData` field. It uses Dublin Core (`dc:title`, `dc:creator`) and UPnP metadata namespaces. Regex extraction is used instead of a nested xml2js parse to keep each poll tick fast and synchronous.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write failing tests** — create `tests/sonos.test.js`:
```js
jest.mock('../lib/soap');
const { soapCall } = require('../lib/soap');
const sonos = require('../lib/sonos');

const resp = (action, fields = {}) =>
  ({ 's:Envelope': { 's:Body': { [`u:${action}Response`]: fields } } });

beforeEach(() => jest.clearAllMocks());

test('play() calls AVTransport Play', async () => {
  soapCall.mockResolvedValue(resp('Play'));
  await sonos.play('192.168.1.1');
  expect(soapCall).toHaveBeenCalledWith('192.168.1.1', '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#Play', expect.stringContaining('<u:Play'));
});

test('pause() calls AVTransport Pause', async () => {
  soapCall.mockResolvedValue(resp('Pause'));
  await sonos.pause('192.168.1.1');
  expect(soapCall).toHaveBeenCalledWith('192.168.1.1', '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#Pause', expect.stringContaining('<u:Pause'));
});

test('setVolume() sends DesiredVolume', async () => {
  soapCall.mockResolvedValue(resp('SetVolume'));
  await sonos.setVolume('192.168.1.1', 75);
  expect(soapCall).toHaveBeenCalledWith('192.168.1.1', '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1#SetVolume',
    expect.stringContaining('<DesiredVolume>75</DesiredVolume>'));
});

test('getVolume() returns integer', async () => {
  soapCall.mockResolvedValue(resp('GetVolume', { CurrentVolume: '75' }));
  expect(await sonos.getVolume('192.168.1.1')).toBe(75);
});

test('getTransportInfo() returns state string', async () => {
  soapCall.mockResolvedValue(resp('GetTransportInfo', { CurrentTransportState: 'PLAYING' }));
  expect(await sonos.getTransportInfo('192.168.1.1')).toBe('PLAYING');
});

test('getPositionInfo() parses DIDL-Lite metadata', async () => {
  const meta = encodeURIComponent(
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
    + '<item><dc:title>My Song</dc:title><dc:creator>The Artist</dc:creator>'
    + '<upnp:album>The Album</upnp:album>'
    + '<upnp:albumArtURI>http://192.168.1.1:1400/getaa?foo</upnp:albumArtURI>'
    + '</item></DIDL-Lite>');
  soapCall.mockResolvedValue(resp('GetPositionInfo',
    { TrackMetaData: meta, RelTime: '0:01:23', TrackDuration: '0:03:45' }));
  const info = await sonos.getPositionInfo('192.168.1.1');
  expect(info.track.title).toBe('My Song');
  expect(info.track.artist).toBe('The Artist');
  expect(info.track.album).toBe('The Album');
  expect(info.track.artUri).toBe('http://192.168.1.1:1400/getaa?foo');
  expect(info.position).toBe('0:01:23');
  expect(info.duration).toBe('0:03:45');
});

test('getPositionInfo() returns null track for NOT_IMPLEMENTED', async () => {
  soapCall.mockResolvedValue(resp('GetPositionInfo',
    { TrackMetaData: 'NOT_IMPLEMENTED', RelTime: '0:00:00', TrackDuration: '0:00:00' }));
  expect((await sonos.getPositionInfo('192.168.1.1')).track).toBeNull();
});

test('seek() sends REL_TIME position', async () => {
  soapCall.mockResolvedValue(resp('Seek'));
  await sonos.seek('192.168.1.1', '0:01:30');
  expect(soapCall).toHaveBeenCalledWith('192.168.1.1', '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#Seek',
    expect.stringContaining('<Target>0:01:30</Target>'));
});

test('joinGroup() sets URI to x-rincon:<id>', async () => {
  soapCall.mockResolvedValue(resp('SetAVTransportURI'));
  await sonos.joinGroup('192.168.1.2', 'RINCON_000E58830A96');
  expect(soapCall).toHaveBeenCalledWith('192.168.1.2', '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
    expect.stringContaining('x-rincon:RINCON_000E58830A96'));
});

test('leaveGroup() calls BecomeCoordinatorOfStandaloneGroup', async () => {
  soapCall.mockResolvedValue(resp('BecomeCoordinatorOfStandaloneGroup'));
  await sonos.leaveGroup('192.168.1.2');
  expect(soapCall).toHaveBeenCalledWith('192.168.1.2', '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#BecomeCoordinatorOfStandaloneGroup',
    expect.any(String));
});
```

- [ ] **Step 2: Run — verify FAIL**
```bash
npx jest tests/sonos.test.js --no-coverage
```

- [ ] **Step 3: Implement `lib/sonos.js`**
```js
const { soapCall } = require('./soap');

const AVT    = '/MediaRenderer/AVTransport/Control';
const AVT_NS = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC     = '/MediaRenderer/RenderingControl/Control';
const RC_NS  = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CD     = '/MediaServer/ContentDirectory/Control';
const CD_NS  = 'urn:schemas-upnp-org:service:ContentDirectory:1';
const ZGT    = '/ZoneGroupTopology/Control';
const ZGT_NS = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';

const avt = (ip, a, b) => soapCall(ip, AVT, `${AVT_NS}#${a}`, b);

const play     = (ip) => avt(ip, 'Play',     `<u:Play xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>`);
const pause    = (ip) => avt(ip, 'Pause',    `<u:Pause xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:Pause>`);
const next     = (ip) => avt(ip, 'Next',     `<u:Next xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:Next>`);
const previous = (ip) => avt(ip, 'Previous', `<u:Previous xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:Previous>`);
const seek     = (ip, pos) => avt(ip, 'Seek',
  `<u:Seek xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${pos}</Target></u:Seek>`);

async function getTransportInfo(ip) {
  const r = await avt(ip, 'GetTransportInfo',
    `<u:GetTransportInfo xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:GetTransportInfo>`);
  return r['s:Envelope']['s:Body']['u:GetTransportInfoResponse']['CurrentTransportState'];
}

async function getVolume(ip) {
  const r = await soapCall(ip, RC, `${RC_NS}#GetVolume`,
    `<u:GetVolume xmlns:u="${RC_NS}"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume>`);
  return parseInt(r['s:Envelope']['s:Body']['u:GetVolumeResponse']['CurrentVolume'], 10);
}

const setVolume = (ip, v) => soapCall(ip, RC, `${RC_NS}#SetVolume`,
  `<u:SetVolume xmlns:u="${RC_NS}"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${v}</DesiredVolume></u:SetVolume>`);

function parseTrackMetadata(metaStr) {
  if (!metaStr || metaStr === 'NOT_IMPLEMENTED' || !metaStr.includes('<')) return null;
  try {
    const d = decodeURIComponent(metaStr);
    const tag = (t) => (d.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)) || [])[1] || '';
    const title = tag('dc:title'), artist = tag('dc:creator');
    if (!title && !artist) return null;
    return { title, artist, album: tag('upnp:album'), artUri: tag('upnp:albumArtURI') };
  } catch { return null; }
}

async function getPositionInfo(ip) {
  const r = await avt(ip, 'GetPositionInfo',
    `<u:GetPositionInfo xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:GetPositionInfo>`);
  const p = r['s:Envelope']['s:Body']['u:GetPositionInfoResponse'];
  return { track: parseTrackMetadata(p['TrackMetaData']), position: p['RelTime'] || '0:00:00', duration: p['TrackDuration'] || '0:00:00' };
}

async function getZoneGroupState(ip) {
  const r = await soapCall(ip, ZGT, `${ZGT_NS}#GetZoneGroupState`,
    `<u:GetZoneGroupState xmlns:u="${ZGT_NS}"></u:GetZoneGroupState>`);
  return r['s:Envelope']['s:Body']['u:GetZoneGroupStateResponse']['ZoneGroupState'];
}

async function getQueue(ip) {
  const r = await soapCall(ip, CD, `${CD_NS}#Browse`,
    `<u:Browse xmlns:u="${CD_NS}"><ObjectID>Q:0</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>100</RequestedCount><SortCriteria></SortCriteria></u:Browse>`);
  const s = r['s:Envelope']['s:Body']['u:BrowseResponse']['Result'];
  if (!s) return [];
  return [...s.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)].map((m) => {
    const i = m[1], t = (tag) => (i.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)) || [])[1] || '';
    return { title: t('dc:title'), artist: t('dc:creator'), album: t('upnp:album') };
  });
}

const clearQueue = (ip) => avt(ip, 'RemoveAllTracksFromQueue',
  `<u:RemoveAllTracksFromQueue xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>`);
const joinGroup = (ip, coordId) => avt(ip, 'SetAVTransportURI',
  `<u:SetAVTransportURI xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><CurrentURI>x-rincon:${coordId}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>`);
const leaveGroup = (ip) => avt(ip, 'BecomeCoordinatorOfStandaloneGroup',
  `<u:BecomeCoordinatorOfStandaloneGroup xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:BecomeCoordinatorOfStandaloneGroup>`);

module.exports = { play, pause, next, previous, seek, getTransportInfo, getPositionInfo, getVolume, setVolume, getZoneGroupState, getQueue, clearQueue, joinGroup, leaveGroup };
```

- [ ] **Step 4: Run — verify PASS (10 tests)**
```bash
npx jest tests/sonos.test.js --no-coverage
```

- [ ] **Step 5: Commit**
```bash
git add lib/sonos.js tests/sonos.test.js && git commit -m "feat: add Sonos operations with DIDL-Lite metadata parsing"
```

---

## Task 4: Device Discovery (`lib/discovery.js`)

**Files:** `lib/discovery.js`, `tests/discovery.test.js`

`★ Insight ─────────────────────────────────────`
The Sonos UDN in device_description.xml is `uuid:RINCON_000E58830A9601400`. The last 5 digits are a port number appended to the canonical RINCON ID. Stripping `uuid:` and the trailing 5-digit suffix gives `RINCON_000E58830A96`, the ID used throughout the UPnP API.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write failing tests** — create `tests/discovery.test.js`:
```js
const nock = require('nock');
const { buildDeviceFromIp } = require('../lib/discovery');
afterEach(() => nock.cleanAll());

const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>192.168.1.133 - Sonos Play:5</friendlyName>
    <modelName>Sonos Play:5</modelName>
    <roomName>Living Room</roomName>
    <UDN>uuid:RINCON_000E58830A9601400</UDN>
  </device>
</root>`;

test('parses RINCON ID, room name, and model', async () => {
  nock('http://192.168.1.133:1400').get('/xml/device_description.xml').reply(200, DESC);
  const d = await buildDeviceFromIp('192.168.1.133');
  expect(d.ip).toBe('192.168.1.133');
  expect(d.id).toBe('RINCON_000E58830A96');
  expect(d.name).toBe('Living Room');
  expect(d.model).toBe('Sonos Play:5');
});

test('returns null when device is unreachable', async () => {
  nock('http://192.168.1.99:1400').get('/xml/device_description.xml').replyWithError('ECONNREFUSED');
  expect(await buildDeviceFromIp('192.168.1.99')).toBeNull();
});
```

- [ ] **Step 2: Run — verify FAIL**
```bash
npx jest tests/discovery.test.js --no-coverage
```

- [ ] **Step 3: Implement `lib/discovery.js`**
```js
const http = require('http');
const xml2js = require('xml2js');
const mdns = require('multicast-dns');

function buildDeviceFromIp(ip, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: ip, port: 1400, path: '/xml/device_description.xml', method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          xml2js.parseString(data, { explicitArray: false }, (err, result) => {
            if (err) return resolve(null);
            try {
              const dev = result.root.device;
              const id = dev.UDN.replace('uuid:', '').replace(/\d{5}$/, '');
              resolve({ ip, id, name: dev.roomName || dev.friendlyName || '', model: dev.modelName || '' });
            } catch { resolve(null); }
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function startDiscovery(onDevice) {
  const m = mdns();
  const seen = new Set();
  m.on('response', async (response) => {
    const all = [...(response.answers || []), ...(response.additionals || [])];
    // PTR → SRV → A resolution chain: only trust IPs from devices advertised under _sonos._tcp
    const ptrNames = new Set(
      all.filter((r) => r.type === 'PTR' && r.name === '_sonos._tcp.local').map((r) => r.data)
    );
    const srvTargets = new Set(
      all.filter((r) => r.type === 'SRV' && ptrNames.has(r.name)).map((r) => r.data.target)
    );
    for (const record of all) {
      if (record.type === 'A' && srvTargets.has(record.name)) {
        const ip = record.data;
        if (!seen.has(ip)) {
          seen.add(ip);
          const device = await buildDeviceFromIp(ip);
          if (device) onDevice(device);
        }
      }
    }
  });
  m.query({ questions: [{ name: '_sonos._tcp.local', type: 'PTR' }] });
  return () => m.destroy();
}

module.exports = { startDiscovery, buildDeviceFromIp };
```

- [ ] **Step 4: Run — verify PASS (2 tests)**
```bash
npx jest tests/discovery.test.js --no-coverage
```

- [ ] **Step 5: Commit**
```bash
git add lib/discovery.js tests/discovery.test.js && git commit -m "feat: add mDNS device discovery"
```

---

## Task 5: State Store & Poller (`lib/state.js`)

**Files:** `lib/state.js`, `tests/state.test.js`

`★ Insight ─────────────────────────────────────`
Sonos group topology is stored in `ZoneGroup` XML. Each group has a `Coordinator` attribute and `ZoneGroupMember` children. Only the coordinator needs transport/track polling — members inherit those — but **every** device has its own independent volume that must be fetched individually. String.matchAll() provides clean multi-match iteration without mutation.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Write failing tests** — create `tests/state.test.js`:
```js
jest.mock('../lib/sonos');
const sonos = require('../lib/sonos');
const { StateStore } = require('../lib/state');

const TOPO = '<ZoneGroups><ZoneGroup Coordinator="RINCON_AAA" ID="RINCON_AAA:0">'
  + '<ZoneGroupMember UUID="RINCON_AAA" Location="http://192.168.1.1:1400/xml/device_description.xml"/>'
  + '</ZoneGroup></ZoneGroups>';

const dev = (o = {}) => ({ ip: '192.168.1.1', id: 'RINCON_AAA', name: 'Living Room', model: 'Play:5', ...o });
beforeEach(() => jest.clearAllMocks());

test('registerDevice adds device with STOPPED state', () => {
  const store = new StateStore();
  store.registerDevice(dev());
  const rooms = store.getRooms();
  expect(rooms[0].state).toBe('STOPPED');
  expect(rooms[0].track).toBeNull();
  expect(rooms[0].online).toBe(true);
});

test('getDeviceByRincon returns device for known ID', () => {
  const store = new StateStore();
  store.registerDevice(dev());
  expect(store.getDeviceByRincon('RINCON_AAA').ip).toBe('192.168.1.1');
});

test('getDeviceByRincon returns undefined for unknown ID', () => {
  expect(new StateStore().getDeviceByRincon('UNKNOWN')).toBeUndefined();
});

test('_poll updates state and emits state event', async () => {
  sonos.getZoneGroupState.mockResolvedValue(TOPO);
  sonos.getTransportInfo.mockResolvedValue('PLAYING');
  sonos.getPositionInfo.mockResolvedValue({
    track: { title: 'Song', artist: 'Artist', album: 'Album', artUri: '' },
    position: '0:01:00', duration: '0:03:00',
  });
  sonos.getVolume.mockResolvedValue(75);

  const store = new StateStore();
  store.registerDevice(dev());
  const events = [];
  store.on('state', (r) => events.push(r));
  await store._poll();

  expect(events[0][0].state).toBe('PLAYING');
  expect(events[0][0].track.title).toBe('Song');
  expect(events[0][0].volume).toBe(75);
  expect(events[0][0].isCoordinator).toBe(true);
});

test('_poll marks offline when SOAP throws', async () => {
  sonos.getZoneGroupState.mockRejectedValue(new Error('timeout'));
  sonos.getVolume.mockRejectedValue(new Error('timeout'));
  const store = new StateStore();
  store.registerDevice(dev());
  const events = [];
  store.on('state', (r) => events.push(r));
  await store._poll();
  expect(events[0][0].online).toBe(false);
});
```

- [ ] **Step 2: Run — verify FAIL**
```bash
npx jest tests/state.test.js --no-coverage
```

- [ ] **Step 3: Implement `lib/state.js`**
```js
const EventEmitter = require('events');
const sonos = require('./sonos');

class StateStore extends EventEmitter {
  constructor() {
    super();
    this._devices  = new Map();
    this._state    = new Map();
    this._topology = new Map();
    this._pollTimer = null;
  }

  registerDevice(d) {
    this._devices.set(d.id, d);
    this._state.set(d.id, {
      id: d.id, name: d.name, model: d.model,
      online: true, isCoordinator: true, groupCoordinatorId: d.id,
      state: 'STOPPED', volume: 0, track: null, position: '0:00:00', duration: '0:00:00',
    });
  }

  getDeviceByRincon(id) { return this._devices.get(id); }
  getRooms()            { return Array.from(this._state.values()); }

  async _updateTopology() {
    for (const device of this._devices.values()) {
      try { this._parseTopology(await sonos.getZoneGroupState(device.ip)); return; }
      catch { /* try next */ }
    }
  }

  _parseTopology(xml) {
    for (const gm of xml.matchAll(/<ZoneGroup\s+Coordinator="([^"]+)"[^>]*>([\s\S]*?)<\/ZoneGroup>/g)) {
      const coordId = gm[1];
      for (const mm of gm[2].matchAll(/<ZoneGroupMember\s[^>]*UUID="([^"]+)"/g)) {
        this._topology.set(mm[1], { isCoordinator: mm[1] === coordId, groupCoordinatorId: coordId });
      }
    }
  }

  async _poll() {
    await this._updateTopology();
    for (const [id, device] of this._devices) {
      const topo = this._topology.get(id) || { isCoordinator: true, groupCoordinatorId: id };
      const next = { ...this._state.get(id), ...topo };
      try {
        next.volume = await sonos.getVolume(device.ip);
        if (topo.isCoordinator) {
          next.state    = await sonos.getTransportInfo(device.ip);
          const pos     = await sonos.getPositionInfo(device.ip);
          next.track = pos.track
            ? { ...pos.track, position: pos.position, duration: pos.duration }
            : null;
        }
        next.online = true;
      } catch { next.online = false; }
      this._state.set(id, next);
    }
    this.emit('state', this.getRooms());
  }

  startPolling(ms = 2000) { this._poll(); this._pollTimer = setInterval(() => this._poll(), ms); }
  stopPolling()           { if (this._pollTimer) clearInterval(this._pollTimer); }
}

module.exports = { StateStore };
```

- [ ] **Step 4: Run — verify PASS (5 tests)**
```bash
npx jest tests/state.test.js --no-coverage
```

- [ ] **Step 5: Commit**
```bash
git add lib/state.js tests/state.test.js && git commit -m "feat: add state store with topology-aware poll loop"
```

---

## Task 6: Express Server + REST API + SSE (`server.js`)

**Files:** `server.js` (replace stub), `tests/routes.test.js`

- [ ] **Step 1: Write failing tests** — create `tests/routes.test.js`:
```js
jest.mock('../lib/sonos');
jest.mock('../lib/discovery');
jest.mock('../lib/state');

const sonos = require('../lib/sonos');
const { StateStore } = require('../lib/state');
const request = require('supertest');

const mockRooms = [
  { id: 'RINCON_AAA', name: 'Living Room', model: 'Play:5', online: true,
    isCoordinator: true, groupCoordinatorId: 'RINCON_AAA', state: 'PAUSED_PLAYBACK',
    volume: 75, track: { title: 'T', artist: 'A', album: 'B', artUri: '', position: '0:01:00', duration: '0:03:00' } },
  { id: 'RINCON_BBB', name: 'Bedroom', model: 'Play:3', online: true,
    isCoordinator: false, groupCoordinatorId: 'RINCON_AAA', state: 'PAUSED_PLAYBACK',
    volume: 40, track: null },
];

StateStore.mockImplementation(() => ({
  registerDevice: jest.fn(),
  getRooms: jest.fn().mockReturnValue(mockRooms),
  getDeviceByRincon: jest.fn((id) => {
    if (id === 'RINCON_AAA') return { ip: '192.168.1.1', id: 'RINCON_AAA' };
    if (id === 'RINCON_BBB') return { ip: '192.168.1.2', id: 'RINCON_BBB' };
    return undefined;
  }),
  startPolling: jest.fn(),
  on: jest.fn(),
}));

let app;
beforeAll(() => { app = require('../server'); });
afterAll(() => { jest.resetModules(); });
beforeEach(() => jest.clearAllMocks());

test('GET /api/rooms returns rooms', async () => {
  const res = await request(app).get('/api/rooms');
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(2);
});

test('POST /api/rooms/:id/play calls sonos.play', async () => {
  sonos.play.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_AAA/play');
  expect(res.status).toBe(200);
  expect(sonos.play).toHaveBeenCalledWith('192.168.1.1');
});

test('POST /api/rooms/:id/pause calls sonos.pause', async () => {
  sonos.pause.mockResolvedValue({});
  expect((await request(app).post('/api/rooms/RINCON_AAA/pause')).status).toBe(200);
  expect(sonos.pause).toHaveBeenCalledWith('192.168.1.1');
});

test('POST /api/rooms/:id/volume sets volume', async () => {
  sonos.setVolume.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_AAA/volume').send({ volume: 50 });
  expect(res.status).toBe(200);
  expect(sonos.setVolume).toHaveBeenCalledWith('192.168.1.1', 50);
});

test('POST /api/rooms/:id/volume rejects out-of-range', async () => {
  expect((await request(app).post('/api/rooms/RINCON_AAA/volume').send({ volume: 150 })).status).toBe(400);
});

test('POST /api/rooms/:id/group with id calls joinGroup', async () => {
  sonos.joinGroup.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_BBB/group').send({ coordinatorId: 'RINCON_AAA' });
  expect(res.status).toBe(200);
  expect(sonos.joinGroup).toHaveBeenCalledWith('192.168.1.2', 'RINCON_AAA');
});

test('POST /api/rooms/:id/group with null calls leaveGroup', async () => {
  sonos.leaveGroup.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_BBB/group').send({ coordinatorId: null });
  expect(res.status).toBe(200);
  expect(sonos.leaveGroup).toHaveBeenCalledWith('192.168.1.2');
});

test('GET /api/rooms/:id/queue returns queue for coordinator', async () => {
  sonos.getQueue.mockResolvedValue([{ title: 'T', artist: 'A', album: 'B' }]);
  const res = await request(app).get('/api/rooms/RINCON_AAA/queue');
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
});

test('GET /api/rooms/:id/queue returns 400 for non-coordinator', async () => {
  expect((await request(app).get('/api/rooms/RINCON_BBB/queue')).status).toBe(400);
});

test('DELETE /api/rooms/:id/queue clears queue', async () => {
  sonos.clearQueue.mockResolvedValue({});
  expect((await request(app).delete('/api/rooms/RINCON_AAA/queue')).status).toBe(200);
  expect(sonos.clearQueue).toHaveBeenCalledWith('192.168.1.1');
});

test('POST /api/rooms/:id/seek calls sonos.seek', async () => {
  sonos.seek.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_AAA/seek').send({ position: '0:01:30' });
  expect(res.status).toBe(200);
  expect(sonos.seek).toHaveBeenCalledWith('192.168.1.1', '0:01:30');
});

test('POST /api/rooms/:id/seek rejects missing position', async () => {
  expect((await request(app).post('/api/rooms/RINCON_AAA/seek').send({})).status).toBe(400);
});

test('returns 404 for unknown room', async () => {
  expect((await request(app).post('/api/rooms/RINCON_UNKNOWN/play')).status).toBe(404);
});
```

- [ ] **Step 2: Run — verify FAIL**
```bash
npx jest tests/routes.test.js --no-coverage
```

- [ ] **Step 3: Replace `server.js`**
```js
const express = require('express');
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
  try { await fn(); } catch (e) { console.error(e.message); res.status(502).json({ error: e.message }); }
}

// Routes
app.get('/api/rooms', (req, res) => res.json(store.getRooms()));
app.post('/api/rooms/:id/play',  async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.play(d.ip); res.json({ok:true}); }); });
app.post('/api/rooms/:id/pause', async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.pause(d.ip); res.json({ok:true}); }); });
app.post('/api/rooms/:id/next',  async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.next(d.ip); res.json({ok:true}); }); });
app.post('/api/rooms/:id/prev',  async (req, res) => { const d = getDevice(req,res); if(!d) return; await wrap(res, async () => { await sonos.previous(d.ip); res.json({ok:true}); }); });

app.post('/api/rooms/:id/seek', async (req, res) => {
  const d = getDevice(req,res); if(!d) return;
  if (!req.body.position) return res.status(400).json({ error: 'position required' });
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

// Startup
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const stop = startDiscovery((device) => {
    console.log(`Discovered: ${device.name} (${device.model}) at ${device.ip}`);
    store.registerDevice(device);
  });
  store.startPolling(2000);
  app.listen(PORT, () => console.log(`Sonos controller on http://localhost:${PORT}`));
  process.on('SIGTERM', () => { stop(); store.stopPolling(); });
}

module.exports = app;
```

- [ ] **Step 4: Run route tests — verify PASS (11 tests)**
```bash
npx jest tests/routes.test.js --no-coverage
```

- [ ] **Step 5: Run full test suite**
```bash
npx jest --no-coverage
```
Expected: all tests pass across all files.

- [ ] **Step 6: Commit**
```bash
git add server.js tests/routes.test.js && git commit -m "feat: add Express server with REST API and SSE endpoint"
```

---

## Task 7: Frontend HTML & CSS

**Files:** `public/index.html`, `public/style.css`

No automated tests — verified visually.

- [ ] **Step 1: Create `public/index.html`**
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sonos</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="header">
    <span class="logo">◈ Sonos</span>
    <span class="room-count" id="room-count"></span>
  </header>
  <main class="dashboard">
    <div class="col-left">
      <section class="card">
        <div class="card-label">Now Playing · <span id="now-playing-room"></span></div>
        <div class="art-wrap">
          <img id="album-art" src="" alt="Album art">
          <div id="art-placeholder" class="art-placeholder"></div>
        </div>
        <div class="track-title" id="track-title">—</div>
        <div class="track-sub"   id="track-sub">—</div>
        <div class="seek-bar-wrap">
          <span class="time" id="time-pos">0:00</span>
          <input type="range" id="seek-bar" class="seek-bar" min="0" max="100" value="0">
          <span class="time" id="time-dur">0:00</span>
        </div>
        <div class="controls">
          <button class="ctrl-btn"          id="btn-prev">⏮</button>
          <button class="ctrl-btn ctrl-play" id="btn-play">▶</button>
          <button class="ctrl-btn"          id="btn-next">⏭</button>
        </div>
      </section>
      <section class="card">
        <div class="card-label">Queue</div>
        <ul class="queue-list" id="queue-list"></ul>
        <button class="clear-btn" id="btn-clear-queue">Clear queue</button>
      </section>
    </div>
    <div class="col-right">
      <section class="card">
        <div class="card-label">Rooms</div>
        <ul class="rooms-list" id="rooms-list"></ul>
      </section>
      <section class="card">
        <div class="card-label">Grouping</div>
        <ul class="grouping-list" id="grouping-list"></ul>
      </section>
    </div>
  </main>
  <div class="toast" id="toast"></div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/style.css`**
```css
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--surface:#1a1a1a;--surface2:#242424;--border:#2a2a2a;
  --accent:#e8ff48;--accent2:#a8e063;--text:#fff;--text2:#888;--text3:#555;
  --danger:#ff4848;--radius:12px;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif
}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;min-height:100vh}
.header{display:flex;align-items:center;justify-content:space-between;padding:20px 28px 12px;border-bottom:1px solid var(--border)}
.logo{color:var(--accent);font-weight:700;font-size:18px}
.room-count{color:var(--text3);font-size:12px}
.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px 28px;max-width:960px}
@media(max-width:640px){.dashboard{grid-template-columns:1fr}}
.col-left,.col-right{display:flex;flex-direction:column;gap:16px}
.card{background:var(--surface);border-radius:var(--radius);padding:18px}
.card-label{color:var(--text3);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:14px}
.art-wrap{position:relative;width:100%;aspect-ratio:1;border-radius:8px;overflow:hidden;margin-bottom:14px;background:var(--surface2)}
.art-wrap img{width:100%;height:100%;object-fit:cover;display:none}
.art-wrap img.loaded{display:block}
.art-placeholder{width:100%;height:100%;background:linear-gradient(135deg,var(--surface2),var(--border))}
.track-title{font-size:16px;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track-sub{color:var(--text2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:14px}
.seek-bar-wrap{display:flex;align-items:center;gap:8px;margin-bottom:16px}
.time{color:var(--text3);font-size:11px;font-variant-numeric:tabular-nums;min-width:34px}
.seek-bar{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:var(--border);cursor:pointer;outline:none}
.seek-bar::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:var(--accent);cursor:pointer}
.controls{display:flex;justify-content:center;align-items:center;gap:24px}
.ctrl-btn{background:none;border:none;cursor:pointer;color:var(--text2);font-size:18px;padding:4px 8px;transition:color .15s}
.ctrl-btn:hover{color:var(--text)}
.ctrl-play{color:var(--accent);font-size:22px}
.ctrl-play:hover{color:var(--accent2)}
.queue-list{list-style:none;display:flex;flex-direction:column;gap:8px;max-height:200px;overflow-y:auto;margin-bottom:12px}
.queue-list li{font-size:12px;color:var(--text2);padding-bottom:6px;border-bottom:1px solid var(--border)}
.queue-list li.current{color:var(--accent)}
.q-artist{color:var(--text3);margin-left:6px}
.clear-btn{background:none;border:1px solid var(--border);color:var(--text3);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;transition:border-color .15s,color .15s}
.clear-btn:hover{border-color:var(--danger);color:var(--danger)}
.rooms-list{list-style:none;display:flex;flex-direction:column;gap:14px}
.room-item{display:flex;flex-direction:column;gap:6px}
.room-header{display:flex;justify-content:space-between;align-items:center}
.room-name{font-size:13px;font-weight:500}
.room-name.offline{color:var(--text3)}
.room-status{font-size:10px}
.room-status.playing{color:var(--accent)}
.room-status.paused{color:var(--text3)}
.room-status.offline{color:var(--border)}
.vol-row{display:flex;align-items:center;gap:8px}
.vol-slider{flex:1;-webkit-appearance:none;height:4px;border-radius:2px;background:var(--border);cursor:pointer;outline:none}
.vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:var(--text2);cursor:pointer}
.vol-slider.active::-webkit-slider-thumb{background:var(--accent)}
.vol-num{color:var(--text3);font-size:11px;min-width:26px;text-align:right}
.grouping-list{list-style:none;display:flex;flex-direction:column;gap:12px}
.group-item{display:flex;justify-content:space-between;align-items:center}
.group-name{font-size:13px;color:var(--text2)}
.toggle{position:relative;width:36px;height:20px;background:var(--border);border-radius:10px;cursor:pointer;border:none;transition:background .2s}
.toggle.on{background:var(--accent)}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--bg);transition:transform .2s}
.toggle.on::after{transform:translateX(16px)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--surface2);color:var(--danger);border:1px solid var(--danger);border-radius:8px;padding:10px 20px;font-size:13px;opacity:0;transition:transform .3s,opacity .3s;pointer-events:none;z-index:100}
.toast.show{transform:translateX(-50%) translateY(0);opacity:1}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
```

- [ ] **Step 3: Verify layout**
```bash
node server.js
```
Open http://localhost:3000. Expected: dark two-column dashboard shell.

- [ ] **Step 4: Commit**
```bash
git add public/index.html public/style.css && git commit -m "feat: add dark premium dashboard HTML and CSS"
```

---

## Task 8: Frontend JavaScript (`public/app.js`)

**Files:** `public/app.js`

Uses DOM creation methods (no template-literal element construction) to safely render data from Sonos devices.

`★ Insight ─────────────────────────────────────`
The `mk(tag, props)` helper uses `Object.assign` to set element properties declaratively. Member rooms read track/progress from the coordinator entry (via `groupCoordinatorId` lookup) while reading their own volume — this is the key cross-room data join in the render loop.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Create `public/app.js`**
```js
// ── State ──────────────────────────────────────────────────────────────
let rooms = [];
let activeRoomId = null;
let seekDragging = false;

// ── Helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// Safe element builder — no template-literal HTML construction
function mk(tag, props = {}) {
  const e = document.createElement(tag);
  const { cls, text, data = {}, ...rest } = props;
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  Object.entries(data).forEach(([k, v]) => { e.dataset[k] = String(v); });
  Object.entries(rest).forEach(([k, v]) => { e[k] = v; });
  return e;
}

function fmtTime(hms) {
  if (!hms || hms === 'NOT_IMPLEMENTED') return '0:00';
  const [h, m, s] = hms.split(':').map(Number);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}
function hmsToSec(hms) {
  if (!hms) return 0;
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}
function secToHms(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── Active room ────────────────────────────────────────────────────────
function getActiveRoom() {
  return rooms.find((r) => r.id === activeRoomId)
    || rooms.find((r) => r.isCoordinator && r.state === 'PLAYING')
    || rooms.find((r) => r.isCoordinator)
    || rooms[0];
}

// ── Render: Now Playing ────────────────────────────────────────────────
function renderNowPlaying() {
  const room = getActiveRoom();
  if (!room) return;
  activeRoomId = room.id;
  const coord = rooms.find((r) => r.id === room.groupCoordinatorId) || room;
  const track = coord.track;

  $('now-playing-room').textContent = room.name;
  $('track-title').textContent = track ? (track.title || '—') : '—';
  $('track-sub').textContent   = track ? [track.artist, track.album].filter(Boolean).join(' · ') || '—' : '—';

  const artEl = $('album-art'), phEl = $('art-placeholder');
  if (track && track.artUri) {
    artEl.src = track.artUri;
    artEl.onload  = () => { artEl.classList.add('loaded'); phEl.style.display = 'none'; };
    artEl.onerror = () => { artEl.classList.remove('loaded'); phEl.style.display = ''; };
  } else {
    artEl.classList.remove('loaded');
    phEl.style.display = '';
  }

  $('btn-play').textContent = coord.state === 'PLAYING' ? '⏸' : '▶';

  if (!seekDragging) {
    const dur = hmsToSec((coord.track && coord.track.duration) || '0:00:00');
    const pos = hmsToSec((coord.track && coord.track.position) || '0:00:00');
    $('seek-bar').value        = dur > 0 ? (pos / dur) * 100 : 0;
    $('time-pos').textContent  = fmtTime(coord.track && coord.track.position);
    $('time-dur').textContent  = fmtTime(coord.track && coord.track.duration);
  }
}

// ── Render: Rooms ──────────────────────────────────────────────────────
function renderRooms() {
  const list = $('rooms-list');
  list.replaceChildren();
  for (const room of rooms) {
    const sc = room.online ? (room.state === 'PLAYING' ? 'playing' : 'paused') : 'offline';
    const st = sc === 'playing' ? '● playing' : sc === 'paused' ? '○ paused' : '✕ offline';

    const header = mk('div', { cls: 'room-header' });
    header.append(
      mk('span', { cls: 'room-name' + (room.online ? '' : ' offline'), text: room.name }),
      mk('span', { cls: `room-status ${sc}`, text: st })
    );

    const slider = mk('input', {
      type: 'range', cls: 'vol-slider' + (room.state === 'PLAYING' ? ' active' : ''),
      min: '0', max: '100', value: String(room.volume), disabled: !room.online,
      data: { id: room.id },
    });
    const volNum = mk('span', { cls: 'vol-num', text: String(room.volume) });
    const volRow = mk('div', { cls: 'vol-row' });
    volRow.append(slider, volNum);

    const li = mk('li', { cls: 'room-item' });
    li.append(header, volRow);
    list.appendChild(li);
  }

  list.querySelectorAll('.vol-slider').forEach((slider) => {
    let timer;
    slider.addEventListener('input', (e) => {
      e.target.nextSibling.textContent = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try { await api('POST', `/api/rooms/${e.target.dataset.id}/volume`, { volume: +e.target.value }); }
        catch (err) { showToast(err.message); }
      }, 100);
    });
  });
}

// ── Render: Grouping ───────────────────────────────────────────────────
function renderGrouping() {
  const list = $('grouping-list');
  list.replaceChildren();
  const active = getActiveRoom();
  if (!active) return;
  const coordId = active.groupCoordinatorId;

  for (const room of rooms) {
    const inGroup = room.groupCoordinatorId === coordId;
    const toggle = mk('button', { cls: 'toggle' + (inGroup ? ' on' : ''), data: { id: room.id, coord: coordId } });
    const li = mk('li', { cls: 'group-item' });
    li.append(mk('span', { cls: 'group-name', text: room.name }), toggle);
    list.appendChild(li);
  }

  list.querySelectorAll('.toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const on = btn.classList.contains('on');
      try {
        if (on) await api('POST', `/api/rooms/${btn.dataset.id}/group`, { coordinatorId: null });
        else    await api('POST', `/api/rooms/${btn.dataset.id}/group`, { coordinatorId: btn.dataset.coord });
      } catch (err) { showToast(err.message); }
    });
  });
}

// ── Render: Queue ──────────────────────────────────────────────────────
async function renderQueue() {
  const active = getActiveRoom();
  if (!active) return;
  const coordId = active.isCoordinator ? active.id : active.groupCoordinatorId;
  const list = $('queue-list');
  try {
    const queue = await api('GET', `/api/rooms/${coordId}/queue`);
    list.replaceChildren();
    if (!queue || queue.length === 0) {
      list.appendChild(mk('li', { text: 'Queue is empty', cls: '' }));
      list.firstChild.style.color = 'var(--text3)';
      return;
    }
    queue.forEach((item, i) => {
      const li = mk('li', { cls: i === 0 ? 'current' : '' });
      li.append(
        mk('span', { cls: 'q-title',  text: item.title  || '—' }),
        mk('span', { cls: 'q-artist', text: item.artist || '' })
      );
      list.appendChild(li);
    });
  } catch { /* queue unavailable */ }
}

// ── Controls ───────────────────────────────────────────────────────────
function attachControls() {
  $('btn-play').addEventListener('click', async () => {
    const room = getActiveRoom(); if (!room) return;
    const coord = rooms.find((r) => r.id === room.groupCoordinatorId) || room;
    try {
      if (coord.state === 'PLAYING') await api('POST', `/api/rooms/${coord.id}/pause`);
      else                           await api('POST', `/api/rooms/${coord.id}/play`);
    } catch (err) { showToast(err.message); }
  });

  $('btn-next').addEventListener('click', async () => {
    const r = getActiveRoom(); if (!r) return;
    const id = r.isCoordinator ? r.id : r.groupCoordinatorId;
    try { await api('POST', `/api/rooms/${id}/next`); } catch (e) { showToast(e.message); }
  });

  $('btn-prev').addEventListener('click', async () => {
    const r = getActiveRoom(); if (!r) return;
    const id = r.isCoordinator ? r.id : r.groupCoordinatorId;
    try { await api('POST', `/api/rooms/${id}/prev`); } catch (e) { showToast(e.message); }
  });

  const seekBar = $('seek-bar');
  seekBar.addEventListener('mousedown', () => { seekDragging = true; });
  seekBar.addEventListener('mouseup', async (e) => {
    seekDragging = false;
    const room = getActiveRoom(); if (!room) return;
    const coord = rooms.find((r) => r.id === room.groupCoordinatorId) || room;
    const dur = hmsToSec((coord.track && coord.track.duration) || '0:00:00');
    const targetSec = Math.floor((e.target.value / 100) * dur);
    try { await api('POST', `/api/rooms/${coord.id}/seek`, { position: secToHms(targetSec) }); }
    catch (err) { showToast(err.message); }
  });

  $('btn-clear-queue').addEventListener('click', async () => {
    const r = getActiveRoom(); if (!r) return;
    const id = r.isCoordinator ? r.id : r.groupCoordinatorId;
    try { await api('DELETE', `/api/rooms/${id}/queue`); renderQueue(); }
    catch (err) { showToast(err.message); }
  });
}

// ── SSE ────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    rooms = JSON.parse(e.data);
    $('room-count').textContent = `${rooms.length} room${rooms.length !== 1 ? 's' : ''}`;
    renderNowPlaying();
    renderRooms();
    renderGrouping();
  };
  es.onerror = () => console.warn('SSE disconnected, browser will reconnect…');
}

// ── Init ───────────────────────────────────────────────────────────────
attachControls();
connectSSE();
setTimeout(renderQueue, 800);
setInterval(renderQueue, 10_000);
```

- [ ] **Step 2: Run full test suite**
```bash
npx jest --no-coverage
```
Expected: all tests pass.

- [ ] **Step 3: Verify UI against real devices**
```bash
node server.js
```
Open http://localhost:3000 and verify:
- 3 rooms discovered (Living Room ×2 stereo pair, Master Bedroom)
- Now Playing shows current track, album art, seek position in real time
- Play/pause reflects actual device state
- Volume sliders update device volume (debounced, ~100ms)
- Grouping toggles join/unjoin speakers
- Queue panel lists tracks; Clear queue button empties it
- Seek bar draggable; POSTs position on mouseup
- Offline device shows greyed-out card
- Error toast appears briefly on API failures

- [ ] **Step 4: Commit**
```bash
git add public/app.js && git commit -m "feat: add frontend JS with SSE, controls, seek, grouping, and queue"
```

---

## Done

`node server.js` — open http://localhost:3000 (or `PORT=8080 node server.js`).
