# Phase 10 Implementation Progress Status

最終更新: 2026-11-25
対象ブランチ: `claude/loving-bohr-lb0uj2`

---

## 全体進捗サマリー (`PHASE10_OVERHAUL_PLAN.md`)

| ステップ | 対象セクション | 状態 | 概要 |
| --- | --- | --- | --- |
| **Step 10A-1** | `10A-1`, `10A-2`, `10A-4` | **完了 (Committed: `0f09d4e`)** | 60fps 描画・物理パイプライン最適化（12m CSR 空間グリッド + 2D DDA）、ビジュアル＆構造バグ修正（看板浮遊ゼロ・飛行船18mクリアランス）、5種スクリーンフィルター＆動的シャドウ切替 |
| **Step 10A-2** | `10A-3`, `10A-3b`, `10A-5`, `10A-6` | **完了 (今回実装・検証済み)** | 3Dマズルフラッシュ＆薬莢排出＆銃身蒸気、冷却弾痕デカール(48)、Sniper 4x ADS レンジファインダー、8の字ストライドヘッドボブ＆バネ・ダンパー反動キック、高所対応モバイル敵 `ALERT` 調査AI＆ボリューメトリックスキャナーコーン、左上 `136×136` 円形パルススキャン・ミニレーダー（Option C: 3D透視マーカー廃止） |
| **Step 10B** | `10B-1` 〜 `10B-4` | **完了 (今回実装・検証済み)** | 全有効ロット 92% 以上に建物（空き区画は屋根付きサイバー屋台市場 1 か所のみ）、外周 36 m 以上のスカイライン・内周 farTowers (115–220 m)、14 m 以内のみ表示される LockdownBarrier、看板の 100% 英語化、0.35 m 3D AABB 非重複ガード、`MegaBillboards` (2048×1024 英語広告アトラス, cap 140, +1 call: 大通りスクリーン / 90° L 字コーナー / モノリスブレード / 円筒リング)、`lampHalos` 内のミストハロー (+0)、4 種メガストラクチャ (+0)、5 セクターの個性とパレット |
| **Step 10C** | `10C-1` 〜 `10C-4` | **未着手** | 路面・街路ディテール強化（`StreetFurnishings` 統合、横断歩道・縁石・排水溝・蒸気ベント・`BillboardMist` 統合） |
| **Step 10D** | `10D-1` 〜 `10D-4` | **未着手** | 6B・7B・8A・9A・9B の統合ポリッシュおよび最終パフォーマンス・ビジュアル監査 |

---

## Step 10A-2（今回完了分）の実装詳細

