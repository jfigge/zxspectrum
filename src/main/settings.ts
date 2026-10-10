import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/api';

const DEFAULTS: Settings = { model: '48k', fastLoad: true, accelerateLoading: true, scale: 2, recent: [] };
const MAX_RECENT = 10;

function path(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  writeFileSync(path(), JSON.stringify(s, null, 2));
}

export function addRecent(s: Settings, file: string): void {
  s.recent = [file, ...s.recent.filter((f) => f !== file)].slice(0, MAX_RECENT);
  app.addRecentDocument(file);
}
