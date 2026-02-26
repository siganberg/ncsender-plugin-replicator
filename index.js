/*
 * This file is part of ncSender.
 *
 * ncSender is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ncSender is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with ncSender. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Replicator Plugin - Node.js Lifecycle Wrapper
 * Thin wrapper for the community (Node.js) version.
 * Reads config.html and shows it as a dialog.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const resolveServerPort = (pluginSettings = {}, appSettings = {}) => {
  const appPort = Number.parseInt(appSettings?.senderPort, 10);
  if (Number.isFinite(appPort)) {
    return appPort;
  }
  const pluginPort = Number.parseInt(pluginSettings?.port, 10);
  if (Number.isFinite(pluginPort)) {
    return pluginPort;
  }
  return 8090;
};

export async function onLoad(ctx) {
  ctx.log('Replicator plugin loaded');

  ctx.registerToolMenu('Replicator', async () => {
    ctx.log('Replicator tool opened');

    const storedSettings = ctx.getSettings() || {};
    const currentAppSettings = ctx.getAppSettings() || {};
    const serverPort = resolveServerPort(storedSettings, currentAppSettings);
    const initialConfigJson = JSON.stringify(storedSettings)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e');

    let html = readFileSync(join(__dirname, 'config.html'), 'utf-8');
    html = html.replace('__SERVER_PORT__', String(serverPort));
    html = html.replace('__INITIAL_CONFIG__', initialConfigJson);

    ctx.showDialog('Replicator', html, { size: 'large' });
  }, {
    icon: 'logo.png'
  });
}

export async function onUnload(ctx) {
  ctx.log('Replicator plugin unloaded');
}
