/**
 * BlueAirDevice - State management model for BlueAir devices
 *
 * This class acts as a bridge between the platform (API) and accessories (HomeKit).
 * It holds device state, calculates AQI, and emits events for state changes.
 */

import EventEmitter from "events";
import {
  BlueAirDeviceSensorData,
  BlueAirDeviceState,
  BlueAirDeviceStatus,
  FullBlueAirDeviceState,
} from "./api/BlueAirAwsApi";
import { Mutex } from "async-mutex";
import { AQI } from "./constants";

export type BlueAirSensorDataWithAqi = BlueAirDeviceSensorData & {
  aqi?: number;
};

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

    const release = await this.mutex.acquire();

    const changesToApply = this.currentChanges;
    this.currentChanges = { state: {}, sensorData: {} };

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

  /**
   * Request a state change on the device.
   * Emits "setState" event for the platform to handle the API call.
   * Waits for "setStateDone" before updating local state.
   */
  public async setState(attribute: string, value: number | boolean) {
    // Skip if value is unchanged
    if (attribute in this.state && this.state[attribute] === value) {
      return;
    }

    this.emit("setState", { id: this.id, name: this.name, attribute, value });

    const release = await this.mutex.acquire();

    return new Promise<void>((resolve) => {
      this.once("setStateDone", async (success) => {
        release();
        if (success) {
          const newState: Partial<BlueAirDeviceState> = { [attribute]: value };
          // Night mode turns off display brightness
          if (attribute === "nightmode" && value === true) {
            newState["brightness"] = 0;
          }
          await this.notifyStateUpdate(newState);
        }
        resolve();
      });
    });
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
        if (k === "pm2_5" || k === "pm10" || k === "voc") {
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
