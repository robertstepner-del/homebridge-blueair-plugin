import {
  BlueAirDeviceState,
  FullBlueAirDeviceState,
} from "./api/BlueAirAwsApi";
import { CharacteristicValue, PlatformAccessory, Service, Characteristic, WithUUID } from "homebridge";
import { DeviceConfig, DeviceCapabilities, detectCapabilities, formatCapabilities, Debouncer } from "./utils";
import {
  HUMIDITY_MIN,
  HUMIDITY_MAX,
  FAN_SPEED_LEVELS,
  FAN_SPEED_HOMEKIT_STEP,
  NL_LEVELS,
  NL_HOMEKIT_STEP,
  DEBOUNCE_DELAY_MS,
  AQI_THRESHOLDS,
  fanSpeedHomeKitToDevice,
  fanSpeedDeviceToHomeKit,
  nlDeviceToHomeKit,
  nlHomeKitToDevice,
  nlDeviceToName,
} from "./constants";
import { BlueAirDevice } from "./device";
import type { BlueAirPlatform } from "./platform";

// Re-export BlueAirDevice for backward compatibility
export { BlueAirDevice } from "./device";

type DeviceType = "humidifier" | "air-purifier";

export class BlueAirAccessory {
  private service!: Service;
  private fanService?: Service;
  private filterMaintenanceService?: Service;
  private readonly optionalServices = new Map<string, Service>();
  private deviceType: DeviceType;
  private humidityAutoControlEnabled = false;
  private lastManualOverride = 0;
  private lastAutoAdjust = 0;
  private loggedNoWritableTargetHumidity = false;
  
  // Track last brightness for LED on/off toggle
  private lastBrightness: number;
  
  // Debouncers for HomeKit slider interactions
  private fanSpeedDebouncer: Debouncer<{ speed: number; isNightMode: boolean; isStandby: boolean; hkSpeed: number }>;
  private nlBrightnessDebouncer: Debouncer<number>;
  private humidityDebouncer: Debouncer<number>;
  
  // Dynamic capabilities detected from device state keys
  private capabilities: DeviceCapabilities = {
    hasBrightness: false,
    hasNightLight: false,
    hasNightMode: false,
    hasAutoMode: false,
    hasHumidity: false,
    hasHumidityTarget: false,
    hasWaterLevel: false,
    hasTemperature: false,
    hasAirQuality: false,
    hasGermShield: false,
    hasFilterUsage: false,
    hasChildLock: false,
    hasFanSpeed: false,
  };

  constructor(
    protected readonly platform: BlueAirPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly device: BlueAirDevice,
    protected readonly configDev: DeviceConfig,
    deviceType: DeviceType = "air-purifier",
  ) {
    this.deviceType = deviceType;
    
    // Initialize last brightness from device state
    this.lastBrightness = this.device.state.brightness || 0;
    
    // Initialize debouncers
    this.fanSpeedDebouncer = new Debouncer(DEBOUNCE_DELAY_MS, this.executeFanSpeedChange.bind(this));
    this.nlBrightnessDebouncer = new Debouncer(DEBOUNCE_DELAY_MS, this.executeNlBrightnessChange.bind(this));
    this.humidityDebouncer = new Debouncer(DEBOUNCE_DELAY_MS, this.executeHumidityChange.bind(this));
    
    // Detect capabilities from available state keys
    this.initCapabilities();

    this.setupAccessoryInformation();
    this.setupMainService();
    this.setupOptionalServices();
    this.setupEventListeners();
  }

  private initCapabilities() {
    this.capabilities = detectCapabilities(this.device.state, this.device.sensorData);
    this.platform.log.info(`[${this.device.name}] Detected capabilities: ${formatCapabilities(this.capabilities)}`);
  }

