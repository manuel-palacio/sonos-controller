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
  if (!metaStr || metaStr === 'NOT_IMPLEMENTED') return null;
  try {
    const tag = (t, src) => (src.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)) || [])[1] || '';
    // Text fields may be URI-encoded; the artUri must keep its original encoding
    // so the Sonos /getaa endpoint receives a valid query string.
    let decoded = metaStr;
    try { decoded = decodeURIComponent(metaStr); } catch { /* keep as-is */ }
    const title = tag('dc:title', decoded), artist = tag('dc:creator', decoded);
    if (!title && !artist) return null;
    const artUri = tag('upnp:albumArtURI', metaStr).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return { title, artist, album: tag('upnp:album', decoded), artUri };
  } catch { return null; }
}

async function getPositionInfo(ip) {
  const r = await avt(ip, 'GetPositionInfo',
    `<u:GetPositionInfo xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:GetPositionInfo>`);
  const p = r['s:Envelope']['s:Body']['u:GetPositionInfoResponse'];
  const track = parseTrackMetadata(p['TrackMetaData']);
  if (track && track.artUri && track.artUri.startsWith('/')) {
    // Route art through our proxy — Sonos /getaa requires server-side access
    track.artUri = `/api/art?url=${encodeURIComponent(`http://${ip}:1400${track.artUri}`)}`;
  }
  return { track, position: p['RelTime'] || '0:00:00', duration: p['TrackDuration'] || '0:00:00' };
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
    const ent = (s) => s.replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return [...s.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)].map((m) => {
      const i = m[1], t = (tag) => ent((i.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)) || [])[1] || '');
    return { title: t('dc:title'), artist: t('dc:creator'), album: t('upnp:album') };
  });
}

const clearQueue = (ip) => avt(ip, 'RemoveAllTracksFromQueue',
  `<u:RemoveAllTracksFromQueue xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>`);
const joinGroup = (ip, coordId) => avt(ip, 'SetAVTransportURI',
  `<u:SetAVTransportURI xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><CurrentURI>x-rincon:${coordId}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>`);
const leaveGroup = (ip) => avt(ip, 'BecomeCoordinatorOfStandaloneGroup',
  `<u:BecomeCoordinatorOfStandaloneGroup xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:BecomeCoordinatorOfStandaloneGroup>`);

async function getSavedQueues(ip) {
  const r = await soapCall(ip, CD, `${CD_NS}#Browse`,
    `<u:Browse xmlns:u="${CD_NS}"><ObjectID>SQ:</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>100</RequestedCount><SortCriteria></SortCriteria></u:Browse>`);
  const s = r['s:Envelope']['s:Body']['u:BrowseResponse']['Result'];
  if (!s) return [];
  return [...s.matchAll(/<container[^>]+id="(SQ:\d+)"[^>]*>([\s\S]*?)<\/container>/g)].map((m) => {
    const id = m[1], inner = m[2];
    const tag = (t) => (inner.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`)) || [])[1] || '';
    const artMatch = inner.match(/<upnp:albumArtURI>([^<]+)<\/upnp:albumArtURI>/);
    const artUri = artMatch ? artMatch[1].replace(/&amp;/g, '&') : '';
    const resMatch = inner.match(/<res[^>]*>([^<]+)<\/res>/);
    const resUri = resMatch ? resMatch[1].replace(/&amp;/g, '&') : '';
    return { id, title: tag('dc:title').replace(/&apos;/g, "'").replace(/&amp;/g, '&'), artUri, resUri };
  });
}

async function playPlaylist(ip, rinconId, sqId, resUri, title) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const meta = esc(`<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${sqId}" parentID="SQ:" restricted="true"><dc:title>${title}</dc:title><upnp:class>object.container.playlistContainer</upnp:class></item></DIDL-Lite>`);
  await avt(ip, 'RemoveAllTracksFromQueue', `<u:RemoveAllTracksFromQueue xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID></u:RemoveAllTracksFromQueue>`);
  await avt(ip, 'AddURIToQueue', `<u:AddURIToQueue xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><EnqueuedURI>${esc(resUri)}</EnqueuedURI><EnqueuedURIMetaData>${meta}</EnqueuedURIMetaData><DesiredFirstTrackNumberEnqueued>1</DesiredFirstTrackNumberEnqueued><EnqueueAsNext>0</EnqueueAsNext></u:AddURIToQueue>`);
  await avt(ip, 'SetAVTransportURI', `<u:SetAVTransportURI xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><CurrentURI>x-rincon-queue:${esc(rinconId)}#0</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>`);
  await avt(ip, 'Seek', `<u:Seek xmlns:u="${AVT_NS}"><InstanceID>0</InstanceID><Unit>TRACK_NR</Unit><Target>1</Target></u:Seek>`);
  await play(ip);
}

async function browseRaw(ip, objectId) {
  const r = await soapCall(ip, CD, `${CD_NS}#Browse`,
    `<u:Browse xmlns:u="${CD_NS}"><ObjectID>${objectId}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter><StartingIndex>0</StartingIndex><RequestedCount>100</RequestedCount><SortCriteria></SortCriteria></u:Browse>`);
  const body = r['s:Envelope']['s:Body']['u:BrowseResponse'];
  return { totalMatches: body?.TotalMatches, returned: body?.NumberReturned, result: body?.Result };
}

module.exports = { play, pause, next, previous, seek, getTransportInfo, getPositionInfo, getVolume, setVolume, getZoneGroupState, getQueue, clearQueue, joinGroup, leaveGroup, getSavedQueues, playPlaylist, browseRaw };
