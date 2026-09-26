import { screen, type BrowserWindow } from 'electron';
import * as fs from 'fs';
import { writeJsonAtomic } from './settingsStore';

// Restores window size/position across launches, ignoring off-screen positions.

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_WIDTH = 1080;
const DEFAULT_WINDOW_HEIGHT = 880;

export const isWindowBoundsOnScreen = (
  x: number,
  y: number,
  width: number,
  height: number
): boolean => {
  const TITLE_BAR_CLEARANCE = 64;
  return screen.getAllDisplays().some(({ bounds }) => {
    return (
      x + width > bounds.x &&
      x < bounds.x + bounds.width &&
      y + TITLE_BAR_CLEARANCE > bounds.y &&
      y < bounds.y + bounds.height
    );
  });
};

export const loadWindowState = (statePath: string): WindowState => {
  const defaults: WindowState = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  try {
    if (!fs.existsSync(statePath)) return defaults;
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const width =
      typeof data.width === 'number' && data.width >= 600 ? data.width : DEFAULT_WINDOW_WIDTH;
    const height =
      typeof data.height === 'number' && data.height >= 500 ? data.height : DEFAULT_WINDOW_HEIGHT;
    return {
      width,
      height,
      x: typeof data.x === 'number' ? data.x : undefined,
      y: typeof data.y === 'number' ? data.y : undefined,
      isMaximized: data.isMaximized === true,
    };
  } catch {
    return defaults;
  }
};

export const saveWindowState = (window: BrowserWindow | null, statePath: string): void => {
  if (!window || window.isDestroyed()) return;
  try {
    // getNormalBounds() returns restored-state bounds even when maximized
    const bounds = window.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: window.isMaximized(),
    };
    writeJsonAtomic(statePath, state);
  } catch (err) {
    console.error('Failed to save window state:', err);
  }
};
