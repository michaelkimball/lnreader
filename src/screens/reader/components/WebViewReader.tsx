import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  StatusBar,
} from 'react-native';
import WebView from 'react-native-webview';
import color from 'color';

import { useTheme } from '@hooks/persisted';
import { getString } from '@strings/translations';

import { getPlugin } from '@plugins/pluginManager';
import { MMKVStorage, getMMKVObject, setMMKVObject } from '@utils/mmkv/mmkv';
import {
  CHAPTER_GENERAL_SETTINGS,
  CHAPTER_READER_SETTINGS,
  INTEGRATION_SETTINGS,
  ChapterGeneralSettings,
  ChapterReaderSettings,
  IntegrationSettings,
  initialChapterGeneralSettings,
  initialChapterReaderSettings,
} from '@hooks/persisted/useSettings';
import { getBatteryLevelSync } from 'react-native-device-info';
import { PLUGIN_STORAGE } from '@utils/Storages';
import { useChapterContext } from '../ChapterContext';
import {
  showTTSNotification,
  updateTTSNotification,
  updateTTSPlaybackState,
  updateTTSProgress,
  dismissTTSNotification,
  ttsMediaEmitter,
} from '@utils/ttsNotification';
import { microsoftSpeechService } from '@services/tts/MicrosoftSpeechService';
import { showToast } from '@utils/showToast';
import { ttsPlaybackManager, PlaybackEvent } from '@services/tts/TTSPlaybackManager';
import { VoiceSettings, TTSEngine } from '@services/tts/TTSAudioGenerator';
import { handleExtractionResult } from '@utils/tts/extractChapterText';
import { hasCompletedDownload } from '@database/queries/TTSDownloadQueries';
import { uiLog } from '@utils/logger';

const TTS_AUTOSTART_KEY = 'tts_autostart_pending';
// Module-level flag: true while the new chapter's audio is being handed off in background.
// The old component's unmount cleanup must NOT call stop() during this window or it will
// kill the audio that the new component just started loading.
let backgroundHandoffInFlight = false;

type WebViewPostEvent = {
  type: string;
  data?: { [key: string]: unknown };
  autoStartTTS?: boolean;
  index?: number;
  total?: number;
};

type WebViewReaderProps = {
  onPress(): void;
};

const onLogMessage = (payload: { nativeEvent: { data: string } }) => {
  const dataPayload = JSON.parse(payload.nativeEvent.data);
  if (dataPayload) {
    if (dataPayload.type === 'console') {
      uiLog.info(`[Console] ${JSON.stringify(dataPayload.msg, null, 2)}`);
    }
  }
};

const { RNDeviceInfo } = NativeModules;
const deviceInfoEmitter = new NativeEventEmitter(RNDeviceInfo);

const assetsUriPrefix = __DEV__
  ? 'http://localhost:8081/assets'
  : 'file:///android_asset';

