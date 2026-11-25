import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.louis.shiying"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.louis.shiying"
        minSdk = 24
        targetSdk = 34
        versionCode = 5
        versionName = "2.3"
        // Manifest mirrors, tried in order (comma separated). Override with -PupdateUrls=https://a/version.json,https://b/version.json
        val updateUrls = (project.findProperty("updateUrls") as String?)
            ?: "https://shiying-louis.pages.dev/version.json,https://fastly.jsdelivr.net/gh/louis-shiying/shiying-update@main/version.json"
        buildConfigField("String", "UPDATE_URLS", "\"$updateUrls\"")
    }

    buildFeatures { buildConfig = true }

    // yt-dlp (Python) + ffmpeg ship as native binaries per ABI (~50 MB each), so build one APK per ABI.
    // A universal APK would be ~200 MB, so it is not built.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = false
        }
    }

    // Signing: put keystore.properties (storeFile/storePassword/keyAlias/keyPassword) in the project root.
    // It is git-ignored. Without it, release builds fall back to the debug key (cannot update installed 拾影).
    val ksProps = Properties().apply {
        val f = rootProject.file("keystore.properties"); if (f.exists()) f.inputStream().use { load(it) }
    }
    signingConfigs {
        if (ksProps.getProperty("storeFile") != null) create("mykey") {
            storeFile = rootProject.file(ksProps.getProperty("storeFile"))
            storePassword = ksProps.getProperty("storePassword")
            keyAlias = ksProps.getProperty("keyAlias")
            keyPassword = ksProps.getProperty("keyPassword")
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("mykey") ?: signingConfigs.getByName("debug")
        }
        getByName("debug") {
            signingConfig = signingConfigs.findByName("mykey") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
    lint { checkReleaseBuilds = false; abortOnError = false }
    packaging {
        resources { excludes += setOf("META-INF/*.kotlin_module", "META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*") }
        // youtubedl-android runs libpython.so / libffmpeg.so as executables from nativeLibraryDir → must be extracted.
        jniLibs { useLegacyPackaging = true }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // yt-dlp + Python 3.12 + QuickJS (GPL-3.0) and ffmpeg for DASH merging.
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013") // real org.json for JVM unit tests (android.jar only has stubs)
}

tasks.withType<Test> {
    testLogging { showStandardStreams = true; events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
    outputs.upToDateWhen { false }
}
