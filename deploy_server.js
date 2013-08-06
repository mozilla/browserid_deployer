#!/usr/bin/env node

const
temp = require('temp'),
path = require('path'),
util = require('util'),
events = require('events'),
git = require('awsbox/lib/git.js'),
vm = require('awsbox/lib/vm.js'),
https = require('https'),
jsel = require('JSONSelect'),
fs = require('fs'),
express = require('express'),
irc = require('irc'),
latestSha = require('./lib/latest_sha.js'),
spawn = require('child_process').spawn;

const DEPLOY_HOSTNAME = "login.dev.anosrep.org";

console.log(new Date().toISOString() + ": deploy server starting up");

// a class capable of deploying and emmitting events along the way
function Deployer() {
  events.EventEmitter.call(this);

  // a directory where we'll keep code
  this._codeDir = process.env['CODE_DIR'] || temp.mkdirSync();
  console.log(new Date().toISOString() + ": code dir is:", this._codeDir);
  var self = this;

  git.init(this._codeDir, function(err) {
    if (err) {
      console.log(new Date().toISOString() + ": can't init code dir:", err);
      process.exit(1);
    }
    self.emit('ready');
  });
}

util.inherits(Deployer, events.EventEmitter);

Deployer.prototype._getLatestRunningSHA = function(cb) {
  var self = this;
  latestSha(DEPLOY_HOSTNAME, function(err, sha) {
    if (err) {
      self.emit('info', "can't get current running code: " + err);
    } else {
      self.emit('info', "current running sha is: " + sha);
    }
    cb(err, sha);
  });
};

Deployer.prototype._cleanUpOldVMs = function() {
  var self = this;
  // what's our sha
  git.currentSHA(self._codeDir, function(err, latest) {
    if (err) return self.emit('info', err);
    vm.list(function(err, r) {
      if (err) return self.emit('info', err);
      // only check the vms that have DEPLOY_HOSTNAME as a name
      jsel.forEach("object:has(:root > .name:contains(?))", [ DEPLOY_HOSTNAME ], r, function(o) {
        // don't delete the current one
        if (o.name.indexOf(latest) == -1) {
          self.emit('info', 'decommissioning VM: ' + o.name + ' - ' + o.instanceId);
          vm.destroy(o.instanceId, function(err, r) {
            if (err) self.emit('info', 'decomissioning failed: ' + err);
            else self.emit('info', 'decomissioning succeeded of ' + r);
          })
        }
      });
    });
  });
}

Deployer.prototype._deployNewCode = function(cb) {
  var self = this;

  function splitAndEmit(chunk) {
    if (chunk) chunk = chunk.toString();
    if (typeof chunk === 'string') {
      chunk.split('\n').forEach(function (line) {
        line = line.trim();
        if (line.length) self.emit('progress', line);
      });
    }
  }

  var npmInstall = spawn('npm', [ 'install' ], { cwd: self._codeDir });

  npmInstall.stdout.on('data', splitAndEmit);
  npmInstall.stderr.on('data', splitAndEmit);

  npmInstall.on('exit', function(code, signal) {
    if (code != 0) {
      self.emit('error', "can't npm install to prepare to run deploy_dev");
      return;
    }
    var p = spawn(path.join(__dirname, 'deploy_dev.js'), [], { cwd: self._codeDir });

    p.stdout.on('data', splitAndEmit);
    p.stderr.on('data', splitAndEmit);

    p.on('exit', function(code, signal) {
      return cb(code != 0);
    });
  });
};

Deployer.prototype._pullLatest = function(cb) {
  var self = this;
  git.pull(this._codeDir, 'git://github.com/mozilla/browserid', 'dev', function(l) {
    self.emit('progress', l);
  }, function(err) {
    if (err) return cb(err);
    git.currentSHA(self._codeDir, function(err, latest) {
      if (err) return cb(err);
      self.emit('info', 'latest available sha is ' + latest);
      self._getLatestRunningSHA(function(err, running) {
        // this is not a fatal error, it just means there's no server running right now,
        // we'll optimistically deploy anyway
        if (err) {
          self.emit('warn', 'latest available sha is ' + latest);
        }
        if (latest != running) {
          self.emit('deployment_begins', {
            sha: latest,
          });
          var startTime = new Date();

          self._deployNewCode(function(err, res) {
            if (err) return cb(err);
            // deployment is complete!
            self.emit('deployment_complete', {
              sha: latest,
              time: (new Date() - startTime)
            });
            // finally, let's clean up old servers
            self._cleanUpOldVMs();
            cb(null, null);
          });
        } else {
          self.emit('info', 'up to date');
          cb(null, null);
        }
      });
    });
  });
}

