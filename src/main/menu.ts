import { Menu, type MenuItemConstructorOptions } from 'electron';
import { basename } from 'node:path';
import type { Command, ModelId, Settings } from '../shared/api';

export interface MenuActions {
  send(cmd: Command): void;
  openDialog(): void;
  openRecent(path: string): void;
  clearRecent(): void;
  setModel(model: ModelId): void;
  setScale(scale: number): void;
  setFastLoad(enabled: boolean): void;
  setAccelerate(enabled: boolean): void;
}

export function buildMenu(s: Settings, a: MenuActions): Menu {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => a.openDialog() },
        {
          label: 'Open Recent',
          submenu: [
            ...s.recent.map((p) => ({ label: basename(p), toolTip: p, click: () => a.openRecent(p) })),
            ...(s.recent.length ? [{ type: 'separator' as const }] : []),
            { label: 'Clear Menu', enabled: s.recent.length > 0, click: () => a.clearRecent() },
          ],
        },
        { type: 'separator' },
        { label: 'Save Snapshot (.z80)…', accelerator: 'CmdOrCtrl+S', click: () => a.send({ type: 'save-snapshot', format: 'z80' }) },
        { label: 'Save Snapshot (.sna)…', accelerator: 'CmdOrCtrl+Shift+S', click: () => a.send({ type: 'save-snapshot', format: 'sna' }) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Machine',
      submenu: [
        { label: 'ZX Spectrum 48K', type: 'radio', checked: s.model === '48k', click: () => a.setModel('48k') },
        { label: 'ZX Spectrum 128K', type: 'radio', checked: s.model === '128k', click: () => a.setModel('128k') },
        { type: 'separator' },
        { label: 'Reset', accelerator: 'CmdOrCtrl+R', click: () => a.send({ type: 'reset' }) },
        { label: 'Pause', accelerator: 'CmdOrCtrl+P', click: () => a.send({ type: 'toggle-pause' }) },
      ],
    },
    {
      label: 'Tape',
      submenu: [
        { label: 'Play / Stop', accelerator: 'CmdOrCtrl+Shift+P', click: () => a.send({ type: 'tape-toggle' }) },
        { label: 'Rewind', click: () => a.send({ type: 'tape-rewind' }) },
        { label: 'Eject', click: () => a.send({ type: 'tape-eject' }) },
        { type: 'separator' },
        { label: 'Fast Load (ROM trap)', type: 'checkbox', checked: s.fastLoad, click: (i) => a.setFastLoad(i.checked) },
        { label: 'Accelerate Loading', type: 'checkbox', checked: s.accelerateLoading, click: (i) => a.setAccelerate(i.checked) },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...[1, 2, 3, 4].map((n) => ({
          label: `${n}×`, type: 'radio' as const, checked: s.scale === n, accelerator: `CmdOrCtrl+${n}`,
          click: () => a.setScale(n),
        })),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
