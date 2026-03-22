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
