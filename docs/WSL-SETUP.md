# LNReader Development on WSL (Windows Subsystem for Linux)

## Overview

This guide covers setting up React Native development for LNReader in a WSL environment. Direct USB connections don't work in WSL, so we use a combination of manual APK installation and ADB reverse port forwarding.

## Prerequisites

- WSL2 with Node.js >= 20 and pnpm installed
- Android device connected to Windows via USB
- ADB (Android Debug Bridge) installed on Windows
- Metro bundler accessible from device via port forwarding

## One-Time Setup

### 1. Install Dependencies

```bash
# In WSL terminal
cd /path/to/lnreader-debug
pnpm install --frozen-lockfile
```

### 2. Generate Debug Environment File

```bash
pnpm run generate:env:debug
```

### 3. Build Debug APK

```bash
cd android
./gradlew assembleDebug
```

Build output: `android/app/build/outputs/apk/debug/app-debug.apk`
Build time: ~20 seconds (after initial Gradle setup)

### 4. Install APK on Device

```bash
# Check device is connected (from Windows or WSL with proper ADB setup)
adb devices

# Install the debug APK
# Note: ADB runs on Windows, so use relative path from android/ directory
cd android
adb install -r ./app/build/outputs/apk/debug/app-debug.apk
```

**Expected result:**
```
Performing Streamed Install
Success
```

### 5. Verify Installation

```bash
# Check installed packages
adb shell pm list packages | grep rajarsheechatterjee

# Should show:
# package:com.rajarsheechatterjee.LNReader
# package:com.rajarsheechatterjee.LNReader.debug
```

## Daily Development Workflow

### Step 1: Start Metro Bundler

```bash
# In WSL terminal
cd /path/to/lnreader-debug
pnpm run dev:start

# Or if cache issues:
pnpm run dev:clean-start
```

### Step 2: Set Up ADB Reverse Port Forwarding

This allows the device to connect to Metro running in WSL on localhost:8081:

```bash
# Check connected devices
adb devices

# Set up reverse port forwarding (use device serial if multiple devices)
adb reverse tcp:8081 tcp:8081

# For specific device:
adb -s DEVICE_SERIAL reverse tcp:8081 tcp:8081
```

**Expected output:**
```
8081
```

### Step 3: Launch Debug App

```bash
# Force stop and restart app to establish connection
adb shell am force-stop com.rajarsheechatterjee.LNReader.debug
adb shell am start -n com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity
```

**Expected output:**
```
Starting: Intent { cmp=com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity }
```

### Step 4: Verify Metro Connection

Check your Metro terminal - you should see:

```
INFO  Reloading connected app(s)...
 BUNDLE  ./index.js
```

## Troubleshooting

### Problem: "No apps connected" Warning

**Symptom:**
```
warn No apps connected. Sending "reload" to all React Native apps failed.
```

**Solution:**
1. Ensure ADB reverse port forwarding is active: `adb reverse tcp:8081 tcp:8081`
2. Restart the app: `adb shell am force-stop com.rajarsheechatterjee.LNReader.debug && adb shell am start -n com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity`

### Problem: "More than one device/emulator"

**Solution:**
Specify device serial explicitly:
```bash
adb devices  # Get device serial (e.g., RFCY419RSCP)
adb -s RFCY419RSCP reverse tcp:8081 tcp:8081
adb -s RFCY419RSCP shell am start -n com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity
```

### Problem: Metro Can't Find Module

**Solution:**
Clear Metro cache:
```bash
pnpm run dev:clean-start
```

### Problem: Build Fails After Dependency Changes

**Solution:**
```bash
# Nuclear option - clean and reinstall everything
pnpm run clean:full
```

## Quick Reference Commands

```bash
# Start Metro bundler
pnpm run dev:start

# Build debug APK
cd android && ./gradlew assembleDebug

# Install APK
adb install -r ./app/build/outputs/apk/debug/app-debug.apk

# Port forwarding
adb reverse tcp:8081 tcp:8081

# Launch app
adb shell am start -n com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity

# Force stop app
adb shell am force-stop com.rajarsheechatterjee.LNReader.debug

# Check running app
adb shell dumpsys activity activities | grep -i lnreader

# Open dev menu on device
adb shell input keyevent 82
```

## Understanding the Package Names

- **Namespace:** `com.rajarsheechatterjee.LNReader`
- **Debug Build:** `com.rajarsheechatterjee.LNReader.debug` (has `.debug` suffix)
- **Release Build:** `com.rajarsheechatterjee.LNReader`

Debug and release builds can coexist on the same device.

## Why This Approach?

1. **WSL Limitation:** USB devices aren't directly accessible in WSL2
2. **ADB Runs on Windows:** The `adb` command connects through Windows to the device
3. **Metro Runs in WSL:** The Metro bundler runs in WSL on port 8081
4. **Reverse Port Forwarding:** `adb reverse` makes the device's localhost:8081 forward to WSL's localhost:8081

This setup provides full hot-reloading capabilities without needing to rebuild the APK for every code change.

## Alternative: Direct Windows Development

If you prefer, you can develop directly in Windows:
1. Install Node.js, pnpm, and Android SDK on Windows
2. Use `pnpm run dev:android` which handles everything automatically
3. No port forwarding needed

However, WSL development is often preferred for its Linux compatibility and tooling.
