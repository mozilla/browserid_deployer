var nativeDns = require('native-dns'),
         util = require('util'),
          dns = require('dns'),
         http = require('http'); 

function resolve(hostname, cb) {
  // resolve zerigo's nameserver
  dns.resolve4('A.NS.ZERIGO.NET', function(err, ip) {
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
        foundAddr = a.promote().address;
      });
    });

    req.on('end', function () {
      cb(null, foundAddr);
    });
    
    req.send();
  });
}

module.exports = function(hostname, cb) {
  resolve(hostname, function(err, ip) {
    if (err) return cb(err);
    console.log('resolved ' + hostname + ' -> ' + ip);
    http.get({ host: ip, path: '/ver.txt' }, function(res) {
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
