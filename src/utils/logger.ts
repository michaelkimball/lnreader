import { logger as rnLogger, type transportFunctionType } from 'react-native-logs';

/**
 * Custom transport for React Native DevTools.
 *
 * Two constraints drive the design:
 *  1. String/primitive args must be joined into ONE string — DevTools renders
 *     each separate console argument on its own line, which produces the
 *     broken multi-line output seen previously.
 *  2. Object/array args must be passed as SEPARATE trailing args — DevTools
 *     renders them as interactive, collapsible sections only when they arrive
 *     as distinct arguments to console.log/warn/error.
 */
const singleLineTransport: transportFunctionType = ({ rawMsg, level, extension }) => {
  const args: unknown[] = Array.isArray(rawMsg) ? rawMsg : [rawMsg];

  // Split into primitives (join into one string) and objects (pass through).
  const primitives: string[] = [];
  const objects: object[] = [];
  for (const a of args) {
    if (a !== null && typeof a === 'object') {
      objects.push(a as object);
    } else {
      primitives.push(String(a));
    }
  }

  const ns = extension ?? 'LOG';
  const prefix = `${ns} | ${level.text.toUpperCase()} : ${primitives.join(' ')}`;
  const consoleArgs: unknown[] = objects.length ? [prefix, ...objects] : [prefix];

  switch (level.severity) {
    case 2:
      // eslint-disable-next-line no-console
      console.warn(...(consoleArgs as Parameters<typeof console.warn>));
      break;
    case 3:
      // eslint-disable-next-line no-console
      console.error(...(consoleArgs as Parameters<typeof console.error>));
      break;
    default:
      // eslint-disable-next-line no-console
      console.log(...(consoleArgs as Parameters<typeof console.log>));
  }
};

const config = {
  severity: __DEV__ ? 'debug' : 'warn',
  transport: singleLineTransport,
  async: false,
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
