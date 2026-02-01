// Combined utils from platformUtils.ts and settings.ts

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

export type DeviceCapabilities = {
  hasAirQuality: boolean;
  hasTemperature: boolean;
  hasHumidity: boolean;
  hasGermShield: boolean;
  hasNightMode: boolean;
  hasLED: boolean;
  hasFilterMaintenance: boolean;
  hasCO2Sensor: boolean;
  hasNO2Sensor: boolean;
  hasOzoneSensor: boolean;
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
  region: Region.EU,
  accountUuid: "",
  pollingInterval: 60,
  devices: [],
};

export const PLATFORM_NAME = "blueair-purifier";
export const PLUGIN_NAME = "homebridge-blueair-purifier";

// Device capability mapping based on model name and type
export const DEVICE_CAPABILITIES: Record<string, DeviceCapabilities> = {
  // Blue Pure series
  "blue pure 211i max": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  "blue pure 311i max": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  "blue pure 311i+ max": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  "blue pure 411i max": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  "blue pure 511i max": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  // HealthProtect series
  healthprotect: {
    hasAirQuality: true,
    hasTemperature: true,
    hasHumidity: false,
    hasGermShield: true,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  // DustMagnet series
  "dustmagnet 5440i": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
  // Protect series
  "protect 7470i": {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  },
};

/**
 * Get device capabilities by model name
 * Falls back to default air purifier capabilities if not found
 */
export function getDeviceCapabilities(
  modelName?: string,
  deviceType?: string,
): DeviceCapabilities {
  if (!modelName) {
    // Default air purifier capabilities
    return {
      hasAirQuality: true,
      hasTemperature: false,
      hasHumidity: false,
      hasGermShield: false,
      hasNightMode: true,
      hasLED: true,
      hasFilterMaintenance: true,
      hasCO2Sensor: false,
      hasNO2Sensor: false,
      hasOzoneSensor: false,
    };
  }

  const normalizedModel = (modelName || "").toLowerCase();

  // Check for exact match first
  if (DEVICE_CAPABILITIES[normalizedModel]) {
    return DEVICE_CAPABILITIES[normalizedModel];
  }

  // Check for partial matches (e.g., "healthprotect" in device name)
  for (const [key, capabilities] of Object.entries(DEVICE_CAPABILITIES)) {
    if (normalizedModel.includes(key) || key.includes(normalizedModel)) {
      return capabilities;
    }
  }

  // Default based on device type if provided
  if (deviceType) {
    if (deviceType.toLowerCase().includes("humidifier")) {
      return {
        hasAirQuality: true,
        hasTemperature: false,
        hasHumidity: true,
        hasGermShield: false,
        hasNightMode: true,
        hasLED: true,
        hasFilterMaintenance: false,
        hasCO2Sensor: false,
        hasNO2Sensor: false,
        hasOzoneSensor: false,
      };
    }
  }

  // Return default air purifier capabilities
  return {
    hasAirQuality: true,
    hasTemperature: false,
    hasHumidity: false,
    hasGermShield: false,
    hasNightMode: true,
    hasLED: true,
    hasFilterMaintenance: true,
    hasCO2Sensor: false,
    hasNO2Sensor: false,
    hasOzoneSensor: false,
  };
}
