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

test('POST /api/rooms/:id/next calls sonos.next', async () => {
  sonos.next.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_AAA/next');
  expect(res.status).toBe(200);
  expect(sonos.next).toHaveBeenCalledWith('192.168.1.1');
});

test('POST /api/rooms/:id/prev calls sonos.previous', async () => {
  sonos.previous.mockResolvedValue({});
  const res = await request(app).post('/api/rooms/RINCON_AAA/prev');
  expect(res.status).toBe(200);
  expect(sonos.previous).toHaveBeenCalledWith('192.168.1.1');
});

test('returns 502 when sonos operation throws', async () => {
  sonos.play.mockRejectedValue(new Error('device unreachable'));
  const res = await request(app).post('/api/rooms/RINCON_AAA/play');
  expect(res.status).toBe(502);
  expect(res.body.error).toBe('device unreachable');
});
