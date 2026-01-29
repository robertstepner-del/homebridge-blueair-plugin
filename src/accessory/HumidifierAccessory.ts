import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { BlueAirPlatform } from '../platform';
import { BlueAirDevice } from '../device/BlueAirDevice';
import { DeviceConfig } from '../platformUtils';
import { FullBlueAirDeviceState } from '../api/BlueAirAwsApi';

export class HumidifierAccessory {
  private service: Service;
  private humidityService?: Service;
  private ledService?: Service;
  private temperatureService?: Service;
  private nightModeService?: Service;

  constructor(
    protected readonly platform: BlueAirPlatform,
    protected readonly accessory: PlatformAccessory,
    protected readonly device: BlueAirDevice,
    protected readonly configDev: DeviceConfig,
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'BlueAir')
      .setCharacteristic(this.platform.Characteristic.Model, this.configDev.model || 'BlueAir Humidifier')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.configDev.serialNumber || 'BlueAir Device');

    this.service =
      this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.configDev.name);
    this.service.getCharacteristic(this.platform.Characteristic.Active).onGet(this.getActive.bind(this)).onSet(this.setActive.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity).onGet(this.getCurrentRelativeHumidity.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetRelativeHumidity)
      .onGet(this.getTargetRelativeHumidity.bind(this))
      .onSet(this.setTargetRelativeHumidity.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentHumidifierDehumidifierState)
      .onGet(this.getCurrentHumidifierState.bind(this));

    this.humidityService = this.accessory.getServiceById(this.platform.Service.HumiditySensor, 'Humidity');
    if (this.configDev.humiditySensor) {
      this.humidityService ??= this.accessory.addService(this.platform.Service.HumiditySensor, `${this.device.name} Humidity`, 'Humidity');
      this.humidityService
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getCurrentRelativeHumidity.bind(this));
    } else if (this.humidityService) {
      this.accessory.removeService(this.humidityService);
    }

    this.ledService = this.accessory.getServiceById(this.platform.Service.Lightbulb, 'Led');
    if (this.configDev.led) {
      this.ledService ??= this.accessory.addService(this.platform.Service.Lightbulb, `${this.device.name} Led`, 'Led');
      this.ledService.setCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Led`);
      this.ledService.setCharacteristic(this.platform.Characteristic.ConfiguredName, `${this.device.name} Led`);
      this.ledService.getCharacteristic(this.platform.Characteristic.On).onGet(this.getLedOn.bind(this)).onSet(this.setLedOn.bind(this));
      this.ledService
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getLedBrightness.bind(this))
        .onSet(this.setLedBrightness.bind(this));
    } else if (this.ledService) {
      this.accessory.removeService(this.ledService);
    }

    this.temperatureService = this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'Temperature');
    if (this.configDev.temperatureSensor) {
      this.temperatureService ??= this.accessory.addService(
        this.platform.Service.TemperatureSensor,
        `${this.device.name} Temperature`,
        'Temperature',
      );
      this.temperatureService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getCurrentTemperature.bind(this));
    } else if (this.temperatureService) {
      this.accessory.removeService(this.temperatureService);
    }

    this.nightModeService = this.accessory.getServiceById(this.platform.Service.Switch, 'NightMode');
    if (this.configDev.nightMode) {
      this.nightModeService ??= this.accessory.addService(this.platform.Service.Switch, `${this.device.name} Night Mode`, 'NightMode');
      this.nightModeService.setCharacteristic(this.platform.Characteristic.Name, `${this.device.name} Night Mode`);
      this.nightModeService.setCharacteristic(this.platform.Characteristic.ConfiguredName, `${this.device.name} Night Mode`);
      this.nightModeService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getNightMode.bind(this))
        .onSet(this.setNightMode.bind(this));
    } else if (this.nightModeService) {
      this.accessory.removeService(this.nightModeService);
    }
    this.device.on('stateUpdated', this.updateCharacteristics.bind(this));
  }

  updateCharacteristics(changedStates: Partial<FullBlueAirDeviceState>) {
    for (const [k, v] of Object.entries(changedStates)) {
      this.platform.log.debug(`[${this.device.name}] ${k} changed to ${v}}`);
      let updateState = false;
      switch (k) {
        case 'standby':
          updateState = true;
          break;
        case 'automode':
          updateState = true;
          break;
        case 'fanspeed':
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentHumidifierDehumidifierState,
            this.getCurrentHumidifierState(),
          );
          break;
        case 'humidity':
          this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
          this.humidityService?.updateCharacteristic(
            this.platform.Characteristic.CurrentRelativeHumidity,
            this.getCurrentRelativeHumidity(),
          );
          break;
        case 'temperature':
          this.temperatureService?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.getCurrentTemperature());
          break;
        case 'brightness':
          this.ledService?.updateCharacteristic(this.platform.Characteristic.On, this.getLedOn());
          this.ledService?.updateCharacteristic(this.platform.Characteristic.Brightness, this.getLedBrightness());
          break;
        case 'nightmode':
          this.nightModeService?.updateCharacteristic(this.platform.Characteristic.On, this.getNightMode());
          break;
      }

      if (updateState) {
        this.service.updateCharacteristic(this.platform.Characteristic.Active, this.getActive());
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentHumidifierDehumidifierState,
          this.getCurrentHumidifierState(),
        );
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.getCurrentRelativeHumidity());
        this.ledService?.updateCharacteristic(this.platform.Characteristic.On, this.getLedOn());
        this.nightModeService?.updateCharacteristic(this.platform.Characteristic.On, this.getNightMode());
      }
    }
  }

  getActive(): CharacteristicValue {
    return this.device.state.standby === false ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  async setActive(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting active to ${value}`);
    await this.device.setState('standby', value === this.platform.Characteristic.Active.INACTIVE);
  }

  getCurrentRelativeHumidity(): CharacteristicValue {
    return this.device.sensorData.humidity || 0;
  }

  getTargetRelativeHumidity(): CharacteristicValue {
    // Return a reasonable default target humidity (e.g., 60%)
    // This can be enhanced if the API provides target humidity data
    return 60;
  }

  async setTargetRelativeHumidity(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting target humidity to ${value}`);
    // TODO: Implement if the BlueAir API supports humidity target control
    // For now, this is a placeholder for future implementation
  }

  getCurrentHumidifierState(): CharacteristicValue {
    if (this.device.state.standby === false) {
      return this.device.state.automode && this.device.state.fanspeed === 0
        ? this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE
        : this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
    }

    return this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
  }

  getCurrentTemperature(): CharacteristicValue {
    return this.device.sensorData.temperature || 0;
  }

  getLedOn(): CharacteristicValue {
    return this.device.state.brightness !== undefined && this.device.state.brightness > 0 && this.device.state.nightmode !== true;
  }

  async setLedOn(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting LED on to ${value}`);
    await this.device.setLedOn(value as boolean);
  }

  getLedBrightness(): CharacteristicValue {
    return this.device.state.brightness || 0;
  }

  async setLedBrightness(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting LED brightness to ${value}`);
    await this.device.setState('brightness', value as number);
  }

  getNightMode(): CharacteristicValue {
    return this.device.state.nightmode === true;
  }

  async setNightMode(value: CharacteristicValue) {
    this.platform.log.debug(`[${this.device.name}] Setting night mode to ${value}`);
    await this.device.setState('nightmode', value as boolean);
  }
}