  private setupAccessoryInformation() {
    const typeLabel =
      this.deviceType === "humidifier" ? "Humidifier" : "Purifier";
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "BlueAir")
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.configDev.model || `BlueAir ${typeLabel}`,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.configDev.serialNumber || "BlueAir Device",
      );

    if (this.configDev.room) {
      this.accessory.displayName = `${this.configDev.name} (${this.configDev.room})`;
    }

    this.platform.log.info(
      `[${this.configDev.name}] Initializing ${typeLabel} accessory (Model: ${this.configDev.model || "Unknown"})`,
    );
  }

  private setupMainService() {
    if (this.deviceType === "humidifier") {
      this.setupHumidifierService();
    } else {
      this.setupAirPurifierService();
    }
    
    // Common setup for all device types
    this.setupCommonServiceCharacteristics();
  }

  /**
   * Setup characteristics common to both Air Purifier and Humidifier services
   */
  private setupCommonServiceCharacteristics() {
    const C = this.platform.Characteristic;

    // Active state
    this.service
      .getCharacteristic(C.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    // Lock physical controls (child lock)
    this.service
      .getCharacteristic(C.LockPhysicalControls)
      .onGet(this.getLockPhysicalControls.bind(this))
      .onSet(this.setLockPhysicalControls.bind(this));

    // Rotation speed (fan speed) - discrete steps matching device capability
    this.service
      .getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: FAN_SPEED_HOMEKIT_STEP })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    // Filter maintenance service
    this.filterMaintenanceService =
      this.accessory.getService(this.platform.Service.FilterMaintenance) ||
      this.accessory.addService(this.platform.Service.FilterMaintenance);

    this.filterMaintenanceService
      .getCharacteristic(C.FilterChangeIndication)
      .onGet(this.getFilterChangeIndication.bind(this));

    this.filterMaintenanceService
      .getCharacteristic(C.FilterLifeLevel)
      .onGet(this.getFilterLifeLevel.bind(this));

    // Link for grouping in Home app
    this.service.addLinkedService(this.filterMaintenanceService);
  }

  private setupAirPurifierService() {
    this.service =
      this.accessory.getService(this.platform.Service.AirPurifier) ||
      this.accessory.addService(this.platform.Service.AirPurifier);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.configDev.name,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState)
      .onGet(this.getCurrentAirPurifierState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onGet(this.getTargetAirPurifierState.bind(this))
      .onSet(this.setTargetAirPurifierState.bind(this));

    // Add humidity to main control screen if available
    if (this.capabilities.hasHumidity) {
      this.service
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentRelativeHumidity.bind(this));
    }
  }

  private setupHumidifierService() {
    this.service =
      this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.configDev.name,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // RelativeHumidityHumidifierThreshold for target humidity
    this.service
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .onSet(this.setTargetRelativeHumidity.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(this.getCurrentHumidifierState.bind(this));

    // Lock to HUMIDIFIER mode only
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
        ],
      })
      .onGet(this.getTargetHumidifierState.bind(this))
      .onSet(this.setTargetHumidifierState.bind(this));

    // Water level
    this.service
      .getCharacteristic(this.platform.Characteristic.WaterLevel)
      .onGet(this.getWaterLevel.bind(this));

    // Optional separate Fan tile for Home app visibility
    if (this.configDev.showFanTile !== false) {
      this.setupFanService();
    }
  }

  /**
   * Setup separate Fan service for humidifiers (optional)
   */
  private setupFanService() {
    const C = this.platform.Characteristic;

    this.fanService =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2, "Fan", "Fan");

    this.fanService.setCharacteristic(C.Name, this.configDev.name + " Fan");

    this.fanService
      .getCharacteristic(C.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.fanService
      .getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: FAN_SPEED_HOMEKIT_STEP })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    // Link for better UI grouping
    this.service.addLinkedService(this.fanService);
  }

  /**
   * Helper to set up or remove an optional service based on config.
   * Returns the service if enabled, undefined otherwise.
   * 
   * Note: By default, optional services are NOT linked to the primary service.
   * This means they appear as separate tiles in the Home app, which provides
   * a cleaner UX than stacked controls in the main control popup.
   * The primary service (purifier/humidifier) handles the main device controls.
   */
  private setupOptionalService(
    serviceConstructor: WithUUID<typeof Service>,
    subtype: string,
    displayName: string,
    enabled: boolean,
    configure: (service: Service) => void,
    linkToMain = false, // Set to true to link service to primary (shows in control popup)
  ): Service | undefined {
    const existingService = this.accessory.getServiceById(serviceConstructor, subtype);

    if (enabled) {
      const service =
        existingService ??
        this.accessory.addService(
          serviceConstructor,
          `${this.device.name} ${displayName}`,
          subtype,
        );
      service.setCharacteristic(
        this.platform.Characteristic.Name,
        `${this.device.name} ${displayName}`,
      );
      configure(service);
      this.optionalServices.set(subtype, service);
      // Only link if explicitly requested
      if (linkToMain) {
        this.service.addLinkedService(service);
      }
      return service;
    } else if (existingService) {
      // Remove any existing link before removing service
      try {
        this.service.removeLinkedService(existingService);
      } catch {
        // Ignore if not linked
      }
      this.accessory.removeService(existingService);
      this.optionalServices.delete(subtype);
    }
    return undefined;
  }

  private setupOptionalServices() {
    const C = this.platform.Characteristic;
    const S = this.platform.Service;

    // Remove legacy "Led" service from cache (renamed to DisplayBrightness)
    this.setupOptionalService(
      S.Lightbulb,
      "Led",
      "Led",
      false, // Always remove - replaced by DisplayBrightness
      () => {},
    );

    // Display brightness - only if device has brightness capability
    this.setupOptionalService(
      S.Lightbulb,
      "DisplayBrightness",
      "Display Brightness",
      this.capabilities.hasBrightness && this.configDev.led !== false,
      (svc) => {
        svc.setCharacteristic(C.ConfiguredName, `${this.device.name} Display`);
        svc.getCharacteristic(C.On).onGet(this.getDisplayOn.bind(this)).onSet(this.setDisplayOn.bind(this));
        svc.getCharacteristic(C.Brightness).onGet(this.getDisplayBrightness.bind(this)).onSet(this.setDisplayBrightness.bind(this));
      },
    );

    // Night light brightness - only if device has nlbrightness capability
    this.setupOptionalService(
      S.Lightbulb,
      "NightLight",
      "Night Light",
      this.capabilities.hasNightLight && this.configDev.nightLight !== false,
      (svc) => {
        svc.setCharacteristic(C.ConfiguredName, `${this.device.name} Night Light`);
        svc.getCharacteristic(C.On).onGet(this.getNightLightOn.bind(this)).onSet(this.setNightLightOn.bind(this));
        svc.getCharacteristic(C.Brightness)
          .setProps({ minValue: 0, maxValue: 100, minStep: NL_HOMEKIT_STEP })
          .onGet(this.getNightLightBrightness.bind(this))
          .onSet(this.setNightLightBrightness.bind(this));
      },
    );

    // Temperature sensor - only if device has temperature data
    this.setupOptionalService(
      S.TemperatureSensor,
      "Temperature",
      "Temperature",
      this.capabilities.hasTemperature && this.configDev.temperatureSensor !== false,
      (svc) => {
        svc.getCharacteristic(C.CurrentTemperature).onGet(this.getCurrentTemperature.bind(this));
      },
    );

    // Night mode switch removed - night mode is triggered automatically when fan speed is low
    this.setupOptionalService(
      S.Switch,
      "NightMode",
      "Night Mode",
      false, // Always remove
      () => {},
    );

    // Humidity sensor - only if device has humidity data
    this.setupOptionalService(
      S.HumiditySensor,
      "Humidity",
      "Humidity",
      this.capabilities.hasHumidity && this.configDev.humiditySensor !== false,
      (svc) => {
        svc.getCharacteristic(C.CurrentRelativeHumidity).onGet(this.getCurrentRelativeHumidity.bind(this));
      },
    );

    // Air quality sensor - only if device has air quality data
    this.setupOptionalService(
      S.AirQualitySensor,
      "AirQuality",
      "Air Quality",
      this.capabilities.hasAirQuality && this.configDev.airQualitySensor !== false,
      (svc) => {
        svc.getCharacteristic(C.AirQuality).onGet(this.getAirQuality.bind(this));
        svc.getCharacteristic(C.PM2_5Density).onGet(this.getPM2_5Density.bind(this));
        svc.getCharacteristic(C.PM10Density).onGet(this.getPM10Density.bind(this));
        svc.getCharacteristic(C.VOCDensity).onGet(this.getVOCDensity.bind(this));
      },
    );

    // Germ shield switch - only if device has germshield capability
    this.setupOptionalService(
      S.Switch,
      "GermShield",
      "Germ Shield",
      this.capabilities.hasGermShield && this.configDev.germShield !== false,
      (svc) => {
        svc.setCharacteristic(C.ConfiguredName, `${this.device.name} Germ Shield`);
        svc.getCharacteristic(C.On).onGet(this.getGermShield.bind(this)).onSet(this.setGermShield.bind(this));
      },
    );
  }

  private setupEventListeners() {
    this.device.on("stateUpdated", this.updateCharacteristics.bind(this));
  }

  /** Helper to get an optional service by subtype */
  private getOptionalService(subtype: string): Service | undefined {
    return this.optionalServices.get(subtype);
  }

  /** Helper to update a characteristic on an optional service if it exists */
  private updateOptionalCharacteristic(
    subtype: string,
    characteristic: WithUUID<new () => Characteristic>,
    value: CharacteristicValue,
  ): void {
    this.getOptionalService(subtype)?.updateCharacteristic(characteristic, value);
  }

  updateCharacteristics(changedStates: Partial<FullBlueAirDeviceState>) {
    const C = this.platform.Characteristic;
    
    for (const key of Object.keys(changedStates)) {
      this.platform.log.debug(`[${this.device.name}] ${key} changed`);

      switch (key) {
        case "standby":
          this.handleStandbyChange();
          break;
        case "automode":
          this.handleAutomodeChange();
          break;
        case "childlock":
          this.service.updateCharacteristic(C.LockPhysicalControls, this.getLockPhysicalControls());
          break;
        case "fanspeed":
          this.handleFanspeedChange();
          break;
        case "filterusage":
          this.filterMaintenanceService?.updateCharacteristic(C.FilterChangeIndication, this.getFilterChangeIndication());
          this.filterMaintenanceService?.updateCharacteristic(C.FilterLifeLevel, this.getFilterLifeLevel());
          break;
        case "temperature":
          this.updateOptionalCharacteristic("Temperature", C.CurrentTemperature, this.getCurrentTemperature());
          break;
        case "humidity":
          // Update humidity on main service
          this.service.updateCharacteristic(C.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
          // Also update optional humidity sensor tile
          this.updateOptionalCharacteristic("Humidity", C.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
          break;
        case "brightness":
          this.updateOptionalCharacteristic("DisplayBrightness", C.On, this.getDisplayOn());
          this.updateOptionalCharacteristic("DisplayBrightness", C.Brightness, this.getDisplayBrightness());
          break;
        case "nlbrightness":
          this.updateOptionalCharacteristic("NightLight", C.On, this.getNightLightOn());
          this.updateOptionalCharacteristic("NightLight", C.Brightness, this.getNightLightBrightness());
          break;
        case "pm25":
        case "pm10":
        case "voc":
          this.handleAirQualityChange(key);
          break;
        case "germshield":
          this.updateOptionalCharacteristic("GermShield", C.On, this.getGermShield());
          break;
        case "nightmode":
          // Update the dropdown to reflect night mode state for humidifiers
          if (this.deviceType === "humidifier") {
            this.service.updateCharacteristic(C.TargetHumidifierDehumidifierState, this.getTargetHumidifierState());
          }
          break;
        case "wlevel":
          // Update water level for humidifiers
          if (this.deviceType === "humidifier") {
            this.service.updateCharacteristic(C.WaterLevel, this.getWaterLevel());
          }
          break;
        case "autorh":
          // Update target humidity for humidifiers
          if (this.deviceType === "humidifier") {
            this.service.updateCharacteristic(C.RelativeHumidityHumidifierThreshold, this.getTargetRelativeHumidity());
          }
          break;
      }
    }
  }

  private handleStandbyChange(): void {
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.Active, this.getActive());

    if (this.deviceType === "air-purifier") {
      this.service.updateCharacteristic(C.CurrentAirPurifierState, this.getCurrentAirPurifierState());
      this.service.updateCharacteristic(C.TargetAirPurifierState, this.getTargetAirPurifierState());
    } else {
      this.service.updateCharacteristic(C.CurrentHumidifierDehumidifierState, this.getCurrentHumidifierState());
      this.service.updateCharacteristic(C.TargetHumidifierDehumidifierState, this.getTargetHumidifierState());
      this.service.updateCharacteristic(C.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
      this.service.updateCharacteristic(C.RelativeHumidityHumidifierThreshold, this.getTargetRelativeHumidity());
      this.fanService?.updateCharacteristic(C.RotationSpeed, this.getRotationSpeed());
    }
    this.service.updateCharacteristic(C.RotationSpeed, this.getRotationSpeed());
    this.updateOptionalCharacteristic("DisplayBrightness", C.On, this.getDisplayOn());
    this.updateOptionalCharacteristic("GermShield", C.On, this.getGermShield());
    this.updateOptionalCharacteristic("NightMode", C.On, this.getNightMode());
    this.maybeAutoAdjustFanSpeed();
  }

  private handleAutomodeChange(): void {
    const C = this.platform.Characteristic;
    if (this.deviceType === "air-purifier") {
      this.service.updateCharacteristic(C.TargetAirPurifierState, this.getTargetAirPurifierState());
    } else {
      this.service.updateCharacteristic(C.TargetHumidifierDehumidifierState, this.getTargetHumidifierState());
    }
  }

  private handleFanspeedChange(): void {
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.RotationSpeed, this.getRotationSpeed());
    this.fanService?.updateCharacteristic(C.RotationSpeed, this.getRotationSpeed());
    if (this.deviceType === "air-purifier") {
      this.service.updateCharacteristic(C.CurrentAirPurifierState, this.getCurrentAirPurifierState());
    } else {
      this.service.updateCharacteristic(C.CurrentHumidifierDehumidifierState, this.getCurrentHumidifierState());
      // Update target state dropdown (Auto/Manual/Sleep) based on fanspeed
      this.service.updateCharacteristic(C.TargetHumidifierDehumidifierState, this.getTargetHumidifierState());
    }
  }

  private handleAirQualityChange(sensor: string): void {
    const C = this.platform.Characteristic;
    const aqService = this.getOptionalService("AirQuality");
    if (!aqService) return;

    switch (sensor) {
      case "pm25":
        aqService.updateCharacteristic(C.PM2_5Density, this.getPM2_5Density());
        break;
      case "pm10":
        aqService.updateCharacteristic(C.PM10Density, this.getPM10Density());
        break;
      case "voc":
        aqService.updateCharacteristic(C.VOCDensity, this.getVOCDensity());
        break;
    }
    aqService.updateCharacteristic(C.AirQuality, this.getAirQuality());
  }

  // Common getters/setters

  getActive(): CharacteristicValue {
    return this.device.state.standby === false
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  async setActive(value: CharacteristicValue) {
    const isActive = value === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.info(`[${this.device.name}] HomeKit → setActive: ${isActive ? "ON" : "OFF"}`);
    await this.device.setState("standby", !isActive);
  }

  getCurrentTemperature(): CharacteristicValue {
    return this.device.sensorData.temperature || 0;
  }

  // Display brightness (main LED display)
  getDisplayOn(): CharacteristicValue {
    return (
      this.device.state.brightness !== undefined &&
      this.device.state.brightness > 0 &&
      this.device.state.nightmode !== true
    );
  }

  async setDisplayOn(value: CharacteristicValue) {
    const turnOn = value as boolean;
    this.platform.log.info(`[${this.device.name}] HomeKit → setDisplayOn: ${turnOn ? "ON" : "OFF"}`);
    
    // Save current brightness before turning off, restore when turning on
    if (!turnOn) {
      this.lastBrightness = this.device.state.brightness || 0;
    }
    const brightness = turnOn ? (this.lastBrightness || 100) : 0;
    await this.device.setState("brightness", brightness);
  }

  getDisplayBrightness(): CharacteristicValue {
    return this.device.state.brightness || 0;
  }

  async setDisplayBrightness(value: CharacteristicValue) {
    const brightness = value as number;
    this.platform.log.info(`[${this.device.name}] HomeKit → setDisplayBrightness: ${brightness}%`);
    // Update lastBrightness when user sets a non-zero value
    if (brightness > 0) {
      this.lastBrightness = brightness;
    }
    await this.device.setState("brightness", brightness);
  }

  // Night light uses imported NL_LEVELS and helper functions from constants.ts

  getNightLightOn(): CharacteristicValue {
    return (
      this.device.state.nlbrightness !== undefined &&
      this.device.state.nlbrightness > 0 &&
      this.device.state.nlbrightness !== 0
    );
  }

  async setNightLightOn(value: CharacteristicValue) {
    this.platform.log.info(`[${this.device.name}] HomeKit → setNightLightOn: ${value ? "ON" : "OFF"}`);
    const deviceBrightness = value ? NL_LEVELS.NORMAL : NL_LEVELS.OFF;
    await this.device.setState("nlbrightness", deviceBrightness);
  }

  getNightLightBrightness(): CharacteristicValue {
    return nlDeviceToHomeKit(this.device.state.nlbrightness || 0);
  }

  async setNightLightBrightness(value: CharacteristicValue) {
    const hkValue = value as number;
    const deviceValue = nlHomeKitToDevice(hkValue);
    this.nlBrightnessDebouncer.call(deviceValue);
  }

  /** Debounced execution for night light brightness */
  private async executeNlBrightnessChange(deviceValue: number): Promise<void> {
    this.platform.log.info(
      `[${this.device.name}] HomeKit → setNightLightBrightness: ${nlDeviceToName(deviceValue)} (${deviceValue})`,
    );
    await this.device.setState("nlbrightness", deviceValue);
  }

  getNightMode(): CharacteristicValue {
    return this.device.state.nightmode === true;
  }

  async setNightMode(value: CharacteristicValue) {
    this.platform.log.info(`[${this.device.name}] HomeKit → setNightMode: ${value ? "ON" : "OFF"}`);
    await this.device.setState("nightmode", value as boolean);
  }

  // Air Purifier specific

  getCurrentAirPurifierState(): CharacteristicValue {
    if (this.device.state.standby === false) {
      return this.device.state.automode && this.device.state.fanspeed === 0
        ? this.platform.Characteristic.CurrentAirPurifierState.IDLE
        : this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    }

    return this.platform.Characteristic.CurrentAirPurifierState.INACTIVE;
  }

  getTargetAirPurifierState(): CharacteristicValue {
    return this.device.state.automode
      ? this.platform.Characteristic.TargetAirPurifierState.AUTO
      : this.platform.Characteristic.TargetAirPurifierState.MANUAL;
  }

  async setTargetAirPurifierState(value: CharacteristicValue) {
    const isAuto = value === this.platform.Characteristic.TargetAirPurifierState.AUTO;
    this.platform.log.info(`[${this.device.name}] HomeKit → setTargetAirPurifierState: ${isAuto ? "AUTO" : "MANUAL"}`);
    await this.device.setState("automode", isAuto);
  }

  getLockPhysicalControls(): CharacteristicValue {
    return this.device.state.childlock
      ? this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
      : this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
  }

  async setLockPhysicalControls(value: CharacteristicValue) {
    const isLocked = value === this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
    this.platform.log.info(`[${this.device.name}] HomeKit → setLockPhysicalControls: ${isLocked ? "LOCKED" : "UNLOCKED"}`);
    await this.device.setState("childlock", isLocked);
  }

  // Fan speed uses discrete HomeKit values (0, 25, 50, 75, 100) to prevent slider jumping
  // 0% = Off, 25% = Sleep/Night, 50% = Low, 75% = Medium, 100% = High

  getRotationSpeed(): CharacteristicValue {
    const isStandby = this.device.state.standby !== false;
    const isNightMode = this.device.state.nightmode === true;
    const deviceSpeed = this.device.state.fanspeed ?? 0;
    return fanSpeedDeviceToHomeKit(deviceSpeed, isNightMode, isStandby);
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const hkSpeed = value as number;
    const fanState = fanSpeedHomeKitToDevice(hkSpeed);
    this.fanSpeedDebouncer.call({ ...fanState, hkSpeed });
  }

  /** Debounced execution for fan speed changes */
  private async executeFanSpeedChange(params: { 
    speed: number; 
    isNightMode: boolean; 
    isStandby: boolean; 
    hkSpeed: number;
  }): Promise<void> {
    const { speed, isNightMode, isStandby, hkSpeed } = params;

    try {
      if (isStandby) {
        // 0% = Turn device off
        this.platform.log.info(
          `[${this.device.name}] HomeKit → setFanSpeed: ${hkSpeed}% → Standby`,
        );
        await this.device.setState("standby", true);
      } else if (isNightMode && this.capabilities.hasNightMode) {
        // 25% = Sleep/Night mode
        this.platform.log.info(
          `[${this.device.name}] HomeKit → setFanSpeed: ${hkSpeed}% → Night Mode`,
        );
        this.humidityAutoControlEnabled = false;
        await this.device.setState("standby", false);
        if (this.capabilities.hasAutoMode) {
          await this.device.setState("automode", false);
        }
        await this.device.setState("nightmode", true);
        // Set target humidity to current humidity when leaving auto mode
        await this.syncTargetHumidityToCurrent();
      } else {
        // 50%, 75%, 100% = Manual fan speeds
        this.platform.log.info(
          `[${this.device.name}] HomeKit → setFanSpeed: ${hkSpeed}% → speed ${speed}`,
        );
        this.humidityAutoControlEnabled = false;
        this.lastManualOverride = Date.now();
        await this.device.setState("standby", false);
        if (this.capabilities.hasNightMode) {
          await this.device.setState("nightmode", false);
        }
        if (this.capabilities.hasAutoMode) {
          await this.device.setState("automode", false);
        }
        await this.device.setState("fanspeed", speed);
        // Set target humidity to current humidity when leaving auto mode
        await this.syncTargetHumidityToCurrent();
      }
    } catch (error) {
      this.platform.log.error(
        `[${this.device.name}] Failed to set fan speed: ${error}`,
      );
    }
  }

  getFilterChangeIndication(): CharacteristicValue {
    return this.device.state.filterusage !== undefined &&
      this.device.state.filterusage >= this.configDev.filterChangeLevel
      ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
      : this.platform.Characteristic.FilterChangeIndication.FILTER_OK;
  }

  getFilterLifeLevel(): CharacteristicValue {
    return 100 - (this.device.state.filterusage || 0);
  }

  getPM2_5Density(): CharacteristicValue {
    return this.device.sensorData.pm2_5 || 0;
  }

  getPM10Density(): CharacteristicValue {
    return this.device.sensorData.pm10 || 0;
  }

  getVOCDensity(): CharacteristicValue {
    return this.device.sensorData.voc || 0;
  }

  getAirQuality(): CharacteristicValue {
    const aqi = this.device.sensorData.aqi;
    if (aqi === undefined) {
      return this.platform.Characteristic.AirQuality.UNKNOWN;
    }

    const C = this.platform.Characteristic.AirQuality;
    if (aqi <= AQI_THRESHOLDS.EXCELLENT) return C.EXCELLENT;
    if (aqi <= AQI_THRESHOLDS.GOOD) return C.GOOD;
    if (aqi <= AQI_THRESHOLDS.FAIR) return C.FAIR;
    if (aqi <= AQI_THRESHOLDS.INFERIOR) return C.INFERIOR;
    return C.POOR;
  }

  getGermShield(): CharacteristicValue {
    return this.device.state.germshield === true;
  }

  async setGermShield(value: CharacteristicValue) {
    this.platform.log.info(`[${this.device.name}] HomeKit → setGermShield: ${value ? "ON" : "OFF"}`);
    await this.device.setState("germshield", value as boolean);
  }

  // Humidifier specific
  private findHumidityTargetAttribute(): string | null {
    // First, check for a manual override from config
    if (this.configDev.targetHumidityAttribute) {
      const key = this.configDev.targetHumidityAttribute;
      const v = (this.device.state as any)[key];
      if (typeof v === "number") {
        return key;
      }
    }

    const keys = Object.keys(this.device.state || {});
    const patterns = [
      /^autorh$/i,          // BlueAir humidifier uses "autorh"
      /target\s*hum/i,
      /hum\s*target/i,
      /humidity\s*target/i,
      /target\s*humidity/i,
      /hum(i)?d(ity)?\s*set(point)?/i,
      /set\s*hum/i,
    ];

    for (const k of keys) {
      for (const p of patterns) {
        if (p.test(k)) {
          const v = this.device.state[k];
          if (typeof v === "number") {
            return k;
          }
        }
      }
    }
    return null;
  }

  getCurrentRelativeHumidity(): CharacteristicValue {
    const humidity = Math.max(
      0,
      Math.min(100, this.device.sensorData.humidity || 0),
    );
    return humidity;
  }

  /**
   * Sync target humidity to current humidity when switching to manual mode.
   * This provides a sensible starting point for manual control.
   */
  private async syncTargetHumidityToCurrent(): Promise<void> {
    // Only applies to humidifiers
    if (this.deviceType !== "humidifier") {
      return;
    }

    const currentHumidity = this.device.sensorData.humidity;
    if (currentHumidity === undefined) {
      this.platform.log.debug(
        `[${this.device.name}] Cannot sync humidity: no current humidity data`,
      );
      return;
    }

    const clampedHumidity = Math.max(HUMIDITY_MIN, Math.min(HUMIDITY_MAX, Math.round(currentHumidity)));
    const attr = this.findHumidityTargetAttribute();
    
    if (attr) {
      this.platform.log.info(
        `[${this.device.name}] Syncing target humidity to current: ${clampedHumidity}%`,
      );
      await this.device.setState(attr, clampedHumidity);
      
      // Update HomeKit to reflect the new target immediately
      this.service.updateCharacteristic(
        this.platform.Characteristic.RelativeHumidityHumidifierThreshold,
        clampedHumidity,
      );
    } else {
      // No device attribute, update local config and HomeKit
      this.platform.log.debug(
        `[${this.device.name}] No humidity target attribute, updating locally to ${clampedHumidity}%`,
      );
      this.configDev.targetHumidity = clampedHumidity;
      this.service.updateCharacteristic(
        this.platform.Characteristic.RelativeHumidityHumidifierThreshold,
        clampedHumidity,
      );
    }
  }

  getTargetRelativeHumidity(): CharacteristicValue {
    const attr = this.findHumidityTargetAttribute();
    if (attr && typeof this.device.state[attr] === "number") {
      const v = this.device.state[attr] as number;
      return Math.max(HUMIDITY_MIN, Math.min(HUMIDITY_MAX, v));
    }
    const fallback =
      this.configDev.targetHumidity ?? this.configDev.defaultTargetHumidity ?? 60;
    return Math.max(HUMIDITY_MIN, Math.min(HUMIDITY_MAX, fallback));
  }

  async setTargetRelativeHumidity(value: CharacteristicValue) {
    const desired = Math.max(HUMIDITY_MIN, Math.min(HUMIDITY_MAX, value as number));
    this.humidityDebouncer.call(desired);
  }

  /** Debounced execution for target humidity changes */
  private async executeHumidityChange(valueToSet: number): Promise<void> {
    this.platform.log.info(
      `[${this.device.name}] HomeKit → setTargetHumidity: ${valueToSet}% - enabling auto mode`,
    );
    const attr = this.findHumidityTargetAttribute();
    if (attr) {
      await this.device.setState(attr, valueToSet);
      await this.device.setState("automode", true);
      this.humidityAutoControlEnabled = true;
      return;
    }
    // Fallback: store locally if device does not expose a writable target
    if (!this.loggedNoWritableTargetHumidity) {
      this.platform.log.info(
        `[${this.device.name}] Device did not expose a writable target humidity attribute; storing locally.`,
      );
      this.loggedNoWritableTargetHumidity = true;
    }
    this.configDev.targetHumidity = valueToSet;
    await this.device.setState("automode", true);
    this.humidityAutoControlEnabled = true;
  }

  private maybeAutoAdjustFanSpeed() {
    if (this.deviceType !== "humidifier") return;
    if (!this.humidityAutoControlEnabled) return;
    if (this.device.state.standby) return;
    if (this.device.state.nightmode) return;
    if (this.device.state.automode === false) return;

    const now = Date.now();
    if (now - this.lastAutoAdjust < 60000) return; // adjust at most once per minute
    if (now - this.lastManualOverride < 60000) return; // respect recent manual change

    const current = (this.device.sensorData.humidity ?? 0) as number;
    const target = this.getTargetRelativeHumidity() as number;
    if (current === 0) return; // no data

    const diff = target - current; // positive -> need more humidity
    const speed = (this.device.state.fanspeed ?? 0) as number;

    // Find current speed index in valid levels
    const speedIndex = FAN_SPEED_LEVELS.findIndex(
      (lvl, i, arr) => speed <= lvl || i === arr.length - 1
    );

    let newSpeedIndex = speedIndex;
    // Use hysteresis thresholds to avoid oscillation
    // Step up/down one level at a time based on humidity difference
    if (diff > 2) {
      // Need more humidity - increase fan speed one level
      newSpeedIndex = Math.min(FAN_SPEED_LEVELS.length - 1, speedIndex + 1);
    } else if (diff < -4) {
      // Too humid - decrease fan speed one level
      newSpeedIndex = Math.max(0, speedIndex - 1);
    }

    const newSpeed = FAN_SPEED_LEVELS[newSpeedIndex];
    if (newSpeed !== speed) {
      this.platform.log.debug(
        `[${this.device.name}] Auto-adjust fan: humidity ${current}% target ${target}% -> speed ${speed} -> ${newSpeed}`,
      );
      this.lastAutoAdjust = now;
      void this.device.setState("fanspeed", newSpeed);
    }
  }

  getCurrentHumidifierState(): CharacteristicValue {
    if (this.device.state.standby === false) {
      return this.device.state.automode && this.device.state.fanspeed === 0
        ? this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE
        : this.platform.Characteristic.CurrentHumidifierDehumidifierState
            .HUMIDIFYING;
    }

    return this.platform.Characteristic.CurrentHumidifierDehumidifierState
      .INACTIVE;
  }

  getTargetHumidifierState(): CharacteristicValue {
    // Always return HUMIDIFIER - dropdown is locked to single value
    // Night mode is controlled via fan speed slider (low speed = night mode)
    return this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
  }

  async setTargetHumidifierState(_value: CharacteristicValue) {
    // No-op - mode is locked to HUMIDIFIER
    // Auto/manual/night mode is controlled automatically via humidity and fan speed sliders
  }

  getWaterLevel(): CharacteristicValue {
    // Use wlevel from device state if available
    const wlevel = this.device.state.wlevel;
    if (typeof wlevel === "number") {
      return Math.max(0, Math.min(100, wlevel));
    }
    // Fallback if not available
    return 100;
  }
}
