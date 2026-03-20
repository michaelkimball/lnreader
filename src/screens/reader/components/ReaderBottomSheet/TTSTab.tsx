import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { View, StyleSheet, Text, ScrollView, TouchableOpacity } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import Slider from '@react-native-community/slider';
import { getAvailableVoicesAsync, Voice } from 'expo-speech';
import { getLocales } from 'expo-localization';
import {
  useTheme,
  useChapterGeneralSettings,
  useChapterReaderSettings,
  useIntegrationSettings,
  TTSEngine,
  MicrosoftSpeechVoice,
} from '@hooks/persisted';
import { getString } from '@strings/translations';
import { List, Button } from '@components/index';
import { Portal, Modal, Chip } from 'react-native-paper';
import ReaderSheetPreferenceItem from './ReaderSheetPreferenceItem';
import { microsoftSpeechService } from '@services/tts/MicrosoftSpeechService';

interface VoicePickerModalProps {
  visible: boolean;
  onDismiss: () => void;
  voices: Voice[];
  onSelect: (voice: Voice) => void;
  currentVoice?: Voice;
}

const VoicePickerModal: React.FC<VoicePickerModalProps> = ({
  visible,
  onDismiss,
  voices,
  onSelect,
  currentVoice
}) => {
  const theme = useTheme();
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  // Get system language safely using getLocales()
  const systemLocale = getLocales()[0]?.languageCode || 'en';

  // Get unique languages from voices
  const availableLanguages = useMemo(() => {
    const languages = new Set<string>();
    voices.forEach(voice => {
      if (voice.language) {
        const lang = voice.language.split('-')[0];
        languages.add(lang);
      }
    });
    return Array.from(languages).sort((a, b) => {
      // System language first
      if (a === systemLocale) return -1;
      if (b === systemLocale) return 1;
      return a.localeCompare(b);
    });
  }, [voices, systemLocale]);

  // Filter voices by selected languages
  const filteredVoices = useMemo(() => {
    if (selectedLanguages.length === 0) {
      // Show system language voices by default
      return voices.filter(voice => {
        if (voice.name === 'System') return true;
        const lang = voice.language?.split('-')[0];
        return lang === systemLocale;
      });
    }

    return voices.filter(voice => {
      if (voice.name === 'System') return true;
      const lang = voice.language?.split('-')[0];
      return lang && selectedLanguages.includes(lang);
    });
  }, [voices, selectedLanguages, systemLocale]);

  const toggleLanguage = (lang: string) => {
    setSelectedLanguages(prev => {
      if (prev.includes(lang)) {
        return prev.filter(l => l !== lang);
      } else {
        return [...prev, lang];
      }
    });
  };

  useEffect(() => {
    // Reset to system language when modal opens
    if (visible) {
      setSelectedLanguages([]);
    }
  }, [visible]);

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.modalContent,
          { backgroundColor: theme.surface }
        ]}
      >
        <Text style={[styles.modalTitle, { color: theme.onSurface }]}>
          Select Voice
        </Text>

        {/* Language Filter */}
        <View style={styles.languageFilterContainer}>
          <Text style={[styles.filterLabel, { color: theme.onSurfaceVariant }]}>
            Filter by language:
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.languageChipsScroll}
          >
            {availableLanguages.map(lang => {
              const isSelected = selectedLanguages.includes(lang);
              const isSystemLang = lang === systemLocale;
              const showingSystemOnly = selectedLanguages.length === 0;
              const isActive = isSelected || (showingSystemOnly && isSystemLang);

              return (
                <Chip
                  key={lang}
                  selected={isActive}
                  onPress={() => toggleLanguage(lang)}
                  style={[
                    styles.languageChip,
                    isActive && { backgroundColor: theme.primary }
                  ]}
                  textStyle={[
                    styles.languageChipText,
                    { color: isActive ? theme.onPrimary : theme.onSurface }
                  ]}
                >
                  {lang.toUpperCase()}
                  {isSystemLang && ' (System)'}
                </Chip>
              );
            })}
          </ScrollView>
        </View>

        {/* Voice List */}
        <ScrollView style={styles.voiceList}>
          {filteredVoices.length === 0 ? (
            <Text style={[styles.noVoicesText, { color: theme.onSurfaceVariant }]}>
              No voices available for selected languages
            </Text>
          ) : (
            filteredVoices.map((voice: Voice, index: number) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.voiceItem,
                  currentVoice?.identifier === voice.identifier && {
                    backgroundColor: theme.surfaceVariant,
                  }
                ]}
                onPress={() => {
                  onSelect(voice);
                  onDismiss();
                }}
              >
                <View style={styles.voiceItemContent}>
                  <Text style={[styles.voiceItemText, { color: theme.onSurface }]}>
                    {voice.name}
                  </Text>
                  {voice.language && (
                    <Text style={[styles.voiceItemLanguage, { color: theme.onSurfaceVariant }]}>
                      {voice.language}
                    </Text>
                  )}
                </View>
                {currentVoice?.identifier === voice.identifier && (
                  <Text style={[styles.checkIcon, { color: theme.primary }]}>✓</Text>
                )}
              </TouchableOpacity>
            ))
          )}
        </ScrollView>

        <Button
          title="Cancel"
          mode="outlined"
          onPress={onDismiss}
          style={styles.cancelButton}
        />
      </Modal>
    </Portal>
  );
};

