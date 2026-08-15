from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
ANDROID = "{http://schemas.android.com/apk/res/android}"
URL = "http://192.168.1.101:8791/tv.html"
PACKAGE = "com.junkyardolympics.tv"


class AndroidTvStaticContract(unittest.TestCase):
    def test_gradle_identity_sdk_and_fixed_url(self):
        gradle = (APP / "build.gradle.kts").read_text()
        for contract in (
            f'applicationId = "{PACKAGE}"',
            'namespace = "com.junkyardolympics.tv"',
            "minSdk = 26",
            "targetSdk = 34",
            "versionCode = 5",
            'versionName = "1.4-broadcast"',
            URL,
        ):
            self.assertIn(contract, gradle)
        self.assertNotIn("findProperty", gradle)

    def test_manifest_is_leanback_landscape_fullscreen_and_awake(self):
        manifest_path = APP / "src/main/AndroidManifest.xml"
        root = ET.parse(manifest_path).getroot()
        permissions = {node.get(ANDROID + "name") for node in root.findall("uses-permission")}
        self.assertEqual({"android.permission.INTERNET", "android.permission.WAKE_LOCK"}, permissions)
        features = {node.get(ANDROID + "name"): node.get(ANDROID + "required") for node in root.findall("uses-feature")}
        self.assertEqual("true", features["android.software.leanback"])
        self.assertEqual("false", features["android.hardware.touchscreen"])
        app = root.find("application")
        self.assertEqual("Junkyard Olympics TV", app.get(ANDROID + "label"))
        self.assertEqual("true", app.get(ANDROID + "usesCleartextTraffic"))
        self.assertEqual("false", app.get(ANDROID + "allowBackup"))
        self.assertEqual("@drawable/tv_banner", app.get(ANDROID + "banner"))
        activities = app.findall("activity")
        self.assertEqual(1, len(activities), "settings/dream activities must not be present")
        activity = activities[0]
        self.assertEqual("landscape", activity.get(ANDROID + "screenOrientation"))
        categories = {node.get(ANDROID + "name") for node in activity.findall("./intent-filter/category")}
        self.assertIn("android.intent.category.LEANBACK_LAUNCHER", categories)
        self.assertIn("android.intent.category.LAUNCHER", categories)
        source = (APP / "src/main/java/com/junkyardolympics/tv/MainActivity.kt").read_text()
        self.assertIn("FLAG_KEEP_SCREEN_ON", source)
        self.assertIn("IMMERSIVE_STICKY", source)

    def test_webview_reconnect_remote_reload_and_back_guard(self):
        source = (APP / "src/main/java/com/junkyardolympics/tv/MainActivity.kt").read_text()
        for behavior in (
            "javaScriptEnabled = true",
            "domStorageEnabled = true",
            "mediaPlaybackRequiresUserGesture = false",
            "onReceivedError",
            "onReceivedHttpError",
            "onPageFinished",
            "RetryPolicy",
            "onKeyDown",
            "KEYCODE_DPAD_CENTER",
            "KEYCODE_DPAD_RIGHT",
            "KEYCODE_DPAD_LEFT",
            "KEYCODE_ENTER",
            "evaluateJavascript",
            "nextPanel",
            "previousPanel",
            "Press BACK again to exit",
        ):
            self.assertIn(behavior, source)
        layout = (APP / "src/main/res/layout/activity_main.xml").read_text()
        self.assertIn("Reconnecting", layout)

    def test_cleartext_is_scoped_to_lan_host_and_no_credentials_exist(self):
        manifest = (APP / "src/main/AndroidManifest.xml").read_text()
        self.assertIn('android:networkSecurityConfig="@xml/network_security_config"', manifest)
        security = (APP / "src/main/res/xml/network_security_config.xml").read_text()
        self.assertIn('cleartextTrafficPermitted="false"', security)
        self.assertIn('cleartextTrafficPermitted="true"', security)
        self.assertIn("192.168.1.101", security)
        audited = [APP / "build.gradle.kts", *APP.glob("src/main/**/*.kt"), *APP.glob("src/main/**/*.xml")]
        combined = "\n".join(p.read_text(errors="ignore") for p in audited if p.is_file())
        suspicious = re.compile(r"(?i)(password|passwd|api[_-]?key|bearer|authorization)[\s:=]+[\"'][^\"']{4,}")
        self.assertIsNone(suspicious.search(combined))
        self.assertNotIn("SharedPreferences", combined)

    def test_all_launcher_assets_exist(self):
        for density in ("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"):
            for name in ("ic_launcher.png", "ic_launcher_round.png"):
                self.assertTrue((APP / f"src/main/res/mipmap-{density}/{name}").is_file())
        self.assertTrue((APP / "src/main/res/mipmap-anydpi-v26/ic_launcher.xml").is_file())
        self.assertTrue((APP / "src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml").is_file())
        self.assertTrue((APP / "src/main/res/drawable-xhdpi/tv_banner.png").is_file())


if __name__ == "__main__":
    unittest.main()
