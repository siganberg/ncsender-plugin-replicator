# Replicator Plugin for ncSender

The **Replicator** plugin allows you to replicate a loaded G-code program in a grid pattern, making it easy to produce multiple copies of a part in a single operation.

## Features

- **Grid Replication**: Replicate your G-code in a configurable rows x columns grid pattern
- **Flexible Direction**: Choose positive or negative direction for both X and Y axes
- **Gap Configuration**: Set the gap between parts for precise spacing
- **Sort by Tool**: Optimize tool changes by grouping operations per tool across all replicas
- **Machine Limit Validation**: Automatic validation against machine limits to prevent exceeding work area
- **Temporary Loading**: Generated G-code is loaded temporarily without cluttering your file manager
- **Re-replication Support**: Easily re-replicate from the original source file

## Installation

1. Open **ncSender** and go to **Settings > Plugins**
2. Paste the latest release ZIP file link
3. Click **Install**

## Usage

1. Load a G-code program in ncSender
2. Click on the **Replicator** tool in the toolbar
3. Configure the grid:
   - Set the number of columns (X) and rows (Y)
   - Choose the direction for each axis (+ or -)
   - Set the gap between parts
   - Optionally enable "Sort by Tool" to minimize tool changes
4. Review the summary to ensure the grid fits within machine limits
5. Click **Generate** to create and load the replicated G-code

## Development

This plugin is part of the ncSender ecosystem: https://github.com/siganberg/ncSender

## License

This plugin is available under a **dual license** (GPL-3.0 + Commercial).

See the [LICENSE](LICENSE) file for details, or contact support@franciscreation.com for commercial licensing.
