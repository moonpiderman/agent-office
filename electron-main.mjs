import { app, BrowserWindow, dialog, shell } from 'electron';
import { startAgentOfficeServer } from './agent-office.mjs';

let mainWindow = null;
let officeServer = null;

async function createWindow() {
  const office = await startAgentOfficeServer({ port: 0, quiet: true });
  officeServer = office.server;

  mainWindow = new BrowserWindow({
    title: 'Agent Office',
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#dce7ef',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const appOrigin = new URL(office.url).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== appOrigin) event.preventDefault();
  });

  await mainWindow.loadURL(office.url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Agent Office를 시작하지 못했어요', String(error?.stack || error));
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch((error) => {
    dialog.showErrorBox('Agent Office를 시작하지 못했어요', String(error?.stack || error));
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (officeServer?.listening) officeServer.close();
});
