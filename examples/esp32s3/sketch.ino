// Generic ESP32-S3 compatible firmware; connect GPIO4 through a resistor to an LED.
void setup() { pinMode(4, OUTPUT); Serial.begin(115200); }
void loop() {
  digitalWrite(4, HIGH); Serial.println("SIMULAB COMPILED S3"); delay(250);
  digitalWrite(4, LOW); delay(250);
}
