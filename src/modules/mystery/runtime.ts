import { SlashCommandBuilder } from 'discord.js';
import type { Command } from '../../core/types';

// Upstream JS is retained to preserve gameplay. These are the only untyped
// require boundaries; validate exports before exposing typed entry points.
function loadRecord(modulePath: string): Record<string, unknown> {
    const value: unknown = require(modulePath);
    if (!value || typeof value !== 'object') throw new Error(`Invalid mystery module: ${modulePath}`);
    return value as Record<string, unknown>;
}

export function loadFunction<Args extends unknown[], Result>(
    modulePath: string,
    exportName: string,
): (...args: Args) => Result {
    const value = loadRecord(modulePath)[exportName];
    if (typeof value !== 'function') throw new Error(`Missing mystery export: ${modulePath}.${exportName}`);
    return value as (...args: Args) => Result;
}

export function loadCommand(modulePath: string): Command {
    const value = loadRecord(modulePath);
    if (!(value.data instanceof SlashCommandBuilder) || typeof value.execute !== 'function') {
        throw new Error(`Invalid mystery command: ${modulePath}`);
    }
    return { data: value.data, execute: value.execute as Command['execute'] };
}

export function loadStoreFlusher(modulePath: string, exportName: string): () => Promise<void> {
    const store = loadRecord(modulePath)[exportName];
    if (!store || typeof store !== 'object' || !('flush' in store) || typeof store.flush !== 'function') {
        throw new Error(`Missing mystery store flush: ${modulePath}.${exportName}`);
    }
    return store.flush.bind(store) as () => Promise<void>;
}
