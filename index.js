'use strict';
var childProcess = require('child_process'),
  path = require('path');

Promise.series = function(promiseFunctions) {
  var results = [];
  return promiseFunctions.reduce(function (cur, next) {
    return cur
      .then(next)
      .then(function(result) {
        results.push(result);
        return result;
      });
  }, Promise.resolve())
    .then(function () {
      return results;
    });
};

function createDeployer(projectRoot, foundrySpecs, environments,
                        environmentName, timestamp) {
  var foundries = {};

  timestamp = timestamp || Math.ceil(new Date().valueOf() / 1000);

  function getEnvironment() {
    return environments[environmentName];
  }

  function newFoundry(location) {
    var foundrySpec = foundrySpecs[location],
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
            CF_HOME: foundrySpec.home,
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
      return cf('api', foundrySpec.api);
    }
    function addCommunityRepo() {
      return cf('add-plugin-repo', 'CF-Community', 'http://plugins.cloudfoundry.org/')
        .catch(function (error) {
          console.log('ignoring add-plugin-repo', error);
        });
    }
    function installDiego() {
      return cf('install-plugin', 'Diego-Enabler', '-r', 'CF-Community', '-f')
        .catch(function (error) {
          console.log('ignoring install-plugin error', error);
        });
    }
    function enableDiego() {
      return cf('enable-diego', newAppName)
        .catch(function (error) {
          console.log('ignoring enable-diego error', error);
        });
    }
    function cfVersion() {
      return cf('-v');
    }
    function logout() {
      return cf('logout');
    }
    function login() {
      var space = foundrySpec.spaces[environment.appEnv.NODE_ENV];
      return cf('login', '--u', foundrySpec.username, '--p', foundrySpec.password,
                '--o', foundrySpec.org, '--s', space);
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
      return cf('delete', '-f', appName)
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
      return Promise.series(settings);
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
      return Promise.series([
        getAppName.bind(undefined, foundrySpec.domain, environment.endpoint),
        getAppName.bind(undefined, environment.baseDomain, environment.baseName)
      ])
        .then(function (appNames) {
          console.log('appNames', appNames);
          oldAppName = appNames.filter(function (appName) {
            return appName && appName !== newAppName;
          })[0];
          console.log('set old app name', oldAppName);
          return oldAppName;
        });
    }
    function mapNewApp(domain, endpoint) {
      var mapArgs = ['map-route', newAppName, domain];
      if (endpoint) {
        mapArgs.push('-n', endpoint);
      }
      return cf.apply(foundrySpec, mapArgs)
        .catch(function (error) {
          console.error('error mapping app:', newAppName,
                        'domain:', domain, 'error:', error);
          return Promise.reject(error);
        });
    }
    function pushNewApp() {
      return cfVersion()
        .then(logout)
        .then(setApi)
        .then(login)
        .then(pushApp)
        .then(addCommunityRepo)
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
    function mapNewApps() {
      var mappings = [
        mapNewApp.bind(undefined, foundrySpec.domain, environment.endpoint)
      ];
      if (environment.baseDomain === 'ctl.io') {
        // the ctl.io domain does not exist in AppFog
        mappings.push(
          mapNewApp.bind(undefined, environment.baseName + '.' + environment.baseDomain, undefined));
      } else {
        mappings.push(
          mapNewApp.bind(undefined, environment.baseDomain, environment.baseName));
      }
      mappings =
        mappings.concat(environment.custom_domains.map(function (domain) {
          return mapNewApp.bind(undefined, domain, undefined);
        }));

      return Promise.series(mappings);
    }
    function bindServicesToApp() {
      return Promise.series(environment.services.map(function (service) {
        return bindServiceToApp.bind(undefined, service);
      }));
    }
    return {
      pushNewApp: pushNewApp,
      deleteNewApp: deleteNewApp,
      deleteOldApp: deleteOldApp,
      bindServicesToApp: bindServicesToApp,
      mapNewApps: mapNewApps,
      setOldAppName: setOldAppName,
      spec: foundrySpec
    };
  }

  function getFoundry(location) {
    if (!foundries[location]) {
      foundries[location] = newFoundry(location);
    }
    return foundries[location];
  }

  function pushNewApp(location) {
    var foundry = getFoundry(location);
    return foundry.pushNewApp();
  }

  function deleteNewApp(location) {
    var foundry = getFoundry(location);
    return foundry.deleteNewApp();
  }

  function deleteOldApp(location) {
    var foundry = getFoundry(location);
    return foundry.deleteOldApp();
  }

  function bindServicesToApp(location) {
    var foundry = getFoundry(location);
    return foundry.bindServicesToApp();
  }

  function remapNewApp(location) {
    var foundry = getFoundry(location);
    return foundry.setOldAppName()
      .then(function () {
        return foundry.mapNewApps();
      });
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

  function remapNewApps() {
    return eachLocation(remapNewApp);
  }

  function deleteNewApps() {
    return eachLocation(deleteNewApp);
  }

  function deleteOldApps() {
    return eachLocation(deleteOldApp)
      .catch(function (error) {
        console.log('error deleting old apps', error);
      });
  }

  function deployApps() {
    pushNewApps()
      .then(bindServicesToApps)
      .then(remapNewApps)
      .then(deleteOldApps)
      .catch(function (error) {
        deleteNewApps()
          .then(function () {
            console.error('deploy failed', error, error.stack);
            process.exit(1);
          });
      });
  }

  return {
    deployApps: deployApps
  };
}

exports.createDeployer = createDeployer;