interface MicrosoftVoicePickerModalProps {
  visible: boolean;
  onDismiss: () => void;
  voices: MicrosoftSpeechVoice[];
  onSelect: (voice: MicrosoftSpeechVoice) => void;
  currentVoice?: MicrosoftSpeechVoice;
}

const MicrosoftVoicePickerModal: React.FC<MicrosoftVoicePickerModalProps> = ({
  visible,
  onDismiss,
  voices,
  onSelect,
  currentVoice
}) => {
  const theme = useTheme();
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);
  const systemLocale = getLocales()[0]?.languageCode || 'en';

  const availableLanguages = useMemo(() => {
    const languages = new Set<string>();
    voices.forEach(voice => {
      if (voice.locale) {
        const lang = voice.locale.split('-')[0];
        languages.add(lang);
      }
    });
    return Array.from(languages).sort((a, b) => {
      if (a === systemLocale) return -1;
      if (b === systemLocale) return 1;
      return a.localeCompare(b);
    });
  }, [voices, systemLocale]);

  const filteredVoices = useMemo(() => {
    if (selectedLanguages.length === 0) {
      return voices.filter(voice => {
        const lang = voice.locale?.split('-')[0];
        return lang === systemLocale;
      });
    }

    return voices.filter(voice => {
      const lang = voice.locale?.split('-')[0];
      return lang && selectedLanguages.includes(lang);
    });
  }, [voices, selectedLanguages, systemLocale]);

  const toggleLanguage = (lang: string) => {
    setSelectedLanguages(prev => {
      if (prev.includes(lang)) {
        return prev.filter(l => l !== lang);
      } else {
        return [...prev, lang];
      }
    });
  };

  useEffect(() => {
    if (visible) {
      setSelectedLanguages([]);
    }
  }, [visible]);

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={[
          styles.modalContent,
          { backgroundColor: theme.surface }
        ]}
      >
        <Text style={[styles.modalTitle, { color: theme.onSurface }]}>
          Select Microsoft Voice
        </Text>

        <View style={styles.languageFilterContainer}>
          <Text style={[styles.filterLabel, { color: theme.onSurfaceVariant }]}>
            Filter by language:
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.languageChipsScroll}
          >
            {availableLanguages.map(lang => {
              const isSelected = selectedLanguages.includes(lang);
              const isSystemLang = lang === systemLocale;
              const showingSystemOnly = selectedLanguages.length === 0;
              const isActive = isSelected || (showingSystemOnly && isSystemLang);

              return (
                <Chip
                  key={lang}
                  selected={isActive}
                  onPress={() => toggleLanguage(lang)}
                  style={[
                    styles.languageChip,
                    isActive && { backgroundColor: theme.primary }
                  ]}
                  textStyle={[
                    styles.languageChipText,
                    { color: isActive ? theme.onPrimary : theme.onSurface }
                  ]}
                >
                  {lang.toUpperCase()}
                  {isSystemLang && ' (System)'}
                </Chip>
              );
            })}
          </ScrollView>
        </View>

        <ScrollView style={styles.voiceList}>
          {filteredVoices.length === 0 ? (
            <Text style={[styles.noVoicesText, { color: theme.onSurfaceVariant }]}>
              No voices available for selected languages
            </Text>
          ) : (
            filteredVoices.map((voice, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.voiceItem,
                  currentVoice?.shortName === voice.shortName && {
                    backgroundColor: theme.surfaceVariant,
                  }
                ]}
                onPress={() => {
                  onSelect(voice);
                  onDismiss();
                }}
              >
                <View style={styles.voiceItemContent}>
                  <Text style={[styles.voiceItemText, { color: theme.onSurface }]}>
                    {voice.displayName}
                  </Text>
                  {voice.locale && (
                    <Text style={[styles.voiceItemLanguage, { color: theme.onSurfaceVariant }]}>
                      {voice.locale}
                    </Text>
                  )}
                </View>
                {currentVoice?.shortName === voice.shortName && (
                  <Text style={[styles.checkIcon, { color: theme.primary }]}>✓</Text>
                )}
              </TouchableOpacity>
            ))
          )}
        </ScrollView>

        <Button
          title="Cancel"
          mode="outlined"
          onPress={onDismiss}
          style={styles.cancelButton}
        />
      </Modal>
    </Portal>
  );
};

