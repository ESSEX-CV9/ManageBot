// src/core/config/timeconfig.ts
//
// 通用时间/调度配置：测试/生产模式开关、后台任务检查间隔、北京时间白天/夜晚判定、启动时打印。
// 模块专用的时间参数请放到对应模块内。

// 是否为测试模式（true = 时间大幅缩短，便于本地验证；false = 生产模式）
export const TEST_MODE = false;

// 后台任务检查间隔（分钟）。模版模块的调度器会读取 templateCheck。
interface IntervalConfig {
    templateCheck: number;
    /** 募选调度器：检查是否有场次到点需要开投票/结算。 */
    electionCheck: number;
}

const TEST_CONFIG: IntervalConfig = {
    templateCheck: 0.5,
    electionCheck: 0.25,
};

const PRODUCTION_CONFIG: IntervalConfig = {
    templateCheck: 30,
    electionCheck: 0.5,
};

// 北京时间白天时段配置
export const DAY_NIGHT_CONFIG = {
    DAY_START_HOUR: 8,   // 白天开始（8点）
    DAY_END_HOUR: 23,    // 白天结束（23点）；若小于开始时间表示跨越午夜
};

/**
 * 判断当前是否为白天（基于北京时间 UTC+8）。
 */
export function isDayTime(): boolean {
    const now = new Date();
    const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const hour = beijingTime.getUTCHours();

    const { DAY_START_HOUR: startHour, DAY_END_HOUR: endHour } = DAY_NIGHT_CONFIG;

    if (endHour < startHour) {
        // 跨越午夜：例如 22:00 - 次日 6:00 为夜晚
        return hour >= startHour || hour < endHour;
    }
    return hour >= startHour && hour < endHour;
}

/**
 * 获取当前时段标识文字。
 */
export function getCurrentTimeMode(): string {
    return isDayTime() ? '☀️ 白天模式' : '🌙 夜晚模式';
}

/**
 * 获取白天时段描述。
 */
export function getTimeRangeDescription(): string {
    const { DAY_START_HOUR: startHour, DAY_END_HOUR: endHour } = DAY_NIGHT_CONFIG;
    return endHour < startHour
        ? `${startHour}:00 - 次日${endHour}:00`
        : `${startHour}:00 - ${endHour}:00`;
}

/**
 * 获取当前生效的配置对象。
 */
export function getTimeConfig(): IntervalConfig {
    return TEST_MODE ? TEST_CONFIG : PRODUCTION_CONFIG;
}

/**
 * 获取各后台任务的检查间隔（毫秒）。
 * 新模块的调度器可在此扩展自己的间隔项。
 */
export function getCheckIntervals(): Record<keyof IntervalConfig, number> {
    const config = getTimeConfig();
    return {
        templateCheck: config.templateCheck * 60 * 1000,
        electionCheck: config.electionCheck * 60 * 1000,
    };
}

/**
 * 启动时打印当前时间配置。
 */
export function printTimeConfig(): void {
    const mode = TEST_MODE ? '🧪 测试模式' : '🚀 生产模式';
    console.log(`\n=== 时间配置 - ${mode} ===`);
    console.log(`⏰ 当前时段: ${getCurrentTimeMode()}`);
    console.log(`☀️ 白天时段: ${getTimeRangeDescription()} (北京时间)`);
    console.log(`🔁 模版调度间隔: ${getTimeConfig().templateCheck} 分钟`);
    console.log(`===============================\n`);
}
