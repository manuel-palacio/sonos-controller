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
