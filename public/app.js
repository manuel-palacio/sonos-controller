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
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
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

// ── Render: Playlists ──────────────────────────────────────────────────
async function renderPlaylists() {
  const list = $('playlist-list');
  try {
    const playlists = await api('GET', '/api/playlists');
    list.replaceChildren();
    if (!playlists.length) {
      const empty = mk('li', { text: 'No saved queues', cls: 'playlist-empty' });
      list.appendChild(empty);
      return;
    }
    playlists.forEach((pl) => {
      const art = mk('div', { cls: 'pl-art' });
      if (pl.artUri) {
        const img = mk('img'); img.src = pl.artUri;
        img.onerror = () => img.remove();
        art.appendChild(img);
      }
      const title = mk('span', { cls: 'pl-title', text: pl.title });
      const li = mk('li', { cls: 'playlist-item', data: { id: pl.id, title: pl.title, resUri: pl.resUri } });
      li.append(art, title);
      list.appendChild(li);
    });

    list.querySelectorAll('.playlist-item').forEach((li) => {
      li.addEventListener('click', async () => {
        const room = getActiveRoom(); if (!room) return;
        const id = room.isCoordinator ? room.id : room.groupCoordinatorId;
        try {
          await api('POST', `/api/rooms/${id}/playlist`, { sqId: li.dataset.id, resUri: li.dataset.resUri, title: li.dataset.title });
          showToast(`Playing ${li.dataset.title}`);
        } catch (err) { showToast(err.message); }
      });
    });
  } catch { /* silently ignore if no coordinator yet */ }
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
setTimeout(renderPlaylists, 1000);
setInterval(renderQueue, 10_000);
