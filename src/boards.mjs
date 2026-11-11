/** @file Fixed toolchain targets; physical board metadata does not imply emulator support. */
export const boards = Object.freeze({
  uno: { name: "Arduino Uno", fqbn: "arduino:avr:uno", simulation: "uno" },
  nano:{name:"Arduino Nano",fqbn:"arduino:avr:nano:cpu=atmega328",simulation:"nano"},
  mega2560:{name:"Arduino Mega2560",fqbn:"arduino:avr:mega:cpu=atmega2560",simulation:"mega2560"},
  esp32: { name: "ESP32 DevKit", fqbn: "esp32:esp32:esp32", simulation: null },
  esp32s3: {
    name: "ESP32-S3 DevKit",
    fqbn: "esp32:esp32:esp32s3",
    simulation: "esp32s3",
  },
  "yd-n16r8": {
    name: "YD ESP32-S3 N16R8 (compatible generic profile)",
    fqbn: "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi",
    simulation: "esp32s3",
    warning:
      "Compatible compile profile only; physical module and emulator full 16 MiB capacity unverified",
  },
});
