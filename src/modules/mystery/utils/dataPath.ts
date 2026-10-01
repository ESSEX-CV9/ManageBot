import path from 'node:path';

// src/modules/mystery/utils and dist/modules/mystery/utils have equal depth.
// Resolve once at module load so a later chdir never forks the data directory.
const projectRoot = path.resolve(__dirname, '../../../..');
const configuredDirectory = process.env.MYSTERY_DATA_DIR?.trim();
export const mysteryDataDirectory = configuredDirectory
    ? path.resolve(projectRoot, configuredDirectory)
    : path.join(projectRoot, 'data', 'mystery');

export function mysteryDataPath(...parts: string[]): string {
    return path.join(mysteryDataDirectory, ...parts);
}
