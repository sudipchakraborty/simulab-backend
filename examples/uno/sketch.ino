// Genuine Arduino core sample; D13 LED and UART are driven by compiled instructions.
void setup() { pinMode(13, OUTPUT); Serial.begin(9600); }
void loop() {
  digitalWrite(13, HIGH); Serial.println("SIMULAB COMPILED UNO"); delay(250);
  digitalWrite(13, LOW); delay(250);
}
