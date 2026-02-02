import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME, Config, defaultConfig, getDeviceCapabilities } from "./utils";
import { defaultsDeep } from "lodash";
import BlueAirAwsApi, { BlueAirDeviceStatus, DEVICE_TYPES } from "./api/BlueAirAwsApi";
import { BlueAirDevice, BlueAirAccessory } from "./accessory";
import EventEmitter from "events";

export class BlueAirPlatform
  extends EventEmitter
  implements DynamicPlatformPlugin
{
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private readonly platformConfig: Config;
  private readonly blueAirApi: BlueAirAwsApi;

  private existingUuids: string[] = [];

  private devices: BlueAirDevice[] = [];
  private polling: NodeJS.Timeout | null = null;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    super();
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.platformConfig = defaultsDeep(config, defaultConfig);
    this.log.debug("Finished initializing platform:", this.platformConfig.name);

    if (
      !this.platformConfig.username ||
      !this.platformConfig.password ||
      !this.platformConfig.accountUuid
    ) {
      this.log.error(
        "Missing required configuration options! Please do the device discovery in the configuration UI and/or check your\
      config.json file",
      );
    }

    this.blueAirApi = new BlueAirAwsApi(
      this.platformConfig.username,
      this.platformConfig.password,
      this.platformConfig.region,
      log,
    );

    this.api.on("didFinishLaunching", async () => {
      await this.getInitialDeviceStates();

      // Add a small delay before starting polling to reduce API pressure
      setTimeout(() => {
        this.getValidDevicesStatus();
      }, 5000); // 5 second delay
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info("Loading accessory from cache:", accessory.displayName);
    this.accessories.push(accessory);
  }

  private retryCount = 0;
  private readonly MAX_RETRY_COUNT = 5;

  async getValidDevicesStatus() {
    this.log.debug("Updating devices states...");
    try {
      const devices = await this.blueAirApi.getDeviceStatus(
        this.platformConfig.accountUuid,
        this.existingUuids,
      );
      for (const device of devices) {
        const blueAirDevice = this.devices.find((d) => d.id === device.id);
        if (!blueAirDevice) {
          this.log.error(`[${device.name}] Device not found in cache!`);
          continue;
        }
        this.log.debug(`[${device.name}] Updating device state...`);
        blueAirDevice.emit("update", device);
      }
      this.log.debug("Devices states updated!");
      // Reset retry count on success
      this.retryCount = 0;
    } catch (error) {
      const err = error as Error;
      let retryDelay = this.platformConfig.pollingInterval * 1000;
      
      // Check if this is a rate limit error
      if (err.message.includes("rate limit") || err.message.includes("too many calls")) {
        this.retryCount++;
        // Exponential backoff for rate limit: double the interval each time, up to 10 minutes
        retryDelay = Math.min(
          this.platformConfig.pollingInterval * 1000 * Math.pow(2, this.retryCount),
          600000 // Max 10 minutes
        );
        this.log.warn(
          `Rate limit exceeded (attempt ${this.retryCount}/${this.MAX_RETRY_COUNT}). ` +
          `Backing off and retrying in ${Math.round(retryDelay / 1000)} seconds...`,
        );
        
        if (this.retryCount >= this.MAX_RETRY_COUNT) {
          this.log.error(
            `Rate limit retry limit reached. Please increase the polling interval in your config ` +
            `(current: ${this.platformConfig.pollingInterval}s, recommended: ${this.platformConfig.pollingInterval * 2}s or more)`,
          );
          // Reset counter but keep long delay
          this.retryCount = 0;
        }
      } else {
        retryDelay = 5000; // 5 seconds for non-rate-limit errors
        this.log.warn(
          "Error getting valid devices status: " +
            err.message +
            `. Retrying in ${retryDelay / 1000} seconds...`,
        );
        this.log.debug("Error stack:", err.stack);
      }
      
      this.polling = setTimeout(
        this.getValidDevicesStatus.bind(this),
        retryDelay,
      );
      return;
    }
    
    // Schedule next update with normal interval
    this.polling = setTimeout(
      this.getValidDevicesStatus.bind(this),
      this.platformConfig.pollingInterval * 1000,
    );
  }

  async getInitialDeviceStates(retryCount = 0, maxRetries = 5) {
    this.log.info("Getting initial device states...");
    try {
      await this.blueAirApi.login();
      let uuids = this.platformConfig.devices.map((device) => device.id);
      const devices = await this.blueAirApi.getDeviceStatus(
        this.platformConfig.accountUuid,
        uuids,
      );

      // Log status at startup for visibility
      this.log.info(`Found ${devices.length} device(s) in API response`);
      for (const device of devices) {
        const config = this.platformConfig.devices.find(
          (c) => c.id === device.id,
        );
        const deviceType =
          config && this.isHumidifierDevice(config)
            ? "Humidifier"
            : "Air Purifier";
        this.log.info(
          `[${device.name}] Type: ${deviceType}, Model: ${config?.model || "Unknown"}`,
        );
      }

      for (const device of devices) {
        this.addDevice(device);
        uuids = uuids.filter((uuid) => uuid !== device.id);
      }

      for (const uuid of uuids) {
        const device = this.platformConfig.devices.find(
          (device) => device.id === uuid,
        )!;
        this.log.warn(`[${device.name}] Device not found in AWS API response!`);
      }

      this.log.info("All configured devices have been added!");
    } catch (error) {
      const err = error as Error;
      
      // Check if this is a rate limit error
      if (err.message.includes("rate limit") || err.message.includes("too many calls")) {
        if (retryCount < maxRetries) {
          // Exponential backoff: 30s, 60s, 120s, 240s, 480s
          const retryDelay = 30000 * Math.pow(2, retryCount);
          this.log.warn(
            `Rate limit during initialization (attempt ${retryCount + 1}/${maxRetries}). ` +
            `Retrying in ${retryDelay / 1000} seconds...`,
          );
          
          setTimeout(async () => {
            await this.getInitialDeviceStates(retryCount + 1, maxRetries);
          }, retryDelay);
          return;
        } else {
          this.log.error(
            `Failed to initialize devices after ${maxRetries} attempts due to rate limiting. ` +
            `Please wait a few minutes and restart Homebridge, or increase the polling interval.`,
          );
          return;
        }
      }
      
      // For non-rate-limit errors, retry once after 10 seconds
      if (retryCount === 0) {
        this.log.error("Error getting initial device states:", err.message);
        this.log.warn("Retrying in 10 seconds...");
        setTimeout(async () => {
          await this.getInitialDeviceStates(1, 1);
        }, 10000);
      } else {
        this.log.error("Failed to get initial device states after retry:", err.message);
      }
    }
  }

  async addDevice(device: BlueAirDeviceStatus) {
    const uuid = this.api.hap.uuid.generate(device.id);
    const existingAccessory = this.accessories.find(
      (accessory) => accessory.UUID === uuid,
    );
    const deviceConfig = this.platformConfig.devices.find(
      (config) => config.id === device.id,
    );
    this.existingUuids.push(device.id);

    if (!deviceConfig) {
      this.log.error(`[${device.name}] Device configuration not found!`);
      return;
    }

    const blueAirDevice = new BlueAirDevice(device);
    this.devices.push(blueAirDevice);

    blueAirDevice.on("setState", async ({ id, name, attribute, value }) => {
      // this.log.info(`[${name}] Setting state: ${attribute} = ${value}`);

      // Clear polling to avoid conflicts
      this.polling && clearTimeout(this.polling);
      let success = false;
      try {
        await this.blueAirApi.setDeviceStatus(id, attribute, value);
        success = true;
      } catch (error) {
        this.log.error(
          `[${name}] Error setting state: ${attribute} = ${value}`,
          error,
        );
      } finally {
        blueAirDevice.emit("setStateDone", success);
        // Have to clear polling again to avoid conflicts
        this.polling && clearTimeout(this.polling);
        this.polling = setTimeout(
          this.getValidDevicesStatus.bind(this),
          this.platformConfig.pollingInterval * 1000,
        );
      }
    });

    // Determine if this is a humidifier based on model name or device config
    const isHumidifier = this.isHumidifierDevice(deviceConfig);

    if (existingAccessory) {
      this.log.info(
        `[${deviceConfig.name}] Restoring existing accessory from cache: ${existingAccessory.displayName}`,
      );
      new BlueAirAccessory(
        this,
        existingAccessory,
        blueAirDevice,
        deviceConfig,
        isHumidifier ? "humidifier" : "air-purifier",
      );
    } else {
      this.log.info("Adding new accessory:", device.name);
      const accessory = new this.api.platformAccessory(device.name, uuid);
      new BlueAirAccessory(
        this,
        accessory,
        blueAirDevice,
        deviceConfig,
        isHumidifier ? "humidifier" : "air-purifier",
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
        accessory,
      ]);
    }
  }

  /**
   * Get available devices from API for auto-discovery
   * Used by the configuration UI to populate available devices
   */
  async getAvailableDevices(): Promise<
    Array<{ uuid: string; name: string; type: string; mac: string }>
  > {
    try {
      await this.blueAirApi.login();
      const devices = await this.blueAirApi.getDevices();
      return devices.map((d) => ({
        uuid: d.uuid,
        name: d.name,
        type: d.type,
        mac: d.mac,
      }));
    } catch (error) {
      this.log.error("Error getting available devices:", error);
      return [];
    }
  }

  private isHumidifierDevice(deviceConfig: {
    model?: string;
    name?: string;
    type?: string;
  }): boolean {
    const deviceName = (
      deviceConfig.model ||
      deviceConfig.name ||
      ""
    ).toLowerCase();
    const deviceType = (deviceConfig.type || "").toLowerCase();

    // Check device type first (from API)
    if (
      deviceType.includes(DEVICE_TYPES.HUMIDIFIER) ||
      deviceType.includes("humidity")
    ) {
      return true;
    }

    // Check model name for humidifier patterns
    const humidifierPatterns = [
      "humidifier",
      "humidify",
      "moisture",
      "hygrostat",
    ];
    return humidifierPatterns.some((pattern) => deviceName.includes(pattern));
  }
}
