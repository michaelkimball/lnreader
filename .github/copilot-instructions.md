# LNReader - Copilot Coding Agent Instructions

## Project Overview

**LNReader** is a free and open source light novel reader for Android, inspired by Tachiyomi. This is a React Native 0.81.6 application with Expo integration, written primarily in TypeScript and React.

### Tech Stack
- **Runtime**: Node.js >= 20, Java SDK >= 17
- **Package Manager**: pnpm (required, not npm or yarn)
- **Framework**: React Native 0.81.6 with Expo 54
- **Platform**: Android (minSdk: 24, targetSdk: 36, compileSdk: 36)
- **Database**: SQLite via @op-engineering/op-sqlite with Drizzle ORM
- **Testing**: Jest 29.7.0 with React Testing Library
- **Linting**: ESLint 8.57.1 with @react-native/eslint-config
- **Formatting**: Prettier 2.8.8
- **Build**: Gradle with Kotlin 2.1.20
- **Native Modules**: C++ (Epub processing via pugixml), Kotlin (TTS foreground service, media controls)
- **State Management**: React Context API with MMKV for persistence
- **TTS**: Android foreground service + expo-av + Azure Speech (real-time + batch synthesis)

---

## Critical Setup & Build Sequence

### Prerequisites Installation
```bash
# Verify versions BEFORE starting
node --version    # Must be >= 20 (use nvm for version management)
java -version     # Must be >= 17 (use jenv optional)

# Install pnpm globally if not present
npm install -g pnpm
pnpm --version    # Should show 10.x or higher
```

### Initial Setup (First Time Only)
```bash
# 1. Install dependencies - ALWAYS use --frozen-lockfile
pnpm install --frozen-lockfile

# 2. Verify installation succeeded (should show ~1338 packages)
# Dependencies take ~8s on standard hardware
```

### Environment Files Required
The project requires `.env` file for builds. Generate it before building:
```bash
# For debug builds
pnpm run generate:env:debug

# For release builds
pnpm run generate:env:release
```

---

## Validation Commands (Run in Order)

### 1. Linting (MUST PASS for CI)
```bash
pnpm run lint
# Expected: 17 warnings (inline styles, exhaustive-deps), 0 errors
# Fix auto-fixable issues: pnpm run lint:fix
# CI workflow: .github/workflows/lint.yml
```

### 2. Testing (MUST PASS for CI)
```bash
# Run all tests (takes ~18s)
pnpm run test
# Expected: 12 test suites, 199 tests passed

# Run specific test projects
pnpm run test:db       # Database tests only (node environment)
pnpm run test:rn       # React Native tests only
pnpm run test:watch    # Watch mode for development
pnpm run test:coverage # Generate coverage report
```

**Testing Notes**:
- Tests use Jest with 2 projects: `db` (node env) and `rn` (react-native env)
- Global mocks in `__mocks__/` (react-native-mmkv, react-navigation, database)
- Custom test utilities in `__tests-modules__/test-utils.tsx`
- See `TESTING.md` for detailed testing patterns and common issues

### 3. Type Checking (CURRENTLY DISABLED in CI)
```bash
pnpm run type-check
# Note: Currently has ~14 type errors (workflow disabled)
# See .github/workflows/types.yml - marked "Temporarily Disabled"
# DO NOT rely on type-check passing for PR approval
```

### 4. Formatting
```bash
pnpm run format:check  # Check formatting
pnpm run format        # Auto-fix formatting
```

---

## Build Commands

### Android Development Build
```bash
# 1. Generate debug environment file
pnpm run generate:env:debug

# 2. Connect Android device or start emulator
adb devices  # Verify device is connected

# 3. Start Metro bundler (keep running in separate terminal)
pnpm run dev:start
# If caching issues: pnpm run dev:clean-start

# 4. Deploy to device (new terminal, while Metro is running)
pnpm run dev:android
# This runs: react-native run-android --appIdSuffix "debug" --active-arch-only
```

### Android Release Build
```bash
pnpm run build:release:android
# This:
# 1. Generates release environment file
# 2. Runs: cd android && ./gradlew clean && ./gradlew assembleRelease
# 3. Output: android/app/build/outputs/apk/release/app-release.apk
# 4. Build time: ~60 minutes on CI (ubuntu-latest)
```

**Build-Specific Notes**:
- Always run `pnpm install --frozen-lockfile` before building after dependency changes
- If build fails, try full clean: `pnpm run clean:full` (removes node_modules, build dirs, reinstalls)
- Gradlew must be executable: `chmod +x android/gradlew` if needed
- CI uses Java 17 (Zulu distribution), Gradle caching enabled

---

## Project Architecture

