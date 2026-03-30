import { TurboModule, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  startService(
    title: string,
    subtitle: string,
    coverUri: string,
    isPlaying: boolean
  ): void;
  
  stopService(): void;
  
  updateMetadata(
    title: string,
    subtitle: string,
    coverUri: string
  ): void;
  
  updatePlaybackState(isPlaying: boolean): void;
  
  isServiceRunning(): boolean;
  
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeTTSForegroundService');
