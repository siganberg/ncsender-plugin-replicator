/**
 * Replicator Plugin
 * Replicates loaded G-code program in a grid pattern
 */

export async function onLoad(ctx) {
  ctx.log('Replicator plugin loaded');

  ctx.registerToolMenu('Replicator', async () => {
    ctx.log('Replicator tool clicked');

    // Check if a G-code program is loaded
    let serverState;
    try {
      const response = await fetch('/api/server-state');
      serverState = await response.json();
    } catch (error) {
      ctx.log('Failed to get server state:', error);
      showNoFileDialog(ctx);
      return;
    }

    const jobLoaded = serverState?.jobLoaded;
    const filename = jobLoaded?.filename;

    if (!filename) {
      showNoFileDialog(ctx);
      return;
    }

    // Get the currently loaded G-code content
    let gcodeContent;
    try {
      const response = await fetch('/api/gcode-files/current/download');
      if (!response.ok) {
        throw new Error('Failed to download G-code');
      }
      gcodeContent = await response.text();
    } catch (error) {
      ctx.log('Failed to get G-code content:', error);
      showNoFileDialog(ctx);
      return;
    }

    // Get machine limits from firmware settings
    let machineLimits = { x: 400, y: 400 };
    try {
      const fwResponse = await fetch('/api/firmware/settings');
      if (fwResponse.ok) {
        const firmware = await fwResponse.json();
        const xMax = parseFloat(firmware.settings?.['130']?.value);
        const yMax = parseFloat(firmware.settings?.['131']?.value);
        if (!isNaN(xMax) && xMax > 0) machineLimits.x = xMax;
        if (!isNaN(yMax) && yMax > 0) machineLimits.y = yMax;
      }
    } catch (error) {
      ctx.log('Failed to get firmware settings, using defaults:', error);
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
    const INCH_TO_MM = 25.4;
    const convertToDisplay = (value) => isImperial ? parseFloat((value * MM_TO_INCH).toFixed(3)) : value;
    const convertToMetric = (value) => isImperial ? value * INCH_TO_MM : value;

    // Calculate default spacing based on bounds
    const partWidth = bounds.max.x - bounds.min.x;
    const partHeight = bounds.max.y - bounds.min.y;
    const defaultSpacingX = convertToDisplay(Math.ceil(partWidth + 5));
    const defaultSpacingY = convertToDisplay(Math.ceil(partHeight + 5));

    // Get saved settings
    const savedSettings = ctx.getSettings()?.replicator || {};

    const settings = {
      rows: savedSettings.rows ?? 1,
      rowDirection: savedSettings.rowDirection ?? 'positive',
      columns: savedSettings.columns ?? 2,
      columnDirection: savedSettings.columnDirection ?? 'positive',
      spacingX: convertToDisplay(savedSettings.spacingX ?? (partWidth + 5)),
      spacingY: convertToDisplay(savedSettings.spacingY ?? (partHeight + 5))
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
      convertToMetric,
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
    convertToMetric,
    partWidth,
    partHeight
  } = params;

  ctx.showDialog(
    'Replicator',
    /* html */ `
    <style>
      .replicator-layout {
        display: flex;
        flex-direction: column;
        max-width: 600px;
        width: 100%;
      }
      .form-column {
        padding: 20px;
      }
      .plugin-dialog-footer {
        padding: 16px 20px;
        border-top: 1px solid var(--color-border);
        background: var(--color-surface);
      }
      .form-card {
        background: var(--color-surface-muted);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-medium);
        padding: 20px;
        margin-bottom: 16px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      }
      .form-card-title {
        font-size: 1rem;
        font-weight: 600;
        color: var(--color-text-primary);
        margin-bottom: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--color-border);
        text-align: center;
      }
      .info-card {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        padding: 12px;
        margin-bottom: 16px;
        font-size: 0.85rem;
      }
      .info-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
        color: var(--color-text-secondary);
      }
      .info-value {
        font-weight: 600;
        color: var(--color-accent);
      }
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-bottom: 16px;
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
        padding: 8px;
        text-align: center;
        width: 100%;
        box-sizing: border-box;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        font-size: 0.9rem;
        background: var(--color-surface);
        color: var(--color-text-primary);
      }
      input:focus, select:focus {
        outline: none;
        border-color: var(--color-accent);
      }
      .validation-message {
        background: #dc354520;
        border: 1px solid #dc3545;
        border-radius: var(--radius-small);
        padding: 12px;
        margin-top: 16px;
        color: #dc3545;
        font-size: 0.85rem;
        display: none;
      }
      .validation-message.show {
        display: block;
      }
      .preview-info {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-small);
        padding: 12px;
        margin-top: 16px;
        font-size: 0.85rem;
      }
      .preview-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
      }
      .preview-label {
        color: var(--color-text-secondary);
      }
      .preview-value {
        font-weight: 600;
        color: var(--color-accent);
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
    </style>

    <div class="replicator-layout">
      <div class="form-column">
        <div class="info-card">
          <div class="info-row">
            <span>Source File:</span>
            <span class="info-value">${filename}</span>
          </div>
          <div class="info-row">
            <span>Part Size:</span>
            <span class="info-value">${convertToDisplay(partWidth).toFixed(1)} x ${convertToDisplay(partHeight).toFixed(1)} ${distanceUnit}</span>
          </div>
          <div class="info-row">
            <span>Machine Limits:</span>
            <span class="info-value">${convertToDisplay(machineLimits.x).toFixed(0)} x ${convertToDisplay(machineLimits.y).toFixed(0)} ${distanceUnit}</span>
          </div>
        </div>

        <form id="replicatorForm" novalidate>
          <div class="form-card">
            <div class="form-card-title">Grid Configuration</div>
            <div class="form-row">
              <div class="form-group">
                <label for="columns">Columns (X)</label>
                <input type="number" id="columns" min="1" max="50" step="1" value="${settings.columns}" required>
              </div>
              <div class="form-group">
                <label for="columnDirection">X Direction</label>
                <select id="columnDirection">
                  <option value="positive" ${settings.columnDirection === 'positive' ? 'selected' : ''}>Positive (+X)</option>
                  <option value="negative" ${settings.columnDirection === 'negative' ? 'selected' : ''}>Negative (-X)</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label for="rows">Rows (Y)</label>
                <input type="number" id="rows" min="1" max="50" step="1" value="${settings.rows}" required>
              </div>
              <div class="form-group">
                <label for="rowDirection">Y Direction</label>
                <select id="rowDirection">
                  <option value="positive" ${settings.rowDirection === 'positive' ? 'selected' : ''}>Positive (+Y)</option>
                  <option value="negative" ${settings.rowDirection === 'negative' ? 'selected' : ''}>Negative (-Y)</option>
                </select>
              </div>
            </div>
          </div>

          <div class="form-card">
            <div class="form-card-title">Spacing (center to center)</div>
            <div class="form-row">
              <div class="form-group">
                <label for="spacingX">X Spacing (${distanceUnit})</label>
                <input type="number" id="spacingX" min="0.1" step="0.1" value="${settings.spacingX}" required>
              </div>
              <div class="form-group">
                <label for="spacingY">Y Spacing (${distanceUnit})</label>
                <input type="number" id="spacingY" min="0.1" step="0.1" value="${settings.spacingY}" required>
              </div>
            </div>
          </div>

          <div class="preview-info" id="previewInfo">
            <div class="preview-row">
              <span class="preview-label">Total Parts:</span>
              <span class="preview-value" id="totalParts">-</span>
            </div>
            <div class="preview-row">
              <span class="preview-label">Grid Size:</span>
              <span class="preview-value" id="gridSize">-</span>
            </div>
            <div class="preview-row">
              <span class="preview-label">Output File:</span>
              <span class="preview-value" id="outputFile">-</span>
            </div>
          </div>

          <div class="validation-message" id="validationMessage"></div>
        </form>
      </div>
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
          const spacingX = parseFloat(document.getElementById('spacingX').value) || 0;
          const spacingY = parseFloat(document.getElementById('spacingY').value) || 0;

          const spacingXMm = convertToMetric(spacingX);
          const spacingYMm = convertToMetric(spacingY);

          const totalParts = rows * columns;
          const gridWidthMm = partWidth + (columns - 1) * spacingXMm;
          const gridHeightMm = partHeight + (rows - 1) * spacingYMm;

          document.getElementById('totalParts').textContent = totalParts;
          document.getElementById('gridSize').textContent =
            convertToDisplay(gridWidthMm).toFixed(1) + ' x ' +
            convertToDisplay(gridHeightMm).toFixed(1) + ' ${distanceUnit}';
          document.getElementById('outputFile').textContent = getOutputFilename();

          // Validate against machine limits
          const validationMsg = document.getElementById('validationMessage');
          const generateBtn = document.getElementById('generateBtn');

          if (gridWidthMm > machineLimitsX || gridHeightMm > machineLimitsY) {
            validationMsg.textContent = 'Grid size exceeds machine limits! ' +
              'Grid: ' + convertToDisplay(gridWidthMm).toFixed(1) + ' x ' + convertToDisplay(gridHeightMm).toFixed(1) + ' ${distanceUnit}, ' +
              'Machine: ' + convertToDisplay(machineLimitsX).toFixed(0) + ' x ' + convertToDisplay(machineLimitsY).toFixed(0) + ' ${distanceUnit}';
            validationMsg.classList.add('show');
            generateBtn.disabled = true;
          } else if (spacingXMm < partWidth || spacingYMm < partHeight) {
            validationMsg.textContent = 'Warning: Spacing is less than part size. Parts may overlap.';
            validationMsg.classList.add('show');
            generateBtn.disabled = false;
          } else {
            validationMsg.classList.remove('show');
            generateBtn.disabled = false;
          }
        }

        // Add listeners
        ['rows', 'columns', 'spacingX', 'spacingY', 'rowDirection', 'columnDirection'].forEach(id => {
          const el = document.getElementById(id);
          if (el) {
            el.addEventListener('input', updatePreview);
            el.addEventListener('change', updatePreview);
          }
        });

        // Initial preview
        updatePreview();

        // Form submission
        document.getElementById('replicatorForm').addEventListener('submit', async (e) => {
          e.preventDefault();

          const rows = parseInt(document.getElementById('rows').value);
          const columns = parseInt(document.getElementById('columns').value);
          const rowDirection = document.getElementById('rowDirection').value;
          const columnDirection = document.getElementById('columnDirection').value;
          const spacingX = parseFloat(document.getElementById('spacingX').value);
          const spacingY = parseFloat(document.getElementById('spacingY').value);

          const spacingXMm = convertToMetric(spacingX);
          const spacingYMm = convertToMetric(spacingY);

          // Save settings
          const settingsToSave = {
            replicator: {
              rows,
              columns,
              rowDirection,
              columnDirection,
              spacingX: spacingXMm,
              spacingY: spacingYMm
            }
          };

          await fetch('/api/plugins/com.ncsender.replicator/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settingsToSave)
          });

          // Post message to generate G-code
          window.postMessage({
            type: 'replicator-generate',
            data: {
              rows,
              columns,
              rowDirection,
              columnDirection,
              spacingXMm,
              spacingYMm,
              outputFilename: getOutputFilename()
            }
          }, '*');
        });

        // Listen for generate response
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'replicator-done') {
            window.postMessage({type: 'close-plugin-dialog'}, '*');
          }
        });
      })();
    </script>
    `,
    {
      closable: true,
      width: '600px',
      onMessage: async (message) => {
        if (message.type === 'replicator-generate') {
          const { rows, columns, rowDirection, columnDirection, spacingXMm, spacingYMm, outputFilename } = message.data;

          ctx.log('Generating replicated G-code:', message.data);

          // Generate the replicated G-code
          const replicatedGcode = generateReplicatedGCode(gcodeContent, {
            rows,
            columns,
            rowDirection,
            columnDirection,
            spacingX: spacingXMm,
            spacingY: spacingYMm,
            originalFilename: filename
          });

          // Upload the generated G-code
          try {
            const formData = new FormData();
            const blob = new Blob([replicatedGcode], { type: 'text/plain' });
            formData.append('file', blob, outputFilename);

            const response = await fetch('/api/gcode-files', {
              method: 'POST',
              body: formData
            });

            if (response.ok) {
              ctx.log('Replicated G-code generated and loaded:', outputFilename);
              ctx.broadcast('replicator-done', {});
            } else {
              ctx.log('Failed to load replicated G-code');
            }
          } catch (error) {
            ctx.log('Error uploading replicated G-code:', error);
          }
        }
      }
    }
  );
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

    // Skip comments
    if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed.startsWith('%')) {
      continue;
    }

    // Check for absolute/incremental mode
    if (trimmed.includes('G90')) isAbsolute = true;
    if (trimmed.includes('G91')) isAbsolute = false;

    // Skip machine coordinate moves (G53)
    if (trimmed.includes('G53')) continue;

    // Parse coordinates
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

    // Update bounds (only if we found coordinates)
    if (xMatch || yMatch || zMatch) {
      bounds.min.x = Math.min(bounds.min.x, currentX);
      bounds.min.y = Math.min(bounds.min.y, currentY);
      bounds.min.z = Math.min(bounds.min.z, currentZ);
      bounds.max.x = Math.max(bounds.max.x, currentX);
      bounds.max.y = Math.max(bounds.max.y, currentY);
      bounds.max.z = Math.max(bounds.max.z, currentZ);
    }
  }

  // Handle case where no coordinates were found
  if (bounds.min.x === Infinity) bounds.min.x = 0;
  if (bounds.min.y === Infinity) bounds.min.y = 0;
  if (bounds.min.z === Infinity) bounds.min.z = 0;
  if (bounds.max.x === -Infinity) bounds.max.x = 0;
  if (bounds.max.y === -Infinity) bounds.max.y = 0;
  if (bounds.max.z === -Infinity) bounds.max.z = 0;

  return bounds;
}

function generateReplicatedGCode(originalGcode, options) {
  const {
    rows,
    columns,
    rowDirection,
    columnDirection,
    spacingX,
    spacingY,
    originalFilename
  } = options;

  const xMultiplier = columnDirection === 'positive' ? 1 : -1;
  const yMultiplier = rowDirection === 'positive' ? 1 : -1;

  const output = [];

  // Header
  output.push(`; Replicated G-code generated by Replicator Plugin`);
  output.push(`; Source: ${originalFilename}`);
  output.push(`; Grid: ${columns} columns x ${rows} rows = ${rows * columns} parts`);
  output.push(`; Spacing: X=${spacingX.toFixed(3)}mm, Y=${spacingY.toFixed(3)}mm`);
  output.push(`; X Direction: ${columnDirection}, Y Direction: ${rowDirection}`);
  output.push('');

  // Remove header comments and program end from original
  const originalLines = originalGcode.split('\n');
  const cleanedLines = [];
  let foundFirstMove = false;

  for (const line of originalLines) {
    const trimmed = line.trim().toUpperCase();

    // Skip empty lines at the start
    if (!foundFirstMove && trimmed === '') continue;

    // Skip M30/M2 program end
    if (trimmed === 'M30' || trimmed === 'M2') continue;

    // Mark when we find first real content
    if (!foundFirstMove && (trimmed.startsWith('G') || trimmed.startsWith('M') || trimmed.startsWith('S') || trimmed.startsWith('F'))) {
      foundFirstMove = true;
    }

    cleanedLines.push(line);
  }

  // Generate grid
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const partNum = row * columns + col + 1;
      const offsetX = col * spacingX * xMultiplier;
      const offsetY = row * spacingY * yMultiplier;

      output.push(`; ===== Part ${partNum} of ${rows * columns} (Row ${row + 1}, Col ${col + 1}) =====`);
      output.push(`; Offset: X=${offsetX.toFixed(3)}, Y=${offsetY.toFixed(3)}`);

      // Apply offset to each line
      for (const line of cleanedLines) {
        const offsetLine = applyOffset(line, offsetX, offsetY);
        output.push(offsetLine);
      }

      output.push('');
    }
  }

  // Footer
  output.push('M30 ; Program end');

  return output.join('\n');
}

function applyOffset(line, offsetX, offsetY) {
  const trimmed = line.trim().toUpperCase();

  // Skip comments, empty lines, and machine coordinate moves
  if (trimmed.startsWith('(') || trimmed.startsWith(';') || trimmed === '' || trimmed.includes('G53')) {
    return line;
  }

  // Skip lines without X or Y coordinates
  if (!trimmed.includes('X') && !trimmed.includes('Y')) {
    return line;
  }

  // Skip incremental mode moves (would need different handling)
  if (trimmed.includes('G91')) {
    return line;
  }

  let result = line;

  // Apply X offset
  result = result.replace(/X([+-]?\d*\.?\d+)/gi, (match, value) => {
    const newValue = parseFloat(value) + offsetX;
    return 'X' + newValue.toFixed(3);
  });

  // Apply Y offset
  result = result.replace(/Y([+-]?\d*\.?\d+)/gi, (match, value) => {
    const newValue = parseFloat(value) + offsetY;
    return 'Y' + newValue.toFixed(3);
  });

  return result;
}

export async function onUnload(ctx) {
  ctx.log('Replicator plugin unloaded');
}
