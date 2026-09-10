// src/modules/titleGuard/services/types.ts
//
// 标题规范模块的引擎层类型。
// 这一层是纯逻辑：不碰 Discord、不碰数据库，输入标题+配置，输出违规清单。
// 好处是可以脱离机器人单独跑测试（见 *.test.ts）。

/** 分类组标识，如 '纯爱' / 'NTR' / '百破'。规则的运算单位。 */
export type GroupId = string;

/** 词典条目的类型 */
export type DictKind =
    | '分类词'    // 映射到某个分类组，参与互斥判定
    | '黑名单'    // 命中即违规，替换为 replaceTo
    | '白名单'    // 明确「不算分类标记」，用于吃掉误判
    | '中性标记'; // 如「多路线」，不属于任何互斥集合，不影响判定

/** 词典条目的生效范围 */
export type DictScope = '全标题' | '仅标记段' | '仅主体段';

export interface DictEntry {
    /** 词面。存库时即为归一化形式（小写、NFKC） */
    word: string;
    kind: DictKind;
    /** 所属分类组；白名单为 null */
    group: GroupId | null;
    scope: DictScope;
    /** 黑名单词的替换目标，如 '纯爱牛' -> 'NTR'。为空则直接删除 */
    replaceTo: string | null;
    /**
     * 是否强制 ASCII 词边界。
     * 对 NTR / GL / les / 1v1 这类拉丁词必须打开，
     * 否则 GL 会命中 ENGLISH、les 会命中 files。
     */
    asciiBoundary: boolean;
    note?: string;
}

/**
 * 互斥作用在哪个维度上。
 *
 * TAG 和标题关键字是**两套独立的东西**，都是为了让搜索和筛选好使，
 * 但一组分类在两个维度上互不互斥是分开配的，四种组合都成立：
 *
 *   TAG 互斥 + 关键字互斥      —— 纯爱 / NTR，两边都不许同时出现
 *   TAG 互斥 + 关键字不互斥    —— TAG 只能挂一个，标题里怎么写随意
 *   TAG 不互斥 + 关键字互斥    —— TAG 可以并存，标题里不许同时写
 *   TAG 不互斥 + 关键字不互斥  —— 压根不是一对互斥分类
 */
export type ExclusiveDimension = 'tag' | 'word';

/** 一个互斥集合内的分类组只能出现一个。dimension 决定这条规矩管的是 TAG 还是标题关键字 */
export interface ExclusiveSet {
    dimension: ExclusiveDimension;
    groups: GroupId[];
    note?: string;
}

/**
 * 交叉互斥：挂了 tagGroup 的 TAG，标题里就不许出现 wordGroup 的关键字。
 *
 * 这是横跨两个维度的第三种互斥，**有方向**——
 * 「TAG 纯爱 × 关键字 NTR」和「TAG NTR × 关键字 纯爱」是两条独立的规矩，
 * 要都禁就得写两条。
 *
 * 纯爱和 NTR 是两个方向都禁；
 * 百合和百破则只有一个方向：关键字层面它俩完全可以并存
 * （「百合破坏」本来就得写百合两个字），但挂了百合 TAG 就不许标题里写百破。
 */
export interface CrossExclusion {
    tagGroup: GroupId;
    wordGroup: GroupId;
    note?: string;
}

/**
 * 喂给中文分词器的词，用来纠正它的切分。
 *
 * 分词闸只放行「正好落在词边界上」的命中，所以分词器切错了，判定就跟着错：
 *   分词器不认识「牛逼」→ 切成「纯爱/牛/逼」→「纯爱牛」正好横跨两个词，误判放行
 *   分词器把「戴绿帽」当成一个词 →「绿帽」抠不出来，真正的 NTR 漏判
 * 前者要**补词**，后者要**拆词**。
 */
export interface SegmenterWord {
    word: string;
    /** 补词：分词器不认识，加给它；拆词：分词器粘得太狠，拆开 */
    action: '补词' | '拆词';
    note?: string;
}

