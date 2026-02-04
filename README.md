<p align="center">
  <a href="https://github.com/homebridge/verified/blob/master/verified-plugins.json"><img alt="Homebridge Verified" src="./branding/Homebridge_x_Blueair.svg" width="500px"></a>
</p>

# homebridge-blueair-plugin

Homebridge plugin for BlueAir air purifiers and humidifiers with cloud connectivity.

## Installation

**Option 1: Install via Homebridge Config UI X:**

Search for "BlueAir" in [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x) and install `homebridge-blueair-plugin`.

**Option 2: Manually Install:**

```bash
sudo npm install -g homebridge-blueair-plugin
```

## Device Setup

1. Open **Homebridge Config UI X**
2. Go to **Plugins** → Find **Homebridge BlueAir Plugin**
3. Click **Settings** (gear icon)
4. Click **"Discover devices"**
5. Enter your BlueAir account credentials and select your region
6. Click **"Discover Devices on account"**
7. Click **Add** next to each device you want to control
8. Save the configuration and restart Homebridge

## Supported Devices

- **Air Purifiers** - BlueAir WiFi-connected air purifiers (e.g., Blue 3210i, HealthProtect series)
- **Humidifiers** - BlueAir humidifier devices

> [!NOTE]
> This plugin only supports devices with cloud connectivity via AWS. Classic/legacy BlueAir devices are not supported.

## Features

### Air Purifier Controls
- Power on/off
- Fan speed control with debounced slider
- Auto mode toggle
- Child lock (lock physical controls)
- LED brightness control (as lightbulb service)
- Germ Shield mode (when supported)
- Night mode for quiet operation

### Humidifier Controls
- Power on/off
- Fan speed control
- Target humidity (30-80%)
- Water level monitoring
- Night light brightness control

### Sensors
The plugin supports the following sensors when available on your device:

| Sensor | Description |
|--------|-------------|
| PM 1.0 / PM 2.5 / PM 10 | Particulate matter sensors |
| Temperature | Ambient temperature |
| Humidity | Relative humidity |
| VOC | Volatile organic compounds |
| Formaldehyde (HCHO) | Formaldehyde concentration |
| CO₂ | Carbon dioxide levels |
| Air Quality Index | Calculated AQI from PM2.5 |

### Filter Maintenance
- Filter life level monitoring
- Filter change indicator with configurable threshold

## Configuration Options

| Option | Description |
|--------|-------------|
| **Region** | BlueAir server region (Default/EU, Australia, China, Russia, USA) |
| **Polling Interval** | API polling interval in seconds (default: 120) |
| **Verbose Logging** | Enable detailed logging for troubleshooting |
| **LED Service** | Show LED brightness as a lightbulb tile |
| **Air Quality Sensor** | Show air quality sensor service |
| **Temperature Sensor** | Show temperature sensor service |
| **Germ Shield** | Show germ shield switch (air purifiers) |
| **Night Mode** | Show night mode switch |
| **Filter Change Level** | Percentage threshold for filter change alert |

## Automatic Device Detection

The plugin automatically detects device capabilities based on:
1. **API Device Type** - Device type information from BlueAir API
2. **Model Name** - Pattern matching against known device models
3. **State Keys** - Available state keys reported by the device

This allows the plugin to intelligently enable/disable features based on what your specific device supports.

## Credits

This plugin is based on the original work by [@kovapatrik](https://github.com/kovapatrik). Special thanks to him for creating and maintaining the homebridge-blueair-purifier plugin.

If you'd like to support kovapatrik's work:
- [GitHub](https://github.com/kovapatrik)
- [Buy Me a Coffee](https://www.buymeacoffee.com/kovapatrik)

Original inspiration from the work of [@fsj21](https://github.com/fjs21) on the Amazon Web Services (AWS) API and construction of the documentation.

### Trademarks

Apple and HomeKit are registered trademarks of Apple Inc.
BlueAir is a trademark of Unilever Corporation
