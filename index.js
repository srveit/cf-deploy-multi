'use strict';
var childProcess = require('child_process'),
  path = require('path');

function createDeployer(projectRoot, foundries, environments, environmentName,
                        timestamp) {
  timestamp = timestamp || Math.ceil(new Date().valueOf() / 1000);

  function getEnvironment() {
    return environments[environmentName];
  }

  function newFoundry(location) {
    var foundry = foundries[location],
      environment = getEnvironment(),
      newAppName = environment.newAppName,
      oldAppName,
      cfCmd = process.env.CF_CMD || path.resolve(__dirname, 'bin/cf');

    function cf() {
      var args = Array.prototype.slice.call(arguments, 0),
        displayOutput = true;

      if (args[0] === '--no-output') {
        displayOutput = false;
        args.shift();
      }
      return new Promise(function (resolve, reject) {
        /*jslint nomen: true */
        var results = '',
          stdio = [process.stdin, 'pipe', process.stderr],
          p;
        p = childProcess.spawn(cfCmd, args, {
          cwd: projectRoot,
          env: {
            CF_HOME: foundry.home,
            CF_COLOR: 'false'
          },
          stdio: stdio
        });
        p.stdout.on('data', function (data) {
          var str = data.toString();
          results += str;
          if (displayOutput) {
            process.stdout.write(data);
          }
        });
        p.on('close', function (code) {
          if (code === 0) {
            resolve(results);
          } else {
            reject({
              message: 'error "cf ' + args.join(' ') + '" ' +
                'failed with exit code ' + code
            });
          }
        });
      });
    }
    function setApi() {
      return cf('api', foundry.api);
    }
    function installDiego() {
      return cf('install-plugin', 'Diego-Enabler', '-r', 'CF-Community', '-f')
        .catch(function (error) {
          console.log('ignoring install-plugin error', error);
        });
    }
    function enableDiego() {
      return cf('enable-diego', newAppName);
    }
    function logout() {
      return cf('logout');
    }
    function login() {
      var space = foundry.spaces[environment.appEnv.NODE_ENV];
      return cf('login', '--u', foundry.username, '--p', foundry.password,
                '--o', foundry.org, '--s', space);
    }
    function logApp() {
      return cf('logs', newAppName, '--recent')
        .catch(function (error) {
          // Do not reject so that a failed app log doesn't cause
          // the rest of the script to fail.
          console.error('logApp', newAppName, 'failed', error);
        });
    }
    function pushApp() {
      return cf('push', newAppName,
                '-c', environment.startCommand,
                '-i', environment.instances,
                '-m', environment.memory,
                '-k', environment.disk,
                '-b', environment.buildPack,
                '--no-start');
    }
    function startApp() {
      return cf('start', newAppName);
    }
    function deleteApp(appName) {
      return cf('delete', '-f', '-r', appName)
        .catch(function (error) {
          // Do not reject so that a failed app deletion doesn't cause
          // the rest of the script to fail.
          console.error('deleteApp', appName, 'failed', error);
        });
    }
    function setAppEnvironment() {
      var settings = Object.keys(environment.appEnv).map(function (variable) {
        return function () {
          if (variable.match(/PASSWORD|KEY/)) {
            return cf('--no-output', 'set-env', newAppName, variable,
                      environment.appEnv[variable]);
          }
          return cf('set-env', newAppName, variable,
                    environment.appEnv[variable]);
        };
      });
      settings.push(function () {
        return cf('set-env', newAppName, "FOUNDRY_LOCATION", location);
      });
      return settings.reduce(function (cur, next) {
        return cur.then(next);
      }, Promise.resolve());
    }
    function bindServiceToApp(serviceName) {
      return cf('bind-service', newAppName, serviceName);
    }
    function checkAppState() {
      return cf('app', newAppName)
        .then(function (results) {
          var isRunning;
          isRunning = results
            .split('\n')
            .filter(function (line) {
              return line.substr(0, 1) === '#';
            })
            .map(function (line) {
              var fields = line.split(/ +/),
                state;
              if (fields[0].substr(0, 1) === '#') {
                state = fields[1];
              }
              return state;
            })
            .some(function (state) {
              return state === 'running';
            });
          if (!isRunning) {
            return Promise.reject({
              message: 'app ' + newAppName + ' is not running'
            });
          }
          return true;
        });
    }

    function getAppName(domain, endpoint) {
      return cf('apps')
        .then(function (results) {
          var appPattern = new RegExp(' ' + endpoint + '\\.' + domain);
          return results
            .split('\n')
            .filter(function (line) {
              return line.match(appPattern);
            })
            .map(function (line) {
              return line.split(' ')[0];
            })[0];
        });
    }
    function setOldAppName() {
      return Promise.all([
        getAppName(foundry.domain, environment.endpoint),
        getAppName(environment.baseDomain, environment.baseName)
      ])
        .then(function (appNames) {
          oldAppName = appNames.filter(function (appName) {
            return appName && appName !== newAppName;
          })[0];
        });
    }
    function mapNewAppAndUnmapOldApp(domain, endpoint) {
      var mapArgs = ['map-route', newAppName, domain],
        unmapArgs = ['unmap-route', oldAppName, domain];
      if (endpoint) {
        mapArgs.push('-n', endpoint);
        unmapArgs.push('-n', endpoint);
      }
      return cf.apply(foundry, mapArgs)
        .then(function () {
          if (!oldAppName) {
            return true;
          }
          return cf.apply(foundry, unmapArgs);
        })
        .catch(function (error) {
          console.error('error mapping route:', error);
          return Promise.reject(error);
        });
    }
    function pushNewApp() {
      return logout()
        .then(setApi)
        .then(login)
        .then(pushApp)
        .then(installDiego)
        .then(enableDiego)
        .then(setAppEnvironment)
        .then(startApp)
        .then(checkAppState)
        .catch(function (error) {
          console.error('error pushing app', location, error);
          return logApp().then(function () {
            return Promise.reject(error);
          });
        });
    }
    function deleteNewApp() {
      return deleteApp(newAppName);
    }
    function deleteOldApp() {
      if (!oldAppName) {
        return true;
      }
      return deleteApp(oldAppName);
    }
    function mapNewAppsAndUnmapOldApps() {
      var mappings = [
        mapNewAppAndUnmapOldApp(foundry.domain, environment.endpoint),
      ];
      if (environment.baseDomain === 'ctl.io') {
        // the ctl.io domain does not exist in AppFog
        mappings.push(
          mapNewAppAndUnmapOldApp(environment.baseName + '.' + environment.baseDomain));
      } else {
        mappings.push(mapNewAppAndUnmapOldApp(environment.baseDomain, environment.baseName));
      }
      mappings =
        mappings.concat(environment.custom_domains.map(mapNewAppAndUnmapOldApp));

      return Promise.all(mappings);
    }
    function remapNewAppAndDeleteOldApp() {
      return setOldAppName()
        .then(mapNewAppsAndUnmapOldApps)
        .then(deleteOldApp);
    }
    function bindServicesToApp() {
      return Promise.all(environment.services.map(bindServiceToApp));
    }
    foundry.pushNewApp = pushNewApp;
    foundry.deleteNewApp = deleteNewApp;
    foundry.bindServicesToApp = bindServicesToApp;
    foundry.remapNewAppAndDeleteOldApp = remapNewAppAndDeleteOldApp;
    return foundry;
  }

  function pushNewApp(location) {
    var foundry = newFoundry(location);
    return foundry.pushNewApp();
  }

  function deleteNewApp(location) {
    var foundry = newFoundry(location);
    return foundry.deleteNewApp();
  }

  function bindServicesToApp(location) {
    var foundry = newFoundry(location);
    return foundry.bindServicesToApp();
  }

  function remapNewAppAndDeleteOldApp(location) {
    var foundry = newFoundry(location);
    return foundry.remapNewAppAndDeleteOldApp();
  }

  function eachLocation(fn) {
    var environment = getEnvironment();
    return Promise.all(environment.locations.map(fn));
  }
  function pushNewApps() {
    return eachLocation(pushNewApp);
  }

  function bindServicesToApps() {
    return eachLocation(bindServicesToApp);
  }

  function remapNewAppsAndDeleteOldApps() {
    return eachLocation(remapNewAppAndDeleteOldApp);
  }

  function deleteApps() {
    return eachLocation(deleteNewApp);
  }

  function deployApps() {
    pushNewApps()
      .then(bindServicesToApps)
      .then(remapNewAppsAndDeleteOldApps)
      .catch(function () {
        deleteApps()
          .then(function () {
            console.error('deploy failed');
            process.exit(1);
          });
      });
  }

  return {
    deployApps: deployApps
  };
}

exports.createDeployer = createDeployer;