export interface GuardConfig {
    dict: DictEntry[];
    /** 分词词库。代码里不内置，全部由管理组维护 */
    segmenterWords: SegmenterWord[];
    /** TAG 之间、关键字之间的互斥集合，靠 dimension 区分 */
    exclusiveSets: ExclusiveSet[];
    /** 跨 TAG 与关键字的互斥 */
    crossExclusions: CrossExclusion[];
    /**
     * 分类组优先级，数值大的优先保留。
     * 社区既定规则：NTR > NTL > 纯爱。
     * 一个帖子挂了多个互斥 TAG 时，靠它决定留哪个，不必转人工。
     */
    groupPriority: Record<GroupId, number>;
    /**
     * 「多路线」这个中性 TAG 对应的分类组名。
     * 摘掉互斥 TAG 后要自动补上它——因为原来挂多个互斥 TAG 的帖子，
     * 作者的意思通常就是「有多条线」，规范写法是「主分类 + 多路线」。
     * 注意：这只作用于 **TAG**，标题里的「多路线」三个字机器人不会替作者加。
     */
    multiRouteGroup: GroupId | null;
}

// ---------- 归一化 ----------

export interface NormalizedTitle {
    /** 原始标题 */
    original: string;
    /** 归一化后的文本 */
    text: string;
    /** srcStart[i] = text[i] 在 original 中的起始下标 */
    srcStart: number[];
    /** srcEnd[i] = text[i] 在 original 中的结束下标（不含） */
    srcEnd: number[];
}

// ---------- 结构切分 ----------

export type SegmentKind = 'marker' | 'body';

/**
 * 标记段在标题里的位置。
 * 前缀 = 标题开头那一串标记；后缀 = 结尾那一串；夹在正文中间的算中部。
 * 主体段一律是 body。
 */
export type SegmentPosition = 'prefix' | 'middle' | 'suffix' | 'body';

export interface Segment {
    kind: SegmentKind;
    position: SegmentPosition;
    /** 在归一化文本中的区间 [start, end) */
    start: number;
    end: number;
    text: string;
    /**
     * 括号是否闭合。未闭合的标记段（如「【NTR 标题名」缺右括号）
     * 结构不规范，处置要降一档：只通知，不自动改。
     */
    wellFormed: boolean;
    /**
     * 有多确信这真是一个标签区。
     * 方括号写得规规矩矩的、竖线夹住的、整段就是一个词典词的 → true，冲突可以直接自动整改；
     * 靠斜杠罗列 + 紧贴括号推出来的、括号没闭合的 → false，冲突得先交给 LLM 定性。
     * 主体段恒为 true（它本来就不承诺自己是标签）。
     */
    confident: boolean;
    /** 该标记段来自哪种括号；来自首尾分隔结构时为 null */
    bracket: { open: string; close: string } | null;
}

// ---------- 匹配 ----------

export interface Match {
    entry: DictEntry;
    /** 在归一化文本中的区间 [start, end) */
    start: number;
    end: number;
    /** 命中所在段的下标 */
    segmentIndex: number;
    segmentKind: SegmentKind;
}

// ---------- 判定 ----------

export type RuleCode =
    | 'T1'  // 黑名单词
    | 'T2'  // 标记段内冲突
    | 'T3'  // 主体段内冲突
    | 'T4'  // 交叉互斥：TAG 与标题关键字打架
    | 'G1'; // TAG 互斥

export interface Violation {
    rule: RuleCode;
    /** 给人看的说明 */
    message: string;
    /** 涉事的标题命中 */
    hits: Match[];
    /** 涉事的分类组 */
    groups: GroupId[];
    /** 涉事的 TAG id（G1/T4 才有） */
    tagIds: string[];
    /**
     * 是否必须先经 LLM 判定「这些词是不是在做分类标记」才能定性。
     * T3/T4 恒为 true；其余为 false。
     */
    needsLlm: boolean;
}

/** 一个 TAG 及其映射到的分类组 */
export interface AppliedTag {
    tagId: string;
    tagName: string;
    /** 该 TAG 映射到的分类组；未映射为 null */
    group: GroupId | null;
}

/** 论坛可用的全部 TAG（不只是帖子已挂的）。补「多路线」TAG 时要从这里找 */
export type ForumTag = AppliedTag;

export interface DetectInput {
    title: string;
    tags: AppliedTag[];
    config: GuardConfig;
}

export interface DetectResult {
    normalized: NormalizedTitle;
    segments: Segment[];
    /** 最大覆盖切分后最终采纳的命中 */
    matches: Match[];
    violations: Violation[];
    /** 是否存在需要 LLM 定性的违规 */
    needsLlm: boolean;
}
