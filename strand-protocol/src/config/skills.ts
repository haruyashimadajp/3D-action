/**
 * STRAND // PROTOCOL — Roguelite data: 15 technical skills, 5-sector structure,
 * endless-loop scaling, rank criteria and hardcore challenge modifiers (§8).
 */

// ---------------------------------------------------------------------------
// §8.1 Sector structure
// ---------------------------------------------------------------------------
export type EnemyKind = 'ENFORCER' | 'AEGIS' | 'VEIL' | 'PHANTOM' | 'DRONE' | 'VALKYRIE';

export interface SectorWave {
  readonly count: number;
}

/** District layout family: street grid (Sectors 1–4) or central scramble with a ring of supertalls (Sector 5). */
export type DistrictLayout = 'GRID' | 'RING';

export interface SectorDef {
  readonly index: number;
  readonly name: string;
  readonly subtitle: string;
  readonly layout: DistrictLayout;
  /** Number of low-rise … supertall towers in the district (14–22). */
  readonly buildingCount: number;
  /** Building height band (m) inside 16 … 95 m. */
  readonly heightMin: number;
  readonly heightMax: number;
  /** Elevated expressways (Y = 9.5 m). */
  readonly highways: number;
  /** Two expressways crossing at grade (Sector 3). */
  readonly highwayCrossing: boolean;
  /** Ring expressway around the central plaza (Sector 5). */
  readonly highwayRing: boolean;
  /** Ground-connected on-ramps (one per expressway system). */
  readonly onRamps: number;
  /** Canal through (or around) the district. */
  readonly canal: 'NONE' | 'THROUGH' | 'OUTER_RING';
  /** Neon truss bridges over the canal. */
  readonly bridges: number;
  /** Narrow wall-run alleys between towers (Sector 3). */
  readonly narrowAlleys: boolean;
  /** Mid-level (Layer 2) sky-bridges between towers. */
  readonly skyBridges: number;
  /** Dense low-rise neon sign street (Sector 4). */
  readonly denseNeon: boolean;
  /** Central scramble crossing plaza (Sector 5). */
  readonly scramblePlaza: boolean;
  /** Parked cyber-cars on streets / expressways (25–45). */
  readonly parkedCars: number;
  readonly waves: readonly SectorWave[];
  /** Total enemy composition (excluding boss summons). */
  readonly roster: Readonly<Partial<Record<EnemyKind, number>>>;
  /** Boss phase-2 summons (sector 5). */
  readonly bossSummons?: Readonly<Partial<Record<EnemyKind, number>>>;
  readonly reward: 'SKILL' | 'RUN_COMPLETE';
}

