const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { defaultConfig, defaultDeviceConfig } = require('../dist/utils.js');
const BlueAirAwsApi = require('../dist/api/BlueAirAwsApi.js').default;

var _ = require('lodash');

/*********************************************************************
 * Logger
 * Lightweight log class to mimic the homebridge log capability
 */
class Logger {
  _debug;
  _Reset = '\x1b[0m';
  _Bright = '\x1b[1m';
  _Dim = '\x1b[2m';

  _FgBlack = '\x1b[30m';
  _FgRed = '\x1b[31m';
  _FgGreen = '\x1b[32m';
  _FgYellow = '\x1b[33m';
  _FgBlue = '\x1b[34m';
  _FgMagenta = '\x1b[35m';
  _FgCyan = '\x1b[36m';
  _FgWhite = '\x1b[37m';
  _FgGray = '\x1b[90m';

  constructor(uiDebug = false) {
    this._debug = uiDebug;
  }

  info(str) {
    console.info(this._FgWhite + str + this._Reset);
  }

  warn(str) {
    console.warn(this._FgYellow + str + this._Reset);
  }

  error(str) {
    console.error(this._FgRed + str + this._Reset);
  }

  debug(str) {
    if (this._debug) {
      console.debug(this._FgGray + str + this._Reset);
    }
  }

  setDebugEnabled(enabled = true) {
    this._debug = enabled;
  }
}

/*********************************************************************
 * UIServer
 * Main server-side script called when Custom UI client sends requests
 */
class UiServer extends HomebridgePluginUiServer {
  logger;
  api;

  constructor() {
    super();
    
    // Initialize logger
    this.logger = new Logger(false);
    this.logger.info('BlueAir Custom UI server started.');

    this.onRequest('/getDefaults', async () => {
      return {
        defaultConfig,
        defaultDeviceConfig,
      };
    });

    this.onRequest('/mergeToDefault', async ({ config }) => {
      try {
        if (!config || typeof config !== 'object') {
          config = {};
        }
        _.defaultsDeep(config, defaultConfig);
        if (config.devices && Array.isArray(config.devices)) {
          config.devices.forEach((device) => {
            _.defaultsDeep(device, defaultDeviceConfig);
          });
        } else {
          config.devices = [];
        }
        this.logger.setDebugEnabled(config.uiDebug || false);
        return config;
      } catch (e) {
        this.logger.error(`mergeToDefault error: ${e}`);
        return { ...defaultConfig, devices: [] };
      }
    });

    this.onRequest('/discover', async ({ username, password, region }) => {
      try {
        if (!username || !password) {
          throw new Error('Username and password are required');
        }
        this.api = new BlueAirAwsApi(username, password, region, this.logger);
        await this.api.login();
        const devices = await this.api.getDevices();
        return devices || [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`Device discovery failed: ${msg}`);
        throw new RequestError(`Discovery failed: ${msg}`);
      }
    });

    this.onRequest('/getInitialDeviceStates', async ({ accountUuid, uuids }) => {
      try {
        if (!this.api) {
          throw new Error('Not logged in. Please discover devices first.');
        }
        if (!accountUuid || !uuids || !uuids.length) {
          throw new Error('Missing accountUuid or device uuids');
        }
        const states = await this.api.getDeviceStatus(accountUuid, uuids);
        return states || [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`Failed to get device states: ${msg}`);
        throw new RequestError(`Failed to get device states: ${msg}`);
      }
    });

    // Signal that the server is ready to receive requests
    this.ready();
  }
}

// Start the server
(() => {
  return new UiServer();
})();
