export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

const writeLog = (
  level: LogLevel,
  component: string,
  message: string,
  fields?: LogFields,
): void => {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(fields ?? {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
};

export interface Logger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}

export const createLogger = (component: string): Logger => ({
  debug: (message, fields) => writeLog("debug", component, message, fields),
  info: (message, fields) => writeLog("info", component, message, fields),
  warn: (message, fields) => writeLog("warn", component, message, fields),
  error: (message, fields) => writeLog("error", component, message, fields),
});