export const SECTORS: readonly SectorDef[] = [
  {
    index: 1, name: 'SECTOR 01', subtitle: 'MAIN AVENUE // EXPRESSWAY ENTRANCE',
    layout: 'GRID', buildingCount: 14, heightMin: 18, heightMax: 65,
    highways: 1, highwayCrossing: false, highwayRing: false, onRamps: 1,
    canal: 'NONE', bridges: 0, narrowAlleys: false, skyBridges: 2, denseNeon: false, scramblePlaza: false,
    parkedCars: 28,
    waves: [{ count: 4 }, { count: 5 }],
    roster: { ENFORCER: 7, VEIL: 2 },
    reward: 'SKILL',
  },
  {
    index: 2, name: 'SECTOR 02', subtitle: 'CANAL // TRUSS BRIDGE QUARTER',
    layout: 'GRID', buildingCount: 16, heightMin: 18, heightMax: 75,
    highways: 1, highwayCrossing: false, highwayRing: false, onRamps: 1,
    canal: 'THROUGH', bridges: 2, narrowAlleys: false, skyBridges: 2, denseNeon: false, scramblePlaza: false,
    parkedCars: 32,
    waves: [{ count: 6 }, { count: 7 }],
    roster: { ENFORCER: 5, AEGIS: 3, VEIL: 2, DRONE: 3 },
    reward: 'SKILL',
  },
  {
    index: 3, name: 'SECTOR 03', subtitle: 'EXPRESSWAY INTERCHANGE // HIGH-RISE ALLEYS',
    layout: 'GRID', buildingCount: 18, heightMin: 22, heightMax: 85,
    highways: 2, highwayCrossing: true, highwayRing: false, onRamps: 2,
    canal: 'NONE', bridges: 0, narrowAlleys: true, skyBridges: 6, denseNeon: false, scramblePlaza: false,
    parkedCars: 36,
    waves: [{ count: 8 }, { count: 8 }],
    roster: { ENFORCER: 5, AEGIS: 3, VEIL: 3, PHANTOM: 2, DRONE: 3 },
    reward: 'SKILL',
  },
  {
    index: 4, name: 'SECTOR 04', subtitle: 'NEON CANAL DISTRICT // TWIN EXPRESSWAYS',
    layout: 'GRID', buildingCount: 22, heightMin: 24, heightMax: 95,
    highways: 2, highwayCrossing: false, highwayRing: false, onRamps: 2,
    canal: 'THROUGH', bridges: 3, narrowAlleys: false, skyBridges: 3, denseNeon: true, scramblePlaza: false,
    parkedCars: 42,
    waves: [{ count: 9 }, { count: 11 }],
    roster: { ENFORCER: 5, AEGIS: 4, VEIL: 4, PHANTOM: 3, DRONE: 4 },
    reward: 'SKILL',
  },
  {
    // Spec gives no car count for Sector 5; 34 sits inside the 25–45 global band.
    index: 5, name: 'SECTOR 05', subtitle: 'CENTRAL SCRAMBLE // VALKYRIE-09',
    layout: 'RING', buildingCount: 16, heightMin: 30, heightMax: 95,
    highways: 1, highwayCrossing: false, highwayRing: true, onRamps: 1,
    canal: 'OUTER_RING', bridges: 4, narrowAlleys: false, skyBridges: 4, denseNeon: false, scramblePlaza: true,
    parkedCars: 34,
    waves: [{ count: 1 }],
    roster: { VALKYRIE: 1 },
    bossSummons: { DRONE: 3, VEIL: 2 },
    reward: 'RUN_COMPLETE',
  },
];

/** Endless Protocol scaling per loop (Loop 2+). */
export const ENDLESS = {
  ENEMY_HP_PER_LOOP: 0.25,
  LOCK_TIME_REDUCTION_PER_LOOP: 0.08,
  LOCK_TIME_FLOOR_MS: 140,
  SPAWN_COUNT_PER_LOOP: 0.2,
} as const;

// ---------------------------------------------------------------------------
// §8.2 Technical roguelite skills (max Lv.3 each)
// ---------------------------------------------------------------------------
export type SkillId =
  | 'SK_01' | 'SK_02' | 'SK_03' | 'SK_04' | 'SK_05'
  | 'SK_06' | 'SK_07' | 'SK_08' | 'SK_09' | 'SK_10'
  | 'SK_11' | 'SK_12' | 'SK_13' | 'SK_14' | 'SK_15';

export type SkillCategory = '切替連携' | '立体機動' | '武器特化' | '精密射撃' | 'バレットタイム' | '見切り回避' | '非交戦回復' | 'ハイリスク';

export interface SkillDef {
  readonly id: SkillId;
  readonly name: string;
  readonly nameEn: string;
  readonly category: SkillCategory;
  readonly trigger: string;
  /** Human-readable per-level effect text (Lv.1 / Lv.2 / Lv.3). */
  readonly levelText: readonly [string, string, string];
  /** Primary numeric parameter per level. */
  readonly values: readonly [number, number, number];
  /** Optional secondary numeric parameter per level. */
  readonly values2?: readonly [number, number, number];
}

export const SKILL_MAX_LEVEL = 3;