const WebViewReader: React.FC<WebViewReaderProps> = ({ onPress }) => {
  const {
    novel,
    chapter,
    chapterText: html,
    navigateChapter,
    saveProgress,
    nextChapter,
    prevChapter,
    webViewRef,
  } = useChapterContext();
  const theme = useTheme();
  // Use state for settings so they update when MMKV changes
  const [readerSettings, setReaderSettings] = useState<ChapterReaderSettings>(
    () =>
      getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
      initialChapterReaderSettings,
  );
  const chapterGeneralSettings = useMemo(
    () =>
      getMMKVObject<ChapterGeneralSettings>(CHAPTER_GENERAL_SETTINGS) ||
      initialChapterGeneralSettings,
    // needed to preserve settings during chapter change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chapter.id],
  );

  // Update readerSettings when chapter changes
  useEffect(() => {
    setReaderSettings(
      getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
      initialChapterReaderSettings,
    );
  }, [chapter.id]);

  // Update battery level when chapter changes to ensure fresh value on navigation
  const batteryLevel = useMemo(() => getBatteryLevelSync(), []);
  const plugin = getPlugin(novel?.pluginId);
  const pluginCustomJS = `file://${PLUGIN_STORAGE}/${plugin?.id}/custom.js`;
  const pluginCustomCSS = `file://${PLUGIN_STORAGE}/${plugin?.id}/custom.css`;
  const nextChapterScreenVisible = useRef<boolean>(false);
  const autoStartTTSRef = useRef<boolean>(false);
  const isTTSReadingRef = useRef<boolean>(false);
  const readerSettingsRef = useRef<ChapterReaderSettings>(readerSettings);
  const appStateRef = useRef(AppState.currentState);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsQueueIndexRef = useRef<number>(0);
  const ttsFullQueueInitializedRef = useRef<boolean>(false);
  const ttsElementIndexMapRef = useRef<number[]>([]); // textQueue index → allReadableElements index
  // Always tracks the current chapter.id even when the component doesn't remount
  // (e.g. background auto-advance via setChapter()). The [] unmount cleanup captures
  // stopTTS from the first render whose closure has the old chapter.id — using this
  // ref ensures the correct chapter key is written to MMKV on navigate-away.
  const chapterIdRef = useRef(chapter.id);
  chapterIdRef.current = chapter.id;
  // Set when a background auto-advance lands on a non-downloaded chapter.
  // The AppState handler checks this on foreground restore and injects tts.start()
  // via WebView so online TTS kicks off when the user unlocks their phone.
  const pendingForegroundAutoStartRef = useRef(false);

  // TTS position persistence helper
  const getTTSPositionKey = (chapterId: number) => `tts_position_${chapterId}`;

  // Background auto-start: when MMKV flag is set (from background chapter auto-advance),
  // start offline playback directly from RN without waiting for WebView JS.
  useEffect(() => {
    const pendingAutostart = getMMKVObject<boolean>(TTS_AUTOSTART_KEY);
    if (!pendingAutostart) return;

    void (async () => {
      const hasOffline = await hasCompletedDownload(chapter.id);
      if (!hasOffline) {
        setMMKVObject(TTS_AUTOSTART_KEY, null);
        backgroundHandoffInFlight = false; // no handoff, safe to clear
        // Chapter not downloaded: can't play audio in background.
        // Reset queue state from the previous chapter's session and signal the
        // AppState handler to start online TTS via WebView when the user unlocks.
        ttsQueueRef.current = [];
        ttsQueueIndexRef.current = 0;
        ttsFullQueueInitializedRef.current = false;
        isTTSReadingRef.current = false;
        // Clear any stale saved position for this chapter — it's a fresh auto-advance
        // continuation, so playback must start from element 0, not a previous session.
        const freshKey = getTTSPositionKey(chapter.id);
        setMMKVObject(freshKey, null);
        pendingForegroundAutoStartRef.current = true;
        uiLog.debug('[WebViewReader] Next chapter not downloaded — will auto-start online TTS on foreground restore');
        return;
      }

      setMMKVObject(TTS_AUTOSTART_KEY, null);
      // Prevent onLoadEnd from also injecting tts.start() (would fail in background anyway)
      autoStartTTSRef.current = false;

      const engine = readerSettingsRef.current.tts?.engine || 'expo' as TTSEngine;
      const integrationSettings = getMMKVObject<IntegrationSettings>(INTEGRATION_SETTINGS);
      let voice = '';
      if (engine === 'microsoft') {
        voice = readerSettingsRef.current.tts?.microsoftVoice?.shortName || '';
        if (integrationSettings?.microsoftSpeech?.enabled && !microsoftSpeechService.isReady()) {
          microsoftSpeechService.initialize({
            subscriptionKey: integrationSettings.microsoftSpeech.subscriptionKey!,
            region: integrationSettings.microsoftSpeech.region!,
            voice,
          });
        }
      } else {
        voice = readerSettingsRef.current.tts?.voice?.identifier || '';
      }
      const voiceSettings: VoiceSettings = {
        voice,
        pitch: readerSettingsRef.current.tts?.pitch || 1,
        rate: readerSettingsRef.current.tts?.rate || 1,
        engine,
      };

      uiLog.debug('[WebViewReader] Background auto-start: starting offline playback for chapter', chapter.id);
      // Sentinel queue: length > 0 so background queueEnd logic can detect session,
      // and index 0 < length 1 comparison correctly falls to chapter-end auto-advance.
      ttsQueueRef.current = [''];
      ttsQueueIndexRef.current = 0;
      ttsFullQueueInitializedRef.current = true;
      isTTSReadingRef.current = true;
      showTTSNotification({
        novelName: novel?.name || 'Unknown',
        chapterName: chapter.name,
        coverUri: novel?.cover || '',
        isPlaying: true,
      });
      // Keep backgroundHandoffInFlight = true until play() fully completes.
      // play() awaits playFromOfflineFiles() → NativeTTSForegroundService.startService()
      // and Audio.Sound.createAsync(). The old component's stopTTS() must not call
      // stop() / stopService() until after both of those resolve.
      try {
        await ttsPlaybackManager.play([''], 0, chapter.id, novel?.id || 0, voiceSettings);
      } finally {
        backgroundHandoffInFlight = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  useEffect(() => {
    const playListener = ttsMediaEmitter.addListener('TTSPlay', () => {
      uiLog.debug('[WebViewReader] TTSPlay event received from bluetooth/notification');
      // Resume playback (expo-av true pause)
      ttsPlaybackManager.resume();
    });
    
    const pauseListener = ttsMediaEmitter.addListener('TTSPause', () => {
      uiLog.debug('[WebViewReader] TTSPause event received from bluetooth/notification');
      // Pause playback (expo-av true pause)
      ttsPlaybackManager.pause();
    });
    
    const stopListener = ttsMediaEmitter.addListener('TTSStop', () => {
      uiLog.debug('[WebViewReader] TTSStop event received (from notification dismiss or stop button)');
      // Use stopTTS() to properly clean up both RN and WebView
      stopTTS();
    });
    
    const rewindListener = ttsMediaEmitter.addListener('TTSRewind', () => {
      uiLog.debug('[WebViewReader] TTSRewind notification button pressed');
      // Stop current playback and go back one element
      ttsPlaybackManager.stop(true); // Stop without emitting queueEnd
      webViewRef.current?.injectJavaScript(`
        console.log("[WebView] Rewind button - elementsRead:", tts.elementsRead, "started:", tts.started);
        if (window.tts && tts.started && tts.elementsRead > 0) {
          const targetIndex = Math.max(0, tts.elementsRead - 2);
          console.log("[WebView] Seeking to:", targetIndex);
          tts.seekTo(targetIndex);
        } else {
          console.log("[WebView] Rewind conditions not met");
        }
      `);
    });
    
    const prevListener = ttsMediaEmitter.addListener('TTSPrev', () => {
      uiLog.debug('[WebViewReader] TTSPrev notification button pressed');
      // Stop current playback and go back one element
      ttsPlaybackManager.stop(true); // Stop without emitting queueEnd
      webViewRef.current?.injectJavaScript(`
        console.log("[WebView] Previous button - elementsRead:", tts.elementsRead, "started:", tts.started);
        if (window.tts && tts.started && tts.elementsRead > 0) {
          const targetIndex = Math.max(0, tts.elementsRead - 2);
          console.log("[WebView] Seeking to:", targetIndex);
          tts.seekTo(targetIndex);
        } else {
          console.log("[WebView] Previous conditions not met");
        }
      `);
    });
    
    const nextListener = ttsMediaEmitter.addListener('TTSNext', () => {
      uiLog.debug('[WebViewReader] TTSNext notification button pressed');
      // Stop current playback before advancing to prevent double-next
      ttsPlaybackManager.stop(true); // Stop without emitting queueEnd
      webViewRef.current?.injectJavaScript(`
        console.log("[WebView] Next button - elementsRead:", tts.elementsRead, "totalElements:", tts.totalElements);
        if (window.tts && tts.started) {
          tts.next();
        }
      `);
    });
    
    const seekToListener = ttsMediaEmitter.addListener(
      'TTSSeekTo',
      (event: { position: number }) => {
        const position = event.position;
        // Seek to specific index in WebView queue
        webViewRef.current?.injectJavaScript(`
          if (window.tts && tts.started) { tts.seekTo(${position}); }
        `);
      },
    );
    
    return () => {
      playListener.remove();
      pauseListener.remove();
      stopListener.remove();
      rewindListener.remove();
      prevListener.remove();
      nextListener.remove();
      seekToListener.remove();
    };
  }, [webViewRef]);

  useEffect(() => {
    if (isTTSReadingRef.current) {
      updateTTSNotification({
        novelName: novel?.name || 'Unknown',
        chapterName: chapter.name,
        coverUri: novel?.cover || '',
        isPlaying: isTTSReadingRef.current,
      });
    }
  }, [novel?.name, novel?.cover, chapter.name]);

  useEffect(() => {
    return () => {
      uiLog.debug('[WebViewReader] Component unmounting, stopping TTS');
      // Save position and stop TTS properly
      stopTTS();
      dismissTTSNotification();
      // Cleanup Microsoft Speech service
      if (microsoftSpeechService.isReady()) {
        microsoftSpeechService.dispose();
      }
    };
  }, []);

  useEffect(() => {
    const mmkvListener = MMKVStorage.addOnValueChangedListener(key => {
      switch (key) {
        case CHAPTER_READER_SETTINGS:
          // Update local state with new settings
          const newSettings =
            getMMKVObject<ChapterReaderSettings>(CHAPTER_READER_SETTINGS) ||
            initialChapterReaderSettings;
          setReaderSettings(newSettings);

          // Stop any currently playing speech
          stopTTS();

          // Update WebView settings
          webViewRef.current?.injectJavaScript(
            `
            reader.readerSettings.val = ${MMKVStorage.getString(
              CHAPTER_READER_SETTINGS,
            )};
            // Auto-restart TTS if currently reading
            if (window.tts && tts.reading) {
              const currentElement = tts.currentElement;
              const wasReading = tts.reading;
              tts.stop();
              if (wasReading) {
                setTimeout(() => {
                  tts.start(currentElement);
                }, 100);
              }
            }
            `,
          );
          break;
        case CHAPTER_GENERAL_SETTINGS:
          webViewRef.current?.injectJavaScript(
            `reader.generalSettings.val = ${MMKVStorage.getString(
              CHAPTER_GENERAL_SETTINGS,
            )}`,
          );
          break;
      }
    });

    const subscription = deviceInfoEmitter.addListener(
      'RNDeviceInfo_batteryLevelDidChange',
      (level: number) => {
        webViewRef.current?.injectJavaScript(
          `reader.batteryLevel.val = ${level}`,
        );
      },
    );
    return () => {
      subscription.remove();
      mmkvListener.remove();
    };
  }, [webViewRef]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;
      
      // When a background auto-advance landed on a non-downloaded chapter we can't
      // play audio in background. Defer to foreground restore: inject tts.start()
      // via WebView so the user gets online TTS as soon as they unlock their phone.
      if (nextState === 'active' && (previousState === 'background' || previousState === 'inactive') && pendingForegroundAutoStartRef.current) {
        pendingForegroundAutoStartRef.current = false;
        uiLog.debug('[WebViewReader] Foreground restore — starting online TTS for non-downloaded chapter');
        // onLoadEnd already ran in background and set up the DOM (including any stale
        // tts.savedPosition). Clear savedPosition so playback starts from element 0,
        // then call tts.start() after a short settle delay.
        setTimeout(() => {
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (window.tts && reader.generalSettings.val.TTSEnable) {
                tts.savedPosition = null;
                tts.start();
              }
            })();
          `);
        }, 200);
      }

      // Sync WebView TTS UI when returning to foreground.
      // Only inject if allReadableElements is already populated (tts.start() was called
      // before background). For background-auto-start sessions allReadableElements is
      // empty — onLoadEnd will handle that case after the page fully loads.
      if (nextState === 'active' && (previousState === 'background' || previousState === 'inactive') && isTTSReadingRef.current) {
        const index = ttsQueueIndexRef.current;
        uiLog.debug('[WebViewReader] Returning to foreground - syncing UI at index:', index);

        webViewRef.current?.injectJavaScript(`
          (function() {
            if (!window.tts || !tts.allReadableElements || tts.allReadableElements.length === 0) {
              // allReadableElements not built yet (background auto-start).
              // onLoadEnd will sync after the page fully loads — skip for now.
              console.log('[WebView TTS] Skipping foreground sync — allReadableElements empty');
              return;
            }
            var idx = ${index};
            tts.started = true;
            tts.reading = true;
            var controller = document.getElementById('TTS-Controller');
            if (controller && controller.firstElementChild && window.ttsIcons) {
              controller.firstElementChild.innerHTML = window.ttsIcons.pauseIcon;
            }
            if (idx >= 0 && idx < tts.allReadableElements.length) {
              tts.allReadableElements.forEach(function(el) { el && el.classList && el.classList.remove('highlight'); });
              tts.elementsRead = idx + 1;
              tts.currentElement = tts.allReadableElements[idx];
              tts.prevElement = idx > 0 ? tts.allReadableElements[idx - 1] : null;
              if (tts.currentElement) {
                tts.currentElement.classList.add('highlight');
                tts.scrollToElement && tts.scrollToElement(tts.currentElement);
              }
              console.log('[WebView TTS] Foreground sync at element', idx, 'of', tts.totalElements);
            }
          })();
        `);
      }
    });

    return () => subscription.remove();
  }, [webViewRef]);

  // TTSPlaybackManager event listeners
  useEffect(() => {
    const handleStateChange = (event: PlaybackEvent) => {
      if (event.type === 'stateChange' && event.state) {
        const isPlaying = event.state === 'playing';
        const isLoading = event.state === 'loading';
        const isPaused = event.state === 'paused';
        isTTSReadingRef.current = isPlaying || isLoading;

        updateTTSPlaybackState(isPlaying);

        if (isPlaying || isLoading || isPaused) {
          updateTTSNotification({
            novelName: novel?.name || 'Unknown',
            chapterName: chapter.name,
            coverUri: novel?.cover || '',
            isPlaying: isPlaying,
          });
        }

        // Sync the WebView TTS button icon when playback state changes from outside
        // (e.g. Bluetooth headphone controls). tts.reading and the icon are normally
        // only updated by the WebView's own onclick handler, so we must sync them here.
        if (isPaused) {
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (window.tts) { tts.reading = false; }
              var c = document.getElementById('TTS-Controller');
              if (c && c.firstElementChild && window.ttsIcons) {
                c.firstElementChild.innerHTML = window.ttsIcons.resumeIcon;
              }
            })();
          `);
        } else if (isPlaying) {
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (window.tts) { tts.reading = true; }
              var c = document.getElementById('TTS-Controller');
              if (c && c.firstElementChild && window.ttsIcons) {
                c.firstElementChild.innerHTML = window.ttsIcons.pauseIcon;
              }
            })();
          `);
        }
      }
    };

    const handleElementChange = (event: PlaybackEvent) => {
      if (event.type === 'elementChange' && event.index !== undefined) {
        // event.index is the textQueue index from TTSPlaybackManager.
        // Convert it to the allReadableElements index so that ttsQueueIndexRef
        // stays consistent with the allReadableIdx that speak events emit.
        // stopTTS() reads this ref and stores it as tts.savedPosition, which
        // core.js uses as `this.elementsRead` (an allReadableElements index).
        const indexMap = ttsElementIndexMapRef.current;
        const realIdx = indexMap.length > 0 && event.index < indexMap.length
          ? indexMap[event.index]
          : event.index;
        ttsQueueIndexRef.current = realIdx;
        uiLog.debug('[WebViewReader] Element changed to index:', event.index, '(allReadable:', realIdx, ')');

        // In full-queue mode the WebView doesn't drive playback, so it never
        // calls tts.next() itself. Push a highlight update directly so the
        // reader stays in sync with what is actually playing.
        if (ttsFullQueueInitializedRef.current) {
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (window.tts && tts.allReadableElements && tts.allReadableElements.length) {
                var idx = ${realIdx};
                tts.allReadableElements.forEach(function(el) { el && el.classList && el.classList.remove('highlight'); });
                tts.elementsRead = idx + 1;
                tts.currentElement = tts.allReadableElements[idx];
                if (tts.currentElement) {
                  tts.currentElement.classList.add('highlight');
                  tts.scrollToElement && tts.scrollToElement(tts.currentElement);
                }
              }
            })();
          `);
        }
      }
    };

    const handleQueueEnd = (event: PlaybackEvent) => {
      uiLog.debug('##################################################');
      uiLog.debug('[WebViewReader] ⚠️ QUEUE END EVENT RECEIVED');
      uiLog.debug('##################################################');
      
      if (event.type === 'queueEnd') {
        if (event.reason === 'completed') {
          // Check if app is in background or screen is locked
          const isBackground = appStateRef.current === 'background' || appStateRef.current === 'inactive';
          
          uiLog.debug('[WebViewReader] handleQueueEnd - isBackground:', isBackground, 'appState:', appStateRef.current, 'queueLength:', ttsQueueRef.current.length);
          
          if (isBackground && ttsQueueRef.current.length > 0) {
            // Background playback: WebView doesn't execute in background
            const nextIndex = ttsQueueIndexRef.current + 1;
            uiLog.debug('[WebViewReader] Background mode - advancing from', ttsQueueIndexRef.current, 'to', nextIndex, 'of', ttsQueueRef.current.length);
            
            if (nextIndex < ttsQueueRef.current.length) {
              ttsQueueIndexRef.current = nextIndex;
              uiLog.debug('[WebViewReader] Using seek() to play preloaded audio at index', nextIndex);
              
              // Use seek() which plays from the existing preloaded queue without resetting it
              ttsPlaybackManager.seek(nextIndex);
              return;
            }

            // End of queue reached in background — check for auto-page-advance
            const autoPageAdvance = readerSettingsRef.current.tts?.autoPageAdvance === true;
            uiLog.debug('[WebViewReader] Background queue end - autoPageAdvance:', autoPageAdvance, 'nextChapter:', !!nextChapter);
            if (autoPageAdvance && nextChapter) {
              uiLog.debug('[WebViewReader] Background auto-advancing to next chapter');
              // Persist intent in MMKV so the new chapter's component instance picks it up.
              // autoStartTTSRef alone doesn't survive if a new component instance is mounted.
              backgroundHandoffInFlight = true;
              setMMKVObject(TTS_AUTOSTART_KEY, true);
              // Do NOT set autoStartTTSRef.current here — the MMKV useEffect will handle
              // the actual start and will clear autoStartTTSRef to prevent onLoadEnd double-start.
              // Clear saved position for completed chapter before navigating
              const clearKey = getTTSPositionKey(chapter.id);
              setMMKVObject(clearKey, null);
              navigateChapter('NEXT');
              return;
            }

            // No auto-advance — stop cleanly
            isTTSReadingRef.current = false;
            ttsFullQueueInitializedRef.current = false;
            dismissTTSNotification();
            return;
          }
          
          // Foreground: use WebView queue
          uiLog.debug('[WebViewReader] Injecting tts.next() into WebView');
          webViewRef.current?.injectJavaScript('tts.next?.()');
        } else {
          // User stopped or error - end TTS session
          isTTSReadingRef.current = false;
          ttsFullQueueInitializedRef.current = false; // Reset for next TTS session
          dismissTTSNotification();
          webViewRef.current?.injectJavaScript('tts.stop?.()');
        }
      }
    };

    const handleError = (event: PlaybackEvent) => {
      if (event.type === 'error') {
        showToast(event.message || 'TTS error occurred', 'error');
        isTTSReadingRef.current = false;
        ttsFullQueueInitializedRef.current = false; // Reset for next TTS session
        dismissTTSNotification();
      }
    };

    ttsPlaybackManager.on('stateChange', handleStateChange);
    ttsPlaybackManager.on('elementChange', handleElementChange);
    ttsPlaybackManager.on('queueEnd', handleQueueEnd);
    ttsPlaybackManager.on('error', handleError);

    return () => {
      ttsPlaybackManager.off('stateChange', handleStateChange);
      ttsPlaybackManager.off('elementChange', handleElementChange);
      ttsPlaybackManager.off('queueEnd', handleQueueEnd);
      ttsPlaybackManager.off('error', handleError);
    };
  }, [novel?.name, novel?.cover, chapter.name, webViewRef]);

  const stopTTS = async () => {
    uiLog.debug('[WebViewReader] stopTTS called - isTTSReading:', isTTSReadingRef.current, 
                'queueLength:', ttsQueueRef.current.length, 
                'currentIndex:', ttsQueueIndexRef.current,
                'backgroundHandoffInFlight:', backgroundHandoffInFlight);

    // If a background chapter hand-off is in flight, the new chapter's component already
    // started audio loading. Calling stop() here would race with createAsync() and
    // cause a native crash. Skip the stop — the new component owns the session now.
    if (backgroundHandoffInFlight) {
      uiLog.debug('[WebViewReader] Skipping stop() — background hand-off in flight');
      return;
    }
    
    // Save current TTS position from React Native state (not WebView, which might be destroyed).
    // Gate on queue presence, NOT isTTSReadingRef — that flag is false when paused, so
    // navigating away while paused would otherwise silently drop the position.
    const currentIndex = ttsQueueIndexRef.current;
    const totalElements = ttsQueueRef.current.length;
    if (totalElements > 0 && currentIndex > 0) {
      // Use chapterIdRef (not chapter.id) so the save goes to the correct chapter's key
      // even when background auto-advance changed the chapter without remounting this component.
      const positionKey = getTTSPositionKey(chapterIdRef.current);
      setMMKVObject(positionKey, { position: currentIndex, total: totalElements });
      uiLog.debug('[WebViewReader] Saved TTS position on stop:', currentIndex, 'of', totalElements, 'for chapter', chapterIdRef.current);
    } else {
      uiLog.debug('[WebViewReader] NOT saving position - no active queue or at start (queueLength:', totalElements, 'currentIndex:', currentIndex, ')');
    }
    
    await ttsPlaybackManager.stop();
  };

  const speakText = async (text: string) => {
    const engine = readerSettingsRef.current.tts?.engine || 'expo' as TTSEngine;
    const integrationSettings = getMMKVObject<IntegrationSettings>(INTEGRATION_SETTINGS);
    
    // Build voice settings for PlaybackManager
    let voice = '';
    if (engine === 'microsoft') {
      voice = readerSettingsRef.current.tts?.microsoftVoice?.shortName || '';
      
      // Ensure Microsoft Speech is initialized if needed
      if (integrationSettings?.microsoftSpeech?.enabled) {
        if (!microsoftSpeechService.isReady()) {
          microsoftSpeechService.initialize({
            subscriptionKey: integrationSettings.microsoftSpeech.subscriptionKey!,
            region: integrationSettings.microsoftSpeech.region!,
            voice: voice,
          });
        }
      }
    } else {
      voice = readerSettingsRef.current.tts?.voice?.identifier || '';
    }

    const voiceSettings: VoiceSettings = {
      voice,
      pitch: readerSettingsRef.current.tts?.pitch || 1,
      rate: readerSettingsRef.current.tts?.rate || 1,
      engine,
    };

    // Use PlaybackManager to play single text element
    // For now, maintain compatibility with WebView queue - single element playback
    try {
      await ttsPlaybackManager.play(
        [text],
        0,
        chapter.id,
        novel?.id || 0,
        voiceSettings
      );
    } catch {
      // Playback error handled by event listeners
    }
  };
  const isRTL = plugin?.lang === 'Arabic' || plugin?.lang === 'Hebrew';
  const readerDir = isRTL ? 'rtl' : 'ltr';

  return (
    <WebView
      ref={webViewRef}
      style={{ backgroundColor: readerSettings.theme }}
      allowFileAccess={true}
      originWhitelist={['*']}
      scalesPageToFit={true}
      showsVerticalScrollIndicator={false}
      javaScriptEnabled={true}
      webviewDebuggingEnabled={__DEV__}
      androidLayerType="software"
      onLoadEnd={() => {
        // Update battery level when WebView finishes loading
        const currentBatteryLevel = getBatteryLevelSync();
        webViewRef.current?.injectJavaScript(
          `if (window.reader && window.reader.batteryLevel) {
            window.reader.batteryLevel.val = ${currentBatteryLevel};
          }`,
        );

        // Restore saved TTS position if available
        const positionKey = getTTSPositionKey(chapter.id);
        const savedPosition = getMMKVObject<{ position: number; total: number }>(positionKey);
        if (savedPosition && savedPosition.position > 0) {
          uiLog.debug('[WebViewReader] Restoring TTS position:', savedPosition.position, 'of', savedPosition.total);
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (window.tts) {
                window.tts.savedPosition = ${savedPosition.position};
                console.log("[WebView] TTS saved position set:", tts.savedPosition);
              }
            })();
          `);
        }

        // Background auto-start sync: page is now fully loaded so window.tts is stable
        // and getAllReadableElements will find all elements. Sync WebView TTS state so
        // highlight, button icon, and onclick handler are correct when user unlocks.
        if (isTTSReadingRef.current && ttsFullQueueInitializedRef.current) {
          const syncIdx = ttsQueueIndexRef.current;
          uiLog.debug('[WebViewReader] onLoadEnd TTS sync at index:', syncIdx);
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (!window.tts) return;
              // Rebuild allReadableElements from the fully-loaded DOM.
              tts.allReadableElements = tts.getAllReadableElements
                ? tts.getAllReadableElements(reader.chapterElement)
                : [];
              tts.totalElements = tts.allReadableElements.length;
              // Clear savedPosition — RN side is already playing; don't let a stale
              // MMKV position restart TTS via tts.start() if the user presses the button.
              tts.savedPosition = null;
              tts.started = true;
              tts.reading = true;
              var controller = document.getElementById('TTS-Controller');
              if (controller && controller.firstElementChild && window.ttsIcons) {
                controller.firstElementChild.innerHTML = window.ttsIcons.pauseIcon;
              }
              var idx = ${syncIdx};
              if (idx >= 0 && idx < tts.allReadableElements.length) {
                tts.allReadableElements.forEach(function(el) { el && el.classList && el.classList.remove('highlight'); });
                tts.elementsRead = idx + 1;
                tts.currentElement = tts.allReadableElements[idx];
                tts.prevElement = idx > 0 ? tts.allReadableElements[idx - 1] : null;
                if (tts.currentElement) {
                  tts.currentElement.classList.add('highlight');
                  tts.scrollToElement && tts.scrollToElement(tts.currentElement);
                }
              }
              console.log('[WebView TTS] onLoadEnd sync: element', idx, 'of', tts.totalElements);
            })();
          `);
        }

        if (autoStartTTSRef.current) {
          autoStartTTSRef.current = false;
          setTimeout(() => {
            webViewRef.current?.injectJavaScript(`
              (function() {
                if (window.tts && reader.generalSettings.val.TTSEnable) {
                  setTimeout(() => {
                    tts.start();
                    const controller = document.getElementById('TTS-Controller');
                    if (controller && controller.firstElementChild) {
                      controller.firstElementChild.innerHTML = pauseIcon;
                    }
                  }, 500);
                }
              })();
            `);
          }, 300);
        }
      }}
      onMessage={(ev: { nativeEvent: { data: string } }) => {
        __DEV__ && onLogMessage(ev);
        const event: WebViewPostEvent = JSON.parse(ev.nativeEvent.data);
        
        // Handle text extraction results (for TTS downloads)
        if (handleExtractionResult(event as any)) {
          return; // Message was an extraction result, handled
        }
        
        switch (event.type) {
          case 'tts-queue': {
            const payload = event.data as
              | { queue?: unknown; startIndex?: unknown; indexMap?: unknown }
              | undefined;
            const queue = Array.isArray(payload?.queue)
              ? payload?.queue.filter(
                (item): item is string =>
                  typeof item === 'string' && item.trim().length > 0,
              )
              : [];
            ttsQueueRef.current = queue;
            if (typeof payload?.startIndex === 'number') {
              ttsQueueIndexRef.current = payload.startIndex;
            } else {
              ttsQueueIndexRef.current = 0;
            }
            ttsElementIndexMapRef.current = Array.isArray(payload?.indexMap)
              ? (payload.indexMap as unknown[]).filter((x): x is number => typeof x === 'number')
              : [];
            
            uiLog.debug('[WebViewReader] tts-queue received with', queue.length, 'elements - will initialize PlaybackManager on first speak');
            break;
          }
          case 'hide':
            onPress();
            break;
          case 'next':
            nextChapterScreenVisible.current = true;
            if (event.autoStartTTS) {
              autoStartTTSRef.current = true;
            }
            navigateChapter('NEXT');
            break;
          case 'prev':
            if (event.autoStartTTS) {
              autoStartTTSRef.current = true;
            }
            navigateChapter('PREV');
            break;
          case 'save':
            if (event.data && typeof event.data === 'number') {
              saveProgress(event.data);
            }
            break;
          case 'speak':
            if (event.data && typeof event.data === 'string') {
              if (typeof event.index === 'number') {
                ttsQueueIndexRef.current = event.index;
              }
              
              // If this is the first speak event and WebView queue isn't initialized,
              // call tts.start() to build the queue
              if (!isTTSReadingRef.current && (!event.total || event.total === 0)) {
                webViewRef.current?.injectJavaScript(`
                  (function() {
                    if (window.tts && !tts.started) {
                      tts.start();
                    }
                  })();
                `);
                // Don't process this speak event - let tts.start() handle sending the first one
                return;
              }
              
              // If PlaybackManager already initialized with full queue, handle resume or ignore
              if (ttsFullQueueInitializedRef.current) {
                // If paused, resume playback
                if (ttsPlaybackManager.isPaused()) {
                  uiLog.debug('[WebViewReader] Full queue initialized and paused - resuming');
                  ttsPlaybackManager.resume();
                } else {
                  uiLog.debug('[WebViewReader] Ignoring speak event - full queue already initialized, playing via preloader');
                }
                // Just update notification
                updateTTSNotification({
                  novelName: novel?.name || 'Unknown',
                  chapterName: chapter.name,
                  coverUri: novel?.cover || '',
                  isPlaying: true,
                });
                if (
                  typeof event.index === 'number' &&
                  typeof event.total === 'number' &&
                  event.total > 0
                ) {
                  updateTTSProgress(event.index, event.total);
                }
                return;
              }
              
              if (!isTTSReadingRef.current) {
                isTTSReadingRef.current = true;
                showTTSNotification({
                  novelName: novel?.name || 'Unknown',
                  chapterName: chapter.name,
                  coverUri: novel?.cover || '',
                  isPlaying: true,
                });
              } else {
                updateTTSNotification({
                  novelName: novel?.name || 'Unknown',
                  chapterName: chapter.name,
                  coverUri: novel?.cover || '',
                  isPlaying: true,
                });
              }
              if (
                typeof event.index === 'number' &&
                typeof event.total === 'number' &&
                event.total > 0
              ) {
                updateTTSProgress(event.index, event.total);
              }
              
              // First speak event: initialize with full queue if available
              if (ttsQueueRef.current.length > 1) {
                uiLog.debug('[WebViewReader] First speak - initializing PlaybackManager with full queue of', ttsQueueRef.current.length, 'elements');
                const engine = readerSettingsRef.current.tts?.engine || 'expo' as TTSEngine;
                const integrationSettings = getMMKVObject<IntegrationSettings>(INTEGRATION_SETTINGS);
                
                let voice = '';
                if (engine === 'microsoft') {
                  voice = readerSettingsRef.current.tts?.microsoftVoice?.shortName || '';
                  if (integrationSettings?.microsoftSpeech?.enabled) {
                    if (!microsoftSpeechService.isReady()) {
                      microsoftSpeechService.initialize({
                        subscriptionKey: integrationSettings.microsoftSpeech.subscriptionKey!,
                        region: integrationSettings.microsoftSpeech.region!,
                        voice: voice,
                      });
                    }
                  }
                } else {
                  voice = readerSettingsRef.current.tts?.voice?.identifier || '';
                }

                const voiceSettings: VoiceSettings = {
                  voice,
                  pitch: readerSettingsRef.current.tts?.pitch || 1,
                  rate: readerSettingsRef.current.tts?.rate || 1,
                  engine,
                };
                
                // Initialize with FULL queue
                // Use textIndex (textQueue index) rather than index (allReadableElements index)
                const ttsStartIndex = typeof (event as Record<string, unknown>).textIndex === 'number'
                  ? (event as Record<string, unknown>).textIndex as number
                  : (event.index || 0);
                ttsPlaybackManager.play(ttsQueueRef.current, ttsStartIndex, chapter.id, novel?.id || 0, voiceSettings);
                ttsFullQueueInitializedRef.current = true;
              } else {
                // Fallback: single element
                speakText(event.data);
              }
            } else {
              webViewRef.current?.injectJavaScript('tts.next?.()');
            }
            break;
          case 'pause-speak':
            // WebView already paused itself, mirror that on the React Native side
            ttsPlaybackManager.pause();
            break;
          case 'stop-speak':
            // WebView already stopped itself, just clean up React Native side
            // DO NOT call stopTTS() as it will inject tts.stop() back to WebView
            ttsPlaybackManager.stop(true); // fromPlay=true to skip queueEnd emission
            if (!autoStartTTSRef.current) {
              isTTSReadingRef.current = false;
              ttsFullQueueInitializedRef.current = false; // Reset for next TTS session
              ttsQueueRef.current = [];
              ttsQueueIndexRef.current = 0;
              dismissTTSNotification();
            }
            break;
          case 'tts-state':
            if (event.data && typeof event.data === 'object') {
              const data = event.data as { isReading?: boolean };
              const isReading = data.isReading === true;
              isTTSReadingRef.current = isReading;
              updateTTSPlaybackState(isReading);
            }
            break;
          case 'save-tts-position':
            // Save TTS position to MMKV for resumption
            if (typeof event.position === 'number' && typeof event.total === 'number') {
              const positionKey = getTTSPositionKey(chapter.id);
              setMMKVObject(positionKey, { position: event.position, total: event.total });
              uiLog.debug('[WebViewReader] Saved TTS position:', event.position, 'of', event.total);
            }
            break;
          case 'clear-tts-position':
            // Clear saved TTS position (chapter completed)
            const clearKey = getTTSPositionKey(chapter.id);
            setMMKVObject(clearKey, null);
            uiLog.debug('[WebViewReader] Cleared TTS position for chapter', chapter.id);
            break;
          case 'seek-speak': {
            // Drag-seek: WebView already updated highlight — just scrub RN-side audio.
            // event.index = allReadableElements index (for position saving)
            // event.textIndex = textQueue index (for PM seek / elementOffsets lookup)
            if (typeof event.index === 'number') {
              ttsQueueIndexRef.current = event.index; // allReadableIdx — consistent with stopTTS save
            }
            const seekTextIdx = typeof event.textIndex === 'number' ? event.textIndex : event.index;
            if (typeof seekTextIdx === 'number') {
              ttsPlaybackManager.seekToElement(seekTextIdx); // textQueue idx for PM
            }
            break;
          }
        }
      }}
      source={{
        baseUrl: !chapter.isDownloaded ? plugin?.site : undefined,
        headers: plugin?.imageRequestInit?.headers,
        method: plugin?.imageRequestInit?.method,
        body: plugin?.imageRequestInit?.body,
        html: ` 
        <!DOCTYPE html>
          <html dir="${readerDir}">
            <head>
              <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/index.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/pageReader.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/toolWrapper.css">
              <link rel="stylesheet" href="${assetsUriPrefix}/css/tts.css">
              <style>
              :root {
                --StatusBar-currentHeight: ${StatusBar.currentHeight}px;
                --readerSettings-theme: ${readerSettings.theme};
                --readerSettings-padding: ${readerSettings.padding}px;
                --readerSettings-textSize: ${readerSettings.textSize}px;
                --readerSettings-textColor: ${readerSettings.textColor};
                --readerSettings-textAlign: ${readerSettings.textAlign};
                --readerSettings-lineHeight: ${readerSettings.lineHeight};
                --readerSettings-fontFamily: ${readerSettings.fontFamily};
                --theme-primary: ${theme.primary};
                --theme-onPrimary: ${theme.onPrimary};
                --theme-secondary: ${theme.secondary};
                --theme-tertiary: ${theme.tertiary};
                --theme-onTertiary: ${theme.onTertiary};
                --theme-onSecondary: ${theme.onSecondary};
                --theme-surface: ${theme.surface};
                --theme-surface-0-9: ${color(theme.surface)
            .alpha(0.9)
            .toString()};
                --theme-onSurface: ${theme.onSurface};
                --theme-surfaceVariant: ${theme.surfaceVariant};
                --theme-onSurfaceVariant: ${theme.onSurfaceVariant};
                --theme-outline: ${theme.outline};
                --theme-rippleColor: ${theme.rippleColor};
                }
                
                @font-face {
                  font-family: ${readerSettings.fontFamily};
                  src: url("file:///android_asset/fonts/${readerSettings.fontFamily
          }.ttf");
                }
                </style>
 
              <link rel="stylesheet" href="${pluginCustomCSS}">
              <style>${readerSettings.customCSS}</style>
            </head>
            <body class="${chapterGeneralSettings.pageReader ? 'page-reader' : ''
          }">
              <div class="transition-chapter" style="transform: ${nextChapterScreenVisible.current
            ? 'translateX(-100%)'
            : 'translateX(0%)'
          };
              ${chapterGeneralSettings.pageReader ? '' : 'display: none'}"
              ">${chapter.name}</div>
              <div id="LNReader-chapter">
                ${html}  
              </div>
              <div id="reader-ui"></div>
              </body>
              <script>
                var initialPageReaderConfig = ${JSON.stringify({
            nextChapterScreenVisible: nextChapterScreenVisible.current,
          })};
 
 
                var initialReaderConfig = ${JSON.stringify({
            readerSettings,
            chapterGeneralSettings,
            novel,
            chapter,
            nextChapter,
            prevChapter,
            batteryLevel,
            autoSaveInterval: 2222,
            DEBUG: __DEV__,
            strings: {
              finished: getString('readerScreen.finished') + ': ' + chapter.name.trim(),
              nextChapter: getString('readerScreen.nextChapter', {
                name: nextChapter?.name,
              }),
              noNextChapter: getString('readerScreen.noNextChapter'),
            },
          })}
              </script>
              <script src="${assetsUriPrefix}/js/polyfill-onscrollend.js"></script>
              <script src="${assetsUriPrefix}/js/icons.js"></script>
              <script src="${assetsUriPrefix}/js/van.js"></script>
              <script src="${assetsUriPrefix}/js/text-vibe.js"></script>
              <script src="${assetsUriPrefix}/js/core.js"></script>
              <script src="${assetsUriPrefix}/js/index.js"></script>
              <script src="${pluginCustomJS}"></script>
              <script>
                ${readerSettings.customJS}
              </script>
          </html>
          `,
      }}
    />
  );
};

export default memo(WebViewReader);
