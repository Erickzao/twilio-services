type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const levelColors: Record<LogLevel, string> = {
  log: colors.green,
  error: colors.red,
  warn: colors.yellow,
  debug: colors.magenta,
  verbose: colors.cyan,
};

const levelLabels: Record<LogLevel, string> = {
  log: 'LOG',
  error: 'ERROR',
  warn: 'WARN',
  debug: 'DEBUG',
  verbose: 'VERBOSE',
};

function getTimestamp(): string {
  const now = new Date();
  return now.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatMessage(level: LogLevel, message: string, context?: string): string {
  const timestamp = getTimestamp();
  const color = levelColors[level];
  const label = levelLabels[level];
  const pid = process.pid;

  const contextStr = context ? `${colors.yellow}[${context}]${colors.reset} ` : '';

  return (
    `${color}[Infra]${colors.reset} ` +
    `${colors.dim}${pid}${colors.reset}  - ` +
    `${timestamp}     ` +
    `${color}${label.padEnd(7)}${colors.reset} ` +
    `${contextStr}` +
    `${color}${message}${colors.reset}`
  );
}

class Logger {
  constructor(private context?: string) {}

  log(message: string, context?: string) {
    console.log(formatMessage('log', message, context ?? this.context));
  }

  error(message: string, trace?: string, context?: string) {
    console.error(formatMessage('error', message, context ?? this.context));
    if (trace) {
      console.error(`${colors.red}${trace}${colors.reset}`);
    }
  }

  warn(message: string, context?: string) {
    console.warn(formatMessage('warn', message, context ?? this.context));
  }

  debug(message: string, context?: string) {
    console.log(formatMessage('debug', message, context ?? this.context));
  }

  verbose(message: string, context?: string) {
    console.log(formatMessage('verbose', message, context ?? this.context));
  }
}

export const logger = new Logger();

export function createLogger(context: string): Logger {
  return new Logger(context);
}
