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
