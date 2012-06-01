#!/usr/bin/env node

/*
 * Deploy dev.anosrep.org, for fun and profit.
 */

const
path = require('path');
ssh = require('awsbox/lib/ssh.js'),
git = require('awsbox/lib/git.js'),
dns = require('awsbox/lib/dns.js'),
util = require('util'),
events = require('events'),
child_process = require('child_process'),
fs = require('fs');

// verify we have files we need

// a class capable of deploying and emmitting events along the way
function DevDeployer() {
  events.EventEmitter.call(this);

  this.keypairs = [];
  if (process.env['ADDITIONAL_KEYPAIRS']) {
    this.keypairs = process.env['ADDITIONAL_KEYPAIRS'].split(',');
  }
}

util.inherits(DevDeployer, events.EventEmitter);

DevDeployer.prototype.setup = function(cb) {
  var self = this;
  git.currentSHA(process.cwd(), function(err, r) {
    if (err) return cb(err);
    self.sha = r;
    cb(null);
  });
}

DevDeployer.prototype.create = function(cb) {
  var self = this;

  var cmd = [
    "node_modules/.bin/awsbox create",
    "-n \"dev.anosrep.org (" + self.sha + ")\"",
    "-u https://dev.anosrep.org",
    "-p ~/cert.pem",
    "-s ~/key.pem",
    "-x ~/smtp.json",
    "-t m1.small",
    "--no-remote"
  ].join(" ");

  var cp = child_process.exec(cmd, function(err, so, se) {
    checkerr(err);

    // now parse out ip address
    self.ipAddress = /\"ipAddress\":\s\"([0-9\.]+)\"/.exec(so)[1];

    var i = 0;
    function copyNext() {
      if (i == self.keypairs.length) return cb(null);
      ssh.addSSHPubKey(self.ipAddress, self.keypairs[i++], function(err) {
        if (err) return cb(err);
        self.emit('progress', "key added...");
        copyNext();
      });
    }
    copyNext();
  });
  cp.stdout.pipe(process.stdout);
  cp.stderr.pipe(process.stderr);
}

DevDeployer.prototype.pushCode = function(cb) {
  var self = this;
  git.push(process.cwd(), this.ipAddress, function(d) { self.emit('build_output', d); }, cb);
}

DevDeployer.prototype.updateDNS = function(cb) {
  var self = this;
  dns.deleteRecord(process.env['ZERIGO_DNS_KEY'], 'dev.anosrep.org', function() {
    dns.updateRecord(process.env['ZERIGO_DNS_KEY'], 'dev.anosrep.org', self.ipAddress, cb);
  });
}

var deployer = new DevDeployer();

deployer.on('progress', function(d) {
  if (d.indexOf('"pass"') !== -1) d = "<OUTPUT HIDDEN>";
  console.log("PR: " + d);
});

deployer.on('build_output', function(d) {
  if (d.indexOf('"pass"') !== -1) d = "<OUTPUT HIDDEN>";
  console.log("BO: " + d);
});

function checkerr(err) {
  if (err) {
    process.stderr.write("fatal error: " + err + "\n");
    process.exit(1);
  }
}

var startTime = new Date();
deployer.setup(function(err) {
  checkerr(err);
  deployer.create(function(err) {
    checkerr(err);
    deployer.pushCode(function(err) {
      checkerr(err);
      deployer.updateDNS(function(err) {
        checkerr(err);
        console.log("dev.anosrep.org (" + deployer.sha + ") deployed to " +
                    deployer.ipAddress + " in " +
                    ((new Date() - startTime) / 1000.0).toFixed(2) + "s");
      });
    });
  });
});
