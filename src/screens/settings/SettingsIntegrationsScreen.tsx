import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Portal, TextInput, Text } from 'react-native-paper';

import { Appbar, Button, List, SafeAreaView, Switch, Modal } from '@components';
import { useTheme, useIntegrationSettings } from '@hooks/persisted';
import { showToast } from '@utils/showToast';
import { getString } from '@strings/translations';

import { microsoftSpeechService } from '@services/tts/MicrosoftSpeechService';

interface IntegrationsSettingsScreenProps {
  navigation: any;
}

const SettingsIntegrationsScreen = ({ navigation }: IntegrationsSettingsScreenProps) => {
  const theme = useTheme();
  const { microsoftSpeech, azureBlobStorage, setIntegrationSettings } = useIntegrationSettings();

  // Microsoft Speech state
  const [subscriptionKey, setSubscriptionKey] = useState(microsoftSpeech?.subscriptionKey || '');
  const [region, setRegion] = useState(microsoftSpeech?.region || '');
  const [isEnabled, setIsEnabled] = useState(microsoftSpeech?.enabled || false);
  const [isValidating, setIsValidating] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  // Azure Blob Storage state
  const [blobAccountName, setBlobAccountName] = useState(azureBlobStorage?.accountName || '');
  const [blobAccountKey, setBlobAccountKey] = useState(azureBlobStorage?.accountKey || '');
  const [blobContainerName, setBlobContainerName] = useState(azureBlobStorage?.containerName || 'tts-inputs');
  const [isBlobEnabled, setIsBlobEnabled] = useState(azureBlobStorage?.enabled || false);
  const [showBlobHelpModal, setShowBlobHelpModal] = useState(false);

  const handleSave = () => {
    setIntegrationSettings({
      microsoftSpeech: {
        subscriptionKey,
        region,
        enabled: isEnabled,
      },
      azureBlobStorage: {
        accountName: blobAccountName,
        accountKey: blobAccountKey,
        containerName: blobContainerName,
        enabled: isBlobEnabled,
      },
    });
    showToast('Settings saved successfully');
  };

  const handleValidate = async () => {
    if (!subscriptionKey || !region) {
      showToast('Please enter both subscription key and region');
      return;
    }

    setIsValidating(true);
    try {
      const isValid = await microsoftSpeechService.validateCredentials(
        subscriptionKey,
        region,
      );

      if (isValid) {
        showToast('✓ Credentials are valid', 'success');
        // Auto-save on successful validation
        setIntegrationSettings({
          microsoftSpeech: {
            subscriptionKey,
            region,
            enabled: true,
          },
        });
        setIsEnabled(true);
      } else {
        showToast('✗ Invalid credentials', 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Validation failed';
      showToast(`✗ ${message}`, 'error');
    } finally {
      setIsValidating(false);
    }
  };

  const handleReset = () => {
    setSubscriptionKey('');
    setRegion('');
    setIsEnabled(false);
    setIntegrationSettings({
      microsoftSpeech: {
        subscriptionKey: '',
        region: '',
        enabled: false,
      },
    });
    showToast('Microsoft Speech settings reset');
  };

  return (
    <SafeAreaView excludeTop>
      <Appbar
        title="Integrations"
        handleGoBack={() => navigation.goBack()}
        theme={theme}
      />
      <ScrollView style={{ backgroundColor: theme.background }}>
        <List.Section>
          <List.SubHeader theme={theme}>Microsoft Cognitive Services Speech</List.SubHeader>
          <List.InfoItem
            title="About Microsoft Speech"
            description="Microsoft Azure Text-to-Speech provides high-quality neural voices with advanced customization. Requires an Azure subscription."
            theme={theme}
            icon="information-outline"
            onPress={() => setShowHelpModal(true)}
          />
          <List.Item
            title="Enable Microsoft Speech"
            description={isEnabled ? 'Active' : 'Disabled'}
            theme={theme}
            onPress={() => setIsEnabled(!isEnabled)}
            rightIcon={
              <Switch
                value={isEnabled}
                onValueChange={(value) => {
                  setIsEnabled(value);
                  if (!value) {
                    // Disable immediately without saving
                    setIntegrationSettings({
                      microsoftSpeech: {
                        subscriptionKey,
                        region,
                        enabled: false,
                      },
                    });
                  }
                }}
                theme={theme}
              />
            }
          />
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>Azure Configuration</List.SubHeader>
          <View style={styles.inputContainer}>
            <TextInput
              label="Subscription Key"
              value={subscriptionKey}
              onChangeText={setSubscriptionKey}
              mode="outlined"
              placeholder="Enter your Azure Speech subscription key"
              secureTextEntry
              style={styles.input}
              theme={{ colors: { primary: theme.primary } }}
              outlineColor={theme.textColorSecondary}
              textColor={theme.textColorPrimary}
            />
          </View>
          <View style={styles.inputContainer}>
            <TextInput
              label="Region"
              value={region}
              onChangeText={setRegion}
              mode="outlined"
              placeholder="e.g., eastus, westeurope"
              style={styles.input}
              theme={{ colors: { primary: theme.primary } }}
              outlineColor={theme.textColorSecondary}
              textColor={theme.textColorPrimary}
            />
          </View>
          <View style={styles.buttonRow}>
            <Button
              title={isValidating ? 'Validating...' : 'Validate Credentials'}
              onPress={handleValidate}
              mode="contained"
              style={styles.button}
              disabled={isValidating || !subscriptionKey || !region}
            />
            <Button
              title="Save"
              onPress={handleSave}
              mode="contained"
              style={styles.button}
            />
          </View>
          <View style={styles.buttonRow}>
            <Button
              title="Reset"
              onPress={handleReset}
              mode="outlined"
              style={styles.button}
            />
          </View>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>Azure Blob Storage (For Offline Downloads)</List.SubHeader>
          <List.InfoItem
            title="About Azure Blob Storage"
            description="Required for bulk TTS downloads using Azure Batch Synthesis API. Enables offline playback at 66% cost savings."
            theme={theme}
            icon="information-outline"
            onPress={() => setShowBlobHelpModal(true)}
          />
          <List.Item
            title="Enable Blob Storage"
            description={isBlobEnabled ? 'Active' : 'Disabled'}
            theme={theme}
            onPress={() => setIsBlobEnabled(!isBlobEnabled)}
            rightIcon={
              <Switch
                value={isBlobEnabled}
                onValueChange={(value) => {
                  setIsBlobEnabled(value);
                  if (!value) {
                    setIntegrationSettings({
                      microsoftSpeech: {
                        subscriptionKey,
                        region,
                        enabled: isEnabled,
                      },
                      azureBlobStorage: {
                        accountName: blobAccountName,
                        accountKey: blobAccountKey,
                        containerName: blobContainerName,
                        enabled: false,
                      },
                    });
                  }
                }}
                theme={theme}
              />
            }
          />
          <View style={styles.inputContainer}>
            <TextInput
              label="Storage Account Name"
              value={blobAccountName}
              onChangeText={setBlobAccountName}
              mode="outlined"
              placeholder="e.g., lnreadertts"
              style={styles.input}
              theme={{ colors: { primary: theme.primary } }}
              outlineColor={theme.textColorSecondary}
              textColor={theme.textColorPrimary}
            />
          </View>
          <View style={styles.inputContainer}>
            <TextInput
              label="Account Key"
              value={blobAccountKey}
              onChangeText={setBlobAccountKey}
              mode="outlined"
              placeholder="Enter your storage account key"
              secureTextEntry
              style={styles.input}
              theme={{ colors: { primary: theme.primary } }}
              outlineColor={theme.textColorSecondary}
              textColor={theme.textColorPrimary}
            />
          </View>
          <View style={styles.inputContainer}>
            <TextInput
              label="Container Name"
              value={blobContainerName}
              onChangeText={setBlobContainerName}
              mode="outlined"
              placeholder="tts-inputs"
              style={styles.input}
              theme={{ colors: { primary: theme.primary } }}
              outlineColor={theme.textColorSecondary}
              textColor={theme.textColorPrimary}
            />
          </View>
        </List.Section>

        <List.Section>
          <List.SubHeader theme={theme}>Usage Notes</List.SubHeader>
          <List.InfoItem
            title="Network Required"
            description="Microsoft Speech requires an active internet connection for synthesis."
            theme={theme}
            icon="wifi"
          />
          <List.InfoItem
            title="Billing"
            description="Azure Speech services may incur costs. Check your Azure portal for pricing details."
            theme={theme}
            icon="currency-usd"
          />
        </List.Section>
      </ScrollView>

      <Portal>
        <Modal
          visible={showHelpModal}
          onDismiss={() => setShowHelpModal(false)}
          contentContainerStyle={{
            backgroundColor: theme.background,
            margin: 20,
            padding: 20,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: theme.textColorPrimary, fontSize: 18, fontWeight: 'bold', marginBottom: 12 }}>
            Getting Started with Microsoft Speech
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            1. Create an Azure account at portal.azure.com
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            2. Create a Speech resource in your Azure portal
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            3. Copy the subscription key from "Keys and Endpoint" section
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            4. Note your region (e.g., eastus, westeurope)
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 16 }}>
            5. Enter the credentials above and click "Validate"
          </Text>
          <Button title="Got it" onPress={() => setShowHelpModal(false)} mode="contained" />
        </Modal>
        <Modal
          visible={showBlobHelpModal}
          onDismiss={() => setShowBlobHelpModal(false)}
          contentContainerStyle={{
            backgroundColor: theme.background,
            margin: 20,
            padding: 20,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: theme.textColorPrimary, fontSize: 18, fontWeight: 'bold', marginBottom: 12 }}>
            Setting Up Azure Blob Storage
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            1. Create a Storage Account in your Azure portal
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            2. Create a blob container (e.g., "tts-inputs")
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            3. Set container public access to "Blob" or use SAS tokens
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 8 }}>
            4. Copy account name and key from "Access keys" section
          </Text>
          <Text style={{ color: theme.textColorPrimary, marginBottom: 16 }}>
            5. Enter credentials above and save
          </Text>
          <Text style={{ color: theme.textColorSecondary, fontSize: 12, marginBottom: 16 }}>
            Note: Blob Storage is only needed for bulk downloads. Real-time TTS works without it.
          </Text>
          <Button title="Got it" onPress={() => setShowBlobHelpModal(false)} mode="contained" />
        </Modal>
      </Portal>
    </SafeAreaView>
  );
};

export default SettingsIntegrationsScreen;

const styles = StyleSheet.create({
  inputContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  input: {
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 12,
  },
  button: {
    flex: 1,
  },
});
