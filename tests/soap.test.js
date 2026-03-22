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
