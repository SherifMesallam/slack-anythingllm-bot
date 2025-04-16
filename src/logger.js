import pino from 'pino';
import { logLevel } from './config.js'; // Assuming logLevel is exported from config

// Determine the log level, default to 'info' if not set or invalid
const level = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)
  ? logLevel
  : 'info';

console.log(`[Logger] Initializing logger with level: ${level}`);

const logger = pino({
  level: level,
  transport: {
    target: 'pino-pretty', // Make logs human-readable
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l', // Consistent timestamp format
      ignore: 'pid,hostname', // Exclude less relevant fields
      messageFormat: '{msg} {context}', // Include context directly if provided
      errorLikeObjectKeys: ['err', 'error'], // Better error serialization
    }
  },
  // Base context can be added here if needed
  // base: { pid: undefined, hostname: undefined, name: 'SlackAnythingLLMBot' }
});

export default logger; 