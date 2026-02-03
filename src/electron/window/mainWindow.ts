/**
 * Main Window Management
 *
 * Creates and manages the main application window.
 */

import { app, BrowserWindow, Menu, screen, dialog } from "electron";
import path from "node:path";
import { setMainWindow as setControlPlaneMainWindow } from "../mcp/controlPlane";
import { setMainWindow as setBrowserManagerMainWindow } from "../browser";
import { clearCredentials } from "../auth/credentialsStore";
import { isUpdatePending, quitAndInstall } from "../updater";

// Main window reference
let mainWindow: BrowserWindow | null = null;

/**
 * Get the main window instance.
 */
export const getMainWindow = (): BrowserWindow | null => mainWindow;

/**
 * Create the main application window.
 * Window size: 80% of screen height (max 800px), with 1.5:1 aspect ratio.
 */
export const createMainWindow = () => {
  // Icon path: Only needed in dev mode - production uses embedded .icns
  const iconPath = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? path.join(__dirname, "../../icons/icon.png")
    : undefined;

  // Get the primary display dimensions to calculate window size
  // Window opens at 80% screen height (max 800px), with width = 1.5x height
  const { width: screenWidth, height: screenHeight } =
    screen.getPrimaryDisplay().workAreaSize;
  const maxHeight = 900;
  const windowHeight = Math.min(Math.round(screenHeight * 0.8), maxHeight);
  const windowWidth = Math.min(
    Math.round(windowHeight * 1.5),
    screenWidth
  );

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 400,
    backgroundColor: "#0D0D0B",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 10, y: 10 },
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
    },
  });

  // Set the main window for control plane and browser manager
  setControlPlaneMainWindow(mainWindow);
  setBrowserManagerMainWindow(mainWindow);

  // Load the app
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    setControlPlaneMainWindow(null);
    setBrowserManagerMainWindow(null);
  });

  // Emit fullscreen state changes to the renderer
  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("window:fullscreen-changed", true);
  });

  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("window:fullscreen-changed", false);
  });

  return mainWindow;
};

/**
 * Creates the application menu with File menu options.
 * Includes standard app controls plus authentication actions like Logout.
 */
export const createAppMenu = () => {
  const isMac = process.platform === "darwin";

  // Set About panel options (macOS)
  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: "Creature",
      applicationVersion: app.getVersion(),
      version: "",
      credits: "This is a beta release. Things may break.",
      copyright: "Serverless, Inc.",
    });
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: "Creature",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    // File menu
    {
      label: "File",
      submenu: [
        {
          label: "Clear Credentials",
          click: async () => {
            await clearCredentials();
            // Reload the window to show the login screen
            mainWindow?.webContents.reload();
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    // Edit menu
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" as const },
              { role: "delete" as const },
              { role: "selectAll" as const },
            ]
          : [
              { role: "delete" as const },
              { type: "separator" as const },
              { role: "selectAll" as const },
            ]),
      ],
    },
    // View menu
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    // Window menu
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    // Help menu (with debug options in packaged builds)
    {
      label: "Help",
      submenu: [
        ...(app.isPackaged
          ? [
              {
                label: "Check Update Status",
                click: () => {
                  const pending = isUpdatePending();
                  const version = app.getVersion();
                  dialog.showMessageBox({
                    type: "info",
                    title: "Update Status",
                    message: `Current version: ${version}\nUpdate pending: ${pending}`,
                    buttons: pending ? ["Install Now", "Cancel"] : ["OK"],
                  }).then((result) => {
                    if (pending && result.response === 0) {
                      console.log("[Debug] Manual quitAndInstall triggered");
                      quitAndInstall();
                    }
                  });
                },
              },
              { type: "separator" as const },
            ]
          : []),
        {
          label: "Learn More",
          click: async () => {
            const { shell } = await import("electron");
            shell.openExternal("https://creature.run");
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

/**
 * Set up the dock icon on macOS (dev mode only).
 */
export const setupDockIcon = () => {
  if (process.platform === "darwin" && MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const iconPath = path.join(__dirname, "../../icons/icon.png");
    app.dock.setIcon(iconPath);
  }
};

