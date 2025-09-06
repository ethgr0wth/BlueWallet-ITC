# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

-keep class com.facebook.hermes.unicode.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.swmansion.** { *; }               # RNGH/Reanimated/etc.
-keep class com.google.firebase.** { *; }         # if using Firebase
-keep class com.google.android.gms.** { *; }
-keep class com.dieam.reactnativepushnotification.** { *; }  # your push lib
-dontwarn com.facebook.react.**
-dontwarn com.facebook.hermes.**
-dontwarn com.google.firebase.**
-dontwarn com.google.android.gms.**
-keepattributes *Annotation*
