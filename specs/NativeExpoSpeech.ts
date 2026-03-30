import { TurboModule, TurboModuleRegistry } from 'react-native';

export interface Voice {
  identifier: string;
  name: string;
  language: string;
  quality?: number;
}

export interface Spec extends TurboModule {
  /**
   * Synthesize text to an audio file
   * @param text - Text to synthesize
   * @param voiceId - Voice identifier (use 'system' for default)
   * @param pitch - Voice pitch (0.5 to 2.0, default 1.0)
   * @param rate - Speech rate (0.5 to 2.0, default 1.0)
   * @param outputPath - Full path where to save the audio file
   * @returns Promise<string> - URI of the generated audio file
   */
  synthesizeToFile(
    text: string,
    voiceId: string,
    pitch: number,
    rate: number,
    outputPath: string
  ): Promise<string>;
  
  /**
   * Get list of available TTS voices on the device
   * @returns Promise<Voice[]> - Array of available voices
   */
  getAvailableVoices(): Promise<Voice[]>;
  
  /**
   * Check if TTS engine is currently speaking
   * @returns boolean - True if speaking
   */
  isSpeaking(): boolean;
  
  /**
   * Stop any ongoing TTS synthesis
   */
  stop(): void;
  
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeExpoSpeech');
