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
 * Replicator Plugin
 * Replicates loaded G-code program in a grid pattern
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function getUserDataDir() {
  const platform = os.platform();
  const appName = 'ncSender';
  switch (platform) {
    case 'win32':
      return path.join(os.homedir(), 'AppData', 'Roaming', appName);
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    case 'linux':
      return path.join(os.homedir(), '.config', appName);
    default:
      return path.join(os.homedir(), `.${appName}`);
  }
}

function analyzeGCodeBounds(gcodeContent) {
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };

  let currentX = 0, currentY = 0, currentZ = 0;
  let isAbsolute = true;
  let isArcAbsolute = false; // G90.1/G91.1 for arc center mode
  let motionMode = 0; // Track modal motion mode: 0=G0, 1=G1, 2=G2, 3=G3

  const lines = gcodeContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();

    if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed.startsWith('%')) {
      continue;
    }

    if (trimmed.includes('G90.1')) isArcAbsolute = true;
    if (trimmed.includes('G91.1')) isArcAbsolute = false;
    if (trimmed.includes('G90') && !trimmed.includes('G90.1')) isAbsolute = true;
    if (trimmed.includes('G91') && !trimmed.includes('G91.1')) isAbsolute = false;

    if (trimmed.includes('G53')) continue;

    // Update modal motion mode if explicitly specified on this line
    if (/\bG0*0\b/.test(trimmed)) motionMode = 0;
    if (/\bG0*1\b/.test(trimmed)) motionMode = 1;
    if (/\bG0*2\b/.test(trimmed)) motionMode = 2;
    if (/\bG0*3\b/.test(trimmed)) motionMode = 3;

    const xMatch = trimmed.match(/X([+-]?\d*\.?\d+)/);
    const yMatch = trimmed.match(/Y([+-]?\d*\.?\d+)/);
    const zMatch = trimmed.match(/Z([+-]?\d*\.?\d+)/);
    const iMatch = trimmed.match(/I([+-]?\d*\.?\d+)/);
    const jMatch = trimmed.match(/J([+-]?\d*\.?\d+)/);

    // Store start position for arc calculation
    const startX = currentX;
    const startY = currentY;

    // Calculate end position
    let endX = currentX;
    let endY = currentY;
    let endZ = currentZ;

    if (xMatch) {
      const val = parseFloat(xMatch[1]);
      endX = isAbsolute ? val : currentX + val;
    }
    if (yMatch) {
      const val = parseFloat(yMatch[1]);
      endY = isAbsolute ? val : currentY + val;
    }
    if (zMatch) {
      const val = parseFloat(zMatch[1]);
      endZ = isAbsolute ? val : currentZ + val;
    }

    // Detect arc: motion mode is G2/G3 AND line has I/J parameters
    const isArc = (motionMode === 2 || motionMode === 3) && (iMatch || jMatch);

    if (isArc) {
      // Calculate arc center
      const i = iMatch ? parseFloat(iMatch[1]) : 0;
      const j = jMatch ? parseFloat(jMatch[1]) : 0;

      let centerX, centerY;
      if (isArcAbsolute) {
        centerX = i;
        centerY = j;
      } else {
        // Incremental mode (default) - I/J are offsets from start position
        centerX = startX + i;
        centerY = startY + j;
      }

      // Calculate radius
      const radius = Math.sqrt(Math.pow(startX - centerX, 2) + Math.pow(startY - centerY, 2));

      // Calculate start and end angles
      const startAngle = Math.atan2(startY - centerY, startX - centerX);
      const endAngle = Math.atan2(endY - centerY, endX - centerX);

      // Determine if arc is clockwise (G2) or counter-clockwise (G3)
      const isG2 = motionMode === 2; // Clockwise

      // Calculate arc extent by checking if cardinal directions are crossed
      const arcBounds = calculateArcBounds(centerX, centerY, radius, startAngle, endAngle, isG2);

      bounds.min.x = Math.min(bounds.min.x, arcBounds.minX);
      bounds.min.y = Math.min(bounds.min.y, arcBounds.minY);
      bounds.max.x = Math.max(bounds.max.x, arcBounds.maxX);
      bounds.max.y = Math.max(bounds.max.y, arcBounds.maxY);
    }

    // Update current position
    currentX = endX;
    currentY = endY;
    currentZ = endZ;

    // Only update bounds for cutting moves (G1, G2, G3), not rapids (G0)
    // This excludes rapid positioning moves from origin to workpiece
    if (motionMode >= 1) {
      if (xMatch) {
        bounds.min.x = Math.min(bounds.min.x, currentX);
        bounds.max.x = Math.max(bounds.max.x, currentX);
      }
      if (yMatch) {
        bounds.min.y = Math.min(bounds.min.y, currentY);
        bounds.max.y = Math.max(bounds.max.y, currentY);
      }
      if (zMatch) {
        bounds.min.z = Math.min(bounds.min.z, currentZ);
        bounds.max.z = Math.max(bounds.max.z, currentZ);
      }
    }
  }

  if (bounds.min.x === Infinity) bounds.min.x = 0;
  if (bounds.min.y === Infinity) bounds.min.y = 0;
  if (bounds.min.z === Infinity) bounds.min.z = 0;
  if (bounds.max.x === -Infinity) bounds.max.x = 0;
  if (bounds.max.y === -Infinity) bounds.max.y = 0;
  if (bounds.max.z === -Infinity) bounds.max.z = 0;

  return bounds;
}

