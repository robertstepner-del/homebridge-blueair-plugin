# Changelog

## v1.2.0 (2026-02-03)

### Updates
- Fixed ESLint and Prettier formatting issues
- Moved Custom UI to correct `homebridge-ui` folder location
- Added `defaultDeviceConfig` export for UI server
- Updated documentation and README

## v1.0.0 (2026-02-03)

### Initial Release

First release of the homebridge-blueair-plugin.

### Features

#### Device Support
- **Air Purifiers** - Full support for BlueAir WiFi-connected air purifiers
- **Humidifiers** - Full support for BlueAir humidifier devices
- **Automatic Device Detection** - Intelligently detects device type and capabilities from API responses
- **Multi-Device Support** - Configure and control multiple BlueAir devices from a single platform

#### Authentication & Discovery
- **Simple Login** - Username/password authentication via BlueAir cloud API (AWS)
- **Custom UI Discovery** - Built-in device discovery in Homebridge Config UI X
- **Region Selection** - Support for Default (EU), Australia, China, Russia, and USA/Canada regions
- **Gigya OAuth Integration** - Secure authentication via Gigya identity platform

#### Air Purifier Controls
- **Power On/Off** - Active state control
- **Fan Speed** - Adjustable rotation speed with debounced slider
- **Auto Mode** - Toggle automatic air purification mode
- **Child Lock** - Lock physical controls
- **Germ Shield** - Toggle germ shield mode (when supported)
- **Night Mode** - Toggle night mode for quiet operation
- **LED Brightness** - Control LED indicator brightness as a lightbulb service

#### Humidifier Controls
- **Power On/Off** - Active state control
- **Fan Speed** - Adjustable rotation speed
- **Target Humidity** - Set desired humidity level (30-80%)
- **Water Level** - Monitor current water level
- **Night Light** - Control night light brightness
- **Auto Humidity Control** - Automatic humidity regulation

#### Sensors
- **PM 1.0** - Particulate matter 1 micron
- **PM 2.5** - Particulate matter 2.5 microns
- **PM 10** - Particulate matter 10 microns
- **Temperature** - Ambient temperature sensor
- **Humidity** - Relative humidity sensor
- **VOC** - Volatile organic compounds
- **Formaldehyde (HCHO)** - Formaldehyde concentration
- **Carbon Dioxide (CO₂)** - CO₂ levels
- **Nitrogen Dioxide (NO₂)** - NO₂ levels
- **Ozone (O₃)** - Ozone concentration
- **Air Quality Index (AQI)** - Calculated from PM2.5 readings

#### Filter Maintenance
- **Filter Life Level** - Monitor remaining filter life percentage
- **Filter Change Indicator** - Alert when filter needs replacement
- **Configurable Threshold** - Set custom filter change level

#### Configuration Options
- **Polling Interval** - Configurable API polling interval (default: 120 seconds)
- **Verbose Logging** - Enable detailed logging for troubleshooting
- **UI Debug Mode** - Debug mode for Custom UI development
- **Per-Device Settings** - Individual configuration for each device
- **Service Toggles** - Enable/disable LED, sensors, germ shield, night mode services

#### Technical Features
- **Event-Driven Architecture** - Efficient state management with EventEmitter pattern
- **Debounced Controls** - Smooth slider interactions without API spam
- **Mutex-Protected State** - Thread-safe state updates
- **Automatic Retry** - API call retry with exponential backoff
- **Capability Detection** - Dynamic feature detection from device state keys
- **Cached Accessories** - Restored accessories from Homebridge cache