### 1. `10A-3`: 一人称銃撃 VFX・薬莢排出・冷却弾痕デカール・4x ADS レンジファインダー
- **3D ファーストパーソン・マズルフラッシュ** ([`ViewModelRenderer.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/ViewModelRenderer.ts), [`EquipmentManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/EquipmentManager.ts)):
  - [`buildMuzzleFlashGeometry()`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/ViewModelRenderer.ts#L333-L421) により、直交3平面スターバースト + 先細り前方プラズマコーン + 側面マズルブレーキ噴射を単一ジオメトリに統合（発砲中のみ `+1` draw call、非発砲時は `visible = false` で `+0` draw call）。
  - 発砲ごとにランダム Z ロール (`0..2π`) とマイクロスケーリング (`0.85–1.18×`) を適用。
  - **MK-IV Rail Pistol**: 長さ `0.09 m`、半径 `0.045 m`、持続 `45 ms`。
  - **K-90 Rail Sniper**: 長さ `0.24 m`、半径 `0.11 m` + 側面マズルブレーキ噴射 (`±0.10 m`)、持続 `75 ms` + レシーバーと周囲の壁を照らす `70 ms` 動的マズル `PointLight`。
- **Sniper 発砲後の銃身ヒートベント蒸気 & 3D 薬莢排出** ([`ViewModelKit.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/ViewModelKit.ts), [`ViewModelRenderer.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/ViewModelRenderer.ts), [`EffectsPool.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EffectsPool.ts), [`EquipmentManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/EquipmentManager.ts)):
  - K-90 発砲時に `uBarrelHeat` ユニフォームが `1.0`（白シアン発光）へ跳ね上がり、`1.5 s` かけて通常のディープシアンへ冷却。冷却中は銃身ベントから上昇する半透明の蒸気パフ ([`EffectsPool.emitBarrelSteam()`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EffectsPool.ts)) を放出。
  - Pistol 発砲時および Sniper の `BOLT_OPEN` リロードビート時に `eject` ポートから回転する 3D 薬莢 ([`EffectsPool.spawnCasing()`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EffectsPool.ts)) を排出（`sparks` インスタンスプールを再利用し追加 draw call `0`・毎フレームアロケーション `0`）。
- **冷却する着弾スコーチ（焦げ跡）デカール** ([`EffectsPool.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EffectsPool.ts), [`constants.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/config/constants.ts)):
  - 48個リングバッファの `InstancedMesh` (`BulletScorchDecals`, `cap: 48`, `+1` draw call)。
  - 壁・路面・プロップ着弾時に法線方向 `+0.015 m` オフセットで配置（Pistol 半径 `0.08 m` / Sniper 半径 `0.15 m`）。
  - 着弾直後は中心が高温オレンジ・シアン (`emissive 2.8`) に発光し、`4.0 s` かけて黒い炭化クレーターへ滑らかに冷却。
- **Sniper 4x ADS デジタル・レンジファインダー** ([`index.html`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/index.html), [`HudManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/ui/HudManager.ts), [`main.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/main.ts)):
  - K-90 Sniper で ADS 中、画面中央レイキャスト距離（地形および敵ヒットボックスの最近傍距離）を算出し、レティクル右下にモノスペース距離表示 (`#xh-range`, `11px`, シアン `0.75` alpha, 例: `64m`, `112m`) を描画。

### 2. `10A-3b`: 8の字ストライド・ヘッドボブ & バネ・ダンパー銃撃反動カメラキック
- **8の字ストライド・ヘッドボブ** ([`PlayerController.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/PlayerController.ts#L1297-L1313)):
  - `GROUNDED` または `CROUCHING` 移動時に `stridePhase += speed * 0.62 * realDt` で位相を進め、滞空・スライディング・壁走り・停止時は滑らかに減衰。
  - 垂直ボブ `-Math.abs(Math.sin(stridePhase)) * (crouching ? 0.014 : 0.028)` m、水平シフト `Math.cos(stridePhase) * (crouching ? 0.006 : 0.012)` m、微小ロール `Math.sin(stridePhase) * (crouching ? 0.22 : 0.45)°` を適用。
  - ADS 中は `0.15×` に自動縮小し、`settings.shakeScale` / `settings.rollScale` に連動。
- **物理バネ・ダンパー銃撃反動キック** ([`PlayerController.onWeaponKick()`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/player/PlayerController.ts#L455-L473)):
  - 銃撃時のランダムな高周波 `trauma` シェイクを抑え、臨界減衰バネ (`kickPitch`, `kickRoll`, `kickZ`) による物理的なカメラキックに置換（被弾・着地・爆発の `trauma` は維持）。
  - **Pistol**: `+0.85°` 腰だめ / `+0.55°` ADS ピッチ、`+0.45°` ロール、`-0.016 m` Zパンチ (`k = 260, c = 28`)。
  - **Sniper**: `+2.4°` 腰だめ / `+1.4°` ADS ピッチ、`±1.1°` ロール、`-0.048 m` Zパンチ、`+1.8°` 瞬間 FOV パンチ (`k = 175, c = 21`)。

### 3. `10A-5`: モバイル敵 `ALERT` 確実調査 AI（高所プレイヤー対応） & ボリューメトリック・スキャナーコーン
- **モバイル敵 `ALERT` 確実調査** ([`StealthAI.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/StealthAI.ts), [`EnemyManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EnemyManager.ts#L2296-L2465)):
  - `ENFORCER`, `AEGIS`, `PHANTOM`, `DRONE` が `ALERT` に入った際、プレイヤーや銃声が高所 (`|dy| >= 2.5 m`) にあっても調査を放棄せず、地上ユニットは `investigatePos` 直下（または建物コライダー手前）の到達可能な地上座標 `investigateGoal` を算出し、Drone は `investigatePos + (0, 3.5, 0)` へ飛行（`VEIL` スナイパーは狙撃位置に留まり視線スイープ）。
  - 移動中（戦闘速度の `0.80×`）および到着後の周囲確認中は `investigating = true` となり、`alertGauge` の自然減衰を凍結（下限 `>= 25` 保証、スタック防止の `7.0 s` 移動ストールタイムアウト付き）。
  - `investigateGoal` から `<= 2.2 m` 以内に到着（またはストールタイムアウト）後、その場で `2.0 s` 間 `±60°` の視線スイープを行い、それでも発見できなかった場合のみ `investigating = false` となって通常の `-14 pt/s` 減衰で `UNAWARE` に戻る。
- **敵タクティカル・フラッシュライト / バイザースキャナーコーン** ([`EnemyManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EnemyManager.ts#L1512-L1560)):
  - `InstancedMesh` (`EnemyScannerCones`, `cap: 14`, 表示中のみ `+1` draw call)。
  - `UNAWARE`（クールなホワイトシアン、不透明度 `0.11`）および `ALERT`（アンバーイエロー、不透明度 `0.14`）の地上パトロール敵および Drone の頭部・レンズから前方へソフトな加算合成ボリューメトリックコーン（地上 `12.5 m` / Drone `11.5 m`、基底半径 `2.4 m`）を投影。`DETECTED` / `COMBAT` 時は非表示（テレグラフレイザーと競合しない）。

### 4. `10A-6`: 左上円形パルススキャン・ミニレーダー（Option C: 3D透視マーカー廃止）
- **3D 透視マーカーの廃止**:
  - [`EnemyManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/entities/EnemyManager.ts#L1137) の `TRACK_REMAINING_MAX = 0` により、通常敵に対する壁越し3Dダイヤモンドマーカーを完全廃止（ボス `VALKYRIE-09` 専用インジケーターのみ維持）。
- **左上 `136×136` 円形パルススキャン・ミニレーダー** ([`index.html`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/index.html), [`HudManager.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/ui/HudManager.ts#L138-L350), [`AudioEngine.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/engine/AudioEngine.ts#L794-L800), [`main.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/main.ts#L1494-L1501)):
  - HTML `<canvas id="radar-canvas" width="136" height="136">` (`left: 24px, top: 24px`) による 2D Canvas 描画で **WebGL draw call 増加 `+0`**。
  - プレイヤー中心・視線ヨー角 (`-player.yaw`) に連動して回転し、常時「上」がプレイヤー正面。前方 FOV コーンと `25 / 50 / 75 m` レンジリングを表示。
  - `3.5 s` ごとにシアンパルスリングが `0 → 75 m` を `0.65 s` で走査（生存敵がいる場合は微かなソナーピング SE [`AudioEngine.radarPing()`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/src/engine/AudioEngine.ts#L795) を再生）。
  - パルスリングが敵の距離を通過した瞬間にその敵の位置・状態スナップショット (`UNAWARE` `#38F8FF`, `ALERT` `#FFCC22`, `DETECTED` `#FF6A1A`, `COMBAT` `#FF2244`) を `alpha = 1.0` で更新し、次の走査までの `3.2 s` で `alpha = 0.18` まで滑らかにフェード。
  - 高低差 `|enemy.y - player.y| >= 3.5 m` の敵には `▲`（上階・屋上）または `▼`（下階）のエレベーションティックを描画し、`75 m` 超の敵は外周リム上の方向ティックにクランプ表示。

---

## 検証結果 (`npm run build` & `npm test`)

- `npm run build`: **成功** (`tsc --noEmit && vite build` エラーゼロ)
- `npm test`: **全 61 テスト合格** (既存 54 テスト + [`tests/phase10a2.test.ts`](file:///home/antigravity/haruyashimadajp/3D-action/strand-protocol/tests/phase10a2.test.ts) の新規 7 テストすべてパス)

---

## 次に再開する作業 (Next Steps)

次回は [`PHASE10_OVERHAUL_PLAN.md`](PHASE10_OVERHAUL_PLAN.md) の **Step 10C（ヒーロー車両・自販機・街路ディテール）** から着手してください。Phase 10B の検証: `npm run build` 成功、`npm test` 69/69 合格（新規 `tests/phase10b.test.ts` 8 件）、Sector 4 HIGH・全敵戦闘中で `renderer.info.render.calls` = 81（≤ 120）。