// may be invoked any time we suspect updates have occured to re-deploy
// if needed
Deployer.prototype.checkForUpdates = function() {
  var self = this;

  if (self._busy) return;

  self._busy = true;
  self.emit('info', 'checking for updates');

  self._pullLatest(function(err, sha) {
    if (err) self.emit('error', err);
    self._busy = false;
  });
}

var deployer = new Deployer();

var currentLogFile = null;
// a directory where we'll keep deployment logs
var deployLogDir = process.env['DEPLOY_LOG_DIR'] || temp.mkdirSync();

var deployingSHA = null;

console.log(new Date().toISOString() + ": deployment log dir is:", deployLogDir);

[ 'info', 'ready', 'error', 'deployment_begins', 'deployment_complete', 'progress' ].forEach(function(evName) {
  deployer.on(evName, function(data) {
    if (data !== null && data !== undefined && typeof data != 'string') data = JSON.stringify(data, null, 2);
    var msg = new Date().toISOString() + ': ' +  evName + (data ? (": " + data) : "")
    console.log(msg)
    if (currentLogFile) currentLogFile.write(msg + "\n");
  });
});

// irc integration!
var ircClient = null;
const ircChannel = '#identity';
function ircSend(msg) {
  if (!ircClient) {
    ircClient = new irc.Client('irc.mozilla.org', 'persona_deployer', {
      channels: [ircChannel]
    });
    ircClient.on('error', function(e) {
      console.log(new Date().toISOString() + ': irc error: ', e);
    });
    ircClient.once('join' + ircChannel, function(e) {
      ircClient.say(ircChannel, msg);
    });
  } else {
    ircClient.say(ircChannel, msg);
  }
}

function ircDisconnect() {
  setTimeout(function() {
    if (ircClient) {
      ircClient.disconnect();
      ircClient = null;
    }
  }, 1000);
}


// now when deployment begins, we log all events
deployer.on('deployment_begins', function(r) {
  currentLogFile = fs.createWriteStream(path.join(deployLogDir, r.sha + ".txt"));
  currentLogFile.write("deployment of " + r.sha + " begins\n");
  deployingSHA = r.sha;
  ircSend("deploying " + r.sha + " - status https://deployer.personatest.org/" + r.sha + ".txt");
});

function closeLogFile() {
  if (currentLogFile) {
    currentLogFile.end();
    currentLogFile = null;
  }
}

deployer.on('deployment_complete', function(r) {
  ircSend("deployment of " + deployingSHA + " completed successfully in " +
          (r.time / 1000.0).toFixed(2) + "s");
  ircDisconnect();

  closeLogFile();
  deployingSHA = null;

  // always check to see if we should try another deployment after one succeeds to handle
  // rapid fire commits
  console.log(new Date().toISOString() + ": checking for updates: received 'deployment_complete' signal, always check after deployment in case of rapid fire commits.");
  deployer.checkForUpdates();
});

deployer.on('error', function(r) {
  if (deployingSHA) {
    ircSend("deployment of " + deployingSHA + " failed.  check logs for deets");
  } else {
    ircSend("error while looking for updates.  check logs for deets");
  }
  ircDisconnect();

  closeLogFile();
  deployingSHA = null;

  // on error, try again in 2 minutes
  setTimeout(function () {
    console.log(new Date().toISOString() + ": checking for updates: received 'error' signal, checking 2 min later.");
    deployer.checkForUpdates();
  }, 2 * 60 * 1000);
});


// We check every 15 minutes, in case a cosmic ray hits and github's
// webhooks fail, or other unexpected errors occur
setInterval(function () {
  console.log(new Date().toISOString() + ": checking for updates: 15 min background loop, in case of githook or other errors.");
  deployer.checkForUpdates();
}, (1000 * 60 * 15));

// check for updates at startup
deployer.on('ready', function() {
  console.log(new Date().toISOString() + ": checking for updates: received 'ready' signal, checking on startup.");
  deployer.checkForUpdates();

  var app = express.createServer();

  app.get('/check', function(req, res) {
    console.log(new Date().toISOString() + ": checking for updates: received HTTP GET to 'check' endpoint.");
    deployer.checkForUpdates();
    res.send('ok');
  });

  app.post('/check', function(req, res) {
    console.log(new Date().toISOString() + ": checking for updates: received HTTP POST to 'check' endpoint.");
    deployer.checkForUpdates();
    res.send('ok');
  });

  app.get('/', function(req, res) {
    var what = "idle";
    if (deployingSHA) what = "deploying " + deployingSHA;
    res.send(what);
  });

  app.use(express.static(deployLogDir));

  app.listen(process.env['PORT'] || 8080, function() {
    console.log(new Date().toISOString() + ": deploy server bound");
  });
});
