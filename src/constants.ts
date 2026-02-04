/**
 * Constants for BlueAir accessory control
 */

// AQI calculation lookup tables
// https://forum.airnowtech.org/t/the-aqi-equation-2024-valid-beginning-may-6th-2024

export type AQILevels = {
  AQI_LO: number[];
  AQI_HI: number[];
  CONC_LO: number[];
  CONC_HI: number[];
};

export const AQI: Record<string, AQILevels> = {
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

// Humidity control range
export const HUMIDITY_MIN = 30;
export const HUMIDITY_MAX = 80;

// Fan speed levels: 0 (off/night), 11 (low), 37 (medium), 64 (high)
export const FAN_SPEED_LEVELS = [0, 11, 37, 64] as const;

// HomeKit fan speed mapping - use 4 discrete positions (0, 33, 66, 100)
// This prevents slider jumping by making HomeKit values match device capability
export const FAN_SPEED_HOMEKIT_STEP = 33;
export const FAN_SPEED_HOMEKIT_VALUES = [0, 33, 66, 100] as const;

// Map HomeKit percentage (0, 33, 66, 100) to device speed (0, 11, 37, 64)
export function fanSpeedHomeKitToDevice(hkSpeed: number): number {
  if (hkSpeed <= 16) return 0;   // 0-16% → off/night
  if (hkSpeed <= 49) return 11;  // 17-49% → low
  if (hkSpeed <= 83) return 37;  // 50-83% → medium
  return 64;                      // 84-100% → high
}

// Map device speed (0, 11, 37, 64) to HomeKit percentage (0, 33, 66, 100)
export function fanSpeedDeviceToHomeKit(deviceSpeed: number): number {
  if (deviceSpeed <= 5) return 0;    // off/night → 0%
  if (deviceSpeed <= 24) return 33;  // low → 33%
  if (deviceSpeed <= 50) return 66;  // medium → 66%
  return 100;                         // high → 100%
}

// Map HomeKit percentage to nearest device speed level (legacy - for direct API calls)
export function mapToDeviceSpeed(hkSpeed: number): number {
  return fanSpeedHomeKitToDevice(hkSpeed);
}

// Night light levels: device uses 0-3, HomeKit uses discrete 0/33/66/100%
export const NL_LEVELS = {
  OFF: 0,
  WARM: 1,
  NORMAL: 2,
  BRIGHT: 3,
} as const;

// HomeKit night light step - 3 brightness levels + off
export const NL_HOMEKIT_STEP = 33;

// Convert device night light value (0-3) to HomeKit percentage (0, 33, 66, 100)
export function nlDeviceToHomeKit(deviceValue: number): number {
  switch (deviceValue) {
    case 0: return 0;
    case 1: return 33;  // warm
    case 2: return 66;  // normal
    case 3: return 100; // bright
    default: return 0;
  }
}

// Convert HomeKit percentage to device night light value (0-3)
export function nlHomeKitToDevice(hkValue: number): number {
  if (hkValue <= 16) return NL_LEVELS.OFF;
  if (hkValue <= 49) return NL_LEVELS.WARM;
  if (hkValue <= 83) return NL_LEVELS.NORMAL;
  return NL_LEVELS.BRIGHT;
}

// Get human-readable name for night light level
export function nlDeviceToName(deviceValue: number): string {
  switch (deviceValue) {
    case 1: return "Warm";
    case 2: return "Normal";
    case 3: return "Bright";
    default: return "Off";
  }
}

// AQI thresholds for HomeKit AirQuality characteristic
export const AQI_THRESHOLDS = {
  EXCELLENT: 50,
  GOOD: 100,
  FAIR: 150,
  INFERIOR: 200,
} as const;

// Default debounce delay for HomeKit slider interactions (ms)
export const DEBOUNCE_DELAY_MS = 500;
