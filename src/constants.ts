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

// Fan speed levels: 0 (sleep/night), 11 (low), 37 (medium), 64 (high)
export const FAN_SPEED_LEVELS = [0, 11, 37, 64] as const;

// HomeKit fan speed mapping - use 5 discrete positions (0, 25, 50, 75, 100)
// 0% = Off/Standby, 25% = Sleep/Night, 50% = Low, 75% = Medium, 100% = High
export const FAN_SPEED_HOMEKIT_STEP = 25;
export const FAN_SPEED_HOMEKIT_VALUES = [0, 25, 50, 75, 100] as const;

// Map HomeKit percentage to device speed
// Returns { speed: number, isNightMode: boolean, isStandby: boolean }
export function fanSpeedHomeKitToDevice(hkSpeed: number): {
  speed: number;
  isNightMode: boolean;
  isStandby: boolean;
} {
  if (hkSpeed <= 12) {
    // 0% = Standby (device off)
    return { speed: 0, isNightMode: false, isStandby: true };
  }
  if (hkSpeed <= 37) {
    // 25% = Sleep/Night mode (device on, night mode enabled)
    return { speed: 0, isNightMode: true, isStandby: false };
  }
  if (hkSpeed <= 62) {
    // 50% = Low
    return { speed: 11, isNightMode: false, isStandby: false };
  }
  if (hkSpeed <= 87) {
    // 75% = Medium
    return { speed: 37, isNightMode: false, isStandby: false };
  }
  // 100% = High
  return { speed: 64, isNightMode: false, isStandby: false };
}

// Map device state to HomeKit percentage
export function fanSpeedDeviceToHomeKit(
  deviceSpeed: number,
  isNightMode: boolean,
  isStandby: boolean,
): number {
  if (isStandby) {
    return 0;
  } // Off → 0%
  if (isNightMode) {
    return 25;
  } // Night mode → 25%
  if (deviceSpeed <= 5) {
    return 25;
  } // Speed 0 without night mode → treat as sleep
  if (deviceSpeed <= 24) {
    return 50;
  } // Low → 50%
  if (deviceSpeed <= 50) {
    return 75;
  } // Medium → 75%
  return 100; // High → 100%
}

// Legacy function for backward compatibility
export function mapToDeviceSpeed(hkSpeed: number): number {
  return fanSpeedHomeKitToDevice(hkSpeed).speed;
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
    case 0:
      return 0;
    case 1:
      return 33; // warm
    case 2:
      return 66; // normal
    case 3:
      return 100; // bright
    default:
      return 0;
  }
}

// Convert HomeKit percentage to device night light value (0-3)
export function nlHomeKitToDevice(hkValue: number): number {
  if (hkValue <= 16) {
    return NL_LEVELS.OFF;
  }
  if (hkValue <= 49) {
    return NL_LEVELS.WARM;
  }
  if (hkValue <= 83) {
    return NL_LEVELS.NORMAL;
  }
  return NL_LEVELS.BRIGHT;
}

// Get human-readable name for night light level
export function nlDeviceToName(deviceValue: number): string {
  switch (deviceValue) {
    case 1:
      return "Warm";
    case 2:
      return "Normal";
    case 3:
      return "Bright";
    default:
      return "Off";
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