function calculateArcBounds(centerX, centerY, radius, startAngle, endAngle, isClockwise) {
  // Normalize angles to [0, 2π)
  const normalize = (angle) => {
    while (angle < 0) angle += 2 * Math.PI;
    while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
    return angle;
  };

  const start = normalize(startAngle);
  const end = normalize(endAngle);

  // Check if an angle is within the arc sweep
  const isAngleInArc = (angle) => {
    const a = normalize(angle);
    if (isClockwise) {
      // CW: goes from start to end in decreasing angle direction
      if (start >= end) {
        return a <= start && a >= end;
      } else {
        return a <= start || a >= end;
      }
    } else {
      // CCW: goes from start to end in increasing angle direction
      if (start <= end) {
        return a >= start && a <= end;
      } else {
        return a >= start || a <= end;
      }
    }
  };

  // Start with endpoints
  const startX = centerX + radius * Math.cos(startAngle);
  const startY = centerY + radius * Math.sin(startAngle);
  const endX = centerX + radius * Math.cos(endAngle);
  const endY = centerY + radius * Math.sin(endAngle);

  let minX = Math.min(startX, endX);
  let maxX = Math.max(startX, endX);
  let minY = Math.min(startY, endY);
  let maxY = Math.max(startY, endY);

  // Check cardinal directions
  // Right (0°)
  if (isAngleInArc(0)) maxX = centerX + radius;
  // Top (90° or π/2)
  if (isAngleInArc(Math.PI / 2)) maxY = centerY + radius;
  // Left (180° or π)
  if (isAngleInArc(Math.PI)) minX = centerX - radius;
  // Bottom (270° or 3π/2)
  if (isAngleInArc(3 * Math.PI / 2)) minY = centerY - radius;

  return { minX, maxX, minY, maxY };
}

export async function onLoad(ctx) {
  ctx.log('Replicator plugin loaded');

  ctx.registerToolMenu('Replicator', async () => {
    ctx.log('Replicator tool clicked');

    // Check if a G-code program is loaded
    const serverState = ctx.getServerState();
    const jobLoaded = serverState?.jobLoaded;
    let filename = jobLoaded?.filename;

    if (!filename) {
      showNoFileDialog(ctx);
      return;
    }

    // Track the original source file - if current file is already replicated/temp,
    // use its sourceFile, otherwise use the current filename
    const originalSourceFile = jobLoaded?.sourceFile || filename;

    // Always load from cache (current modified program) to allow stacking changes
    // This enables users to apply multiple transformations sequentially
    let gcodeContent;
    try {
      const cacheFilePath = path.join(getUserDataDir(), 'gcode-cache', 'current.gcode');
      gcodeContent = await fs.readFile(cacheFilePath, 'utf8');
      ctx.log('Loaded G-code from cache (current modified program)');
    } catch (error) {
      ctx.log('Failed to read G-code content:', error);
      showNoFileDialog(ctx);
      return;
    }

    // Get machine limits from firmware settings
    let machineLimits = { x: 400, y: 400 };
    try {
      const firmwareFilePath = path.join(getUserDataDir(), 'firmware.json');
      const firmwareText = await fs.readFile(firmwareFilePath, 'utf8');
      const firmware = JSON.parse(firmwareText);
      const xMax = parseFloat(firmware.settings?.['130']?.value);
      const yMax = parseFloat(firmware.settings?.['131']?.value);
      if (!isNaN(xMax) && xMax > 0) machineLimits.x = xMax;
      if (!isNaN(yMax) && yMax > 0) machineLimits.y = yMax;
    } catch (error) {
      ctx.log('Failed to read firmware settings, using defaults:', error);
    }

    // Analyze G-code to get bounding box
    const bounds = analyzeGCodeBounds(gcodeContent);
    ctx.log('G-code bounds:', bounds);

    // Get app settings for units
    const appSettings = ctx.getAppSettings();
    const unitsPreference = appSettings.unitsPreference || 'metric';
    const isImperial = unitsPreference === 'imperial';
    const distanceUnit = isImperial ? 'in' : 'mm';

    // Conversion factors
    const MM_TO_INCH = 0.0393701;
    const convertToDisplay = (value) => isImperial ? parseFloat((value * MM_TO_INCH).toFixed(3)) : value;

    // Calculate default spacing based on bounds
    const partWidth = bounds.max.x - bounds.min.x;
    const partHeight = bounds.max.y - bounds.min.y;

    // Get saved settings
    const savedSettings = ctx.getSettings()?.replicator || {};

    const settings = {
      rows: savedSettings.rows ?? 1,
      rowDirection: savedSettings.rowDirection ?? 'positive',
      columns: savedSettings.columns ?? 2,
      columnDirection: savedSettings.columnDirection ?? 'positive',
      gapX: convertToDisplay(savedSettings.gapX ?? 5),
      gapY: convertToDisplay(savedSettings.gapY ?? 5),
      sortByTool: savedSettings.sortByTool ?? false,
      skipInstances: savedSettings.skipInstances ?? ''
    };

    showReplicatorDialog(ctx, {
      filename,
      originalSourceFile,
      gcodeContent,
      bounds,
      machineLimits,
      settings,
      isImperial,
      distanceUnit,
      convertToDisplay,
      partWidth,
      partHeight
    });
  }, { icon: 'logo.png' });
}

function showNoFileDialog(ctx) {
  ctx.showDialog(
    'Replicator',
    /* html */ `
    <style>
      .no-file-message {
        padding: 30px;
        text-align: center;
        color: var(--color-text-secondary);
      }
      .no-file-message h3 {
        margin: 0 0 12px 0;
        color: var(--color-text-primary);
      }
      .no-file-message p {
        margin: 0;
        line-height: 1.5;
      }
      .button-group {
        display: flex;
        justify-content: center;
        padding: 16px 20px;
        border-top: 1px solid var(--color-border);
      }
      .btn {
        padding: 10px 24px;
        border: none;
        border-radius: var(--radius-small);
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        background: var(--color-accent);
        color: white;
      }
    </style>
    <div class="no-file-message">
      <h3>No G-Code Program Loaded</h3>
      <p>Please load a G-code program first before using the Replicator tool.</p>
    </div>
    <div class="button-group">
      <button class="btn" onclick="window.postMessage({type: 'close-plugin-dialog'}, '*')">OK</button>
    </div>
    `,
    { closable: true, width: '400px' }
  );
}