const TTSTab: React.FC = () => {
  const theme = useTheme();
  const {
    TTSEnable = true,
    setChapterGeneralSettings,
  } = useChapterGeneralSettings();

  const { tts, setChapterReaderSettings } = useChapterReaderSettings();
  const { microsoftSpeech } = useIntegrationSettings();
  
  const [voices, setVoices] = useState<Voice[]>([]);
  const [msVoices, setMsVoices] = useState<MicrosoftSpeechVoice[]>([]);
  const [voiceModalVisible, setVoiceModalVisible] = useState(false);
  const [msVoiceModalVisible, setMsVoiceModalVisible] = useState(false);
  const [loadingMsVoices, setLoadingMsVoices] = useState(false);

  const selectedEngine: TTSEngine = tts?.engine || 'expo';
  const isMicrosoftEnabled = microsoftSpeech?.enabled && microsoftSpeech.subscriptionKey && microsoftSpeech.region;

  // Load Expo voices
  useEffect(() => {
    getAvailableVoicesAsync().then(res => {
      res.sort((a, b) => a.name.localeCompare(b.name));
      setVoices([{ name: 'System', language: 'System' } as Voice, ...res]);
    });
  }, []);

  // Initialize and load Microsoft voices when enabled
  useEffect(() => {
    if (isMicrosoftEnabled && selectedEngine === 'microsoft') {
      const initMicrosoft = async () => {
        const initialized = microsoftSpeechService.initialize({
          subscriptionKey: microsoftSpeech!.subscriptionKey!,
          region: microsoftSpeech!.region!,
          voice: tts?.microsoftVoice?.shortName,
        });

        if (initialized) {
          setLoadingMsVoices(true);
          try {
            const voices = await microsoftSpeechService.getVoices();
            setMsVoices(voices);
          } catch (error) {
            console.error('[TTSTab] Failed to load Microsoft voices:', error);
          } finally {
            setLoadingMsVoices(false);
          }
        }
      };

      initMicrosoft();
    }
  }, [isMicrosoftEnabled, selectedEngine, microsoftSpeech, tts?.microsoftVoice?.shortName]);

  const handleVoiceSelect = useCallback((voice: Voice) => {
    setChapterReaderSettings({ tts: { ...tts, voice } });
  }, [tts, setChapterReaderSettings]);

  const handleMsVoiceSelect = useCallback((voice: MicrosoftSpeechVoice) => {
    setChapterReaderSettings({ tts: { ...tts, microsoftVoice: voice } });
  }, [tts, setChapterReaderSettings]);

  const handleEngineChange = useCallback((engine: TTSEngine) => {
    setChapterReaderSettings({ tts: { ...tts, engine } });
  }, [tts, setChapterReaderSettings]);

  return (
    <>
      <BottomSheetScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.contentContainer}
      >
        <View style={styles.section}>
          <List.SubHeader theme={theme}>Text to Speech</List.SubHeader>

          <ReaderSheetPreferenceItem
            label="Enable TTS"
            value={TTSEnable}
            onPress={() =>
              setChapterGeneralSettings({ TTSEnable: !TTSEnable })
            }
            theme={theme}
          />

          {TTSEnable && (
            <>
              {/* TTS Engine Selector */}
              <TouchableOpacity
                style={styles.settingItem}
                onPress={() => {
                  const newEngine: TTSEngine = selectedEngine === 'expo' ? 'microsoft' : 'expo';
                  if (newEngine === 'microsoft' && !isMicrosoftEnabled) {
                    // Can't switch to Microsoft if not configured
                    return;
                  }
                  handleEngineChange(newEngine);
                }}
              >
                <Text style={[styles.label, { color: theme.onSurface }]}>
                  TTS Engine
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[styles.value, { color: theme.onSurfaceVariant }]}>
                    {selectedEngine === 'expo' ? 'Expo Speech' : 'Microsoft Speech'}
                  </Text>
                  {!isMicrosoftEnabled && (
                    <Text style={[styles.value, { color: theme.error, fontSize: 12 }]}>
                      (MS not configured)
                    </Text>
                  )}
                </View>
              </TouchableOpacity>

              {/* Voice Selector - conditional based on engine */}
              {selectedEngine === 'expo' ? (
                <TouchableOpacity
                  style={styles.settingItem}
                  onPress={() => setVoiceModalVisible(true)}
                >
                  <Text style={[styles.label, { color: theme.onSurface }]}>
                    Voice
                  </Text>
                  <Text style={[styles.value, { color: theme.onSurfaceVariant }]}>
                    {tts?.voice?.name || 'System'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.settingItem}
                  onPress={() => setMsVoiceModalVisible(true)}
                  disabled={!isMicrosoftEnabled || loadingMsVoices}
                >
                  <Text style={[
                    styles.label,
                    { color: (!isMicrosoftEnabled || loadingMsVoices) ? theme.onSurfaceVariant : theme.onSurface }
                  ]}>
                    Microsoft Voice
                  </Text>
                  <Text style={[styles.value, { color: theme.onSurfaceVariant }]}>
                    {loadingMsVoices ? 'Loading...' : (tts?.microsoftVoice?.displayName || 'Select voice')}
                  </Text>
                </TouchableOpacity>
              )}

              <View style={styles.sliderSection}>
                <Text style={[styles.sliderLabel, { color: theme.onSurface }]}>
                  Speed: {tts?.rate?.toFixed(1) || '1.0'}x
                </Text>
                <Slider
                  style={styles.slider}
                  value={tts?.rate || 1}
                  minimumValue={0.1}
                  maximumValue={5}
                  step={0.1}
                  minimumTrackTintColor={theme.primary}
                  maximumTrackTintColor={theme.surfaceVariant}
                  thumbTintColor={theme.primary}
                  onValueChange={value =>
                    setChapterReaderSettings({ tts: { ...tts, rate: value } })
                  }
                />
              </View>

              <View style={styles.sliderSection}>
                <Text style={[styles.sliderLabel, { color: theme.onSurface }]}>
                  Pitch: {tts?.pitch?.toFixed(1) || '1.0'}
                </Text>
                <Slider
                  style={styles.slider}
                  value={tts?.pitch || 1}
                  minimumValue={0.1}
                  maximumValue={5}
                  step={0.1}
                  minimumTrackTintColor={theme.primary}
                  maximumTrackTintColor={theme.surfaceVariant}
                  thumbTintColor={theme.primary}
                  onValueChange={value =>
                    setChapterReaderSettings({ tts: { ...tts, pitch: value } })
                  }
                />
              </View>

              <ReaderSheetPreferenceItem
                label="Auto Page Advance"
                value={tts?.autoPageAdvance === true}
                onPress={() =>
                  setChapterReaderSettings({
                    tts: { ...tts, autoPageAdvance: !(tts?.autoPageAdvance === true) },
                  })
                }
                theme={theme}
              />

              <ReaderSheetPreferenceItem
                label="Scroll to Top"
                value={tts?.scrollToTop !== false}
                onPress={() =>
                  setChapterReaderSettings({
                    tts: { ...tts, scrollToTop: !(tts?.scrollToTop !== false) },
                  })
                }
                theme={theme}
              />

              <View style={styles.resetButtonContainer}>
                <Button
                  title={getString('common.reset')}
                  mode="outlined"
                  onPress={() => {
                    setChapterReaderSettings({
                      tts: {
                        engine: 'expo',
                        pitch: 1,
                        rate: 1,
                        voice: { name: 'System', language: 'System' } as Voice,
                        autoPageAdvance: false,
                        scrollToTop: true,
                      },
                    });
                  }}
                  style={styles.resetButton}
                />
              </View>
            </>
          )}
        </View>

        <View style={styles.bottomSpacing} />
      </BottomSheetScrollView>

      <VoicePickerModal
        visible={voiceModalVisible}
        onDismiss={() => setVoiceModalVisible(false)}
        voices={voices}
        onSelect={handleVoiceSelect}
        currentVoice={tts?.voice}
      />

      <MicrosoftVoicePickerModal
        visible={msVoiceModalVisible}
        onDismiss={() => setMsVoiceModalVisible(false)}
        voices={msVoices}
        onSelect={handleMsVoiceSelect}
        currentVoice={tts?.microsoftVoice}
      />
    </>
  );
};

