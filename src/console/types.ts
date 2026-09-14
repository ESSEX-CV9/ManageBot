import type { Interface } from 'node:readline/promises';

export interface ConsoleContext {
    rl: Interface;
    clear: () => void;
    pause: (message?: string) => Promise<void>;
}

export interface ConsoleModule {
    id: string;
    title: string;
    description: string;
    run: (context: ConsoleContext) => Promise<void>;
}
