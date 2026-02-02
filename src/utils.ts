// Combined utils from platformUtils.ts and settings.ts

import { BlueAirDeviceState, BlueAirDeviceSensorData } from "./api/BlueAirAwsApi";

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

/**
 * Device capabilities detected dynamically from state keys
 */
export type DeviceCapabilities = {
  hasBrightness: boolean;
  hasNightLight: boolean;
  hasNightMode: boolean;
  hasAutoMode: boolean;
  hasHumidity: boolean;
  hasHumidityTarget: boolean;
  hasWaterLevel: boolean;
  hasTemperature: boolean;
  hasAirQuality: boolean;
  hasGermShield: boolean;
  hasFilterUsage: boolean;
  hasChildLock: boolean;
  hasFanSpeed: boolean;
};

/**
 * Detect device capabilities from available state keys and sensor data
 */
export function detectCapabilities(
  state: Partial<BlueAirDeviceState>,
  sensors: Partial<BlueAirDeviceSensorData>,
): DeviceCapabilities {
  return {
    hasBrightness: "brightness" in state,
    hasNightLight: "nlbrightness" in state,
    hasNightMode: "nightmode" in state,
    hasAutoMode: "automode" in state,
    hasWaterLevel: "wlevel" in state,
    hasGermShield: "germshield" in state,
    hasFilterUsage: "filterusage" in state,
    hasChildLock: "childlock" in state,
    hasFanSpeed: "fanspeed" in state,
    hasHumidityTarget: "autorh" in state || 
      Object.keys(state).some(k => /target.*hum|hum.*target|humidity.*set/i.test(k)),
    hasTemperature: "temperature" in sensors && sensors.temperature !== undefined,
    hasHumidity: "humidity" in sensors && sensors.humidity !== undefined,
    hasAirQuality: "pm2_5" in sensors || "pm10" in sensors || "voc" in sensors,
  };
}

/**
 * Format capabilities for logging
 */
export function formatCapabilities(capabilities: DeviceCapabilities): string {
  return Object.entries(capabilities)
    .filter(([, v]) => v)
    .map(([k]) => k.replace("has", ""))
    .join(", ") || "none";
}

export type DeviceConfig = {
  id: string;
  name: string;
  model: string;
  serialNumber: string;
  room?: string;
  filterChangeLevel: number;
  targetHumidity?: number;
  // Optional manual override for the device state key used to set target humidity
  // Example values: "targethumidity", "humidity_target", "hum_target"
  targetHumidityAttribute?: string;
  // UI controls
  showFanTile?: boolean; // Show additional Fan tile (Humidifiers)
  defaultTargetHumidity?: number; // Preferred target if device does not expose writable target
  led: boolean;
  nightLight?: boolean; // Show night light control (Humidifiers)
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
  region: Region.EU,
  accountUuid: "",
  pollingInterval: 120,
  devices: [],
};

export const PLATFORM_NAME = "blueair-purifier";
export const PLUGIN_NAME = "homebridge-blueair-purifier";
