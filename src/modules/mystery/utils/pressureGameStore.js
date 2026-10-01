const { mysteryDataPath } = require('./dataPath');
// 加压轮盘的「进行中对局」快照存储。
//
// 为什么要有它：整个神秘游戏系统的对局状态都只活在内存里，推送更新重启一次
// 就全没了 —— 玩家盯着一堆点了就回「已失效」的按钮，一局白打。
// 这里把对局状态落到磁盘，重启后由 restorePressureGames 捞回来接着打。
//
// 设计取舍：
// - **只在稳定检查点写**（轮到某人开枪 / 进入选择 / 进入和局投票 / 招募中）。
//   崩在两个检查点之间最多回退一个动作，不会写出「淘汰到一半」的状态。
// - **整份重写 + 原子改名**。一场对局的快照撑死几 KB，同时进行的对局也就几场，
//   没必要上数据库；rename 保证读到的要么是旧的完整文件，要么是新的完整文件。
// - **同步写**。调用点全在 runExclusive 的临界区外围，写几 KB JSON 是微秒级，
//   换来的是「函数返回时数据一定已经落盘」，不用操心异步写和进程退出赛跑。

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = mysteryDataPath();
const STORE_FILE = path.join(DATA_DIR, 'pressureActiveGames.json');
const TEMP_FILE = `${STORE_FILE}.tmp`;
const failedMutations = new Map();
const PRUNE_MUTATION = Symbol('prune-expired-snapshots');
const CLEAR_MUTATION = Symbol('clear-snapshots');

// 不支持的版本保留原文件并阻止恢复/写入，交由明确的数据迁移处理。
const SNAPSHOT_VERSION = 3;

// 超过这个时间的快照不再恢复：多半是机器人停机很久，玩家早就散了，
// 硬把一局几小时前的游戏拉起来只会莫名其妙。
const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function logFailure(action, error) {
    console.error(`[PressureGameStore] ${action} 失败:`, error);
}

function readStore() {
    let raw;
    try {
        raw = fs.readFileSync(STORE_FILE, 'utf8');
    } catch (error) {
        // 只有文件不存在能表示空存储；权限/网络/目录错误不能被解释为没有旧对局。
        if (error?.code === 'ENOENT') return { version: SNAPSHOT_VERSION, games: {} };
        throw error;
    }
    if (!raw.trim()) throw new Error('加压轮盘快照文件为空，保留原文件等待恢复');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== SNAPSHOT_VERSION) throw new Error('不支持的加压轮盘快照版本，保留原文件等待迁移');
    if (!parsed.games || typeof parsed.games !== 'object' || Array.isArray(parsed.games)) {
        throw new Error('加压轮盘快照 games 必须为对象');
    }
    return parsed;
}

function recordFailure(action, error, mutationId) {
    logFailure(action, error);
    failedMutations.set(mutationId, error);
    return false;
}

function writeStore(store, mutationId) {
    try {
        ensureDir();
        fs.writeFileSync(TEMP_FILE, JSON.stringify(store), 'utf8');
        fs.renameSync(TEMP_FILE, STORE_FILE);
        // 整份写盘不代表之前失败的另一局已补写成功。
        failedMutations.delete(mutationId);
        return true;
    } catch (error) {
        return recordFailure('写入快照', error, mutationId);
    }
}

/** 存 / 更新一局的快照。 */
function saveSnapshot(gameId, snapshot) {
    if (!gameId || !snapshot) return false;
    try {
        const store = readStore();
        store.games[gameId] = snapshot;
        store.savedAt = Date.now();
        return writeStore(store, gameId);
    } catch (error) {
        return recordFailure('读取后保存快照', error, gameId);
    }
}

/** 一局结束（或判定为不可恢复）时把它的快照抹掉。 */
function deleteSnapshot(gameId) {
    if (!gameId) return false;
    try {
        const store = readStore();
        if (!store.games[gameId]) return false;
        delete store.games[gameId];
        store.savedAt = Date.now();
        return writeStore(store, gameId);
    } catch (error) {
        return recordFailure('读取后删除快照', error, gameId);
    }
}

/**
 * 取出所有还值得恢复的快照，同时把过期的清理掉。
 * @returns {Array<object>} 快照数组，调用方自己判断能不能恢复
 */
function loadSnapshots() {
    const store = readStore();
    const now = Date.now();
    const fresh = [];
    let dropped = 0;

    for (const [gameId, snapshot] of Object.entries(store.games)) {
        const savedAt = Number(snapshot?.savedAt) || 0;
        // 已进入结算的待办没有过期时间：数据库/Discord 暂时失败不能丢掉战绩。
        if (!savedAt || (!snapshot?.pendingSettlement && now - savedAt > MAX_SNAPSHOT_AGE_MS)) {
            delete store.games[gameId];
            dropped += 1;
            continue;
        }
        fresh.push(snapshot);
    }

    if (dropped > 0 && !writeStore(store, PRUNE_MUTATION)) throw failedMutations.get(PRUNE_MUTATION);
    return fresh;
}

/** 显式清空存储；恢复流程必须逐局处理，不能使用此函数。 */
function clearAll() {
    try {
        readStore();
        return writeStore({ version: SNAPSHOT_VERSION, games: {}, savedAt: Date.now() }, CLEAR_MUTATION);
    } catch (error) {
        return recordFailure('读取后清空快照', error, CLEAR_MUTATION);
    }
}

async function flush({ strict = false } = {}) {
    if (strict && failedMutations.size > 0) throw [...failedMutations.values()].at(-1);
}

module.exports = {
    flush,
    STORE_FILE,
    SNAPSHOT_VERSION,
    MAX_SNAPSHOT_AGE_MS,
    saveSnapshot,
    deleteSnapshot,
    loadSnapshots,
    clearAll,
};
