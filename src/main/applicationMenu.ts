import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';

export type AppMenuActionId =
  | 'open-settings'
  | 'open-files'
  | 'start-conversion'
  | 'cancel-conversion'
  | 'show-logs'
  | 'open-credits'
  | 'show-in-folder';

export interface ConversionMenuState {
  converting: boolean;
  hasOutput: boolean;
}

export interface ApplicationMenuDeps {
  getMainWindow: () => BrowserWindow | null;
  sendMenuAction: (action: AppMenuActionId, payload?: { paths?: string[] }) => void;
  pickVideoFiles: () => Promise<string[]>;
  checkForUpdates: () => void;
  installDownloadedUpdate: () => Promise<void>;
  isUpdateReadyToInstall: () => boolean;
  isUpdateDisabled: () => boolean;
  getConversionMenuState: () => ConversionMenuState;
}

export interface ApplicationMenuController {
  refresh: () => void;
}

const APP_NAME = 'CONV2';

const HELP_URL = 'https://help.rosie.run/conv2/en-us/faq';
const SUPPORT_URL = 'https://rosie.run/support';

const buildTemplate = (deps: ApplicationMenuDeps): MenuItemConstructorOptions[] => {
  const isMac = process.platform === 'darwin';
  const conversionState = deps.getConversionMenuState();
  const updatesDisabled = deps.isUpdateDisabled();
  const installReady = !updatesDisabled && deps.isUpdateReadyToInstall();

  const appMenu: MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      {
        label: 'Check for Updates…',
        enabled: !updatesDisabled,
        click: () => deps.checkForUpdates(),
      },
      {
        id: 'install-update',
        label: 'Install Update…',
        enabled: installReady,
        click: () => {
          void deps.installDownloadedUpdate().catch(() => undefined);
        },
      },
      { type: 'separator' },
      {
        label: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        click: () => deps.sendMenuAction('open-settings'),
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        click: () => {
          void deps.pickVideoFiles().then((paths) => {
            if (paths.length > 0) {
              deps.sendMenuAction('open-files', { paths });
            }
          });
        },
      },
      {
        id: 'show-in-folder',
        label: isMac ? 'Show Output in Finder' : 'Show Output in Folder',
        enabled: conversionState.hasOutput,
        click: () => deps.sendMenuAction('show-in-folder'),
      },
      { type: 'separator' },
      ...(isMac
        ? [
            { role: 'recentDocuments' as const },
            { role: 'clearRecentDocuments' as const },
            { type: 'separator' as const },
            { role: 'close' as const },
          ]
        : [
            {
              label: `Exit ${APP_NAME}`,
              accelerator: 'Alt+F4',
              click: () => app.quit(),
            },
          ]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [
            { role: 'pasteAndMatchStyle' as const },
            { role: 'delete' as const },
            { role: 'selectAll' as const },
            { type: 'separator' as const },
            {
              label: 'Speech',
              submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }],
            },
          ]
        : [{ role: 'delete' as const }, { role: 'selectAll' as const }]),
    ],
  };

  const convertMenu: MenuItemConstructorOptions = {
    label: 'Convert',
    submenu: [
      {
        label: 'Start Conversion',
        accelerator: 'Enter',
        click: () => deps.sendMenuAction('start-conversion'),
      },
      {
        id: 'cancel-conversion',
        label: 'Cancel Conversion',
        enabled: conversionState.converting,
        click: () => deps.sendMenuAction('cancel-conversion'),
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Show Debug Logs',
        click: () => deps.sendMenuAction('show-logs'),
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? [{ type: 'separator' as const }, { role: 'front' as const }]
        : [{ role: 'close' as const }]),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: `${APP_NAME} Help`,
        click: () => {
          void shell.openExternal(HELP_URL);
        },
      },
      {
        label: 'Support',
        click: () => {
          void shell.openExternal(SUPPORT_URL);
        },
      },
      { type: 'separator' },
      ...(!isMac
        ? ([
            {
              label: 'Check for Updates…',
              enabled: !updatesDisabled,
              click: () => deps.checkForUpdates(),
            },
            {
              id: 'install-update',
              label: 'Install Update…',
              enabled: installReady,
              click: () => {
                void deps.installDownloadedUpdate().catch(() => undefined);
              },
            },
            { type: 'separator' as const },
          ] as MenuItemConstructorOptions[])
        : []),
      {
        label: 'View Credits',
        click: () => deps.sendMenuAction('open-credits'),
      },
    ],
  };

  if (isMac) {
    return [appMenu, fileMenu, editMenu, convertMenu, viewMenu, windowMenu, helpMenu];
  }

  return [fileMenu, editMenu, convertMenu, viewMenu, windowMenu, helpMenu];
};

export const installApplicationMenu = (
  deps: ApplicationMenuDeps,
  onUpdateMenuStateChange: (listener: () => void) => () => void
): ApplicationMenuController => {
  const refresh = (): void => {
    const menu = Menu.buildFromTemplate(buildTemplate(deps));
    Menu.setApplicationMenu(menu);
  };

  const controller: ApplicationMenuController = { refresh };
  onUpdateMenuStateChange(() => refresh());
  refresh();
  return controller;
};
