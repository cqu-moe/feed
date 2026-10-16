import { appendFileSync, writeFileSync } from 'node:fs';
import { Log, LogLevel } from 'miniflare';

// Keep native platform exception detail outside public artifacts and console.
export function privatePlatformLog(file) {
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  return new class extends Log {
    log(message) {
      appendFileSync(file, message + '\n');
    }
  }(LogLevel.ERROR);
}
