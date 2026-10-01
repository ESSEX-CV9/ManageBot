const { mysteryDataPath } = require('./dataPath');
// 恶魔轮盘对局快照存储（独立断连接续用，不依赖共享游戏框架）。
// 把进行中的对局序列化为 JSON 存在 data/mystery/devilRouletteActiveGames.json：
//   - 每次渲染/状态变更后 save(gameId, snapshot)；
//   - 对局真正收尾后 remove(gameId)；
//   - 启动时 list() 读回全部未完成对局，恢复面板继续打。
// 写入走「临时文件 + rename」原子替换 + 串行队列，避免进程崩溃留下半截文件（同 bombCooldownStore 模式）。

const fs = require('node:fs/promises');
const path = require('node:path');

let temporaryFileSequence = 0;

function logFailure(operation, error) {
    console.error(`[DevilRouletteResume] ${operation} failed:`, error);
}

function createDevilRouletteResumeStore({ filePath, now = Date.now } = {}) {
    let snapshots = {}; // gameId -> snapshot object
    let writeQueue = Promise.resolve();
    let lastWriteError = null;
    let loaded = false;
    let loading = null;

    async function ensureDirectory() {
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            return true;
        } catch (error) {
            logFailure('creating resume directory', error);
            lastWriteError = error;
            return false;
        }
    }

    async function writeSnapshot() {
        if (!await ensureDirectory()) return;
        const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${temporaryFileSequence++}.tmp`;
        const payload = JSON.stringify(snapshots);
        try {
            await fs.writeFile(temporaryPath, payload, 'utf8');
        } catch (error) {
            logFailure('writing temporary resume file', error);
            lastWriteError = error;
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary resume file', cleanupError);
            }
            return;
        }
        try {
            await fs.rename(temporaryPath, filePath);
            lastWriteError = null;
        } catch (error) {
            logFailure('renaming temporary resume file', error);
            lastWriteError = error;
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') logFailure('cleaning up temporary resume file', cleanupError);
            }
        }
    }

    function queueWrite(mutate) {
        writeQueue = writeQueue.then(async () => {
            // A first mutation must never replace snapshots that have not been read.
            await ensureLoaded();
            mutate();
            await writeSnapshot();
        }).catch(error => {
            lastWriteError = error;
            logFailure('loading or writing resume data', error);
        });
        return writeQueue;
    }

    async function ensureLoaded(reload = false) {
        if (loading) return loading;
        if (loaded && !reload) return;
        loaded = false;
        loading = (async () => {
            let value;
            try {
                value = JSON.parse(await fs.readFile(filePath, 'utf8'));
                if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Resume data must be a JSON object');
            } catch (error) {
                // Unreadable or malformed data must block recovery and writes; keep the file intact.
                if (error.code !== 'ENOENT') throw error;
                value = {};
            }
            snapshots = value;
            loaded = true;
        })();
        try {
            await loading;
        } finally {
            loading = null;
        }
    }

    async function load() {
        await writeQueue;
        await ensureLoaded(true);
    }

    function save(gameId, snapshot) {
        if (!gameId || !snapshot || typeof snapshot !== 'object') return;
        // The engine's serialized fields still reference live state. Detach them
        // before queuing, using the same JSON representation that reaches disk.
        const value = JSON.parse(JSON.stringify({ ...snapshot, savedAt: now() }));
        void queueWrite(() => { snapshots[gameId] = value; });
    }

    function remove(gameId) {
        if (gameId) void queueWrite(() => { delete snapshots[gameId]; });
    }

    async function list() {
        await load();
        // Restored engines may mutate these objects; keep the stored copies private.
        return JSON.parse(JSON.stringify(Object.values(snapshots).filter(snapshot => snapshot && typeof snapshot === 'object')));
    }

    async function flush({ strict = false } = {}) {
        try {
            await writeQueue;
        } catch (error) {
            logFailure('flushing resume writes', error);
            lastWriteError = error;
        }
        if (strict && lastWriteError) throw lastWriteError;
    }

    return { save, remove, list, load, flush };
}

const defaultStore = createDevilRouletteResumeStore({
    filePath: mysteryDataPath('devilRouletteActiveGames.json'),
});

module.exports = {
    createDevilRouletteResumeStore,
    save: defaultStore.save,
    remove: defaultStore.remove,
    list: defaultStore.list,
    load: defaultStore.load,
    flush: defaultStore.flush,
};