export const SKILLS: readonly SkillDef[] = [
  {
    id: 'SK_01', name: 'クイック・ドロウ', nameEn: 'QUICK DRAW', category: '切替連携',
    trigger: '銃⇄ワイヤー切替時',
    levelText: ['切替所要時間 -22%', '切替所要時間 -38%', '切替所要時間 -50%'],
    values: [0.22, 0.38, 0.5],
  },
  {
    id: 'SK_02', name: 'モメンタム・チャンバー', nameEn: 'MOMENTUM CHAMBER', category: '切替連携',
    trigger: 'ワイヤー解除（または切替）後 1.8s 以内',
    levelText: ['最初の2発に貫通＋弾速 +35%', '最初の3発に貫通＋弾速 +35%', '最初の4発に貫通＋弾速 +35%'],
    values: [2, 3, 4],
    values2: [0.35, 0.35, 0.35],
  },
  {
    id: 'SK_03', name: 'スイング・リローダー', nameEn: 'SWING RELOADER', category: '切替連携',
    trigger: 'ワイヤーぶら下がり中に銃へ切替えた瞬間',
    levelText: ['マガジン即時 +40% 補充', 'マガジン即時 +70% 補充', 'マガジン即時 +100% 補充'],
    values: [0.4, 0.7, 1.0],
  },
  {
    id: 'SK_04', name: 'ウォール・オーバークロック', nameEn: 'WALL OVERCLOCK', category: '立体機動',
    trigger: 'ウォールラン中のヘッドショット命中',
    levelText: ['BTゲージ +15% ＆ 即時リロード', 'BTゲージ +25% ＆ 即時リロード', 'BTゲージ +35% ＆ 即時リロード'],
    values: [15, 25, 35],
  },
  {
    id: 'SK_05', name: 'キネティック・ブーツ', nameEn: 'KINETIC BOOTS', category: '立体機動',
    trigger: '壁蹴り / スライドジャンプ時',
    levelText: ['初速 +12% / 壁走り +0.4s', '初速 +22% / 壁走り +0.8s', '初速 +32% / 壁走り +1.2s'],
    values: [0.12, 0.22, 0.32],
    values2: [0.4, 0.8, 1.2],
  },
  {
    id: 'SK_06', name: 'グラップル・コンデンサ', nameEn: 'GRAPPLE CONDENSER', category: '立体機動',
    trigger: 'ワイヤーで敵に直接フック命中時',
    levelText: ['スタン 1.1s ＆ ワイヤーCD即リセット', 'スタン 1.6s ＆ ワイヤーCD即リセット', 'スタン 2.2s ＆ ワイヤーCD即リセット'],
    values: [1.1, 1.6, 2.2],
  },
  {
    id: 'SK_07', name: 'ブラスト・スラスター', nameEn: 'BLAST THRUSTER', category: '武器特化',
    trigger: 'ショットガンの空中リコイルジャンプ時',
    levelText: ['反動 +20% ＆ 0.35s 重力半減', '反動 +35% ＆ 0.35s 重力半減', '反動 +50% ＆ 0.35s 重力半減'],
    values: [0.2, 0.35, 0.5],
    values2: [0.35, 0.35, 0.35],
  },
  {
    id: 'SK_08', name: 'サーマル・ヘッドハンター', nameEn: 'THERMAL HEADHUNTER', category: '精密射撃',
    trigger: 'レールピストルでのヘッドショットキル時',
    levelText: ['半径 4.5m 電磁ショック (65dmg＋予測線キャンセル)', '半径 6.0m 電磁ショック (65dmg＋予測線キャンセル)', '半径 7.5m 電磁ショック (65dmg＋予測線キャンセル)'],
    values: [4.5, 6.0, 7.5],
    values2: [65, 65, 65],
  },
  {
    id: 'SK_09', name: 'パルス・シールドブレイカー', nameEn: 'PULSE SHIELDBREAKER', category: '武器特化',
    trigger: 'SMGでイージス盾またはボス翼へ命中時',
    levelText: ['部位・盾ダメージ +40% ＆ 破壊時全弾補充', '部位・盾ダメージ +80% ＆ 破壊時全弾補充', '部位・盾ダメージ +120% ＆ 破壊時全弾補充'],
    values: [0.4, 0.8, 1.2],
  },
  {
    id: 'SK_10', name: 'クロノ・エクステンダー', nameEn: 'CHRONO EXTENDER', category: 'バレットタイム',
    trigger: 'バレットタイム発動中',
    levelText: ['消費速度 -18%', '消費速度 -32%', '消費速度 -44%'],
    values: [0.18, 0.32, 0.44],
  },
  {
    id: 'SK_11', name: 'ゼロ・タイム・ボーナス', nameEn: 'ZERO-TIME BONUS', category: 'バレットタイム',
    trigger: 'バレットタイム中の連続キル（1回の発動内）',
    levelText: ['2体目以降キルで解除時 +6 m/s (2.0s)', '2体目以降キルで解除時 +9 m/s (2.0s)', '2体目以降キルで解除時 +12 m/s (2.0s)'],
    values: [6, 9, 12],
    values2: [2.0, 2.0, 2.0],
  },
  {
    id: 'SK_12', name: 'ファントム・グレイズ', nameEn: 'PHANTOM GRAZE', category: '見切り回避',
    trigger: '敵予測線の見切り回避（GRAZE）成立時',
    levelText: ['BTゲージ +10% ＆ 周囲敵弾 0.6s 半減速', 'BTゲージ +18% ＆ 周囲敵弾 0.6s 半減速', 'BTゲージ +26% ＆ 周囲敵弾 0.6s 半減速'],
    values: [10, 18, 26],
    values2: [0.6, 0.6, 0.6],
  },
  {
    id: 'SK_13', name: 'ステルス・プロトコル', nameEn: 'STEALTH PROTOCOL', category: '非交戦回復',
    trigger: '非交戦リジェネ（撃たず・撃たれず）待機',
    levelText: ['リジェネ待機 3.0s → 2.5s', 'リジェネ待機 3.0s → 2.1s', 'リジェネ待機 3.0s → 1.7s'],
    values: [2500, 2100, 1700],
  },
  {
    id: 'SK_14', name: 'アドレナリン・サージ', nameEn: 'ADRENALINE SURGE', category: 'ハイリスク',
    trigger: 'プレイヤーHP <= 45（瀕死状態）の間',
    levelText: ['移動 +15% / 切替・リロード +30%', '移動 +22% / 切替・リロード +45%', '移動 +30% / 切替・リロード +60%'],
    values: [0.15, 0.22, 0.3],
    values2: [0.3, 0.45, 0.6],
  },
  {
    id: 'SK_15', name: 'ヘッドショット・リコシェ', nameEn: 'HEADSHOT RICOCHET', category: '精密射撃',
    trigger: '空中でのヘッドショットキル時',
    levelText: ['最寄り敵 (18m内) へ跳弾 1発 (55dmg)', '最寄り敵 (18m内) へ跳弾 2発 (55dmg)', '最寄り敵 (18m内) へ跳弾 3発 (55dmg)'],
    values: [1, 2, 3],
    values2: [55, 55, 55],
  },
];