function showReplicatorDialog(ctx, params) {
  const {
    filename,
    originalSourceFile,
    gcodeContent,
    bounds,
    machineLimits,
    settings,
    isImperial,
    distanceUnit,
    convertToDisplay,
    partWidth,
    partHeight
  } = params;

  // Escape the G-code content for embedding in JavaScript
  const escapedGcode = JSON.stringify(gcodeContent);

  ctx.showDialog(
    'Replicator',
    /* html */ `
    <style>
      .replicator-layout {
        display: grid;
        grid-template-columns: 320px 280px;
        gap: 12px;
        padding: 16px;
      }
      .plugin-dialog-footer {
        padding: 12px 16px;
        border-top: 1px solid var(--color-border);
        background: var(--color-surface);
      }
      .form-card {
        background: var(--color-surface-muted);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-medium);
        padding: 16px;
        margin-bottom: 0;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      }
      .form-card-title {
        font-size: 0.95rem;
        font-weight: 600;
        color: var(--color-text-primary);
        margin-bottom: 12px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--color-border);
        text-align: center;
      }
      .form-section-title {
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        margin: 16px 0 12px 0;
        padding-top: 12px;
        border-top: 1px solid var(--color-border);
        text-align: center;
      }
      .summary-card {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .summary-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
        flex: 1;
        align-content: center;
      }
      .summary-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: center;
      }
      .summary-label {
        font-size: 0.9rem;
        color: var(--color-text-primary);
      }
      .summary-value {
        font-size: 0.9rem;
        color: var(--color-accent);
      }
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-bottom: 12px;
      }
      .form-group {
        display: flex;
        flex-direction: column;
      }
      label {
        font-size: 0.85rem;
        font-weight: 500;
        margin-bottom: 4px;
        color: var(--color-text-primary);
        text-align: center;
      }
      input[type="number"], input[type="text"], select {
        padding: 6px 8px;
        text-align: center;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.85rem;
        background: var(--color-surface);
        color: var(--color-text-primary);
      }
      input:focus, select:focus {
        outline: none;
        border-color: var(--color-accent);
      }
      input.input-error {
        border-color: #dc3545;
      }
      .validation-tooltip {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: #dc3545;
        color: white;
        padding: 8px 12px;
        border-radius: var(--radius-small);
        font-size: 0.8rem;
        margin-top: 4px;
        z-index: 1000;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        display: none;
      }
      .validation-tooltip::before {
        content: '';
        position: absolute;
        top: -4px;
        left: 20px;
        width: 0;
        height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-bottom: 4px solid #dc3545;
      }
      .form-group.has-error .validation-tooltip {
        display: block;
      }
      .validation-message {
        grid-column: 1 / -1;
        background: #dc354520;
        border: 1px solid #dc3545;
        border-radius: var(--radius-small);
        padding: 12px;
        color: #dc3545;
        font-size: 0.85rem;
        text-align: center;
        display: none;
      }
      .validation-message.show {
        display: block;
      }
      .button-group {
        display: flex;
        gap: 10px;
        justify-content: center;
      }
      .btn {
        padding: 10px 20px;
        border: none;
        border-radius: var(--radius-small);
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.2s;
      }
      .btn:hover { opacity: 0.9; }
      .btn-secondary {
        background: var(--color-surface-muted);
        color: var(--color-text-primary);
        border: 1px solid var(--color-border);
      }
      .btn-primary {
        background: var(--color-accent);
        color: white;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .checkbox-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .checkbox-label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        text-align: left;
      }
      .checkbox-label input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: var(--color-accent);
      }
      .checkbox-text {
        font-weight: 500;
        color: var(--color-text-primary);
      }
      .checkbox-hint {
        font-size: 0.8rem;
        color: var(--color-text-secondary);
        margin-left: 26px;
      }
      .slider-toggle {
        position: relative;
        display: inline-flex;
        align-items: center;
        background: var(--color-surface-muted);
        border: 1px solid var(--color-border);
        border-radius: 20px;
        padding: 4px;
        cursor: pointer;
        user-select: none;
        width: fit-content;
        margin: 0 auto;
      }
      .slider-option {
        position: relative;
        padding: 6px 16px;
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--color-text-secondary);
        transition: color 0.2s ease;
        z-index: 1;
      }
      .slider-option.active {
        color: var(--color-text-primary);
      }
      .slider-indicator {
        position: absolute;
        top: 4px;
        bottom: 4px;
        background: var(--color-accent);
        border-radius: 16px;
        transition: all 0.3s ease;
        z-index: 0;
      }
    </style>

    <div class="replicator-layout">
      <form id="replicatorForm" novalidate>
        <div class="form-card">
          <div class="form-card-title">Configuration</div>
            <div class="form-row">
              <div class="form-group">
                <label for="columns">Columns (X)</label>
                <input type="number" id="columns" min="1" max="50" step="1" value="${settings.columns}" required>
              </div>
              <div class="form-group">
                <label>X Direction</label>
                <div class="slider-toggle" id="columnDirection" data-value="${settings.columnDirection}">
                  <span class="slider-option ${settings.columnDirection === 'negative' ? 'active' : ''}" data-value="negative">−</span>
                  <span class="slider-option ${settings.columnDirection === 'positive' ? 'active' : ''}" data-value="positive">+</span>
                  <div class="slider-indicator"></div>
                </div>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="rows">Rows (Y)</label>
                <input type="number" id="rows" min="1" max="50" step="1" value="${settings.rows}" required>
              </div>
              <div class="form-group">
                <label>Y Direction</label>
                <div class="slider-toggle" id="rowDirection" data-value="${settings.rowDirection}">
                  <span class="slider-option ${settings.rowDirection === 'negative' ? 'active' : ''}" data-value="negative">−</span>
                  <span class="slider-option ${settings.rowDirection === 'positive' ? 'active' : ''}" data-value="positive">+</span>
                  <div class="slider-indicator"></div>
                </div>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="gapX">X Gap (${distanceUnit})</label>
                <input type="number" id="gapX" min="0" step="0.1" value="${settings.gapX}" required>
              </div>
              <div class="form-group">
                <label for="gapY">Y Gap (${distanceUnit})</label>
                <input type="number" id="gapY" min="0" step="0.1" value="${settings.gapY}" required>
              </div>
            </div>
          <div class="checkbox-row" style="margin-top: 8px;">
            <label class="checkbox-label">
              <input type="checkbox" id="sortByTool" ${settings.sortByTool ? 'checked' : ''}>
              <span class="checkbox-text">Sort by Tool</span>
            </label>
            <span class="checkbox-hint">Reduce tool changes by grouping operations per tool across all replicas</span>
          </div>
          <div class="form-group" style="margin-top: 12px; position: relative;">
            <label for="skipInstances">Skip Instances</label>
            <input type="text" id="skipInstances" placeholder="e.g. 1-4, 7, 9" value="${settings.skipInstances}">
            <div class="validation-tooltip" id="skipInstances-error"></div>
            <span class="checkbox-hint" style="margin-left: 0; margin-top: 4px;">Skip specific parts (ranges: 1-4, individual: 5, 7, or combined: 1-4, 7, 9)</span>
          </div>
        </div>
      </form>

      <div class="form-card summary-card">
        <div class="form-card-title">Summary</div>
        <div class="summary-grid">
          <div class="summary-row">
            <span class="summary-label">Source File:</span>
            <span class="summary-value">${filename}</span>
          </div>
          <div class="summary-row">
            <span class="summary-label">Part Size:</span>
            <span class="summary-value">${convertToDisplay(partWidth).toFixed(1)} x ${convertToDisplay(partHeight).toFixed(1)} ${distanceUnit}</span>
          </div>
          <div class="summary-row">
            <span class="summary-label">Machine Limits:</span>
            <span class="summary-value">${convertToDisplay(machineLimits.x).toFixed(0)} x ${convertToDisplay(machineLimits.y).toFixed(0)} ${distanceUnit}</span>
          </div>
          <div class="summary-row">
            <span class="summary-label">Total Replicas:</span>
            <span class="summary-value" id="totalParts">-</span>
          </div>
          <div class="summary-row" id="skippedRow" style="display: none;">
            <span class="summary-label">Skipping:</span>
            <span class="summary-value" id="generatingParts">-</span>
          </div>
          <div class="summary-row">
            <span class="summary-label">Grid Size:</span>
            <span class="summary-value" id="gridSize">-</span>
          </div>
        </div>
      </div>

      <div class="validation-message" id="validationMessage"></div>
    </div>

    <div class="plugin-dialog-footer">
      <div class="button-group">
        <button type="button" class="btn btn-secondary" onclick="window.postMessage({type: 'close-plugin-dialog'}, '*')">Cancel</button>
        <button type="button" class="btn btn-primary" id="generateBtn" onclick="document.getElementById('replicatorForm').requestSubmit()">Generate</button>
      </div>
    </div>

    <script>
      (function() {
        const isImperial = ${isImperial};
        const INCH_TO_MM = 25.4;
        const partWidth = ${partWidth};
        const partHeight = ${partHeight};
        const machineLimitsX = ${machineLimits.x};
        const machineLimitsY = ${machineLimits.y};
        const originalFilename = '${originalSourceFile.replace(/'/g, "\\'")}';
        const originalGcode = ${escapedGcode};

        const convertToMetric = (value) => isImperial ? value * INCH_TO_MM : value;
        const convertToDisplay = (value) => isImperial ? value / INCH_TO_MM : value;

        // Parse skip instances input (e.g., "1-4, 7, 9" returns Set {1,2,3,4,7,9})
        function parseSkipInstances(input, maxParts) {
          const skipSet = new Set();
          if (!input || !input.trim()) return skipSet;

          const parts = input.split(',').map(s => s.trim()).filter(s => s);
          for (const part of parts) {
            if (part.includes('-')) {
              // Range: "1-4" or "3-7"
              const [startStr, endStr] = part.split('-').map(s => s.trim());
              const start = parseInt(startStr, 10);
              const end = parseInt(endStr, 10);
              if (!isNaN(start) && !isNaN(end) && start > 0 && end >= start) {
                for (let i = start; i <= Math.min(end, maxParts); i++) {
                  skipSet.add(i);
                }
              }
            } else {
              // Single number: "7"
              const num = parseInt(part, 10);
              if (!isNaN(num) && num > 0 && num <= maxParts) {
                skipSet.add(num);
              }
            }
          }
          return skipSet;
        }

        // Validate skip instances input and return error message or null
        function validateSkipInstances(input, maxParts) {
          if (!input || !input.trim()) return null;

          const parts = input.split(',').map(s => s.trim()).filter(s => s);
          for (const part of parts) {
            if (part.includes('-')) {
              const rangeParts = part.split('-');
              if (rangeParts.length !== 2) {
                return 'Invalid range format: ' + part;
              }
              const [startStr, endStr] = rangeParts.map(s => s.trim());
              if (!startStr || !endStr) {
                return 'Invalid range: ' + part;
              }
              const start = parseInt(startStr, 10);
              const end = parseInt(endStr, 10);
              if (isNaN(start) || isNaN(end)) {
                return 'Invalid numbers in range: ' + part;
              }
              if (start < 1) {
                return 'Range start must be >= 1: ' + part;
              }
              if (end < start) {
                return 'Range end must be >= start: ' + part;
              }
              if (start > maxParts) {
                return 'Range start exceeds total parts (' + maxParts + '): ' + part;
              }
            } else {
              const num = parseInt(part, 10);
              if (isNaN(num)) {
                return 'Invalid number: ' + part;
              }
              if (num < 1) {
                return 'Instance must be >= 1: ' + part;
              }
              if (num > maxParts) {
                return 'Instance exceeds total parts (' + maxParts + '): ' + part;
              }
            }
          }
          return null;
        }

        function getOutputFilename() {
          const rows = parseInt(document.getElementById('rows').value) || 1;
          const columns = parseInt(document.getElementById('columns').value) || 1;
          const baseName = originalFilename.replace(/\\.[^.]+$/, '');
          return baseName + '_' + rows + 'x' + columns + '.nc';
        }

        function updatePreview() {
          const rows = parseInt(document.getElementById('rows').value) || 1;
          const columns = parseInt(document.getElementById('columns').value) || 1;
          const gapX = parseFloat(document.getElementById('gapX').value) || 0;
          const gapY = parseFloat(document.getElementById('gapY').value) || 0;
          const skipInput = document.getElementById('skipInstances').value || '';

          const gapXMm = convertToMetric(gapX);
          const gapYMm = convertToMetric(gapY);

          const totalParts = rows * columns;

          // Validate skip instances
          const skipError = validateSkipInstances(skipInput, totalParts);
          const skipInputEl = document.getElementById('skipInstances');
          const skipErrorEl = document.getElementById('skipInstances-error');
          const skipFormGroup = skipInputEl.closest('.form-group');

          if (skipError) {
            skipInputEl.classList.add('input-error');
            if (skipFormGroup) skipFormGroup.classList.add('has-error');
            if (skipErrorEl) skipErrorEl.textContent = skipError;
          } else {
            skipInputEl.classList.remove('input-error');
            if (skipFormGroup) skipFormGroup.classList.remove('has-error');
            if (skipErrorEl) skipErrorEl.textContent = '';
          }

          const skipSet = skipError ? new Set() : parseSkipInstances(skipInput, totalParts);
          const generatingCount = totalParts - skipSet.size;

          // Grid size = parts + gaps between them
          const gridWidthMm = columns * partWidth + (columns - 1) * gapXMm;
          const gridHeightMm = rows * partHeight + (rows - 1) * gapYMm;

          // Show total and skip info
          const skippedRow = document.getElementById('skippedRow');
          if (skipSet.size > 0 && !skipError) {
            document.getElementById('totalParts').textContent = generatingCount + ' of ' + totalParts;
            skippedRow.style.display = '';
            document.getElementById('generatingParts').textContent = Array.from(skipSet).sort((a,b) => a-b).join(', ');
          } else {
            document.getElementById('totalParts').textContent = totalParts;
            skippedRow.style.display = 'none';
          }
          document.getElementById('gridSize').textContent =
            convertToDisplay(gridWidthMm).toFixed(1) + ' x ' +
            convertToDisplay(gridHeightMm).toFixed(1) + ' ${distanceUnit}';

          const validationMsg = document.getElementById('validationMessage');
          const generateBtn = document.getElementById('generateBtn');

          if (skipError) {
            validationMsg.classList.remove('show');
            generateBtn.disabled = true;
          } else if (gridWidthMm > machineLimitsX || gridHeightMm > machineLimitsY) {
            validationMsg.textContent = 'Grid size exceeds machine limits! ' +
              'Grid: ' + convertToDisplay(gridWidthMm).toFixed(1) + ' x ' + convertToDisplay(gridHeightMm).toFixed(1) + ' ${distanceUnit}, ' +
              'Machine: ' + convertToDisplay(machineLimitsX).toFixed(0) + ' x ' + convertToDisplay(machineLimitsY).toFixed(0) + ' ${distanceUnit}';
            validationMsg.classList.add('show');
            generateBtn.disabled = true;
          } else if (gapXMm < 0 || gapYMm < 0) {
            validationMsg.textContent = 'Warning: Negative gap will cause parts to overlap.';
            validationMsg.classList.add('show');
            generateBtn.disabled = false;
          } else {
            validationMsg.classList.remove('show');
            generateBtn.disabled = false;
          }
        }

        // G-code generation functions (browser-side)
        // Creates a stateful offset function that tracks G90/G91 positioning mode.
        // Each replication position should get its own instance so state resets per part.
        function createOffsetFn(offsetX, offsetY) {
          let isAbsolute = true;

          return function(line) {
            const trimmed = line.trim().toUpperCase();

            if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed === '' || trimmed.includes('G53')) {
              return line;
            }

            // Track positioning mode changes
            if (trimmed.includes('G90') && !trimmed.includes('G90.1')) isAbsolute = true;
            if (trimmed.includes('G91') && !trimmed.includes('G91.1')) isAbsolute = false;

            if (!trimmed.includes('X') && !trimmed.includes('Y')) {
              return line;
            }

            // Skip incremental mode lines (displacements don't get offset)
            if (!isAbsolute) {
              return line;
            }

            let result = line;

            result = result.replace(/X([+-]?\\d*\\.?\\d+)/gi, (match, value) => {
              const newValue = parseFloat(value) + offsetX;
              return 'X' + newValue.toFixed(3);
            });

            result = result.replace(/Y([+-]?\\d*\\.?\\d+)/gi, (match, value) => {
              const newValue = parseFloat(value) + offsetY;
              return 'Y' + newValue.toFixed(3);
            });

            return result;
          };
        }

        // G-code comment detection
        function isGcodeComment(command) {
          const trimmed = command.trim();
          const withoutLineNumber = trimmed.replace(/^N\\d+\\s*/i, '');
          if (withoutLineNumber.startsWith(';')) return true;
          if (withoutLineNumber.startsWith('(') && withoutLineNumber.endsWith(')')) return true;
          return false;
        }

        // M5 spindle stop detection (matches M5, M05, N100 M5, etc. but not M50, M500)
        const SPINDLE_STOP_PATTERN = /(?:^|[^A-Z0-9])M0*5(?:[^0-9]|$)/i;
        function isSpindleStopCommand(command) {
          if (!command || typeof command !== 'string') return false;
          if (isGcodeComment(command)) return false;
          return SPINDLE_STOP_PATTERN.test(command.trim().toUpperCase());
        }

        // Detect standalone operation name comments like (Bore2), (Trace2), (2D Contour1)
        function isOperationNameComment(line) {
          const trimmed = line.trim();
          // Must be a standalone parentheses comment (not inline with G-code)
          if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return false;
          // Must be short (operation names are typically short)
          if (trimmed.length > 50) return false;
          // Extract content inside parentheses
          const content = trimmed.slice(1, -1).trim();
          // Skip empty or very short content
          if (content.length < 2) return false;
          // Operation names usually don't have colons, equals signs
          if (content.includes(':') || content.includes('=')) return false;
          // If it looks like a simple operation name (short, alphanumeric), it's an op name
          if (/^[A-Za-z0-9_ -]+$/.test(content) && content.length < 30) return true;
          return false;
        }

        // Detect if a line starts a new operation (spindle start, first move after retract)
        function isOperationStart(line) {
          const trimmed = line.trim().toUpperCase();
          // Spindle start commands
          if (/\\bM0*[34]\\b/.test(trimmed)) return true;
          // G0/G1 with X or Y coordinates (but not G53 machine moves)
          if (/\\bG0*[01]\\b/.test(trimmed) && /[XY][+-]?\\d/.test(trimmed) && !trimmed.includes('G53')) return true;
          return false;
        }

        // Process lines with operation comment repositioning
        // Buffers operation name comments and outputs them before the next operation start
        function processLinesWithCommentRepositioning(lines, applyOffsetFn, skipSpindleStop, output) {
          let pendingComment = null;
          let afterG53 = false;

          for (const line of lines) {
            const trimmed = line.trim().toUpperCase();

            // Track G53 (end of operation / retract)
            if (trimmed.includes('G53')) {
              afterG53 = true;
            }

            // Skip spindle stop if requested
            if (skipSpindleStop && isSpindleStopCommand(line)) {
              continue;
            }

            // If this is an operation name comment after G53, buffer it
            if (isOperationNameComment(line)) {
              if (afterG53) {
                pendingComment = line;
                continue;
              }
            }

            // If we have a pending comment and this line starts a new operation, output comment first
            if (pendingComment && isOperationStart(line)) {
              output.push(pendingComment);
              pendingComment = null;
              afterG53 = false;
            }

            // Output the line (with offset applied)
            output.push(applyOffsetFn(line));

            // Clear afterG53 flag when we see meaningful content
            if (!trimmed.startsWith('(') && !trimmed.startsWith(';') && trimmed !== '') {
              if (!trimmed.includes('G53')) {
                afterG53 = false;
              }
            }
          }

          // Don't output orphaned comments at the end - they're for operations in the next part
        }

        function parseToolSegments(gcode) {
          const lines = gcode.split('\\n');
          const segments = [];
          let currentSegment = { toolNum: null, lines: [], isHeader: true };

          for (const line of lines) {
            const trimmed = line.trim().toUpperCase();

            // Skip program end
            if (trimmed === 'M30' || trimmed === 'M2') continue;

            // Detect tool change (M6 with T number, or standalone T command)
            const m6Match = trimmed.match(/M6\\s*T(\\d+)|T(\\d+)\\s*M6/i);
            const tMatch = trimmed.match(/^T(\\d+)$/i);

            if (m6Match || tMatch) {
              // Save current segment if it has content
              if (currentSegment.lines.length > 0) {
                segments.push(currentSegment);
              }

              const toolNum = m6Match ? (m6Match[1] || m6Match[2]) : tMatch[1];
              // Don't include the M6 line in the segment - we'll add it once per unique tool
              currentSegment = { toolNum: parseInt(toolNum), lines: [], isHeader: false };
            } else {
              currentSegment.lines.push(line);
            }
          }

          // Don't forget the last segment
          if (currentSegment.lines.length > 0) {
            segments.push(currentSegment);
          }

          return segments;
        }

        function generateReplicatedGCode(originalGcode, options) {
          const { rows, columns, rowDirection, columnDirection, spacingX, spacingY, gapX, gapY, sortByTool, skipInstances, originalFilename } = options;

          const xMultiplier = columnDirection === 'positive' ? 1 : -1;
          const yMultiplier = rowDirection === 'positive' ? 1 : -1;
          const totalParts = rows * columns;

          const output = [];

          // Parse skip instances
          const skipSet = parseSkipInstances(skipInstances, totalParts);

          output.push('(Replicated G-code generated by Replicator Plugin)');
          output.push('(Source: ' + originalFilename + ')');
          output.push('(Grid: ' + columns + ' columns x ' + rows + ' rows = ' + totalParts + ' parts)');
          if (skipSet.size > 0) {
            output.push('(Skipped instances: ' + Array.from(skipSet).sort((a,b) => a-b).join(', ') + ')');
            output.push('(Generating: ' + (totalParts - skipSet.size) + ' parts)');
          }
          output.push('(Gap: X=' + gapX.toFixed(3) + 'mm, Y=' + gapY.toFixed(3) + 'mm)');
          output.push('(X Direction: ' + columnDirection + ', Y Direction: ' + rowDirection + ')');
          output.push('(Sort by Tool: ' + (sortByTool ? 'Yes' : 'No') + ')');
          output.push('');

          // Generate grid positions (excluding skipped instances)
          const positions = [];
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
              const partNum = row * columns + col + 1;
              if (skipSet.has(partNum)) continue; // Skip this instance
              positions.push({
                partNum,
                row: row + 1,
                col: col + 1,
                offsetX: col * spacingX * xMultiplier,
                offsetY: row * spacingY * yMultiplier
              });
            }
          }

          if (sortByTool) {
            // Parse G-code into tool segments
            const segments = parseToolSegments(originalGcode);

            // Separate header (before first tool) from tool operations
            const headerSegment = segments.find(s => s.isHeader);
            const toolSegments = segments.filter(s => !s.isHeader);

            if (toolSegments.length === 0) {
              // No tool changes found, fall back to normal replication
              // Separate preamble (setup), cutting operations, and postamble (teardown)
              output.push('(No tool changes detected, using standard replication)');
              output.push('');

              const sourceLines = headerSegment ? headerSegment.lines : originalGcode.split('\\n');
              const preamble = [];
              const cutting = [];
              const postamble = [];

              let phase = 'preamble';

              for (const line of sourceLines) {
                const trimmed = line.trim().toUpperCase();

                // Skip program end commands (we add one at the end)
                if (/\\bM0*30\\b/.test(trimmed) || /\\bM0*2\\b/.test(trimmed)) continue;

                if (phase === 'preamble') {
                  const isSpindleStart = /\\bM0*[34]\\b/.test(trimmed);
                  const hasXY = /[XY][+-]?\\d/.test(trimmed) && !/G53/.test(trimmed);
                  if (isSpindleStart || hasXY) {
                    phase = 'cutting';
                  }
                }

                if (phase === 'cutting') {
                  const isG53 = /G53/.test(trimmed);
                  const isSpindleStop = isSpindleStopCommand(line);
                  if (isG53 || isSpindleStop) {
                    phase = 'postamble';
                  }
                }

                if (phase === 'preamble') {
                  preamble.push(line);
                } else if (phase === 'cutting') {
                  cutting.push(line);
                } else {
                  postamble.push(line);
                }
              }

              // Output preamble once
              for (const line of preamble) {
                output.push(line);
              }
              output.push('');

              // Output cutting for each position
              for (let posIndex = 0; posIndex < positions.length; posIndex++) {
                const pos = positions[posIndex];
                const isLastPosition = posIndex === positions.length - 1;

                output.push('(Part ' + pos.partNum + ' of ' + totalParts + ' - Row ' + pos.row + ', Col ' + pos.col + ')');
                output.push('(Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3) + ')');

                // Process with comment repositioning - moves operation comments to correct positions
                processLinesWithCommentRepositioning(
                  cutting,
                  createOffsetFn(pos.offsetX, pos.offsetY),
                  !isLastPosition, // skipSpindleStop
                  output
                );
                output.push('');
              }

              // Output postamble once
              for (const line of postamble) {
                output.push(line);
              }
            } else {
              // Group segments by tool number
              const toolGroups = {};
              const toolOrder = [];
              for (const seg of toolSegments) {
                if (!toolGroups[seg.toolNum]) {
                  toolGroups[seg.toolNum] = [];
                  toolOrder.push(seg.toolNum);
                }
                toolGroups[seg.toolNum].push(seg);
              }

              // Sort by tool - each unique tool runs on all parts before next tool
              output.push('(Tool order optimized to minimize tool changes)');
              output.push('(Unique tools: ' + toolOrder.map(t => 'T' + t).join(', ') + ')');
              output.push('(Total tool changes: ' + toolOrder.length + ', reduced from ' + (toolSegments.length * totalParts) + ')');
              output.push('');

              for (const toolNum of toolOrder) {
                const segmentsForTool = toolGroups[toolNum];

                output.push('(Tool T' + toolNum + ' - All Parts)');
                output.push('M6 T' + toolNum);
                output.push('');

                // Flatten all segment lines for this tool
                const allLinesForTool = [];
                for (const seg of segmentsForTool) {
                  allLinesForTool.push(...seg.lines);
                }

                for (let posIndex = 0; posIndex < positions.length; posIndex++) {
                  const pos = positions[posIndex];
                  const isLastPosition = posIndex === positions.length - 1;

                  output.push('(T' + toolNum + ' Part ' + pos.partNum + ' - Row ' + pos.row + ', Col ' + pos.col + ')');
                  output.push('(Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3) + ')');

                  // Process with comment repositioning - moves operation comments to correct positions
                  processLinesWithCommentRepositioning(
                    allLinesForTool,
                    createOffsetFn(pos.offsetX, pos.offsetY),
                    !isLastPosition, // skipSpindleStop
                    output
                  );
                  output.push('');
                }
              }
            }
          } else {
            // Standard replication - each part runs all tools in original order
            // Use parseToolSegments to properly handle multi-tool files
            const segments = parseToolSegments(originalGcode);

            // Separate header (before first tool) from tool operations
            const headerSegment = segments.find(s => s.isHeader);
            const toolSegments = segments.filter(s => !s.isHeader);

            if (toolSegments.length === 0) {
              // No tool changes found, use simple replication
              const sourceLines = headerSegment ? headerSegment.lines : originalGcode.split('\\n');
              const preamble = [];
              const cutting = [];
              const postamble = [];

              let phase = 'preamble';

              for (const line of sourceLines) {
                const trimmed = line.trim().toUpperCase();

                if (/\\bM0*30\\b/.test(trimmed) || /\\bM0*2\\b/.test(trimmed)) continue;

                if (phase === 'preamble') {
                  const isSpindleStart = /\\bM0*[34]\\b/.test(trimmed);
                  const hasXY = /[XY][+-]?\\d/.test(trimmed) && !/G53/.test(trimmed);
                  if (isSpindleStart || hasXY) {
                    phase = 'cutting';
                  }
                }

                if (phase === 'cutting') {
                  const isG53 = /G53/.test(trimmed);
                  const isSpindleStop = isSpindleStopCommand(line);
                  if (isG53 || isSpindleStop) {
                    phase = 'postamble';
                  }
                }

                if (phase === 'preamble') {
                  preamble.push(line);
                } else if (phase === 'cutting') {
                  cutting.push(line);
                } else {
                  postamble.push(line);
                }
              }

              for (const line of preamble) {
                output.push(line);
              }
              output.push('');

              for (let posIndex = 0; posIndex < positions.length; posIndex++) {
                const pos = positions[posIndex];
                const isLastPosition = posIndex === positions.length - 1;

                output.push('(Part ' + pos.partNum + ' of ' + totalParts + ' - Row ' + pos.row + ', Col ' + pos.col + ')');
                output.push('(Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3) + ')');

                const offsetFn = createOffsetFn(pos.offsetX, pos.offsetY);
                for (const line of cutting) {
                  if (!isLastPosition && isSpindleStopCommand(line)) {
                    continue;
                  }
                  output.push(offsetFn(line));
                }
                output.push('');
              }

              for (const line of postamble) {
                output.push(line);
              }
            } else {
              // Multi-tool file - replicate all tools for each part in original order
              output.push('(Standard replication - all tools per part in original order)');
              output.push('(Tool changes per part: ' + toolSegments.length + ')');
              output.push('');

              // Output header/preamble once
              if (headerSegment && headerSegment.lines.length > 0) {
                for (const line of headerSegment.lines) {
                  output.push(line);
                }
                output.push('');
              }

              // For each position, run all tool segments in original order
              for (let posIndex = 0; posIndex < positions.length; posIndex++) {
                const pos = positions[posIndex];
                const isLastPosition = posIndex === positions.length - 1;

                output.push('(Part ' + pos.partNum + ' of ' + totalParts + ' - Row ' + pos.row + ', Col ' + pos.col + ')');
                output.push('(Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3) + ')');
                output.push('');

                for (let segIndex = 0; segIndex < toolSegments.length; segIndex++) {
                  const seg = toolSegments[segIndex];
                  const isLastSegment = segIndex === toolSegments.length - 1;

                  // Add tool change
                  output.push('T' + seg.toolNum + ' M6');

                  // Process segment lines with offset
                  processLinesWithCommentRepositioning(
                    seg.lines,
                    createOffsetFn(pos.offsetX, pos.offsetY),
                    !(isLastPosition && isLastSegment), // skipSpindleStop unless last part AND last tool
                    output
                  );
                  output.push('');
                }
              }
            }
          }

          output.push('M30 (Program end)');

          return output.join('\\n');
        }

        // Add listeners for inputs
        ['rows', 'columns', 'gapX', 'gapY', 'skipInstances'].forEach(id => {
          const el = document.getElementById(id);
          if (el) {
            el.addEventListener('input', updatePreview);
            el.addEventListener('change', updatePreview);
          }
        });

        // Clear skip instances when rows or columns change
        ['rows', 'columns'].forEach(id => {
          const el = document.getElementById(id);
          if (el) {
            el.addEventListener('change', () => {
              document.getElementById('skipInstances').value = '';
              updatePreview();
            });
          }
        });

        // Filter invalid characters from skip instances input (only allow 0-9, comma, dash, space)
        const skipInstancesInput = document.getElementById('skipInstances');
        if (skipInstancesInput) {
          skipInstancesInput.addEventListener('keypress', (e) => {
            const allowedChars = /[0-9,\\- ]/;
            if (!allowedChars.test(e.key) && e.key !== 'Backspace' && e.key !== 'Delete' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
              e.preventDefault();
            }
          });
          skipInstancesInput.addEventListener('paste', (e) => {
            e.preventDefault();
            const pastedText = (e.clipboardData || window.clipboardData).getData('text');
            const filteredText = pastedText.replace(/[^0-9,\\- ]/g, '');
            document.execCommand('insertText', false, filteredText);
          });
        }

        // Initialize slider toggles
        const initSliderToggle = (toggleId) => {
          const toggle = document.getElementById(toggleId);
          if (!toggle) return;

          const options = toggle.querySelectorAll('.slider-option');
          const indicator = toggle.querySelector('.slider-indicator');

          const updateIndicator = (activeOption) => {
            indicator.style.left = activeOption.offsetLeft + 'px';
            indicator.style.width = activeOption.getBoundingClientRect().width + 'px';
          };

          options.forEach((option) => {
            option.addEventListener('click', () => {
              options.forEach((opt) => opt.classList.remove('active'));
              option.classList.add('active');
              toggle.dataset.value = option.dataset.value;
              updateIndicator(option);
              updatePreview();
            });
          });

          const activeOption = toggle.querySelector('.slider-option.active');
          if (activeOption) {
            setTimeout(() => updateIndicator(activeOption), 0);
          }
        };

        initSliderToggle('columnDirection');
        initSliderToggle('rowDirection');

        // Initial preview
        updatePreview();

        // Form submission
        document.getElementById('replicatorForm').addEventListener('submit', async (e) => {
          e.preventDefault();

          const rows = parseInt(document.getElementById('rows').value);
          const columns = parseInt(document.getElementById('columns').value);
          const rowDirection = document.getElementById('rowDirection').dataset.value;
          const columnDirection = document.getElementById('columnDirection').dataset.value;
          const gapX = parseFloat(document.getElementById('gapX').value);
          const gapY = parseFloat(document.getElementById('gapY').value);
          const sortByTool = document.getElementById('sortByTool').checked;
          const skipInstances = document.getElementById('skipInstances').value.trim();

          const gapXMm = convertToMetric(gapX);
          const gapYMm = convertToMetric(gapY);
          const outputFilename = getOutputFilename();

          // Calculate spacing (center to center) from gap + part size
          const spacingXMm = partWidth + gapXMm;
          const spacingYMm = partHeight + gapYMm;

          // Save settings
          fetch('/api/plugins/com.ncsender.replicator/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              replicator: {
                rows,
                columns,
                rowDirection,
                columnDirection,
                gapX: gapXMm,
                gapY: gapYMm,
                sortByTool,
                skipInstances
              }
            })
          }).catch(err => console.error('Failed to save settings:', err));

          // Generate the replicated G-code
          const replicatedGcode = generateReplicatedGCode(originalGcode, {
            rows,
            columns,
            rowDirection,
            columnDirection,
            spacingX: spacingXMm,
            spacingY: spacingYMm,
            gapX: gapXMm,
            gapY: gapYMm,
            sortByTool,
            skipInstances,
            originalFilename
          });

          // Load the generated G-code temporarily (cache only, no file save)
          try {
            const response = await fetch('/api/gcode-files/load-temp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: replicatedGcode,
                filename: outputFilename,
                sourceFile: originalFilename  // Track original so we can re-replicate
              })
            });

            if (response.ok) {
              console.log('Replicated G-code generated and loaded:', outputFilename);
              setTimeout(() => {
                window.postMessage({ type: 'close-plugin-dialog' }, '*');
              }, 100);
            } else {
              alert('Failed to load G-code');
            }
          } catch (error) {
            console.error('Error loading replicated G-code:', error);
            alert('Error loading G-code');
          }
        });
      })();
    </script>
    `,
    { closable: true, width: 'auto' }
  );
}

export async function onUnload(ctx) {
  ctx.log('Replicator plugin unloaded');
}
