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

    signingConfigs {
        // 沙箱写不了 ~/.android，debug 签名指到工程内已生成的 keystore
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
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