export const SKILL_CONSTANTS = {
  MOMENTUM_WINDOW_S: 1.8,
  GRAPPLE_BASE_STUN_S: 0.4,
  RICOCHET_RANGE_M: 18,
  CHOICES_PER_CLEAR: 3,
} as const;

// ---------------------------------------------------------------------------
// §8.3 Rank criteria & challenge modifiers
// ---------------------------------------------------------------------------
export const RUN_RANK = {
  S_PLUS: { maxDeaths: 0, maxTimeS: 330, minHeadshotRate: 0.45 },
  S: { maxDeaths: 1, maxTimeS: 420, minAvgFlowRankIndex: 3 },
} as const;

export type ModifierId = 'ONE_SHOT_PROTOCOL' | 'NO_BULLET_TIME' | 'HYPER_SPEED';
export interface ModifierDef {
  readonly id: ModifierId;
  readonly label: string;
  readonly description: string;
  readonly scoreMultiplier: number;
}
export const MODIFIERS: readonly ModifierDef[] = [
  { id: 'ONE_SHOT_PROTOCOL', label: 'ONE-SHOT PROTOCOL', description: 'プレイヤーHP 1（全被弾即死）', scoreMultiplier: 1.5 },
  { id: 'NO_BULLET_TIME', label: 'NO BULLET TIME', description: 'バレットタイム封印', scoreMultiplier: 1.6 },
  { id: 'HYPER_SPEED', label: 'HYPER SPEED', description: '予測線ロック時間 -25% ＆ プレイヤー速度上限 +20%', scoreMultiplier: 1.4 },
];
export const HYPER_SPEED_LOCK_REDUCTION = 0.25;
export const HYPER_SPEED_SPEED_BONUS = 0.2;
export const ONE_SHOT_HP = 1;

/** Unlockable weapon energy colors (persisted). */
export const ENERGY_COLORS = [
  { id: 'CYAN', label: 'シアン', hex: 0x38f8ff },
  { id: 'CRIMSON', label: 'クリムゾン', hex: 0xff1e42 },
  { id: 'GOLD', label: 'ゴールド', hex: 0xffb800 },
  { id: 'VIOLET', label: 'バイオレット', hex: 0xb44bff },
  { id: 'WHITE', label: 'ピュアホワイト', hex: 0xffffff },
] as const;
