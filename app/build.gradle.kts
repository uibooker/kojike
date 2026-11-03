plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "io.github.booker.kojike"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.booker.kojike"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    // 沙箱写不了 ~/.android，debug 签名指到 local/ 下已生成的 keystore（本地产物，不入库）
    // 文件不存在时（如新 clone）回退 Android 默认 debug 签名
    val debugKeystore = rootProject.file("local/debug.keystore")

    signingConfigs {
        if (debugKeystore.exists()) {
            getByName("debug") {
                storeFile = debugKeystore
            }
        }
    }

    buildTypes {
        debug {
            if (debugKeystore.exists()) {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    compileOnly(libs.libxposed.api)
}