export default React.memo(TTSTab);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 24,
  },
  section: {
    marginVertical: 8,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  label: {
    fontSize: 16,
  },
  value: {
    fontSize: 14,
  },
  sliderSection: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginVertical: 4,
  },
  sliderLabel: {
    fontSize: 16,
    marginBottom: 12,
  },
  slider: {
    height: 50,
    width: '100%',
  },
  resetButtonContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  resetButton: {
    alignSelf: 'flex-start',
  },
  bottomSpacing: {
    height: 24,
  },
  modalContent: {
    margin: 20,
    borderRadius: 8,
    padding: 20,
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  languageFilterContainer: {
    marginBottom: 16,
  },
  filterLabel: {
    fontSize: 12,
    marginBottom: 8,
  },
  languageChipsScroll: {
    flexGrow: 0,
  },
  languageChip: {
    marginEnd: 8,
    marginBottom: 8,
  },
  voiceList: {
    maxHeight: 350,
    marginTop: 8,
  },
  voiceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 4,
    marginBottom: 4,
  },
  voiceItemContent: {
    flex: 1,
  },
  voiceItemText: {
    fontSize: 16,
    marginBottom: 4,
  },
  voiceItemLanguage: {
    fontSize: 12,
  },
  noVoicesText: {
    textAlign: 'center',
    padding: 20,
    fontSize: 14,
  },
  cancelButton: {
    marginTop: 16,
  },
  languageChipText: {
    fontSize: 12,
  },
  checkIcon: {
    fontSize: 16,
  },
});