### Directory Structure
```
lnreader/
├── .github/workflows/     # CI/CD: build.yml, lint.yml, testing.yml
├── __mocks__/             # Jest global mocks (DB, native modules)
├── __tests__/             # Jest setup files
├── __tests-modules__/     # Test utilities (@test-utils)
├── android/               # Android native code, Gradle configs
│   ├── app/build.gradle   # App-level build config (version, signing)
│   └── build.gradle       # Project-level build config (SDK versions)
├── drizzle/               # Database migrations
├── ios/                   # iOS native code (less maintained for this fork)
├── shared/                # C++ code (Epub.cpp, pugixml)
├── specs/                 # React Native Turbo Modules specs
├── src/
│   ├── api/               # Remote API integrations (drive, remote)
│   ├── components/        # Reusable UI components
│   ├── database/          # SQLite DB layer (Drizzle ORM, queries)
│   ├── hooks/             # Custom React hooks (persisted state via MMKV)
│   ├── navigators/        # React Navigation setup
│   ├── plugins/           # Content source plugins
│   ├── screens/           # Screen components
│   ├── services/
│   │   ├── tts/           # TTS: TTSPlaybackManager, TTSAudioGenerator, cache, downloads
│   │   └── ...            # backup, downloads, updates
│   ├── theme/             # Theming system
│   ├── type/              # TypeScript type definitions
│   └── utils/             # Utility functions
├── docs/
│   ├── tts/               # TTS system documentation (see docs/tts/README.md)
│   └── WSL-SETUP.md       # WSL development environment setup
├── strings/               # i18n translations (Crowdin managed)
├── App.tsx                # Root component
├── index.js               # Entry point (RTL setup, expo registration)
├── package.json           # Dependencies and scripts
├── tsconfig.json          # TypeScript configuration with path aliases
├── babel.config.js        # Babel with module-resolver, React Compiler
├── metro.config.js        # Metro bundler config (.sql support)
├── jest.config.js         # Jest multi-project config
└── .eslintrc.js           # ESLint rules
```

### Path Aliases (Import Shortcuts)
Always use these import aliases instead of relative paths:
```typescript
@components     → ./src/components
@database       → ./src/database
@hooks          → ./src/hooks
@screens        → ./src/screens
@strings        → ./strings
@services       → ./src/services
@plugins        → ./src/plugins
@utils          → ./src/utils
@theme          → ./src/theme
@navigators     → ./src/navigators
@api            → ./src/api
@type           → ./src/type
@specs          → ./specs
@test-utils     → ./__tests-modules__/test-utils
```

### Key Configuration Files
- **tsconfig.json**: TypeScript config with path aliases, ES2022 target
- **babel.config.js**: React Compiler enabled (target: '19'), module resolver, react-native-dotenv
- **metro.config.js**: Custom middleware for Android assets, SQL file support
- **jest.config.js**: Multi-project setup (db + rn), custom moduleNameMapper
- **.eslintrc.js**: Extends @react-native, enforces no-console as error, testing-library for tests
- **.prettierrc.js**: 2-space tabs, single quotes, trailing commas

---

## Git Pre-commit Hooks

Husky is configured to run lint-staged before every commit:
```bash
# Runs on staged *.{js,jsx,ts,tsx} files:
1. eslint --fix
2. prettier --check
```
If linting fails, commit will be blocked. Fix issues before committing.

---

## GitHub Actions CI/CD

### Workflows That MUST Pass for PRs:
1. **Lint** (`.github/workflows/lint.yml`)
   - Runs on: push to main, PRs
   - Command: `pnpm run lint`
   - Timeout: 10 minutes
   
2. **Testing** (`.github/workflows/testing.yml`)
   - Runs on: push to main, PRs
   - Command: `pnpm run test`
   - Timeout: 10 minutes

### Workflows That Run on Main:
3. **Build** (`.github/workflows/build.yml`)
   - Runs on: push to main, manual dispatch
   - Builds release APK with custom app ID
   - Timeout: 60 minutes
   - Uploads artifact to GitHub

### Disabled Workflows:
4. **Type Check** (`.github/workflows/types.yml`)
   - Currently disabled (commented out triggers)
   - Known type errors (~14 issues)
   - Not a blocker for merging

---

## Common Issues & Workarounds

### Issue: pnpm not found
**Fix**: Install globally: `npm install -g pnpm`

### Issue: Gradlew permission denied
**Fix**: `chmod +x android/gradlew`

### Issue: Metro bundler cache issues
**Fix**: `pnpm run dev:clean-start` (clears Metro cache)

### Issue: Build fails after dependency changes
**Fix**: `pnpm run clean:full` (nuclear option - cleans everything and reinstalls)

### Issue: Tests fail with "Cannot use import statement outside a module"
**Fix**: Add mocks at module level (see TESTING.md for patterns)

### Issue: ESLint no-console errors
**Fix**: Remove console.log statements or use proper logging utility

### Known TODO/HACK Comments:
- `src/navigators/Main.tsx:66` - Hack to allow database initialization time
- `src/database/queries/ChapterQueries.ts:189` - TODO: Remove chapters array dependency for deletion
- `src/services/backup/local/index.ts:104` - TODO: Verify allowVirtualFiles behavior
- `src/screens/more/TTSDownloadsScreen.tsx` - TODO: Display chapter names (currently shows chapter ID)

---

