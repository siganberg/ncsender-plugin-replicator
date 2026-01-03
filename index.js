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

  const lines = gcodeContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();

    if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed.startsWith('%')) {
      continue;
    }

    if (trimmed.includes('G90')) isAbsolute = true;
    if (trimmed.includes('G91')) isAbsolute = false;

    if (trimmed.includes('G53')) continue;

    const xMatch = trimmed.match(/X([+-]?\d*\.?\d+)/);
    const yMatch = trimmed.match(/Y([+-]?\d*\.?\d+)/);
    const zMatch = trimmed.match(/Z([+-]?\d*\.?\d+)/);

    if (xMatch) {
      const val = parseFloat(xMatch[1]);
      currentX = isAbsolute ? val : currentX + val;
    }
    if (yMatch) {
      const val = parseFloat(yMatch[1]);
      currentY = isAbsolute ? val : currentY + val;
    }
    if (zMatch) {
      const val = parseFloat(zMatch[1]);
      currentZ = isAbsolute ? val : currentZ + val;
    }

    if (xMatch || yMatch || zMatch) {
      bounds.min.x = Math.min(bounds.min.x, currentX);
      bounds.min.y = Math.min(bounds.min.y, currentY);
      bounds.min.z = Math.min(bounds.min.z, currentZ);
      bounds.max.x = Math.max(bounds.max.x, currentX);
      bounds.max.y = Math.max(bounds.max.y, currentY);
      bounds.max.z = Math.max(bounds.max.z, currentZ);
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

    // Check if current file is a temporary/replicated file with a source
    // If so, use the original source file instead
    const sourceFile = jobLoaded?.sourceFile;
    let gcodeContent;

    if (sourceFile) {
      // Load from original source file
      ctx.log('Using original source file:', sourceFile);
      filename = sourceFile;
      try {
        const sourceFilePath = path.join(getUserDataDir(), 'gcode-files', sourceFile);
        gcodeContent = await fs.readFile(sourceFilePath, 'utf8');
      } catch (error) {
        ctx.log('Failed to read source file, falling back to cache:', error);
        // Fall back to cache if source file not found
        const cacheFilePath = path.join(getUserDataDir(), 'gcode-cache', 'current.gcode');
        gcodeContent = await fs.readFile(cacheFilePath, 'utf8');
      }
    } else {
      // Load from cache (current file)
      try {
        const cacheFilePath = path.join(getUserDataDir(), 'gcode-cache', 'current.gcode');
        gcodeContent = await fs.readFile(cacheFilePath, 'utf8');
      } catch (error) {
        ctx.log('Failed to read G-code content:', error);
        showNoFileDialog(ctx);
        return;
      }
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
      sortByTool: savedSettings.sortByTool ?? false
    };

    showReplicatorDialog(ctx, {
      filename,
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
      input[type="number"], select {
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
        const originalFilename = '${filename.replace(/'/g, "\\'")}';
        const originalGcode = ${escapedGcode};

        const convertToMetric = (value) => isImperial ? value * INCH_TO_MM : value;
        const convertToDisplay = (value) => isImperial ? value / INCH_TO_MM : value;

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

          const gapXMm = convertToMetric(gapX);
          const gapYMm = convertToMetric(gapY);

          const totalParts = rows * columns;
          // Grid size = parts + gaps between them
          const gridWidthMm = columns * partWidth + (columns - 1) * gapXMm;
          const gridHeightMm = rows * partHeight + (rows - 1) * gapYMm;

          document.getElementById('totalParts').textContent = totalParts;
          document.getElementById('gridSize').textContent =
            convertToDisplay(gridWidthMm).toFixed(1) + ' x ' +
            convertToDisplay(gridHeightMm).toFixed(1) + ' ${distanceUnit}';

          const validationMsg = document.getElementById('validationMessage');
          const generateBtn = document.getElementById('generateBtn');

          if (gridWidthMm > machineLimitsX || gridHeightMm > machineLimitsY) {
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
        function applyOffset(line, offsetX, offsetY) {
          const trimmed = line.trim().toUpperCase();

          if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed === '' || trimmed.includes('G53')) {
            return line;
          }

          if (!trimmed.includes('X') && !trimmed.includes('Y')) {
            return line;
          }

          if (trimmed.includes('G91')) {
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
              currentSegment = { toolNum: parseInt(toolNum), lines: [line], isHeader: false };
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
          const { rows, columns, rowDirection, columnDirection, spacingX, spacingY, gapX, gapY, sortByTool, originalFilename } = options;

          const xMultiplier = columnDirection === 'positive' ? 1 : -1;
          const yMultiplier = rowDirection === 'positive' ? 1 : -1;
          const totalParts = rows * columns;

          const output = [];

          output.push('; Replicated G-code generated by Replicator Plugin');
          output.push('; Source: ' + originalFilename);
          output.push('; Grid: ' + columns + ' columns x ' + rows + ' rows = ' + totalParts + ' parts');
          output.push('; Gap: X=' + gapX.toFixed(3) + 'mm, Y=' + gapY.toFixed(3) + 'mm');
          output.push('; X Direction: ' + columnDirection + ', Y Direction: ' + rowDirection);
          output.push('; Sort by Tool: ' + (sortByTool ? 'Yes' : 'No'));
          output.push('');

          // Generate grid positions
          const positions = [];
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
              positions.push({
                partNum: row * columns + col + 1,
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
              output.push('; No tool changes detected, using standard replication');
              output.push('');

              for (const pos of positions) {
                output.push('; ===== Part ' + pos.partNum + ' of ' + totalParts + ' (Row ' + pos.row + ', Col ' + pos.col + ') =====');
                output.push('; Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3));

                for (const line of (headerSegment ? headerSegment.lines : originalGcode.split('\\n'))) {
                  const trimmed = line.trim().toUpperCase();
                  if (trimmed === 'M30' || trimmed === 'M2') continue;
                  output.push(applyOffset(line, pos.offsetX, pos.offsetY));
                }
                output.push('');
              }
            } else {
              // Sort by tool - each tool runs on all parts before next tool
              output.push('; Tool order optimized to minimize tool changes');
              output.push('; Tools found: ' + toolSegments.map(s => 'T' + s.toolNum).join(', '));
              output.push('');

              for (const toolSeg of toolSegments) {
                output.push('; ========== Tool T' + toolSeg.toolNum + ' - All Parts ==========');

                for (let posIndex = 0; posIndex < positions.length; posIndex++) {
                  const pos = positions[posIndex];
                  const isLastPosition = posIndex === positions.length - 1;

                  output.push('; ----- T' + toolSeg.toolNum + ' Part ' + pos.partNum + ' (Row ' + pos.row + ', Col ' + pos.col + ') -----');
                  output.push('; Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3));

                  for (const line of toolSeg.lines) {
                    // Skip M5 (spindle stop) for non-last positions - keep spindle running between parts
                    if (!isLastPosition && isSpindleStopCommand(line)) {
                      continue;
                    }
                    output.push(applyOffset(line, pos.offsetX, pos.offsetY));
                  }
                  output.push('');
                }
              }
            }
          } else {
            // Standard replication - each part runs all tools
            const originalLines = originalGcode.split('\\n');
            const cleanedLines = [];
            let foundFirstMove = false;

            for (const line of originalLines) {
              const trimmed = line.trim().toUpperCase();

              if (!foundFirstMove && trimmed === '') continue;
              if (trimmed === 'M30' || trimmed === 'M2') continue;

              if (!foundFirstMove && (trimmed.startsWith('G') || trimmed.startsWith('M') || trimmed.startsWith('S') || trimmed.startsWith('F'))) {
                foundFirstMove = true;
              }

              cleanedLines.push(line);
            }

            for (const pos of positions) {
              output.push('; ===== Part ' + pos.partNum + ' of ' + totalParts + ' (Row ' + pos.row + ', Col ' + pos.col + ') =====');
              output.push('; Offset: X=' + pos.offsetX.toFixed(3) + ', Y=' + pos.offsetY.toFixed(3));

              for (const line of cleanedLines) {
                output.push(applyOffset(line, pos.offsetX, pos.offsetY));
              }

              output.push('');
            }
          }

          output.push('M30 ; Program end');

          return output.join('\\n');
        }

        // Add listeners for inputs
        ['rows', 'columns', 'gapX', 'gapY'].forEach(id => {
          const el = document.getElementById(id);
          if (el) {
            el.addEventListener('input', updatePreview);
            el.addEventListener('change', updatePreview);
          }
        });

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
                sortByTool
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
