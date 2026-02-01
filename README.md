<p align="center">
  <a href="https://github.com/homebridge/verified/blob/master/verified-plugins.json"><img alt="Homebridge Verified" src="./branding/Homebridge_x_Blueair.svg" width="500px"></a>
</p>

# homebridge-blueair-purifier

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm](https://badgen.net/npm/v/homebridge-blueair-purifier)](https://www.npmjs.com/package/homebridge-blueair-purifier)
[![npm](https://badgen.net/npm/dt/homebridge-blueair-purifier?label=downloads)](https://www.npmjs.com/package/homebridge-blueair-purifier)

## Installation

**Option 1: Install via Homebridge Config UI X:**

Search for "Blueair Purifier" in in [homebridge-config-ui-x](https://github.com/oznu/homebridge-config-ui-x) and install `homebridge-blueair-purifier`.

**Option 2: Manually Install:**

```text
sudo npm install -g homebridge-blueair-purifier
```

### Features

This plugin only supports WiFi connected BlueAir purifiers utilizing cloud connectivity (via AWS) for device communication. Below is a list of known tested products.

- **Simple Login Mechanism** - all you need is your username and password to get started.
- **Semi-automatic detection and configuration of multiple BlueAir devices.**
- **Fast response times** - the plugin uses the BlueAir API to communicate with the devices.
- **Intelligent device detection** - automatically detects device type and capabilities from API responses.
- **Expandable sensor support** - supports PM 1/2.5/10, Temperature, Humidity, VOC, HCHO, CO₂, NO₂, and Ozone sensors (when available on device).

>[!NOTE]
>**Air quality readings** - the plugin may not always report the correct air quality readings (like PM 2.5) due to the BlueAir API limitations. The solution for this issue is in progress.
>
>**Advanced sensors** - CO₂, NO₂, and Ozone sensors are now mapped and will be reported when available from your device, pending Homebridge characteristic support.

## Plugin Configuration

### Feature Toggles
* Show LED service as a lightbulb
* Show Air Quality Sensor service
* Show Temperature Sensor service
* Show Germ Shield switch service
* Show Night Mode switch service

### Customizable Options
* Adjustable Filter Change Level
* Device Name
* Verbose Logging
* BlueAir Server Region Selection

### Sensor Support

The plugin supports the following sensors when available on your device:

| Sensor Type | Code | Description |
|-------------|------|-------------|
| PM 1.0 | `pm1` | Particulate Matter 1 micron |
| PM 2.5 | `pm2_5` | Particulate Matter 2.5 microns |
| PM 10 | `pm10` | Particulate Matter 10 microns |
| Temperature | `t` | Ambient temperature |
| Humidity | `h` | Relative humidity |
| VOC | `tVOC` | Volatile Organic Compounds |
| Formaldehyde | `hcho` | HCHO concentration |
| Carbon Dioxide | `co2` | CO₂ levels |
| Nitrogen Dioxide | `no2` | NO₂ levels |
| Ozone | `o3` | Ozone concentration |
| Nitrogen Oxides | `nox` | NOx density |

### Device Detection

The plugin automatically detects device capabilities based on:
1. **API Device Type** - When the BlueAir API provides device type information
2. **Model Name** - Pattern matching against known device models
3. **Fallback Defaults** - Safe defaults for unknown devices

This allows the plugin to intelligently enable/disable features based on what your specific device supports.

## Extending the Plugin

### Adding Support for New Sensors

New sensor types can be added to the plugin by:

1. Updating the sensor map in `src/api/BlueAirAwsApi.ts`
2. Adding the sensor to the `BlueAirDeviceSensorData` type
3. Creating appropriate Homebridge characteristics (if new sensor type)

## Credits

This plugin is based on the original work by [@kovapatrik](https://github.com/kovapatrik). Special thanks to him for creating and maintaining the homebridge-blueair-purifier plugin.

If you'd like to support kovapatrik's work:
- [GitHub](https://github.com/kovapatrik)
- [Buy Me a Coffee](https://www.buymeacoffee.com/kovapatrik)

Original inspiration from the work of [@fsj21](https://github.com/fjs21) on the Amazon Web Services (AWS) API and construction of the documentation.

### Trademarks

Apple and HomeKit are registered trademarks of Apple Inc.
BlueAir is a trademark of Unilever Corporation
