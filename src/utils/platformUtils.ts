export type Config = {
  name: string;
  username: string;
  password: string;
  region: Region;
  accountUuid: string;
  verboseLogging: boolean;
  uiDebug: boolean;
  pollingInterval: number;
  devices: DeviceConfig[];
  discoveredDevices?: DiscoveredDevice[];
};

export type DiscoveredDevice = {
  uuid: string;
  name: string;
  type: string;
  mac: string;
};

export type DeviceConfig = {
  id: string;
  name: string;
  model: string;
  serialNumber: string;
  room?: string;
  filterChangeLevel: number;
  targetHumidity?: number;
  led: boolean;
  airQualitySensor: boolean;
  co2Sensor: boolean;
  temperatureSensor: boolean;
  humiditySensor: boolean;
  germShield: boolean;
  nightMode: boolean;
};

export enum Region {
  EU = "Default (all other regions)",
  AU = "Australia",
  CN = "China",
  RU = "Russia",
  US = "USA",
}

export const defaultConfig: Config = {
  name: "BlueAir Platform",
  uiDebug: false,
  verboseLogging: true,
  username: "",
  password: "",
  accountUuid: "",
  region: Region.EU,
  pollingInterval: 15000,
  devices: [],
};

export const defaultDeviceConfig: DeviceConfig = {
  id: "",
  name: "",
  model: "",
  serialNumber: "",
  room: "",
  targetHumidity: 60,
  filterChangeLevel: 90,
  led: false,
  airQualitySensor: false,
  co2Sensor: false,
  temperatureSensor: false,
  humiditySensor: false,
  germShield: false,
  nightMode: false,
};
