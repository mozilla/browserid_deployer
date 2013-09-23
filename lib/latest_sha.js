var nativeDns = require('native-dns'),
         util = require('util'),
          dns = require('dns'),
         https = require('https'),
  NiceRoute53 = require('nice-route53');

var route53 = new NiceRoute53({
  accessKeyId : process.env['AWS_ID'],
  secretAccessKey : process.env['AWS_SECRET'],
});

function resolve(hostname, cb) {
  // find an NS for this hostname
  var domain = hostname.split('.').slice(1).join('.');
  route53.zoneInfo(domain, function(err, zoneInfo) {
    if (err) return cb(err);
    var nameserver = zoneInfo.nameServers[0];

    dns.resolve4(nameserver, function(err, ip) {
      var question = nativeDns.Question({
        name: hostname,
        type: 'A',
      });

      var req = nativeDns.Request({
        question: question,
        server: { address: ip[0], port: 53, type: 'udp' },
        timeout: 4000,
      });

      req.on('timeout', function () {
        cb('Timeout resolving ' + hostname);
      });

      var foundAddr = null;

      req.on('message', function (err, answer) {
        answer.answer.forEach(function (a) {
          if (foundAddr) return;
          foundAddr = a.address;
        });
      });

      req.on('end', function () {
        cb(null, foundAddr);
      });

      req.send();
    });
  });
}

module.exports = function(hostname, cb) {
  // first, verify that the hostname resolves properly
  resolve(hostname, function(err, ip) {
    if (err) return cb(err);
    if (!ip) return cb('Found no IP for host ' + hostname);
    console.log(new Date().toISOString() + ': resolved ' + hostname + ' -> ' + ip);

    // next, verify we can fetch ver.txt from the host, and extract
    // the SHA from within.  (NOTE: we must use hostname, because otherwise
    // SSL checks will fail)
    https.get({ host: hostname, path: '/ver.txt' }, function(res) {
      var buf = "";
      res.on('data', function (c) { buf += c });
      res.on('end', function() {
        try {
          var sha = buf.split(' ')[0];
          if (sha.length == 7) {
            return cb(null, sha);
          }
          cb('malformed ver.txt: ' + buf);
        } catch(e) {
          cb(e);
        }
      });
    }).on('error', function(err) {
      cb(err);
    });
  });
};
