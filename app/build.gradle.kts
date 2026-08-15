plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.drclaude"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.drclaude"
        minSdk = 26
        targetSdk = 36
        // Bumped per build so the phone can SAY which one it is running (shown at the bottom
        // of the Profil tab). It stayed at 1/"1.0" through every rebuild, which is why
        // "I still do not see the new tab" could not be answered without guessing.
        versionCode = 37
        versionName = "3.7"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            // Only change on this rollback branch: keeps the package the phone already has installed,
            // so this replaces the current build in place instead of landing as a third app.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        // For the version stamp on the Profil tab.
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

base {
    archivesName = "DoctorClaude"
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)

    // Health Connect — optional heart-rate / steps (needs a wearable + the Health Connect app).
    implementation(libs.androidx.health.connect)

    // In-app camera for the product scan (reliable, asks CAMERA permission itself).
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