## TTS System

See `docs/tts/` for all documentation.

### Documentation Map

| Document | What It Covers |
|---|---|
| [docs/tts/README.md](../docs/tts/README.md) | Doc map, source file index, quick question guide |
| [docs/tts/architecture.md](../docs/tts/architecture.md) | Full layer diagram, data flow, engine routing, component responsibilities |
| [docs/tts/playback-engine.md](../docs/tts/playback-engine.md) | TTSPlaybackManager state machine, expo-av, preloader, foreground service, position resumption |
| [docs/tts/audio-generation.md](../docs/tts/audio-generation.md) | TTSAudioGenerator, MicrosoftSpeechService (Azure), NativeExpoSpeech, LRU cache |
| [docs/tts/offline-downloads.md](../docs/tts/offline-downloads.md) | Azure Batch Synthesis, AzureBlobStorage, TTSDownloadManager, DB schema |
| [docs/tts/webview-integration.md](../docs/tts/webview-integration.md) | core.js TTS engine, WebViewReader bridge, event protocol, position save/restore |
| [docs/tts/known-bugs-and-patterns.md](../docs/tts/known-bugs-and-patterns.md) | All resolved bugs, state patterns, build gotchas |

### Key TTS Files

```
src/services/tts/
  TTSPlaybackManager.ts        # Singleton playback orchestrator
  TTSAudioPreloader.ts         # Progressive look-ahead audio generation
  TTSAudioGenerator.ts         # Unified engine factory (expo + microsoft)
  TTSCacheManager.ts           # LRU FileSystem cache (100MB)
  MicrosoftSpeechService.ts    # Azure Speech REST API
  EventEmitter.ts              # Custom (Node.js 'events' not available in RN)
  AzureBlobStorage.ts          # Upload SSML for batch synthesis
  AzureBatchSynthesisService.ts  # Batch job submission and polling
  TTSDownloadManager.ts        # Offline download orchestration

specs/
  NativeTTSForegroundService.ts  # Turbo Module spec
  NativeExpoSpeech.ts            # Turbo Module spec

src/screens/
  reader/components/WebViewReader.tsx  # React Native ↔ WebView bridge
  more/TTSDownloadsScreen.tsx          # Download management UI

android/.../js/core.js  # WebView TTS engine (DOM traversal, element queue)
```

### Critical TTS Rules

1. **Never call `tts.stop()` in WebView between elements** — destroys the element queue
2. **Use `fromPlay=true` when `stop()` is called from within `play()`** — prevents `queueEnd` feedback loop
3. **Only `handleQueueEnd` should inject `tts.next()`** — not `handleElementChange`
4. **Track unmount-critical state in React refs**, not component state (WebView is destroyed on unmount)
5. **Audio files use `expo-file-system`, not MMKV** (MMKV is for metadata/position only)
6. **Position MMKV key is `tts_position_{chapterId}`**, data shape `{ position: number, total: number }`
7. **Never use `chapter.id` directly in a `useEffect([], [])` cleanup** — the closure is stale. Use `chapterIdRef.current` which is updated on every render.
8. **Never call `tts.start()` mid-session for seeking** — use `seek-speak` → `seekToElement()` instead. `tts.start()` calls `tts.stop()` internally, destroying the element queue.
9. **Background auto-advance to a non-downloaded chapter**: set `pendingForegroundAutoStartRef = true` and defer `tts.start()` to the AppState `'active'` handler. Clear `tts.savedPosition` before calling `tts.start()` to prevent starting at a stale position.

---

## Development Best Practices

1. **Always use pnpm**: Never use npm or yarn - lockfile is pnpm-lock.yaml
2. **Run lint before committing**: `pnpm run lint` - pre-commit hook will catch this anyway
3. **Run tests for affected areas**: `pnpm run test` or targeted tests
4. **Use path aliases**: Import from `@components`, not `../../components`
5. **Follow TypeScript patterns**: Project uses strict TypeScript (noUnusedLocals: true)
6. **Test files must use mocks**: See `__tests-modules__/test-utils.tsx` for render helpers
7. **Database changes require migrations**: Use `pnpm run generate:db-migration` for Drizzle migrations
8. **Translations managed via Crowdin**: Don't edit `strings/languages/` directly

---

## Agent-Specific Guidance

**TRUST THESE INSTRUCTIONS**: Only search for additional context if this document is incomplete or contradicts observed behavior. The workflows and commands documented here are validated and current as of March 2026.

**When making changes**:
1. Run `pnpm run lint` to verify no new ESLint errors (warnings OK)
2. Run `pnpm run test` to ensure all tests still pass
3. For database changes, generate migration: `pnpm run generate:db-migration`
4. Do NOT run `pnpm run type-check` as validation - it currently has known failures

**What MUST pass for PR approval**:
- ✅ ESLint (no errors, warnings acceptable)
- ✅ Jest tests (all passing)
- ❌ Type check is disabled - ignore type errors for now

**TTS changes**: Read `docs/tts/README.md` first before making any modifications.
