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
      res.on('error', reject);
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
