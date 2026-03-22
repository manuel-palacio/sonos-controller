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

test('getZoneGroupState() returns XML string', async () => {
  const xml = '<ZoneGroups><ZoneGroup Coordinator="RINCON_AAA"/></ZoneGroups>';
  soapCall.mockResolvedValue({
    's:Envelope': { 's:Body': { 'u:GetZoneGroupStateResponse': { ZoneGroupState: xml } } }
  });
  expect(await sonos.getZoneGroupState('192.168.1.1')).toBe(xml);
});

test('getQueue() returns parsed track list', async () => {
  const result = '<Result>'
    + '<item><dc:title>Track One</dc:title><dc:creator>Artist</dc:creator><upnp:album>Album</upnp:album></item>'
    + '<item><dc:title>Track Two</dc:title><dc:creator>Artist 2</dc:creator><upnp:album>Album 2</upnp:album></item>'
    + '</Result>';
  soapCall.mockResolvedValue({
    's:Envelope': { 's:Body': { 'u:BrowseResponse': { Result: result } } }
  });
  const queue = await sonos.getQueue('192.168.1.1');
  expect(queue).toHaveLength(2);
  expect(queue[0].title).toBe('Track One');
  expect(queue[1].artist).toBe('Artist 2');
});
