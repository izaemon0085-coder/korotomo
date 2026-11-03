// ころとも：ESP32 に入れるプログラムの「下書き」（β版。まだ本物で試していません）
// サーバー（robot.js）と同じ安全のきまりを、ロボットの中にも入れる
//   1) 止めるは、いつでも効く … 本物の「止める」ボタンは、モーターの電源（ドライバの EN）を直接切る配線にする。
//      プログラムがこわれても止まる。ボタンを押すと、解除の命令が来るまで動かない
//   2) 合図が途切れたら、自分で止まる … 1.5秒、正しい命令が来なければモーターを止める
//   3) 命令には署名 … サーバーが確かめた命令を、ロボット用の合言葉（ROBOT_KEY）で署名しなおして送る。
//      ここでも HMAC-SHA256 を確かめ、番号が前より大きいものだけ受けとる
// 部品の例：ESP32 DevKit、モータードライバ（TB6612FNG など）、ラジコンの車体、非常停止ボタン、電池
#include <WiFi.h>
#include <WiFiUdp.h>
#include "mbedtls/md.h"

const char* WIFI_SSID = "家のWi-Fi";
const char* WIFI_PASS = "パスワード";
const char* ROBOT_KEY = "サーバーと同じロボット用の合言葉";  // 本番では、書きこむときに変える
const uint16_t PORT = 3701;

const int PIN_AIN1 = 25, PIN_AIN2 = 26, PIN_PWMA = 27;   // 左のモーター
const int PIN_BIN1 = 32, PIN_BIN2 = 33, PIN_PWMB = 14;   // 右のモーター
const int PIN_STBY = 13;                                  // ドライバの電源（LOW で全部止まる）
const int PIN_ESTOP = 4;                                  // 非常停止ボタン（押すと LOW）

const unsigned long LOST_MS = 1500;
WiFiUDP udp;
unsigned long lastGood = 0;
unsigned long long lastSeq = 0;
bool estop = false;

void motors(int left, int right) {  // -100〜100
  auto one = [](int in1, int in2, int pwmPin, int v) {
    digitalWrite(in1, v > 0); digitalWrite(in2, v < 0);
    analogWrite(pwmPin, map(abs(constrain(v, -100, 100)), 0, 100, 0, 255));
  };
  bool on = !estop && (left != 0 || right != 0);
  digitalWrite(PIN_STBY, on ? HIGH : LOW);
  one(PIN_AIN1, PIN_AIN2, PIN_PWMA, on ? left : 0);
  one(PIN_BIN1, PIN_BIN2, PIN_PWMB, on ? right : 0);
}

String hmacHex(const String& msg) {
  byte out[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)ROBOT_KEY, strlen(ROBOT_KEY));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&ctx, out);
  mbedtls_md_free(&ctx);
  String hex;
  for (int i = 0; i < 32; i++) { char b[3]; sprintf(b, "%02x", out[i]); hex += b; }
  return hex;
}

// 受けとる形（1行）：seq|type|speed|turn|mac   例）1730000000123|drive|25|0|ab12…
void handle(const String& line) {
  int p1 = line.indexOf('|'), p2 = line.indexOf('|', p1 + 1), p3 = line.indexOf('|', p2 + 1), p4 = line.lastIndexOf('|');
  if (p1 < 0 || p2 < 0 || p3 < 0 || p4 <= p3) return;
  String body = line.substring(0, p4);
  String mac = line.substring(p4 + 1);
  if (hmacHex(body) != mac) return;                         // 署名がちがう → 何もしない
  unsigned long long seq = strtoull(line.substring(0, p1).c_str(), nullptr, 10);
  if (seq <= lastSeq) return;                               // 使い回し → 何もしない
  lastSeq = seq;
  lastGood = millis();
  String type = line.substring(p1 + 1, p2);
  int speed = line.substring(p2 + 1, p3).toInt();
  int turn = line.substring(p3 + 1, p4).toInt();
  if (type == "stop") { estop = true; motors(0, 0); }
  else if (type == "release" && digitalRead(PIN_ESTOP) == HIGH) { estop = false; motors(0, 0); }
  else if (type == "drive" && !estop) motors(speed + turn / 2, speed - turn / 2);
  // beat は lastGood を更新するだけ
}

void setup() {
  for (int p : { PIN_AIN1, PIN_AIN2, PIN_PWMA, PIN_BIN1, PIN_BIN2, PIN_PWMB, PIN_STBY }) pinMode(p, OUTPUT);
  pinMode(PIN_ESTOP, INPUT_PULLUP);
  motors(0, 0);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(200);
  udp.begin(PORT);
}

void loop() {
  if (digitalRead(PIN_ESTOP) == LOW) { estop = true; motors(0, 0); }   // 本物のボタン
  int n = udp.parsePacket();
  if (n > 0 && n < 200) {
    char buf[200];
    int len = udp.read(buf, sizeof(buf) - 1);
    buf[len] = 0;
    handle(String(buf));
  }
  if (millis() - lastGood > LOST_MS) motors(0, 0);                     // 合図が途切れたら止まる
  delay(5);
}
