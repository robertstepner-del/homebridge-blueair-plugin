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
  private filterMaintenanceService?: Service;
  private humidityService?: Service;
  private airQualityService?: Service;
  private ledService?: Service;
  private temperatureService?: Service;
  private germShieldService?: Service;
  private nightModeService?: Service;
  private deviceType: DeviceType;

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

    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 11, minStep: 1 })
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

    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 11, minStep: 1 })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

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
    } else {
      this.setupAirQualityService();
      this.setupGermShieldService();
    }
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
        }

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

  getRotationSpeed(): CharacteristicValue {
    return this.device.state.standby === false
      ? this.device.state.fanspeed || 0
      : 0;
  }

  private getFanSpeedLabel(speed: number): string {
    const labels: { [key: number]: string } = {
      0: "Off",
      1: "Quiet",
      2: "Quiet",
      3: "Quiet",
      4: "Medium",
      5: "Medium",
      6: "Medium",
      7: "High",
      8: "High",
      9: "High",
      10: "Boost",
      11: "Night Mode",
    };
    return labels[speed] || "Unknown";
  }

  async setRotationSpeed(value: CharacteristicValue) {
    const speed = value as number;
    this.platform.log.debug(
      `[${this.device.name}] Setting fan speed to ${speed} (${this.getFanSpeedLabel(speed)})`,
    );
    await this.device.setState("fanspeed", speed);
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

  getCurrentRelativeHumidity(): CharacteristicValue {
    const humidity = Math.max(
      0,
      Math.min(100, this.device.sensorData.humidity || 0),
    );
    return humidity;
  }

  getTargetRelativeHumidity(): CharacteristicValue {
    return this.configDev.targetHumidity || 60;
  }

  async setTargetRelativeHumidity(value: CharacteristicValue) {
    const targetHumidity = Math.max(0, Math.min(100, value as number));
    this.platform.log.debug(
      `[${this.device.name}] Setting target humidity to ${targetHumidity}%`,
    );
    this.platform.log.info(
      `[${this.device.name}] Target humidity set to ${targetHumidity}% (storage only - API control pending)`,
    );
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
