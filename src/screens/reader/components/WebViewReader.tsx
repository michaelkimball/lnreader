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
      /* eslint-disable no-console */
      console.info(`[Console] ${JSON.stringify(dataPayload.msg, null, 2)}`);
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

  // TTS position persistence helper
  const getTTSPositionKey = (chapterId: number) => `tts_position_${chapterId}`;

  useEffect(() => {
    readerSettingsRef.current = readerSettings;
  }, [readerSettings]);

  useEffect(() => {
    const playListener = ttsMediaEmitter.addListener('TTSPlay', () => {
      console.log('[WebViewReader] TTSPlay event received from bluetooth/notification');
      // Resume playback (expo-av true pause)
      ttsPlaybackManager.resume();
    });
    
    const pauseListener = ttsMediaEmitter.addListener('TTSPause', () => {
      console.log('[WebViewReader] TTSPause event received from bluetooth/notification');
      // Pause playback (expo-av true pause)
      ttsPlaybackManager.pause();
    });
    
    const stopListener = ttsMediaEmitter.addListener('TTSStop', () => {
      console.log('[WebViewReader] TTSStop event received (from notification dismiss or stop button)');
      // Use stopTTS() to properly clean up both RN and WebView
      stopTTS();
    });
    
    const rewindListener = ttsMediaEmitter.addListener('TTSRewind', () => {
      console.log('[WebViewReader] TTSRewind notification button pressed');
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
      console.log('[WebViewReader] TTSPrev notification button pressed');
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
      console.log('[WebViewReader] TTSNext notification button pressed');
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
      console.log('[WebViewReader] Component unmounting, stopping TTS');
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
      
      // Sync WebView UI when returning to foreground from background
      if (nextState === 'active' && (previousState === 'background' || previousState === 'inactive') && isTTSReadingRef.current) {
        const index = ttsQueueIndexRef.current;
        console.log('[WebViewReader] Returning to foreground - syncing UI at index:', index);
        
        webViewRef.current?.injectJavaScript(`
          (function() {
            if (window.tts && window.tts.allReadableElements) {
              const idx = ${index};
              if (idx >= 0 && idx < tts.allReadableElements.length) {
                // Remove all existing highlights
                tts.allReadableElements.forEach(el => el?.classList?.remove('highlight'));
                
                // Update TTS state
                tts.elementsRead = idx;
                tts.currentElement = tts.allReadableElements[idx];
                tts.prevElement = idx > 0 ? tts.allReadableElements[idx - 1] : null;
                tts.started = true;
                tts.reading = true;
                
                // Add highlight and scroll to current element
                if (tts.currentElement) {
                  tts.currentElement.classList.add('highlight');
                  tts.scrollToElement(tts.currentElement);
                }
                
                console.log('[WebView TTS] UI synced to element', idx, 'of', tts.totalElements);
              }
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
        isTTSReadingRef.current = isPlaying || isLoading;
        
        updateTTSPlaybackState(isPlaying);
        
        if (isPlaying || isLoading) {
          updateTTSNotification({
            novelName: novel?.name || 'Unknown',
            chapterName: chapter.name,
            coverUri: novel?.cover || '',
            isPlaying: isPlaying,
          });
        }
      }
    };

    const handleElementChange = (event: PlaybackEvent) => {
      if (event.type === 'elementChange' && event.index !== undefined) {
        // Update the queue index ref to track current position
        // This ensures UI sync works correctly when returning from background
        ttsQueueIndexRef.current = event.index;
        
        // 'elementChange' is emitted when NEW audio starts playing
        // WebView already advanced via handleQueueEnd ('queueEnd' → inject tts.next())
        // This event is just for UI updates - do NOT inject tts.next() here!
        console.log('[WebViewReader] Element changed to index:', event.index);
      }
    };

    const handleQueueEnd = (event: PlaybackEvent) => {
      console.log('##################################################');
      console.log('[WebViewReader] ⚠️ QUEUE END EVENT RECEIVED');
      console.log('##################################################');
      
      if (event.type === 'queueEnd') {
        if (event.reason === 'completed') {
          // Check if app is in background or screen is locked
          const isBackground = appStateRef.current === 'background' || appStateRef.current === 'inactive';
          
          console.log('[WebViewReader] handleQueueEnd - isBackground:', isBackground, 'appState:', appStateRef.current, 'queueLength:', ttsQueueRef.current.length);
          
          if (isBackground && ttsQueueRef.current.length > 0) {
            // Background playback: WebView doesn't execute in background
            const nextIndex = ttsQueueIndexRef.current + 1;
            console.log('[WebViewReader] Background mode - advancing from', ttsQueueIndexRef.current, 'to', nextIndex, 'of', ttsQueueRef.current.length);
            
            if (nextIndex < ttsQueueRef.current.length) {
              ttsQueueIndexRef.current = nextIndex;
              console.log('[WebViewReader] Using seek() to play preloaded audio at index', nextIndex);
              
              // Use seek() which plays from the existing preloaded queue without resetting it
              ttsPlaybackManager.seek(nextIndex);
              return;
            }
          }
          
          // Foreground: use WebView queue
          console.log('[WebViewReader] Injecting tts.next() into WebView');
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
    console.log('[WebViewReader] stopTTS called - isTTSReading:', isTTSReadingRef.current, 
                'queueLength:', ttsQueueRef.current.length, 
                'currentIndex:', ttsQueueIndexRef.current);
    
    // Save current TTS position from React Native state (not WebView, which might be destroyed)
    if (isTTSReadingRef.current && ttsQueueRef.current.length > 0) {
      const currentIndex = ttsQueueIndexRef.current;
      const totalElements = ttsQueueRef.current.length;
      const positionKey = getTTSPositionKey(chapter.id);
      setMMKVObject(positionKey, { position: currentIndex, total: totalElements });
      console.log('[WebViewReader] Saved TTS position on stop:', currentIndex, 'of', totalElements);
    } else {
      console.log('[WebViewReader] NOT saving position - conditions not met');
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
          console.log('[WebViewReader] Restoring TTS position:', savedPosition.position, 'of', savedPosition.total);
          webViewRef.current?.injectJavaScript(`
            (function() {
              if (window.tts) {
                window.tts.savedPosition = ${savedPosition.position};
                console.log("[WebView] TTS saved position set:", tts.savedPosition);
              }
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
        switch (event.type) {
          case 'tts-queue': {
            const payload = event.data as
              | { queue?: unknown; startIndex?: unknown }
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
            
            console.log('[WebViewReader] tts-queue received with', queue.length, 'elements - will initialize PlaybackManager on first speak');
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
              
              // If PlaybackManager already initialized with full queue, don't call play() again
              if (ttsFullQueueInitializedRef.current) {
                console.log('[WebViewReader] Ignoring speak event - full queue already initialized, playing via preloader');
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
                console.log('[WebViewReader] First speak - initializing PlaybackManager with full queue of', ttsQueueRef.current.length, 'elements');
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
                ttsPlaybackManager.play(ttsQueueRef.current, event.index || 0, chapter.id, novel?.id || 0, voiceSettings);
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
            // WebView already paused itself, just clean up React Native side
            ttsPlaybackManager.stop(true); // fromPlay=true to skip queueEnd emission
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
              console.log('[WebViewReader] Saved TTS position:', event.position, 'of', event.total);
            }
            break;
          case 'clear-tts-position':
            // Clear saved TTS position (chapter completed)
            const clearKey = getTTSPositionKey(chapter.id);
            setMMKVObject(clearKey, null);
            console.log('[WebViewReader] Cleared TTS position for chapter', chapter.id);
            break;
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
