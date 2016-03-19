'use strict';
var BASE_NAME = 'my-project',
  ROOT_DOMAIN = 'example.com',
  os = require('os'),
  path = require('path'),
  cfDeployMulti = require('cf-deploy-multi'),
  travisCommit = process.env.TRAVIS_COMMIT.substr(0, 6),
  deployer,
  timestamp,
  environmentName,
  foundries,
  environments;

environmentName = process.env.TRAVIS_BRANCH;

timestamp = process.env.TRAVIS_TIMESTAMP ||
  Math.ceil(new Date().valueOf() / 1000);
foundries = {
  pivotal: {
    api: 'https://api.run.pivotal.io',
    domain: 'cfapps.io',
    home: path.resolve(os.homedir(), '.cf-pivotal'),
    username: process.env.PIVOTAL_USERNAME,
    password: process.env.PIVOTAL_PASSWORD,
    org: 'centurylinkcloud',
    spaces: {
      production: 'main',
      staging: 'qa'
    }
  },
  'appfog-east': {
    api: 'https://api.useast.appfog.ctl.io',
    domain: 'useast.appfog.ctl.io',
    home: path.resolve(os.homedir(), '.cf-appfog-east'),
    username: process.env.APPFOG_USERNAME,
    password: process.env.APPFOG_PASSWORD,
    org: 'corp',
    spaces: {
      production: 'prod',
      staging: 'qa',
      dev: 'Digital-Dev'
    }
  },
  'appfog-west': {
    api: 'https://api.uswest.appfog.ctl.io',
    domain: 'uswest.appfog.ctl.io',
    home: path.resolve(os.homedir(), '.cf-appfog-west'),
    username: process.env.APPFOG_USERNAME,
    password: process.env.APPFOG_PASSWORD,
    org: 'corp',
    spaces: {
      production: 'prod',
      staging: 'qa'
    }
  }
};
environments = {
  production: {
    appEnv: {
      NODE_ENV: 'production',
      SLACK_WEBHOOK: process.env.SLACK_KEY
    },
    endpoint: BASE_NAME + '-production-dns',
    baseName: BASE_NAME,
    baseDomain: ROOT_DOMAIN,
    custom_domains: [],
    newAppName: BASE_NAME + '-production-' + travisCommit + '-' + timestamp,
    locations: [
      'appfog-east'
    ],
    instances: 1,
    memory: '512M',
    disk: '512M',
    services: []
  },
  master: {
    appEnv: {
      NODE_ENV: 'staging',
      SLACK_WEBHOOK: process.env.SLACK_KEY
    },
    endpoint: BASE_NAME + '-staging-dns',
    baseName: BASE_NAME,
    baseDomain: 'staging.' + ROOT_DOMAIN,
    custom_domains: [],
    newAppName: BASE_NAME + '-staging-' + travisCommit + '-' + timestamp,
    locations: [
      'appfog-east'
    ],
    instances: 1,
    memory: '512M',
    disk: '512M',
    services: []
  },
  dev: {
    appEnv: {
      NODE_ENV: 'dev',
      SLACK_WEBHOOK: process.env.SLACK_KEY
    },
    endpoint: BASE_NAME + '-dev',
    baseName: BASE_NAME,
    baseDomain: 'dev.' + ROOT_DOMAIN,
    custom_domains: [],
    newAppName: BASE_NAME + '-dev-' + travisCommit + '-' + timestamp,
    locations: [
      'appfog-east'
    ],
    instances: 1,
    memory: '512M',
    disk: '512M',
    services: []
  }
};

deployer = cfDeployMulti.createDeployer(foundries, environments,
                                        environmentName, timestamp);

deployer.deployApps();

