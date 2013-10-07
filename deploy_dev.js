#!/usr/bin/env node

/*
 * Deploy dev.anosrep.org, for fun and profit.
 */

const
path = require('path');
ssh = require('awsbox/lib/ssh.js'),
key = require('awsbox/lib/key.js'),
git = require('awsbox/lib/git.js'),
util = require('util'),
events = require('events'),
child_process = require('child_process'),
fs = require('fs');

const DEPLOY_HOSTNAME = process.env.DEPLOY_HOSTNAME || "login.dev.anosrep.org";

const DEPLOY_ROOT_CERT      = process.env.DEPLOY_ROOT_CERT      || "/home/app/root.cert";
const DEPLOY_ROOT_SECRETKEY = process.env.DEPLOY_ROOT_SECRETKEY || "/home/app/root.secretkey";

const INSTANCE_TYPE = process.env['INSTANCE_TYPE'] || 'm1.small';

const CERT_PEM  = process.env.PERSONA_SSL_PUB          || '~/cert.pem';
const KEY_PEM   = process.env.PERSONA_SSL_PRIV         || '~/key.pem';
const SMTP_JSON = process.env.PERSONA_EPHEMERAL_CONFIG || '~/smtp.json';

const PUBKEY_DIR = process.env.PUBKEY_DIR || '/home/app/team_pubkeys';

// verify we have files we need

// a class capable of deploying and emmitting events along the way
function DevDeployer() {
  events.EventEmitter.call(this);
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
    "-n \"" + DEPLOY_HOSTNAME + " (" + self.sha + ")\"",
    "-u https://" + DEPLOY_HOSTNAME,
    "--noemail",
    "-p " + CERT_PEM,
    "-s " + KEY_PEM,
    "-x " + SMTP_JSON,
    "-t " + INSTANCE_TYPE,
    "--no-remote",
    "--ssl=force",
    "--no-dnscheck",
    "-d"
  ].join(" ");

  var cp = child_process.exec(cmd, function(err, so, se) {
    checkerr(err);

    // now parse out ip address
    self.ipAddress = /\"ipAddress\":\s\"([0-9\.]+)\"/.exec(so)[1];

    if (!fs.existsSync(PUBKEY_DIR)) {
      return cb(null);
    }

    key.addKeysFromDirectory(self.ipAddress, PUBKEY_DIR, function(msg) {
      self.emit('progress', msg);
    }, cb);
  });
  cp.stdout.pipe(process.stdout);
  cp.stderr.pipe(process.stderr);
}

DevDeployer.prototype.pushCode = function(cb) {
  var self = this;
  git.push(process.cwd(), this.ipAddress, function(d) { self.emit('build_output', d); }, cb);
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

function copyDomainKeys(ip, cb) {
  fs.stat(DEPLOY_ROOT_CERT, function(e1, s1) {
    fs.stat(DEPLOY_ROOT_SECRETKEY, function(e2, s2) {
      if (e1 || e2 || !s1.isFile() || !s2.isFile()) {
        console.log("!! can't find domain keys, skipping");
        return cb();
      }
      ssh.copyFile(ip, "app", DEPLOY_ROOT_CERT, "var/", function(err) {
        if (err) return cb(err);
        ssh.copyFile(ip, "app", DEPLOY_ROOT_SECRETKEY, "var/", cb);
      });
    });
  });
}

var startTime = new Date();
deployer.setup(function(err) {
  checkerr(err);
  deployer.create(function(err) {
    checkerr(err);
    console.log('copying up domain keys...');
    copyDomainKeys(deployer.ipAddress, function(err) {
      checkerr(err);
      console.log('domain keys copy complete...');
      deployer.pushCode(function(err) {
        checkerr(err);
        console.log('push of code complete...');
        console.log('creating QA test user...');
        ssh.runScript(
          deployer.ipAddress,
          path.join(__dirname, 'test_user_creation.sh'),
          function(err) {
            console.log(DEPLOY_HOSTNAME + " (" + deployer.sha + ") " +
                        "deployed to " + deployer.ipAddress + " in " +
                        ((new Date() - startTime) / 1000.0).toFixed(2) + "s");
          });
      });
    });
  });
});
