import EventEmitter from "events";
import {
  BlueAirDeviceSensorData,
  BlueAirDeviceState,
  BlueAirDeviceStatus,
  FullBlueAirDeviceState,
} from "./api/BlueAirAwsApi";
import { Mutex } from "async-mutex";
import { CharacteristicValue, PlatformAccessory, Service, Characteristic, WithUUID } from "homebridge";
import { DeviceConfig } from "./utils";
import type { BlueAirPlatform } from "./platform";

type AQILevels = {
  AQI_LO: number[];
  AQI_HI: number[];
  CONC_LO: number[];
  CONC_HI: number[];
};

// https://forum.airnowtech.org/t/the-aqi-equation-2024-valid-beginning-may-6th-2024
const AQI: { [key: string]: AQILevels } = {
  PM2_5: {
    AQI_LO: [0, 51, 101, 151, 201, 301],
    AQI_HI: [50, 100, 150, 200, 300, 500],
    CONC_LO: [0.0, 9.1, 35.5, 55.5, 125.5, 225.5],
    CONC_HI: [9.0, 35.4, 55.4, 125.4, 225.4, 325.4],
  },
  PM10: {
    AQI_LO: [0, 51, 101, 151, 201, 301],
    AQI_HI: [50, 100, 150, 200, 300, 500],
    CONC_LO: [0, 55, 155, 255, 355, 425],
    CONC_HI: [54, 154, 254, 354, 424, 604],
  },
  VOC: {
    AQI_LO: [0, 51, 101, 151, 201, 301],
    AQI_HI: [50, 100, 150, 200, 300, 500],
    CONC_LO: [0, 221, 661, 1431, 2201, 3301],
    CONC_HI: [220, 660, 1430, 2200, 3300, 5500],
  },
};

// Fan speed for humidifier: 0-11 range (0=off/sleep, 11=max)
const FAN_SPEED_MAX = 11;

// Humidity target range
const HUMIDITY_MIN = 30;
const HUMIDITY_MAX = 80;

type BlueAirSensorDataWithAqi = BlueAirDeviceSensorData & { aqi?: number };

type PendingChanges = {
  state: Partial<BlueAirDeviceState>;
  sensorData: Partial<BlueAirSensorDataWithAqi>;
};

