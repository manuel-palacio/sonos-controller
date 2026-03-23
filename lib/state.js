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
      state: 'STOPPED', volume: 0, track: null,
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
    this._topology.clear();
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
          next.state = await sonos.getTransportInfo(device.ip);
          const pos  = await sonos.getPositionInfo(device.ip);
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

  startPolling(ms = 2000) {
    this._pollMs = ms;
    const run = async () => { await this._poll(); this._pollTimer = setTimeout(run, this._pollMs); };
    run();
  }
  stopPolling() { if (this._pollTimer) clearTimeout(this._pollTimer); }
}

module.exports = { StateStore };
