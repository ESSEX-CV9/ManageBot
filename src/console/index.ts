import 'dotenv/config';

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import messageMaintenanceConsole from './modules/messageMaintenanceConsole';
import webConsole from './modules/webConsole';
import type { ConsoleContext, ConsoleModule } from './types';

const modules: ConsoleModule[] = [messageMaintenanceConsole, webConsole];

function clear(): void {
    stdout.write('\x1b[2J\x1b[H');
}

async function main(): Promise<void> {
    process.title = 'Manage Bot Console';
    const rl = createInterface({ input: stdin, output: stdout });
    const context: ConsoleContext = {
        rl,
        clear,
        pause: async (message = '按 Enter 继续...') => {
            await rl.question(`\n${message}`);
        },
    };

    try {
        while (true) {
            clear();
            console.log('Manage Bot · 本地管理控制台');
            console.log('═'.repeat(44));
            modules.forEach((module, index) => {
                console.log(`${index + 1}. ${module.title}`);
                console.log(`   ${module.description}`);
            });
            console.log('0. 退出');

            const answer = (await rl.question('\n选择模块：')).trim();
            if (answer === '0' || answer.toLowerCase() === 'q') break;
            const selected = modules[Number(answer) - 1];
            if (selected) await selected.run(context);
        }
    } finally {
        rl.close();
        clear();
    }
}

void main().catch(error => {
    console.error('\n本地控制台异常：', error);
    process.exitCode = 1;
});