interface BlueAirDeviceEvents {
  stateUpdated: (changedStates: Partial<FullBlueAirDeviceState>) => void;
  update: (newState: BlueAirDeviceStatus) => void;
  setState: (data: {
    id: string;
    name: string;
    attribute: string;
    value: number | boolean;
  }) => void;
  setStateDone: (success: boolean) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface BlueAirDevice {
  on<K extends keyof BlueAirDeviceEvents>(
    event: K,
    listener: BlueAirDeviceEvents[K],
  ): this;
  emit<K extends keyof BlueAirDeviceEvents>(
    event: K,
    ...args: Parameters<BlueAirDeviceEvents[K]>
  ): boolean;
  once<K extends keyof BlueAirDeviceEvents>(
    event: K,
    listener: BlueAirDeviceEvents[K],
  ): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class BlueAirDevice extends EventEmitter {
  public state: BlueAirDeviceState;
  public sensorData: BlueAirSensorDataWithAqi;

  public readonly id: string;
  public readonly name: string;

  private mutex: Mutex;

  private currentChanges: PendingChanges;

  private last_brightness: number;

  constructor(device: BlueAirDeviceStatus) {
    super();
    this.id = device.id;
    this.name = device.name;

    this.state = device.state;
    this.sensorData = {
      ...device.sensorData,
      aqi: undefined,
    };
    this.sensorData.aqi = this.calculateAqi();

    this.mutex = new Mutex();
    this.currentChanges = {
      state: {},
      sensorData: {},
    };

    this.last_brightness = this.state.brightness || 0;

    this.on("update", this.updateState.bind(this));
  }

  private hasChanges(changes: PendingChanges): boolean {
    return (
      Object.keys(changes.state).length > 0 ||
      Object.keys(changes.sensorData).length > 0
    );
  }

  private async notifyStateUpdate(
    newState?: Partial<BlueAirDeviceState>,
    newSensorData?: Partial<BlueAirDeviceSensorData>,
  ) {
    this.currentChanges = {
      state: {
        ...this.currentChanges.state,
        ...newState,
      },
      sensorData: {
        ...this.currentChanges.sensorData,
        ...newSensorData,
      },
    };

    // always acquire the mutex to ensure all changes are eventually applied
    const release = await this.mutex.acquire();

    const changesToApply = this.currentChanges;
    this.currentChanges = { state: {}, sensorData: {} };

    // if there is a change, emit update event
    if (this.hasChanges(changesToApply)) {
      this.state = { ...this.state, ...changesToApply.state };
      this.sensorData = { ...this.sensorData, ...changesToApply.sensorData };
      this.emit("stateUpdated", {
        ...changesToApply.state,
        ...changesToApply.sensorData,
      });
    }

    release();
  }

  public async setState(attribute: string, value: number | boolean) {
    // Skip if value is unchanged (only check if attribute exists)
    if (attribute in this.state && this.state[attribute] === value) {
      return;
    }

    // Emit setState event - platform will handle API call and logging
    this.emit("setState", { id: this.id, name: this.name, attribute, value });

    const release = await this.mutex.acquire();

    return new Promise<void>((resolve) => {
      this.once("setStateDone", async (success) => {
        release();
        if (success) {
          const newState: Partial<BlueAirDeviceState> = { [attribute]: value };
          if (attribute === "nightmode" && value === true) {
            newState["brightness"] = 0;
          }
          await this.notifyStateUpdate(newState);
        }
        resolve();
      });
    });
  }

  public async setLedOn(value: boolean) {
    if (!value) {
      this.last_brightness = this.state.brightness || 0;
    }
    const brightness = value ? this.last_brightness : 0;
    await this.setState("brightness", brightness);
  }

  private async updateState(newState: BlueAirDeviceStatus) {
    const changedState: Partial<BlueAirDeviceState> = {};
    const changedSensorData: Partial<BlueAirSensorDataWithAqi> = {};

    for (const [k, v] of Object.entries(newState.state)) {
      if (this.state[k] !== v) {
        changedState[k] = v;
      }
    }
    for (const [k, v] of Object.entries(newState.sensorData)) {
      if (this.sensorData[k] !== v) {
        changedSensorData[k] = v;
        if (k === "pm25" || k === "pm10" || k === "voc") {
          changedSensorData.aqi = this.calculateAqi();
        }
      }
    }
    await this.notifyStateUpdate(changedState, changedSensorData);
  }

  private calculateAqi(): number | undefined {
    if (
      this.sensorData.pm2_5 === undefined &&
      this.sensorData.pm10 === undefined &&
      this.sensorData.voc === undefined
    ) {
      return undefined;
    }

    const pm2_5 = Math.round((this.sensorData.pm2_5 || 0) * 10) / 10;
    const pm10 = this.sensorData.pm10 || 0;
    const voc = this.sensorData.voc || 0;

    const aqi_pm2_5 = this.calculateAqiForSensor(pm2_5, "PM2_5");
    const aqi_pm10 = this.calculateAqiForSensor(pm10, "PM10");
    const aqi_voc = this.calculateAqiForSensor(voc, "VOC");

    return Math.max(aqi_pm2_5, aqi_pm10, aqi_voc);
  }

  private calculateAqiForSensor(value: number, sensor: string) {
    const levels = AQI[sensor];
    for (let i = 0; i < levels.AQI_LO.length; i++) {
      if (value >= levels.CONC_LO[i] && value <= levels.CONC_HI[i]) {
        return Math.round(
          ((levels.AQI_HI[i] - levels.AQI_LO[i]) /
            (levels.CONC_HI[i] - levels.CONC_LO[i])) *
            (value - levels.CONC_LO[i]) +
            levels.AQI_LO[i],
        );
      }
    }
    return 0;
  }
}

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
  private fanSpeedDebounceTimer?: ReturnType<typeof setTimeout>;
  private pendingFanSpeed?: number;

  constructor(
    protected readonly platform: BlueAirPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly device: BlueAirDevice,
    protected readonly configDev: DeviceConfig,
    deviceType: DeviceType = "air-purifier",
  ) {
    this.deviceType = deviceType;

    this.setupAccessoryInformation();
    this.setupMainService();
    this.setupOptionalServices();
    this.setupEventListeners();
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
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState)
      .onGet(this.getCurrentAirPurifierState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onGet(this.getTargetAirPurifierState.bind(this))
      .onSet(this.setTargetAirPurifierState.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .onGet(this.getLockPhysicalControls.bind(this))
      .onSet(this.setLockPhysicalControls.bind(this));

    // Use 0–100% scale for HomeKit; map internally to device speed (Sleep/1/2/3)
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    this.filterMaintenanceService =
      this.accessory.getService(this.platform.Service.FilterMaintenance) ||
      this.accessory.addService(this.platform.Service.FilterMaintenance);

    this.filterMaintenanceService
      .getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(this.getFilterChangeIndication.bind(this));

    this.filterMaintenanceService
      .getCharacteristic(this.platform.Characteristic.FilterLifeLevel)
      .onGet(this.getFilterLifeLevel.bind(this));

    // Link for grouping in Home app
    this.service.addLinkedService(this.filterMaintenanceService);
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
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.getCurrentRelativeHumidity.bind(this));

    // RelativeHumidityHumidifierThreshold is the correct characteristic for target humidity in HumidifierDehumidifier service
    this.service
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .onSet(this.setTargetRelativeHumidity.bind(this));

    this.service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      )
      .onGet(this.getCurrentHumidifierState.bind(this));

    // Lock to HUMIDIFIER mode only - no dropdown selector
    // Auto/manual mode is handled automatically based on which control the user adjusts:
    // - Adjusting humidity target → enables auto mode
    // - Adjusting fan speed → disables auto mode (manual)
    this.service
      .getCharacteristic(
        this.platform.Characteristic.TargetHumidifierDehumidifierState,
      )
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
        ],
      })
      .onGet(this.getTargetHumidifierState.bind(this))
      .onSet(this.setTargetHumidifierState.bind(this));

    // Use 0–100% scale for HomeKit; map internally to device speed (Sleep/1/2/3)
    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    // setup separate Fan service for visibility in Home app (configurable)
    if (this.configDev.showFanTile !== false) {
      this.fanService =
        this.accessory.getService(this.platform.Service.Fanv2) ||
        this.accessory.addService(this.platform.Service.Fanv2, "Fan", "Fan");

      this.fanService.setCharacteristic(
        this.platform.Characteristic.Name,
        this.configDev.name + " Fan",
      );

      this.fanService
        .getCharacteristic(this.platform.Characteristic.Active)
        .onGet(this.getActive.bind(this))
        .onSet(this.setActive.bind(this));

      this.fanService
        .getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(this.getRotationSpeed.bind(this))
        .onSet(this.setRotationSpeed.bind(this));

      // Link the service for better UI grouping
      this.service.addLinkedService(this.fanService);
    }

    this.service
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .onGet(this.getLockPhysicalControls.bind(this))
      .onSet(this.setLockPhysicalControls.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.WaterLevel)
      .onGet(this.getWaterLevel.bind(this));

    this.filterMaintenanceService =
      this.accessory.getService(this.platform.Service.FilterMaintenance) ||
      this.accessory.addService(this.platform.Service.FilterMaintenance);

    this.filterMaintenanceService
      .getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(this.getFilterChangeIndication.bind(this));

    this.filterMaintenanceService
      .getCharacteristic(this.platform.Characteristic.FilterLifeLevel)
      .onGet(this.getFilterLifeLevel.bind(this));

    // Link for grouping in Home app
    this.service.addLinkedService(this.filterMaintenanceService);
  }

  /**
   * Helper to set up or remove an optional service based on config.
   * Returns the service if enabled, undefined otherwise.
   * All optional services are linked to the primary service for grouping in Home app.
   */
  private setupOptionalService(
    serviceConstructor: WithUUID<typeof Service>,
    subtype: string,
    displayName: string,
    enabled: boolean,
    configure: (service: Service) => void,
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
      // Link to primary service for grouping in Home app
      this.service.addLinkedService(service);
      return service;
    } else if (existingService) {
      this.service.removeLinkedService(existingService);
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

    // Display brightness - controls the main display LED (uses 'brightness' API variable)
    this.setupOptionalService(
      S.Lightbulb,
      "DisplayBrightness",
      "Display Brightness",
      this.configDev.led !== false,
      (svc) => {
        svc.setCharacteristic(C.ConfiguredName, `${this.device.name} Display`);
        svc.getCharacteristic(C.On).onGet(this.getDisplayOn.bind(this)).onSet(this.setDisplayOn.bind(this));
        svc.getCharacteristic(C.Brightness).onGet(this.getDisplayBrightness.bind(this)).onSet(this.setDisplayBrightness.bind(this));
      },
    );

    // Night light brightness - controls the night light (uses 'nlbrightness' API variable)
    // Only available on humidifiers
    if (this.deviceType === "humidifier") {
      this.setupOptionalService(
        S.Lightbulb,
        "NightLight",
        "Night Light",
        this.configDev.nightLight !== false,
        (svc) => {
          svc.setCharacteristic(C.ConfiguredName, `${this.device.name} Night Light`);
          svc.getCharacteristic(C.On).onGet(this.getNightLightOn.bind(this)).onSet(this.setNightLightOn.bind(this));
          svc.getCharacteristic(C.Brightness).onGet(this.getNightLightBrightness.bind(this)).onSet(this.setNightLightBrightness.bind(this));
        },
      );
    }

    // Temperature sensor - default to true if not explicitly set
    this.setupOptionalService(
      S.TemperatureSensor,
      "Temperature",
      "Temperature",
      this.configDev.temperatureSensor !== false,
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

    // Humidity sensor (humidifier only) - default to true if not explicitly set
    if (this.deviceType === "humidifier") {
      this.setupOptionalService(
        S.HumiditySensor,
        "Humidity",
        "Humidity",
        this.configDev.humiditySensor !== false,
        (svc) => {
          svc.getCharacteristic(C.CurrentRelativeHumidity).onGet(this.getCurrentRelativeHumidity.bind(this));
        },
      );
    }

    // Air quality sensor - only for air purifiers (humidifiers don't have these sensors)
    this.setupOptionalService(
      S.AirQualitySensor,
      "AirQuality",
      "Air Quality",
      this.deviceType === "air-purifier" && this.configDev.airQualitySensor !== false,
      (svc) => {
        svc.getCharacteristic(C.AirQuality).onGet(this.getAirQuality.bind(this));
        svc.getCharacteristic(C.PM2_5Density).onGet(this.getPM2_5Density.bind(this));
        svc.getCharacteristic(C.PM10Density).onGet(this.getPM10Density.bind(this));
        svc.getCharacteristic(C.VOCDensity).onGet(this.getVOCDensity.bind(this));
      },
    );

    // Germ shield switch - only for air purifiers
    // Pass false for humidifiers to remove any existing cached service
    this.setupOptionalService(
      S.Switch,
      "GermShield",
      "Germ Shield",
      this.deviceType === "air-purifier" && this.configDev.germShield !== false,
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
          if (this.deviceType === "humidifier") {
            this.service.updateCharacteristic(C.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
            this.updateOptionalCharacteristic("Humidity", C.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
          }
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
    this.platform.log.info(`[${this.device.name}] HomeKit → setDisplayOn: ${value ? "ON" : "OFF"}`);
    await this.device.setLedOn(value as boolean);
  }

  getDisplayBrightness(): CharacteristicValue {
    return this.device.state.brightness || 0;
  }

  async setDisplayBrightness(value: CharacteristicValue) {
    this.platform.log.info(`[${this.device.name}] HomeKit → setDisplayBrightness: ${value}%`);
    await this.device.setState("brightness", value as number);
  }

  // Night light brightness
  getNightLightOn(): CharacteristicValue {
    return (
      this.device.state.nlbrightness !== undefined &&
      this.device.state.nlbrightness > 0
    );
  }

  async setNightLightOn(value: CharacteristicValue) {
    this.platform.log.info(`[${this.device.name}] HomeKit → setNightLightOn: ${value ? "ON" : "OFF"}`);
    // Turn on to previous brightness or 50%, turn off to 0
    const brightness = value ? (this.device.state.nlbrightness || 50) : 0;
    await this.device.setState("nlbrightness", brightness);
  }

  getNightLightBrightness(): CharacteristicValue {
    return this.device.state.nlbrightness || 0;
  }

  async setNightLightBrightness(value: CharacteristicValue) {
    this.platform.log.info(`[${this.device.name}] HomeKit → setNightLightBrightness: ${value}%`);
    await this.device.setState("nlbrightness", value as number);
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

  // Fan speed mapping: 0-100% HomeKit <-> 0-11 device
  getRotationSpeed(): CharacteristicValue {
    const rawSpeed = this.device.state.fanspeed ?? 0;
    if (this.device.state.standby !== false) return 0;
    // Map device 0-11 to HomeKit 0-100%
    return Math.round((rawSpeed / FAN_SPEED_MAX) * 100);
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const hkSpeed = Math.max(0, Math.min(100, value as number));
    // Map HomeKit 0-100% to device 0-11
    const deviceSpeed = Math.round((hkSpeed / 100) * FAN_SPEED_MAX);

    // Debounce: HomeKit sends rapid updates when dragging slider
    // Only send the final value after 300ms of no changes
    this.pendingFanSpeed = deviceSpeed;
    
    if (this.fanSpeedDebounceTimer) {
      clearTimeout(this.fanSpeedDebounceTimer);
    }

    this.fanSpeedDebounceTimer = setTimeout(async () => {
      const speedToSet = this.pendingFanSpeed;
      if (speedToSet === undefined) return;
      
      // Night mode activates when fan speed is below 10% (device speed 1 or less)
      const enableNightMode = speedToSet <= 1;
      
      if (enableNightMode) {
        this.platform.log.info(
          `[${this.device.name}] HomeKit → setFanSpeed: ${hkSpeed}% → enabling Night Mode`,
        );
        this.humidityAutoControlEnabled = false;
        await this.device.setState("automode", false);
        await this.device.setState("nightmode", true);
      } else {
        this.platform.log.info(
          `[${this.device.name}] HomeKit → setFanSpeed: ${hkSpeed}% → device speed ${speedToSet}`,
        );
        // Manual fan change disables auto humidity control, automode, and night mode
        this.humidityAutoControlEnabled = false;
        this.lastManualOverride = Date.now();
        await this.device.setState("nightmode", false);
        await this.device.setState("automode", false);
        await this.device.setState("fanspeed", speedToSet);
      }
      this.pendingFanSpeed = undefined;
    }, 300);
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
    if (this.device.sensorData.aqi === undefined) {
      return this.platform.Characteristic.AirQuality.UNKNOWN;
    }

    if (this.device.sensorData.aqi <= 50) {
      return this.platform.Characteristic.AirQuality.EXCELLENT;
    } else if (this.device.sensorData.aqi <= 100) {
      return this.platform.Characteristic.AirQuality.GOOD;
    } else if (this.device.sensorData.aqi <= 150) {
      return this.platform.Characteristic.AirQuality.FAIR;
    } else if (this.device.sensorData.aqi <= 200) {
      return this.platform.Characteristic.AirQuality.INFERIOR;
    } else {
      return this.platform.Characteristic.AirQuality.POOR;
    }
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
    this.platform.log.info(
      `[${this.device.name}] HomeKit → setTargetHumidity: ${desired}% - enabling auto mode`,
    );
    const attr = this.findHumidityTargetAttribute();
    if (attr) {
      await this.device.setState(attr, desired);
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
    this.configDev.targetHumidity = desired;
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

    let newSpeed = speed;
    // Use hysteresis thresholds to avoid oscillation
    // Adjust by 1-2 steps at a time based on humidity difference
    if (diff > 2) {
      // Need more humidity - increase fan speed
      const step = diff > 5 ? 2 : 1;
      newSpeed = Math.min(FAN_SPEED_MAX, speed + step);
    } else if (diff < -4) {
      // Too humid - decrease fan speed
      const step = diff < -8 ? 2 : 1;
      newSpeed = Math.max(0, speed - step);
    }

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
