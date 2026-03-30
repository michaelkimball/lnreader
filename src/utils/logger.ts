import { logger as rnLogger, consoleTransport } from 'react-native-logs';

const config = {
  severity: __DEV__ ? 'debug' : 'warn',
  transport: consoleTransport,
  transportOptions: {
    colors: {
      debug: 'white',
      info: 'blueBright',
      warn: 'yellowBright',
      error: 'redBright',
    },
  },
  async: true,
  printLevel: false,
  printDate: false,
  enabled: true,
};

const logger = rnLogger.createLogger<'debug' | 'info' | 'warn' | 'error'>(config);

export const ttsLog = logger.extend('TTS');
export const downloadLog = logger.extend('Download');
export const dbLog = logger.extend('DB');
export const uiLog = logger.extend('UI');

export default logger;
