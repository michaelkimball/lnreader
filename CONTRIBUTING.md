# Contributing Guide

Contributions are welcome and are greatly appreciated!

## Setup your environment with nix

If you are on a Linux system, you can install the nix package manager and use the nix flakes to set up your development environment.
See [CONTRIBUTING-NIX.md](CONTRIBUTING-NIX.md)

## Setting up your environment

After forking to your own github org or account, do the following steps to get started:

```bash
# prerequisites
node --version >= 20   (for version management, get nvm [recommended])
java sdk --version >= 17    (for version management, get jenv [optional])
android sdk                 (https://developer.android.com/studio)

# clone your fork to your local machine
git clone https://github.com/<your-account-name>/lnreader.git

# step into local repo
cd lnreader

# install pnpm (if not already installed)
npm install -g pnpm

# install dependencies
pnpm install

# build the apk (the built apk will be found in ~/lnreader/android/app/build/outputs/apk/release/)
pnpm run build:release:android
```

### Developing on Android

You will need an Android device or emulator connected to your computer as well as an IDE of your choice. (eg: vscode)

```bash
# prerequisites
adb                         (https://developer.android.com/studio/command-line/adb)
IDE

# check if android device/emulator is connected
adb devices

# run metro for development
pnpm run dev:start

# then to view on your android device (new terminal)
pnpm run dev:android
```

### Developing on WSL2 (Windows Subsystem for Linux)

If you're developing on WSL2 with a USB-connected Android device, additional setup is required because the device connects to Windows, not directly to WSL.

#### Prerequisites

1. **ADB installed in both Windows and WSL** - The device is managed by Windows ADB, but you'll run commands from WSL
2. **Metro bundler running in WSL** - Your development server runs inside WSL
3. **Port forwarding configured** - Bridge the connection between Windows and WSL

#### Setup Steps

**1. Start Metro bundler in WSL:**

```bash
cd ~/lnreader
pnpm run dev:start
```

Keep this running in a separate terminal.

**2. Build and install the APK:**

```bash
# Build the debug APK
cd android && ./gradlew assembleDebug

# Install via ADB (from WSL)
adb install -r ./app/build/outputs/apk/debug/app-debug.apk
```

**3. Configure port forwarding (choose ONE method):**

**Method A: Using adb reverse (Recommended for USB)**

This tunnels the device's localhost:8081 to your WSL Metro server:

```bash
# Run this command every time you reconnect the device
adb reverse tcp:8081 tcp:8081

# Start the app
adb shell am start -n com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity
```

**Method B: Using Windows IP (For WiFi or if Method A fails)**

If you're on the same WiFi network or `adb reverse` doesn't work:

1. In Windows PowerShell (as Administrator):
   ```powershell
   # Get your WSL IP
   wsl hostname -I
   
   # Set up port proxy (replace WSL_IP with the IP from above)
   netsh interface portproxy add v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=WSL_IP
   
   # Allow firewall
   netsh advfirewall firewall add rule name="Metro Bundler" dir=in action=allow protocol=TCP localport=8081
   
   # Get your Windows IP
   ipconfig
   ```

2. In WSL, configure the app to use your Windows IP:
   ```bash
   # Replace YOUR_WINDOWS_IP with the IP from ipconfig (e.g., 192.168.1.100)
   adb shell "run-as com.rajarsheechatterjee.LNReader.debug sh -c 'mkdir -p /data/data/com.rajarsheechatterjee.LNReader.debug/files && echo \"YOUR_WINDOWS_IP:8081\" > /data/data/com.rajarsheechatterjee.LNReader.debug/files/debug_http_host'"
   
   # Restart the app
   adb shell am force-stop com.rajarsheechatterjee.LNReader.debug
   adb shell am start -n com.rajarsheechatterjee.LNReader.debug/com.rajarsheechatterjee.LNReader.MainActivity
   ```

#### Troubleshooting

**"Unable to load script" error:**
- Ensure Metro is running: `lsof -i :8081` (should show a node process)
- Verify port forwarding: `adb shell "curl -s http://localhost:8081/status"` (should return "packager-status:running")
- Re-run `adb reverse tcp:8081 tcp:8081` if you disconnected/reconnected the device

**App gets stuck at "Task :app:installDebug":**
```bash
# Force stop the app and clean
adb shell am force-stop com.rajarsheechatterjee.LNReader.debug
cd android && ./gradlew clean

# Reinstall manually
./gradlew assembleDebug
adb install -r ./app/build/outputs/apk/debug/app-debug.apk
```

**Metro not responding:**
```bash
# Kill Metro and restart
lsof -ti:8081 | xargs kill -9
pnpm run dev:start
```

#### Quick Reference

After initial setup, this is the typical workflow:

```bash
# 1. Start Metro (if not running)
pnpm run dev:start

# 2. Ensure port forwarding (run once per device connection)
adb reverse tcp:8081 tcp:8081

# 3. If you make native changes, rebuild and reinstall
cd android && ./gradlew assembleDebug && adb install -r ./app/build/outputs/apk/debug/app-debug.apk

# 4. If you only change JS/TS, just reload in the app
# Press 'r' twice in Metro terminal, or shake device → Reload
```

### Style & Linting

This codebase's linting rules are enforced using [ESLint](http://eslint.org/).

It is recommended that you install an eslint plugin for your editor of choice when working on this
codebase, however you can always check to see if the source code is compliant by running:

```bash
pnpm run lint
```
