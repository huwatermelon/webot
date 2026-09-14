const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info") {
  const threshold = levels[level] || levels.info;
  const logger = {};

  for (const [name, weight] of Object.entries(levels)) {
    logger[name] = (message, fields = {}) => {
      if (weight < threshold) return;
      const line = {
        at: new Date().toISOString(),
        level: name,
        message,
        ...fields,
      };
      const output = `${JSON.stringify(line)}\n`;
      (weight >= levels.error ? process.stderr : process.stdout).write(output);
    };
  }
  return logger;
}
