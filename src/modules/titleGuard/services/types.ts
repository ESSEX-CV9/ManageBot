// src/modules/titleGuard/services/types.ts
//
// 标题规范模块的引擎层类型。
// 这一层是纯逻辑：不碰 Discord、不碰数据库，输入标题+TAG+配置，输出违规清单。
// 好处是可以脱离机器人单独跑测试（见 *.test.ts）。

/** 分类组标识，如 '纯爱' / 'NTR' / '百破'。规则的运算单位。 */
export type GroupId = string;

/** 词典条目的类型 */
export type DictKind =
    | '分类词'    // 映射到某个分类组，参与互斥判定
    | '黑名单'    // 污染词：词面含别组的受保护关键字，命中后替换为 replaceTo
    | '白名单'    // 明确「不算分类标记」，用于吃掉误判
    | '中性标记'; // 如「多路线」，不属于任何互斥集合，不影响判定

/**
 * 词档。决定这个词落在**标题主体**里时，判定尺度有多严。
 *
 * 本体词 —— 词面就是某个受保护的搜索关键字本身。
 *   全社区一共就六个：纯爱、NTR、NTL、百合、百破、百合破坏。
 *   这几个字只要写进标题，别人搜这个词就一定搜得到，不管它在句子里
 *   充当主语还是形容词。所以不许拿「只是个形容词」「删了不通顺」当理由放行。
 *
 * 关联词 —— 语义上跟某个分类有关，但词面不碰任何受保护关键字。
 *   绿帽、出轨、黄毛、女同、牛头人、1v1……
 *   写在标题主体里，多半是在描述人物或情节，不是在给作品归类：
 *     「明明是绿帽癖的我，怎么会被辣妹逆推，这辈子好像只能搞纯爱了」
 *   这是一部纯爱作品，「绿帽癖」是人设。所以这类词在主体里要结合上下文判，
 *   默认往「描述」那边靠——它没污染任何一个大关键字的搜索结果。
 *
 * 注意：**词档只在标题主体里起作用。** 进了明写的标签区（方括号、竖线区、TAG），
 * 不管哪一档都是作者亲手盖的章，一律当分类声明，程序直接判。
 */
export type WordTier = '本体' | '关联';

/** 词典条目的生效范围 */
export type DictScope = '全标题' | '仅标记段' | '仅主体段';

export interface DictEntry {
    /** 词面。存库时即为归一化形式（小写、NFKC） */
    word: string;
    kind: DictKind;
    /** 所属分类组；白名单为 null */
    group: GroupId | null;
    /** 词档，见 WordTier。默认「关联」——本体词是明确列举出来的少数 */
    tier: WordTier;
    scope: DictScope;
    /** 污染词的替换目标，如 '纯爱牛' -> 'NTR'。为空则直接删除 */
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
 * 但一组分类在两个维度上互不互斥是分开配的，四种组合都成立。
 *
 * 社区现行规则里 NTR 和 NTL 就是个活例子：
 *   TAG 维度互斥   —— 一个帖子只能挂一个，挂两个是分类不清
 *   关键字维度兼容 —— 标题里两个词可以并排写，因为一部作品确实可以两样都有
 * 所以关键字维度必须配成「纯爱/NTR」和「纯爱/NTL」两组，
 * 而不是「纯爱/NTR/NTL」一组——后者会把 NTR 和 NTL 也判成互斥。
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
 * 要都禁就得写两条。现行规则里：
 *   纯爱TAG ⊥ NTR词 / NTL词      NTR TAG ⊥ 纯爱词      NTL TAG ⊥ 纯爱词
 *   NTR TAG 和 NTL 词兼容         NTL TAG 和 NTR 词兼容（不写就是兼容）
 *   百合TAG ⊥ 百破词              百合词和百破词兼容（「百合破坏」本来就得写百合两个字）
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
 *
 * **前缀和后缀一视同仁。** 社区里两种写法都很常见：
 *   【纯爱/1v1】某某某          某某某[纯爱/救赎/手枪卡]
 * 都是作者在给作品贴标签，没理由区别对待。
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
     * 方括号写得规规矩矩的、竖线夹住的、整段就是一个词典词的 → true，是作者亲手盖的章；
     * 靠斜杠罗列 + 紧贴括号推出来的、括号没闭合的 → false，拿不准，按主体待遇送 LLM。
     * 主体段恒为 false（它本来就不承诺自己是标签）。
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

/**
 * 一处命中在这条标题里算不算「作者在给作品归类」。
 *
 *   声明 —— 板上钉钉。写在明写的标签区里，作者亲手盖的章，没什么可问的。
 *   待定 —— 落在标题主体里。**程序一律不在这儿下结论**，交给模型。
 *
 * 词档（本体/关联）不改变这个分派，只改变模型判的时候尺子有多严。
 */
export type Declaration = '声明' | '待定';

// ---------- 判定 ----------

/**
 * 违规类型。只有四种，对应四种互斥关系：
 *
 *   W  关键字 × 关键字   标题里同时出现互斥分类组的词
 *   G  TAG × TAG         帖子同时挂了互斥的 TAG
 *   X  TAG × 关键字      挂着某个 TAG，标题里却出现了它不兼容的关键字（有方向）
 *   B  污染词            词面含别组受保护关键字的词，如「纯爱牛」
 *
 * 注意这里**没有**按位置分出不同的码。位置不产生新的规矩，
 * 它只决定这条违规归谁裁决——见 Violation.arbiter。
 */
export type RuleCode = 'W' | 'G' | 'X' | 'B';

/**
 * 这条违规谁说了算。
 *
 *   程序 —— 涉事的词全都写在明写的标签区里（或纯粹是 TAG 之间打架）。
 *           作者自己盖的章，按保留顺序直接改，不花钱调模型。
 *   LLM  —— 有任何一处涉事的词落在标题主体里。
 *           主体里的事程序一概不下判断：一句话里的「绿帽」到底是在归类还是在描述人物，
 *           只有读过标题和首楼才知道。
 */
export type Arbiter = '程序' | 'LLM';

export interface Violation {
    rule: RuleCode;
    /** 给人看的说明 */
    message: string;
    /** 涉事的标题命中 */
    hits: Match[];
    /**
     * 涉事的分类组。
     * X（交叉互斥）的顺序固定为 [关键字侧, TAG 侧]，下游靠它分辨哪边是哪边。
     */
    groups: GroupId[];
    /** 涉事的 TAG id（G / X 才有） */
    tagIds: string[];
    /** 谁来裁决，见 Arbiter */
    arbiter: Arbiter;
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
    /** 是否存在要交给模型裁决的违规 */
    needsLlm: boolean;
}
