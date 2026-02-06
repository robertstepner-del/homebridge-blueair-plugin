const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

// Lazy-load compiled dist files to prevent server crash if dist/ doesn't exist yet
let defaultConfig, defaultDeviceConfig, BlueAirAwsApi;
let distLoaded = false;
let distLoadError = null;

function loadDist() {
  if (distLoaded) return true;
  try {
    const utils = require('../dist/utils.js');
    defaultConfig = utils.defaultConfig;
    defaultDeviceConfig = utils.defaultDeviceConfig;
    BlueAirAwsApi = require('../dist/api/BlueAirAwsApi.js').default;
    distLoaded = true;
    return true;
  } catch (e) {
    distLoadError = e;
    // Provide inline fallback defaults so the UI can still render
    defaultConfig = {
      name: 'BlueAir Platform',
      uiDebug: false,
      verboseLogging: true,
      username: '',
      password: '',
      region: 'Default (all other regions)',
      accountUuid: '',
      pollingInterval: 120,
      devices: [],
    };
    defaultDeviceConfig = {
      id: '',
      name: '',
      model: '',
      serialNumber: '',
      filterChangeLevel: 10,
      showFanTile: true,
      defaultTargetHumidity: 60,
      led: true,
      nightLight: false,
      airQualitySensor: true,
      co2Sensor: true,
      temperatureSensor: true,
      humiditySensor: true,
      germShield: false,
      nightMode: false,
    };
    return false;
  }
}

// Attempt initial load
loadDist();

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
  config;
  api;

  constructor() {
    super();
    
    // Initialize logger first (with defaults)
    this.logger = new Logger(false);
    this.logger.info('Custom UI server started.');
    
    // Try to get config from homebridge config.json
    try {
      const allPlatforms = require(this.homebridgeConfigPath).platforms || [];
      const config = allPlatforms.find((obj) => obj.platform === 'blueair-plugin');
      if (config?.uiDebug) {
        this.logger.setDebugEnabled(true);
      }
    } catch (e) {
      this.logger.debug(`Could not load config from homebridgeConfigPath: ${e}`);
    }

    this.onRequest('/mergeToDefault', async ({ config }) => {
      if (!config || typeof config !== 'object') {
        config = {};
      }
      _.defaultsDeep(config, defaultConfig);
      if (config.devices && Array.isArray(config.devices)) {
        config.devices.forEach((device) => {
          if (device && typeof device === 'object') {
            _.defaultsDeep(device, defaultDeviceConfig);
          }
        });
      } else {
        config.devices = [];
      }
      this.config = config;
      this.logger.setDebugEnabled(config.uiDebug ? config.uiDebug : false);
      this.logger.debug(`Merged config:\n${JSON.stringify(config, null, 2)}`);
      return config;
    });

    this.onRequest('/getDefaults', async () => {
      return {
        defaultConfig,
        defaultDeviceConfig,
      };
    });

    this.onRequest('/discover', async ({ username, password, region }) => {
      // Re-attempt loading dist if it failed initially (e.g., build finished after server start)
      if (!distLoaded) {
        loadDist();
      }
      if (!BlueAirAwsApi) {
        throw new RequestError(
          'Plugin is not fully built yet. Please restart Homebridge after the plugin is installed and try again.'
        );
      }
      try {
        this.api = new BlueAirAwsApi(username, password, region, this.logger);
        await this.api.login();
        const devices = await this.api.getDevices();

        return devices;
      } catch (e) {
        const msg = e instanceof Error ? e.stack : e;
        this.logger.error(`Device discovery failed:\n${msg}`);
        throw new RequestError(`Device discovery failed:\n${msg}`);
      }
    });

    this.onRequest('/getInitialDeviceStates', async ({ accountUuid, uuids }) => {
      if (!this.api) {
        throw new RequestError('Please run device discovery first before fetching device states.');
      }
      try {
        return await this.api.getDeviceStatus(accountUuid, uuids);
      } catch (e) {
        const msg = e instanceof Error ? e.stack : e;
        this.logger.error(`Failed to get initial device states:\n${msg}`);
        throw new RequestError(`Failed to get initial device states:\n${msg}`);
      }
    });

    // inform client-side script that we are ready to receive requests.
    this.ready();
  }
}

// start the instance of the class
(() => {
  return new UiServer();
})();
