import EventEmitter from "events";
import {
  BlueAirDeviceSensorData,
  BlueAirDeviceState,
  BlueAirDeviceStatus,
  FullBlueAirDeviceState,
} from "./api/BlueAirAwsApi";
import { Mutex } from "async-mutex";
import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
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
    if (attribute in this.state === false) {
      throw new Error(`Invalid state: ${attribute}`);
    }

    if (this.state[attribute] === value) {
      return;
    }

    this.emit("setState", { id: this.id, name: this.name, attribute, value });

    const release = await this.mutex.acquire();

    return new Promise<void>((resolve) => {
      this.once("setStateDone", async (success) => {
        release();
        if (success) {
          const newState: Partial<BlueAirDeviceState> = { [attribute]: value };
          if (attribute === "nightmode" && value === true) {
            newState["fanspeed"] = 11;
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
  private targetHumidityLightService?: Service;
  private filterMaintenanceService?: Service;
  private humidityService?: Service;
  private airQualityService?: Service;
  private ledService?: Service;
  private temperatureService?: Service;
  private germShieldService?: Service;
  private nightModeService?: Service;
  private deviceType: DeviceType;
  private humidityAutoControlEnabled = false;
  private lastManualOverride = 0;
  private lastAutoAdjust = 0;
  private loggedNoWritableTargetHumidity = false;

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

    // Use 0–100% scale for HomeKit; map internally to device 0–11
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

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetRelativeHumidity)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .onSet(this.setTargetRelativeHumidity.bind(this));

    this.service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      )
      .onGet(this.getCurrentHumidifierState.bind(this));

    this.service
      .getCharacteristic(
        this.platform.Characteristic.TargetHumidifierDehumidifierState,
      )
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHumidifierDehumidifierState
            .HUMIDIFIER_OR_DEHUMIDIFIER,
          this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
        ],
      })
      .onGet(this.getTargetHumidifierState.bind(this))
      .onSet(this.setTargetHumidifierState.bind(this));

    // Use 0–100% scale for HomeKit; map internally to device 0–11
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

    // Setup separate Lightbulb service for Target Humidity control (Workaround for Home app, configurable)
    if (this.configDev.showTargetHumidityTile !== false) {
      this.targetHumidityLightService =
        this.accessory.getServiceById(
          this.platform.Service.Lightbulb,
          "TargetHumidity",
        ) ||
        this.accessory.addService(
          this.platform.Service.Lightbulb,
          "Target Humidity",
          "TargetHumidity",
        );

      this.targetHumidityLightService.setCharacteristic(
        this.platform.Characteristic.Name,
        this.configDev.name + " Target Humidity",
      );

      this.targetHumidityLightService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => {
          return (
            this.getActive() === this.platform.Characteristic.Active.ACTIVE
          );
        })
        .onSet(async (value) => {
          await this.setActive(
            value
              ? this.platform.Characteristic.Active.ACTIVE
              : this.platform.Characteristic.Active.INACTIVE,
          );
        });

      this.targetHumidityLightService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(this.getTargetRelativeHumidityForLightbulb.bind(this))
        .onSet(this.setTargetRelativeHumidityFromLightbulb.bind(this));

      // Link the service for better UI grouping
      this.service.addLinkedService(this.targetHumidityLightService);
    }

    // Lightbulb linked only when created

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
  }

  private setupOptionalServices() {
    this.setupLedService();
    this.setupTemperatureService();
    this.setupNightModeService();

    if (this.deviceType === "humidifier") {
      this.setupHumidityService();
    }

    // Enable for all device types if supported/configured
    this.setupAirQualityService();
    this.setupGermShieldService();
  }

  private setupHumidityService() {
    this.humidityService = this.accessory.getServiceById(
      this.platform.Service.HumiditySensor,
      "Humidity",
    );
    if (this.configDev.humiditySensor) {
      this.humidityService ??= this.accessory.addService(
        this.platform.Service.HumiditySensor,
        `${this.device.name} Humidity`,
        "Humidity",
      );
      this.humidityService
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentRelativeHumidity.bind(this));
    } else if (this.humidityService) {
      this.accessory.removeService(this.humidityService);
    }
  }

  private setupLedService() {
    this.ledService = this.accessory.getServiceById(
      this.platform.Service.Lightbulb,
      "Led",
    );
    if (this.configDev.led) {
      this.ledService ??= this.accessory.addService(
        this.platform.Service.Lightbulb,
        `${this.device.name} Led`,
        "Led",
      );
      this.ledService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${this.device.name} Led`,
      );
      this.ledService.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        `${this.device.name} Led`,
      );
      this.ledService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getLedOn.bind(this))
        .onSet(this.setLedOn.bind(this));
      this.ledService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getLedBrightness.bind(this))
        .onSet(this.setLedBrightness.bind(this));
    } else if (this.ledService) {
      this.accessory.removeService(this.ledService);
    }
  }

  private setupTemperatureService() {
    this.temperatureService = this.accessory.getServiceById(
      this.platform.Service.TemperatureSensor,
      "Temperature",
    );
    if (this.configDev.temperatureSensor) {
      this.temperatureService ??= this.accessory.addService(
        this.platform.Service.TemperatureSensor,
        `${this.device.name} Temperature`,
        "Temperature",
      );
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
    } else if (this.temperatureService) {
      this.accessory.removeService(this.temperatureService);
    }
  }

  private setupAirQualityService() {
    this.airQualityService = this.accessory.getServiceById(
      this.platform.Service.AirQualitySensor,
      "AirQuality",
    );
    if (this.configDev.airQualitySensor) {
      this.airQualityService ??= this.accessory.addService(
        this.platform.Service.AirQualitySensor,
        `${this.device.name} Air Quality`,
        "AirQuality",
      );
      this.airQualityService
        .getCharacteristic(this.platform.Characteristic.AirQuality)
        .onGet(this.getAirQuality.bind(this));
      this.airQualityService
        .getCharacteristic(this.platform.Characteristic.PM2_5Density)
        .onGet(this.getPM2_5Density.bind(this));
      this.airQualityService
        .getCharacteristic(this.platform.Characteristic.PM10Density)
        .onGet(this.getPM10Density.bind(this));
      this.airQualityService
        .getCharacteristic(this.platform.Characteristic.VOCDensity)
        .onGet(this.getVOCDensity.bind(this));
    } else if (this.airQualityService) {
      this.accessory.removeService(this.airQualityService);
    }
  }

  private setupGermShieldService() {
    this.germShieldService = this.accessory.getServiceById(
      this.platform.Service.Switch,
      "GermShield",
    );
    if (this.configDev.germShield) {
      this.germShieldService ??= this.accessory.addService(
        this.platform.Service.Switch,
        `${this.device.name} Germ Shield`,
        "GermShield",
      );
      this.germShieldService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${this.device.name} Germ Shield`,
      );
      this.germShieldService.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        `${this.device.name} Germ Shield`,
      );
      this.germShieldService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getGermShield.bind(this))
        .onSet(this.setGermShield.bind(this));
    } else if (this.germShieldService) {
      this.accessory.removeService(this.germShieldService);
    }
  }

  private setupNightModeService() {
    this.nightModeService = this.accessory.getServiceById(
      this.platform.Service.Switch,
      "NightMode",
    );
    if (this.configDev.nightMode) {
      this.nightModeService ??= this.accessory.addService(
        this.platform.Service.Switch,
        `${this.device.name} Night Mode`,
        "NightMode",
      );
      this.nightModeService.setCharacteristic(
        this.platform.Characteristic.Name,
        `${this.device.name} Night Mode`,
      );
      this.nightModeService.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        `${this.device.name} Night Mode`,
      );
      this.nightModeService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getNightMode.bind(this))
        .onSet(this.setNightMode.bind(this));
    } else if (this.nightModeService) {
      this.accessory.removeService(this.nightModeService);
    }
  }

  private setupEventListeners() {
    this.device.on("stateUpdated", this.updateCharacteristics.bind(this));
  }

  updateCharacteristics(changedStates: Partial<FullBlueAirDeviceState>) {
    for (const [k] of Object.entries(changedStates)) {
      this.platform.log.debug(`[${this.device.name}] ${k} changed`);
      let updateState = false;
      let updateAirQuality = false;

      switch (k) {
        case "standby":
          updateState = true;
          break;
        case "automode":
          if (this.deviceType === "air-purifier") {
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetAirPurifierState,
              this.getTargetAirPurifierState(),
            );
          } else {
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetHumidifierDehumidifierState,
              this.getTargetHumidifierState(),
            );
          }
          break;
        case "childlock":
          this.service.updateCharacteristic(
            this.platform.Characteristic.LockPhysicalControls,
            this.getLockPhysicalControls(),
          );
          break;
        case "fanspeed":
          this.service.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            this.getRotationSpeed(),
          );
          this.fanService?.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            this.getRotationSpeed(),
          );
          if (this.deviceType === "air-purifier") {
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentAirPurifierState,
              this.getCurrentAirPurifierState(),
            );
          } else {
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentHumidifierDehumidifierState,
              this.getCurrentHumidifierState(),
            );
          }
          break;
        case "filterusage":
          this.filterMaintenanceService?.updateCharacteristic(
            this.platform.Characteristic.FilterChangeIndication,
            this.getFilterChangeIndication(),
          );
          this.filterMaintenanceService?.updateCharacteristic(
            this.platform.Characteristic.FilterLifeLevel,
            this.getFilterLifeLevel(),
          );
          break;
        case "temperature":
          this.temperatureService?.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            this.getCurrentTemperature(),
          );
          break;
        case "humidity":
          if (this.deviceType === "humidifier") {
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentRelativeHumidity,
              this.getCurrentRelativeHumidity(),
            );
            this.humidityService?.updateCharacteristic(
              this.platform.Characteristic.CurrentRelativeHumidity,
              this.getCurrentRelativeHumidity(),
            );
          }
          break;
        case "brightness":
          this.ledService?.updateCharacteristic(
            this.platform.Characteristic.On,
            this.getLedOn(),
          );
          this.ledService?.updateCharacteristic(
            this.platform.Characteristic.Brightness,
            this.getLedBrightness(),
          );
          break;
        case "pm25":
          if (this.deviceType === "air-purifier") {
            this.airQualityService?.updateCharacteristic(
              this.platform.Characteristic.PM2_5Density,
              this.getPM2_5Density(),
            );
            updateAirQuality = true;
          }
          break;
        case "pm10":
          if (this.deviceType === "air-purifier") {
            this.airQualityService?.updateCharacteristic(
              this.platform.Characteristic.PM10Density,
              this.getPM10Density(),
            );
            updateAirQuality = true;
          }
          break;
        case "voc":
          if (this.deviceType === "air-purifier") {
            this.airQualityService?.updateCharacteristic(
              this.platform.Characteristic.VOCDensity,
              this.getVOCDensity(),
            );
            updateAirQuality = true;
          }
          break;
        case "germshield":
          if (this.deviceType === "air-purifier") {
            this.germShieldService?.updateCharacteristic(
              this.platform.Characteristic.On,
              this.getGermShield(),
            );
          }
          break;
        case "nightmode":
          this.nightModeService?.updateCharacteristic(
            this.platform.Characteristic.On,
            this.getNightMode(),
          );
          break;
      }

      if (updateState) {
        this.service.updateCharacteristic(
          this.platform.Characteristic.Active,
          this.getActive(),
        );

        if (this.deviceType === "air-purifier") {
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentAirPurifierState,
            this.getCurrentAirPurifierState(),
          );
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetAirPurifierState,
            this.getTargetAirPurifierState(),
          );
          this.service.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            this.getRotationSpeed(),
          );
        } else {
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHumidifierDehumidifierState,
            this.getCurrentHumidifierState(),
          );
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetHumidifierDehumidifierState,
            this.getTargetHumidifierState(),
          );
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentRelativeHumidity,
            this.getCurrentRelativeHumidity(),
          );
          this.service.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            this.getRotationSpeed(),
          );
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetRelativeHumidity,
            this.getTargetRelativeHumidity(),
          );
          this.targetHumidityLightService?.updateCharacteristic(
            this.platform.Characteristic.Brightness,
            this.getTargetRelativeHumidityForLightbulb(),
          );
          this.fanService?.updateCharacteristic(
            this.platform.Characteristic.RotationSpeed,
            this.getRotationSpeed(),
          );
        }

        this.targetHumidityLightService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.getActive() === this.platform.Characteristic.Active.ACTIVE,
        );

        this.ledService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.getLedOn(),
        );
        this.germShieldService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.getGermShield(),
        );
        this.nightModeService?.updateCharacteristic(
          this.platform.Characteristic.On,
          this.getNightMode(),
        );
        // Attempt humidity-based auto adjustment after state updates
        this.maybeAutoAdjustFanSpeed();
      }

      if (updateAirQuality && this.deviceType === "air-purifier") {
        this.airQualityService?.updateCharacteristic(
          this.platform.Characteristic.AirQuality,
          this.getAirQuality(),
        );
      }
    }
  }

  // Common getters/setters

  getActive(): CharacteristicValue {
    return this.device.state.standby === false
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  async setActive(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting active to ${value}`);
    await this.device.setState(
      "standby",
      value === this.platform.Characteristic.Active.INACTIVE,
    );
  }

  getCurrentTemperature(): CharacteristicValue {
    return this.device.sensorData.temperature || 0;
  }

  getLedOn(): CharacteristicValue {
    return (
      this.device.state.brightness !== undefined &&
      this.device.state.brightness > 0 &&
      this.device.state.nightmode !== true
    );
  }

  async setLedOn(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting LED on to ${value}`);
    await this.device.setLedOn(value as boolean);
  }

  getLedBrightness(): CharacteristicValue {
    return this.device.state.brightness || 0;
  }

  async setLedBrightness(value: CharacteristicValue) {
    this.platform.log.debug(
      `[${this.device.name}] Setting LED brightness to ${value}`,
    );
    await this.device.setState("brightness", value as number);
  }

  getNightMode(): CharacteristicValue {
    return this.device.state.nightmode === true;
  }

  async setNightMode(value: CharacteristicValue) {
    this.platform.log.debug(
      `[${this.device.name}] Setting night mode to ${value}`,
    );
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
    this.platform.log.debug(
      `[${this.device.name}] Setting target air purifier state to ${value}`,
    );
    await this.device.setState(
      "automode",
      value === this.platform.Characteristic.TargetAirPurifierState.AUTO,
    );
  }

  getLockPhysicalControls(): CharacteristicValue {
    return this.device.state.childlock
      ? this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
      : this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
  }

  async setLockPhysicalControls(value: CharacteristicValue) {
    this.platform.log.debug(
      `[${this.device.name}] Setting lock physical controls to ${value}`,
    );
    await this.device.setState(
      "childlock",
      value ===
        this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED,
    );
  }

  getOriginalRotationSpeed(): CharacteristicValue {
    return this.device.state.standby === false
      ? this.device.state.fanspeed || 0
      : 0;
  }

  async setOriginalRotationSpeed(value: CharacteristicValue) {
    const speed = value as number;
    this.platform.log.debug(
      `[${this.device.name}] Setting fan speed to ${speed} (${this.getFanSpeedLabel(speed)})`,
    );
    await this.device.setState("fanspeed", speed);
  }

  // Discrete map for humidifier: Sleep(0), 1, 2, 3 -> 25/50/75/100%
  getRotationSpeed(): CharacteristicValue {
    const rawSpeed = this.device.state.fanspeed ?? 0;
    if (this.device.state.standby !== false) return 0;
    if (rawSpeed <= 0) return 25; // Sleep
    if (rawSpeed === 1) return 50;
    if (rawSpeed === 2) return 75;
    return 100; // 3 or higher treated as 3
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const hkSpeed = Math.max(0, Math.min(100, value as number));
    let deviceSpeed = 0;
    // Map 0–100% to Sleep/1/2/3
    if (hkSpeed <= 25) deviceSpeed = 0; // Sleep
    else if (hkSpeed <= 50) deviceSpeed = 1;
    else if (hkSpeed <= 75) deviceSpeed = 2;
    else deviceSpeed = 3;

    this.platform.log.debug(
      `[${this.device.name}] Setting fan speed (discrete) to ${hkSpeed}% -> Device Speed ${deviceSpeed}`,
    );
    // Manual fan change disables auto humidity control and automode
    this.humidityAutoControlEnabled = false;
    this.lastManualOverride = Date.now();
    await this.device.setState("automode", false);
    await this.device.setState("fanspeed", deviceSpeed);
  }

  private getFanSpeedLabel(speed: number): string {
    const labels: { [key: number]: string } = {
      0: "Sleep",
      1: "1",
      2: "2",
      3: "3",
    };
    return labels[speed] || `Speed ${speed}`;
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
    this.platform.log.debug(
      `[${this.device.name}] Setting germ shield to ${value}`,
    );
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
      return Math.max(30, Math.min(80, v));
    }
    const fallback =
      this.configDev.targetHumidity ?? this.configDev.defaultTargetHumidity ?? 60;
    return Math.max(30, Math.min(80, fallback));
  }

  async setTargetRelativeHumidity(value: CharacteristicValue) {
    const desired = Math.max(30, Math.min(80, value as number));
    this.platform.log.debug(
      `[${this.device.name}] Setting target humidity to ${desired}%`,
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

  // Map physical range (30-80%) to HomeKit slider (0-100%)
  // HomeKit 0%   -> Device 30%
  // HomeKit 100% -> Device 80%
  getTargetRelativeHumidityForLightbulb(): CharacteristicValue {
    const realHumidity = (this.getTargetRelativeHumidity() as number) || 45;
    
    // Reverse mapping: (Real - 30) / (80 - 30) * 100
    // Example: Real 30 -> (0/50)*100 = 0%
    // Example: Real 55 -> (25/50)*100 = 50%
    // Example: Real 80 -> (50/50)*100 = 100%
    
    let brightness = Math.round(((realHumidity - 30) / 50) * 100);
    brightness = Math.max(0, Math.min(100, brightness));
    
    return brightness;
  }

  async setTargetRelativeHumidityFromLightbulb(value: CharacteristicValue) {
    const brightness = value as number;
    
    // Forward mapping: (Brightness / 100 * 50) + 30
    // Example: 0%   -> 0 + 30 = 30%
    // Example: 50%  -> 25 + 30 = 55%
    // Example: 100% -> 50 + 30 = 80%
    
    const targetHumidity = Math.round((brightness / 100) * 50 + 30);
    
    this.platform.log.debug(
      `[${this.device.name}] Target Humidity Slider: ${brightness}% -> Setting Device to ${targetHumidity}%`,
    );
    
    await this.setTargetRelativeHumidity(targetHumidity);
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
    let speed = (this.device.state.fanspeed ?? 0) as number;

    // Define preset steps for humidifier
    const presets = [0, 1, 2, 3]; // Sleep, 1, 2, 3

    const pickHigher = () => {
      for (let i = 0; i < presets.length; i++) {
        if (speed < presets[i]) return presets[i];
      }
      return presets[presets.length - 1];
    };
    const pickLower = () => {
      for (let i = presets.length - 1; i >= 0; i--) {
        if (speed > presets[i]) return presets[i];
      }
      return presets[0];
    };

    let newSpeed = speed;
    // Use hysteresis thresholds to avoid oscillation
    if (diff > 2) {
      newSpeed = pickHigher();
    } else if (diff < -4) {
      newSpeed = pickLower();
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
    return this.device.state.automode
      ? this.platform.Characteristic.TargetHumidifierDehumidifierState
          .HUMIDIFIER_OR_DEHUMIDIFIER
      : this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
  }

  async setTargetHumidifierState(value: CharacteristicValue) {
    this.platform.log.debug(
      `[${this.device.name}] Setting target humidifier state to ${value}`,
    );
    await this.device.setState(
      "automode",
      value ===
        this.platform.Characteristic.TargetHumidifierDehumidifierState
          .HUMIDIFIER_OR_DEHUMIDIFIER,
    );
  }

  getWaterLevel(): CharacteristicValue {
    // Water level is not directly available from the API
    // We could estimate based on runtime or other factors
    // For now, return a default high value (100) to indicate no water issue
    // This could be enhanced later with actual tank level if available
    return 100;
  }
}
