import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './database';

const LOG_DIR = path.join(DATA_DIR, 'runtime-logs');

function monthInShanghai(timestamp: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(new Date(timestamp));
    const year = parts.find(part => part.type === 'year')?.value ?? '0000';
    const month = parts.find(part => part.type === 'month')?.value ?? '00';
    return `${year}-${month}`;
}

/** 写入普通的本地运行记录；失败不会中断 Bot 的主要业务。 */
export function appendRuntimeFileRecord(
    event: string,
    details: Record<string, unknown>,
    timestamp = Date.now(),
): boolean {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
        const file = path.join(LOG_DIR, `service-${monthInShanghai(timestamp)}.txt`);
        const line = JSON.stringify({
            time: new Date(timestamp).toISOString(),
            event,
            ...details,
        });
        fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
        if (process.platform !== 'win32') {
            fs.chmodSync(LOG_DIR, 0o700);
            fs.chmodSync(file, 0o600);
        }
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[RuntimeFileLog] 本地运行记录写入失败：${message}`);
        return false;
    }
}
