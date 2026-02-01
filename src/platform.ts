import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import { PLATFORM_NAME, PLUGIN_NAME } from "./utils/settings";
import { Config, defaultConfig } from "./utils/platformUtils";
import { defaultsDeep } from "lodash";
import BlueAirAwsApi, { BlueAirDeviceStatus } from "./api/BlueAirAwsApi";
import { BlueAirDevice } from "./device/BlueAirDevice";
import { BlueAirAccessory } from "./accessory/BlueairAccesory";
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

      this.getValidDevicesStatus();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info("Loading accessory from cache:", accessory.displayName);
    this.accessories.push(accessory);
  }

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
    } catch (error) {
      const err = error as Error;
      this.log.warn(
        "Error getting valid devices status, reason:" +
          err.message +
          ". Retrying in 5 seconds...",
      );
      this.log.debug("Error stack:", err.stack);
    } finally {
      this.polling = setTimeout(
        this.getValidDevicesStatus.bind(this),
        this.platformConfig.pollingInterval,
      );
    }
  }

  async getInitialDeviceStates() {
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
      this.log.error("Error getting initial device states:", error);
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
          this.platformConfig.pollingInterval,
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
  }): boolean {
    const deviceName = (
      deviceConfig.model ||
      deviceConfig.name ||
      ""
    ).toLowerCase();
    const humidifierPatterns = [
      "humidifier",
      "humidify",
      "moisture",
      "hygrostat",
    ];
    return humidifierPatterns.some((pattern) => deviceName.includes(pattern));
  }
}
