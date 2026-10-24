# revcut 規格書（SPEC）

> 版本：v0.5（2026-10-24）
> 狀態：第 0 期已驗收，第 1 期實作完成待驗收
> 一句話：單人自用的網頁，把自己挑好的一段時間（一個月、幾個月或任意期間）的影片和照片，自動排成一支對拍、直式、20–25 秒的 IG Reels，手動微調後再匯出。
>
> 變更紀錄：
> - v0.2：一般片段不再靜音；Live Photo 當影片處理；AI 同時支援 Anthropic 和 OpenAI；專案不再綁定月份。
> - v0.3：不使用 R2，所有檔案只存在本機。
> - v0.4：依對抗式審查修正。修正匯出偏移、說話片段範圍、重複偵測、Live Photo 配對、拍點對齊和排版演算法；拿掉 pg-boss；上傳改成一步完成；時間軸版本直接修改；排版程式移到 `packages/shared`。
> - v0.5：縮小 MVP，拿掉地名和字幕（連同 Whisper 語音辨識與說話片段）；HEIC 改用 `heic-decode` 解碼；Live Photo 照片端的 ID 標籤改為 `Apple:MediaGroupUUID`。

---

## 1. 目標與範圍

### 1.1 使用流程

1. 建立專案並取名，例如「2026 秋天」。專案不綁定月份，可以涵蓋一個月、幾個月或任意期間
2. 上傳挑好的影片和照片（Live Photo 要連同同名的 MOV 一起上傳），系統自動轉檔、讀取拍攝時間和地點
3. 從曲庫選一首歌，系統建議要用哪一段
4. 選擇 AI 供應商（Anthropic 或 OpenAI），按「產生初版」：AI 分析畫面 → 排版程式排出時間軸
5. 在編輯器調整：換片段、調長度、調起點、調裁切、改文字
6. 按「匯出」：算圖 → 下載 MP4 → 自己傳到手機、上傳到 IG

### 1.2 成品規格

| 項目 | 規格 |
|---|---|
| 解析度 | 1080×1920（9:16） |
| 幀率 | 30 fps，固定幀率 |
| 編碼 | H.264 High + AAC 48 kHz 立體聲，MP4（faststart） |
| 長度 | 20–25 秒，以整數小節為原則，結尾落在重拍 |
| 片段長度 | 0.5–2 秒 |
| 切點 | 全部落在拍點上，使用硬切 |
| 疊字 | 左下角：拍攝日期 |
| 聲音 | 背景音樂加上影片原音。原音預設以較低音量和音樂混在一起 |

### 1.3 不做（MVP 範圍外）

- 多使用者、登入、雲端部署：只在本機跑，server 只監聽 `127.0.0.1`
- 硬切以外的轉場特效
- 人臉辨識、人物分組
- 手機版介面：只支援桌面版 Chrome
- 直接發佈到 IG
- 雲端儲存：所有檔案只存在本機，成品由你自己傳到手機
- Android 動態相片（Motion Photo）：當一般照片處理。iPhone Live Photo 則當影片處理（§4.4）
- AI 自動選歌
- 地名：不查詢、不顯示拍攝地點（GPS 只用來推算時區）
- 字幕和語音辨識：不轉錄、不偵測說話，也不會因為有人說話而壓低音樂
- 重新整理頁面後還能 undo：undo 紀錄只存在當次頁面

---

## 2. 系統架構

### 2.1 元件圖

```
┌─────────────────────────── 瀏覽器（桌面 Chrome）───────────────────────────┐
│ apps/web   React 19 + Vite + TanStack Query                                │
│  ├ 專案列表／素材上傳／曲庫                                                  │
│  └ 編輯器：Remotion Player ← packages/composition（與算圖共用同一份元件）     │
└──────────────────────────────┬─────────────────────────────────────────────┘
                               │ REST /api：JSON（用輪詢看進度）
                               │ 上傳：串流寫入本機；讀檔：支援 Range（影片可拖曳）
                               ▼
┌──────────────── apps/server（Node 24，單一程序）────────────┐
│ Fastify API（zod 驗證，schema 來自 packages/shared）         │
│ 背景工作（程式內佇列，狀態存在資料表）                         │
│  ├ media.ingest    ffmpeg / exiftool / heic-decode / sharp  │
│  ├ music.analyze   → Python analyzer（拍點）                 │
│  ├ project.draft   → AI（Anthropic／OpenAI）→ planner        │
│  └ timeline.render → ffmpeg 切高畫質片段 → Remotion 算圖     │
└──────┬──────────────────────────────┬───────────────────────┘
       ▼                              ▼                         外部服務：
  Postgres 17（docker）          本機磁碟 DATA_DIR                Anthropic／OpenAI API
  業務資料表                      原檔、衍生檔、音樂、成品、暫存
```

### 2.2 技術選型

| 層 | 選擇 | 備註 |
|---|---|---|
| 前端 | React 19、Vite、TypeScript、TanStack Query、React Router、dnd-kit、Tailwind CSS | |
| 預覽與算圖 | Remotion 4（`@remotion/player`、`@remotion/renderer`、`@remotion/bundler`） | 預覽和成品用同一份元件。個人使用免費，Phase 0 會再確認最新授權條款 |
| 後端 | Node 24 LTS、Fastify、`fastify-type-provider-zod` | |
| ORM 與 migration | Drizzle ORM + drizzle-kit | |
| 工作佇列 | 程式內佇列（`p-queue`），工作狀態存在各資料表的狀態欄位 | 單人、單一程序，不需要獨立的佇列服務 |
| 資料庫 | Postgres 17（docker compose） | |
| 檔案儲存 | 本機磁碟（WSL 檔案系統內的 `DATA_DIR`） | 原檔本來就在 NAS，本機只放這次要用的複本 |
| 媒體工具 | ffmpeg（必須含 `zscale`/libzimg）、exiftool、`heic-decode`（libheif 1.23 的 WASM 版）、sharp | 系統的 libheif 1.12 讀不了 iPhone 16 Pro 的 HEIC（10 張失敗 9 張），所以改用 npm 套件 |
| 音訊分析 | Python 3.12 + uv：beat_this（拍點） | |
| AI | Anthropic TypeScript SDK（預設 `claude-opus-5-5`）、OpenAI Node SDK（模型由設定決定） | 兩家可切換，共用同一份 prompt 和輸出格式（§7） |
| 時區 | `@photostructure/tz-lookup`（由 GPS 推算時區） | |

### 2.3 Repo 結構（pnpm workspaces）

```
revcut/
├ apps/
│  ├ web/                    前端
│  └ server/                 API + 背景工作
│     └ src/
│        ├ api/              路由
│        ├ jobs/             背景工作和佇列
│        ├ media/            ffmpeg / exiftool / heic-decode 包裝，以及 metadata 解析（純函式）
│        ├ ai/               AI 分析：共用的 prompt 和輸出 schema，加上 anthropic／openai 兩個 adapter
│        ├ render/           Remotion 算圖
│        ├ storage/          本機檔案路徑、串流寫入、Range 讀取、磁碟空間
│        └ db/               Drizzle schema + migrations
├ packages/
│  ├ shared/                 前後端共用：zod schema（Timeline、API DTO）、常數、時間換算、驗證規則、
│  │                         planner（排版）、buildClip（片段預設值）、Live Photo 分組
│  └ composition/            Remotion 影片元件（web 預覽與 server 算圖共用）
├ analyzer/                  Python CLI（uv 專案，只負責拍點）
├ fixtures/
│  ├ metadata/               去除個資的 exiftool／ffprobe 輸出 JSON，可以 commit
│  └ private/                真實素材樣本（列入 .gitignore）
├ docker-compose.yml         Postgres
├ .env.example
└ docs/SPEC.md
```

### 2.4 執行方式

- `docker compose up -d`：啟動 Postgres
- `pnpm dev`：同時啟動以下兩者
  - web：`:5173`，`/api` 由 Vite proxy 轉到 `:3000`
  - server：`:3000`，API 和背景工作跑在同一個程序
- server 只監聽 `127.0.0.1`，而且只接受 `Host` 為 `localhost` 或 `127.0.0.1` 的請求（任何 port），用來擋 DNS rebinding 攻擊
- 系統需求：Node 24、pnpm、Docker（含 compose 外掛）、ffmpeg（含 zscale）、exiftool、uv，以及 Remotion 的 Chrome 需要的系統套件（見 README）
- `DATA_DIR` 必須放在 WSL 自己的檔案系統內（預設 `~/.revcut/data`）。放在 `/mnt/c` 或 NAS 會讓讀寫很慢，預覽拖曳時會卡

---

## 3. 核心概念：時間軸（Timeline）

時間軸是整個系統的中心資料。前端編輯器、API、排版程式和影片元件，都讀寫同一份由 zod 定義的結構（`packages/shared`）。

### 3.1 設計原則

- **切點用「拍」記錄，不用秒數。** 每個片段的長度都是整數拍。
- **音樂和切點用同一套影格位置。** 每一刀的位置都從音樂的絕對時間換算，不逐段累加，所以不會累積誤差。
- **片段的開始位置不另外儲存，** 由前面所有片段的拍數加總推算。重排、刪除、改長度之後都會自動對齊拍點。
- **片段預設值只有一份。** `buildClip` 和排版程式都在 `packages/shared`。AI 排版、編輯器的插入和換素材都用同一套。

### 3.2 Schema

```ts
// packages/shared/src/timeline.ts
export const Clip = z.object({
  id: z.string().uuid(),
  mediaId: z.string().uuid(),
  beats: z.number().int().min(1),            // 片段長度（拍）
  sourceInSec: z.number().min(0),            // 影片：從原片第幾秒開始；照片：0
  crop: z.object({
    focusX: z.number().min(0).max(1),        // 焦點位置（相對於原始畫面，0–1）
    focusY: z.number().min(0).max(1),
    zoom: z.number().min(1).max(3),          // 1 = 剛好填滿 9:16
  }),
  kenBurns: z.object({ endZoom: z.number().min(1).max(3) }).nullable(), // 照片：zoom 漸變到 endZoom
  date: z.string().nullable(),               // 左下角日期，例："2026.10.03"；null 表示不顯示
  originalVolume: z.number().min(0).max(1),  // 影片原音音量；照片忽略
});

export const Timeline = z.object({
  schemaVersion: z.literal(1),
  music: z.object({
    trackId: z.string().uuid(),
    startBeat: z.number().int().min(0),      // 從歌曲的第幾拍開始，必須是重拍
    volume: z.number().min(0).max(1),        // 預設 1
    fadeOutSec: z.number().min(0).max(5),    // 預設 1.5，套用在整體混音
  }),
  overlayEnabled: z.boolean(),               // 日期的總開關
  clips: z.array(Clip).min(1),
});
```

### 3.3 時間換算（`packages/shared/src/timing.ts`，純函式，有單元測試）

```
beats[]        歌曲每一拍的時間（秒）
s              music.startBeat
cum_k          clips[0..k-1].beats 的總和
F(j)           round(beats[j] × 30)                  第 j 拍落在歌曲的第幾格
f0             F(s)                                  音樂從歌曲的第 f0 格開始播放

片段 k 開始影格 = F(s + cum_k) − f0
片段 k 影格數   = F(s + cum_{k+1}) − F(s + cum_k)
片段 k 秒數     = 片段 k 影格數 / 30
總影格數        = F(s + Σbeats) − f0
```

- 音樂起點和切點都對齊同一套影格，每個切點和實際拍點的誤差不超過半格（約 17 毫秒）。
- 片段秒數一律以影格數換算。驗證「片段有沒有超出影片長度」時也用這個值。
- 如果 `s + Σbeats` 超過歌曲的最後一拍，就是驗證錯誤。

**匯出切片範圍**（`sliceWindow`，同一個檔案）：

```
切片起點         = max(0, sourceInSec − 0.5)
切片終點         = min(影片長度, sourceInSec + 片段秒數 + 0.5)
算圖用的起始秒數 = sourceInSec − 切片起點
```

片段從影片開頭附近開始時，前面不足 0.5 秒的緩衝，算圖的起始秒數就會小於 0.5。測試涵蓋起點為 0、0.2 和接近影片結尾三種情況。

### 3.4 驗證規則

規則的實作放在 `packages/shared`。前端即時顯示驗證結果，匯出前 server 會再檢查一次。

| 規則 | 等級 |
|---|---|
| 一般片段長度在 0.5–2.0 秒之間 | 警告 |
| 總長度在 20–25 秒之間 | 警告 |
| 總拍數是整數小節（結尾落在重拍） | 警告 |
| 影片片段的 `sourceInSec` 加上片段秒數，不超過影片長度 | 錯誤 |
| `music.startBeat` 是重拍 | 錯誤 |
| 歌曲存在而且已分析完成，拍數夠用 | 錯誤 |
| 引用的素材存在、未排除、已處理完成 | 錯誤 |

「警告」不會擋匯出，由你自己決定；「錯誤」會擋匯出。

### 3.5 換歌

換歌由 `packages/shared` 的純函式處理，有單元測試：

1. 新的 `startBeat` 取新歌的建議起點（§8.2 第 1 步）。
2. 每段改成新歌節奏下最接近原本秒數、而且在允許範圍內的拍數。
3. 用 §8.2 第 5 步的分配方法，把總拍數調整成新歌的目標拍數 T。
4. 影片片段的起點如果讓片段超出影片長度，就往前移到剛好放得下。

---

## 4. 資料模型

### 4.1 關聯

```
projects 1─* media
projects 1─* analysis_runs 1─* media_analysis *─1 media
projects 1─* timelines 1─* renders
music_tracks ←── timelines.data.music.trackId（JSON 內的參照）
```

### 4.2 資料表

主鍵一律使用 uuid，時間欄位一律使用 `timestamptz`。每張表都有 `created_at`，會被修改的表另外有 `updated_at`。

```sql
create table projects (
  id                  uuid primary key default gen_random_uuid(),
  title               text not null,                  -- 不綁定月份，期間由素材的拍攝時間決定
  current_timeline_id uuid,                           -- FK → timelines（見下）
  draft_state         text not null default 'idle',   -- idle|queued|analyzing|planning|done|failed
  draft_error         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table media (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects(id) on delete cascade,
  kind                text not null check (kind in ('video','photo')), -- 依副檔名決定，處理時用 ffprobe 確認
  status              text not null default 'uploaded', -- uploaded|processing|ready|failed
  error               text,
  filename            text not null,
  ext                 text not null,                  -- 小寫副檔名，決定原檔路徑
  mime_type           text,                           -- 瀏覽器提供，僅供參考
  size_bytes          bigint not null,
  file_last_modified  timestamptz,                    -- 瀏覽器提供，作為拍攝時間的最後備援
  sha256              text not null,                  -- 上傳時邊寫邊算
  width               int,                            -- 套用旋轉之後的顯示尺寸
  height              int,
  duration_sec        real,
  fps                 real,
  is_hdr              boolean,
  has_audio           boolean,
  captured_at         timestamptz,
  utc_offset_min      smallint,                       -- 拍攝地的時區偏移，顯示當地日期用
  lat                 double precision,
  lng                 double precision,
  excluded            boolean not null default false, -- 使用者排除，不參與分析和排版
  content_identifier  text,                           -- Apple Live Photo 配對用 ID
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, sha256)                         -- 同專案不能有重複檔案
);
create index on media (project_id, captured_at);
create index on media (project_id, content_identifier);

create table analysis_runs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  media_ids     uuid[] not null,                      -- 這次分析的素材集合，用來判斷能否重用
  provider      text not null check (provider in ('anthropic','openai')),
  model         text not null,                        -- 實際回應的模型
  effort        text not null,
  status        text not null,                        -- running|done|failed
  error         text,
  input_tokens  int,
  output_tokens int,
  cost_usd      numeric(8,4),
  response      jsonb,                                -- 原始結構化輸出，除錯用
  created_at    timestamptz not null default now()
);

create table media_analysis (
  analysis_run_id   uuid not null references analysis_runs(id) on delete cascade,
  media_id          uuid not null references media(id) on delete cascade,
  usable            boolean not null,
  score             smallint not null,                -- 1–10
  description       text not null,                    -- 繁體中文，30 字以內
  moments           jsonb not null,                   -- [{t, score, focusX, focusY}]
  duplicate_of      uuid references media(id) on delete set null,
  created_at        timestamptz not null default now(),
  primary key (analysis_run_id, media_id)
);

create table music_tracks (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,                     -- 預設取檔名，可修改
  artist           text,
  status           text not null default 'uploaded',  -- uploaded|analyzing|ready|failed
  error            text,
  filename         text not null,
  ext              text not null,
  size_bytes       bigint not null,
  duration_sec     real,
  bpm              real,
  beats            double precision[],                -- 每一拍的時間（秒）
  downbeat_indices int[],                             -- 重拍是 beats 的第幾個（索引）
  energy           real[],                            -- 每 0.5 秒的 RMS，正規化到 0–1，用來建議段落
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table timelines (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  analysis_run_id uuid references analysis_runs(id) on delete set null,
  seed            int not null,                       -- 產生這個版本時的亂數種子
  data            jsonb not null,                     -- Timeline（§3.2）
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table projects add foreign key (current_timeline_id)
  references timelines(id) on delete set null;

create table renders (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  timeline_id uuid references timelines(id) on delete set null,
  snapshot    jsonb not null,                         -- 按下匯出當下的 Timeline
  state       text not null default 'queued',         -- queued|preparing|rendering|done|failed
  progress    real not null default 0,                -- 0–1
  error       text,
  size_bytes  bigint,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
```

### 4.3 時間軸版本

- 每次產生初版或 AI 重排，都建立一個新版本，並設成目前版本。
- 修改直接存回目前版本，沒有「AI 原版不可修改」的限制。
- 版本選單可以切換到舊版本繼續修改。
- 想回到某個 AI 版本的原始樣子，就用那個版本的 seed 再排一次。只要素材沒變，分析結果會重用，不花錢，結果也一樣。

### 4.4 Live Photo 分組

- 只儲存 `content_identifier`，不儲存配對結果。分組在讀取時用純函式 `groupLivePhotos(media[])` 決定，有單元測試。
- 同一專案中 `content_identifier` 相同的素材是一組：
  - 組內有 `ready` 的影片（MOV）時，照片（HEIC）不顯示，也不參與分析和排版。
  - 影片缺少拍攝時間或 GPS 時，沿用同組照片的值。
  - 影片還沒處理完時，照片照常顯示。產生初版要求所有素材都處理完成（§6.4），所以排版不會遇到處理到一半的狀態。
- 刪除組內任何一個素材，整組一起刪除。
- 只上傳 HEIC、沒有 MOV 的 Live Photo，就是一般照片。

---

## 5. 檔案儲存

### 5.1 目錄結構

所有檔案都放在 `DATA_DIR` 底下。路徑完全由 id 和副檔名推算，資料庫不另外存路徑。

```
DATA_DIR/
├ projects/{projectId}/
│  ├ originals/{mediaId}.{ext}         原檔
│  ├ derived/{mediaId}/preview.mp4     影片預覽：SDR、短邊 720、30 fps、GOP 0.5 秒
│  ├ derived/{mediaId}/photo.jpg       照片：長邊 3072，預覽和算圖共用
│  ├ derived/{mediaId}/thumb.webp      縮圖：長邊 360
│  ├ analysis/{mediaId}/…              給 AI 的畫面、16 kHz 音檔（可刪，需要時重建）
│  └ renders/{renderId}.mp4            成品；切片暫存放在 renders/{renderId}.tmp/，完成後刪除
└ music/{trackId}.{ext}
```

### 5.2 上傳與讀取

**上傳**：每個檔案一個請求，`POST /api/projects/:id/media`。request body 就是檔案本身，檔名和修改時間放在 query string。server 依序處理：

1. 檢查副檔名是否在接受清單內，以及磁碟空間（§5.3）。
2. 串流寫入 `.part` 暫存檔，同時計算 sha256。
3. 寫完後改成正式檔名，再新增資料列。`(project_id, sha256)` 有唯一索引。如果是重複的檔案，新增會失敗；server 刪掉剛寫的檔案，回 409，並附上已存在的素材。
4. 新增成功就排入 ingest。

其他規則：

- 請求中斷時，server 刪掉 `.part` 檔，不會留下資料列。server 啟動時也會清掉殘留的 `.part` 檔。
- 前端先在畫面上列出選取的檔案，同時上傳 3 個，用 XHR 的上傳事件顯示進度。失敗的檔案可以按「重傳」，因為瀏覽器還保有檔案。
- 上傳路由關掉 Fastify 預設的 body 解析，直接讀取串流。單檔上限 4 GB。
- 接受的格式依副檔名判斷，處理時再用 ffprobe 或 exiftool 確認。瀏覽器給的 MIME 不可靠（Windows 上 `.heic` 可能是空字串），只記錄、不判斷。
  - 素材：`.mov`、`.mp4`、`.heic`、`.heif`、`.jpg`、`.jpeg`、`.png`
  - 音樂：`.mp3`、`.m4a`、`.aac`、`.wav`、`.flac`，單檔上限 50 MB。Apple Music 下載的歌有 DRM，不能用

**讀取**：

- 預覽檔、縮圖、音樂、成品都透過 API 路由提供（§10.2），支援 HTTP Range，影片才能拖曳和跳轉。
- 衍生檔產生後內容不會再變，回應會帶 ETag 讓瀏覽器快取。
- 下載成品時，`Content-Disposition` 用 RFC 5987 的 `filename*=UTF-8''…` 格式，中文檔名才不會亂碼。

### 5.3 空間與備份

- 剩餘空間取兩者中較小的值：`DATA_DIR` 所在磁碟，以及 `HOST_DRIVE`（預設 `/mnt/c`，WSL 虛擬硬碟所在的 Windows 磁碟）。WSL 的虛擬硬碟回報的是容量上限，不是 Windows 磁碟真正剩下的空間。例如這台電腦在 WSL 內顯示可用 792G，C 槽實際只剩 357G。
- 上傳前：剩餘空間不到「檔案大小 + 2 GB」就拒絕（回 507）。
- 匯出前：剩餘空間不到 2 GB 就直接失敗並說明原因。
- 一個專案大約需要「原檔總大小 + 10%」的空間（多出來的是預覽檔和縮圖）。
- WSL 的虛擬磁碟用掉的空間不會自動還給 Windows。專案做完可以在網頁上刪除；要真正釋放空間，需要手動壓縮虛擬磁碟。
- 原檔本來就在 NAS 上，本機只放複本。唯一需要備份的是資料庫（你的剪輯紀錄），用 `docker compose exec db pg_dump` 匯出即可。這只寫在文件裡，不做成功能。
- `/api/health` 會顯示剩餘空間。

---

## 6. 背景工作

### 6.1 工作佇列

每種工作一個程式內佇列（`p-queue`），用並行數限制同時執行的數量。工作狀態只存在資料表的狀態欄位，沒有另一份工作紀錄。

| 工作 | 觸發時機 | 並行數 | 狀態欄位 | 逾時 |
|---|---|---|---|---|
| `media.ingest` | 上傳完成、手動重試 | 2 | `media.status` | 30 分鐘 |
| `music.analyze` | 音樂上傳完成 | 1 | `music_tracks.status` | 15 分鐘 |
| `project.draft` | 按「產生初版」或「AI 重排」 | 1 | `projects.draft_state` | AI 分析 10 分鐘 |
| `timeline.render` | 按「匯出」 | 1 | `renders.state` | 60 分鐘 |

- **逾時**：由工作自己用 AbortSignal 處理，並結束它啟動的 ffmpeg 等子程序。
- **可以重跑**：每個工作的輸出都先寫到暫存路徑再改名。重跑會從資料表現有的狀態判斷要做什麼，結果和第一次一樣。
- **啟動時的處理**，依狀態欄位決定：
  - 免費的工作（素材處理、拍點分析、匯出）：停在排隊中或執行中的，全部重新排入佇列。
  - 付費的產生初版：停在進行中的改成 `failed`，訊息為「伺服器重啟中斷，請重試」。不自動重跑，避免重複花錢。
  - 刪除殘留的 `.part` 檔和 `.tmp` 資料夾。
- **同一專案同時只能有一個產生初版**：用條件式更新 `UPDATE projects SET draft_state='queued' WHERE id=$1 AND draft_state IN ('idle','done','failed')`。沒有更新到任何資料列就回 409。
- **失敗**：資料列寫入中文錯誤訊息，前端顯示訊息和「重試」按鈕。完整的錯誤堆疊只寫在 log。
- **刪除限制**：素材處理中，或專案有產生初版、匯出正在進行時，刪除回 409「處理中，請稍後再刪」。

### 6.2 `media.ingest`：素材處理

1. **讀取 metadata**：
   - `exiftool -json -n -G1` 讀取尺寸、旋轉、長度、GPS、拍攝時間、Live Photo ID。加上 `-G1` 才分得出不同區塊裡同名的標籤。
   - 影片再用 `ffprobe` 讀取幀率、`color_transfer`、是否有音軌，並確認副檔名判斷的類型正確。
2. **決定拍攝時間**（純函式 `resolveCaptureTime`，用 `fixtures/metadata/` 的 JSON 做單元測試）：
   - 時間來源，依序取第一個有值的：
     1. 照片：`ExifIFD:DateTimeOriginal`，有 `ExifIFD:OffsetTimeOriginal` 就帶上時區
     2. iPhone 影片：`Keys:CreationDate`（本身帶時區）
     3. 其他影片：`QuickTime:CreateDate`（UTC）
     4. 瀏覽器提供的檔案修改時間
   - 時區，依序取第一個有值的：檔案內明確寫的時區 → 用 GPS 推算的時區 → `DEFAULT_TZ`（Asia/Taipei）。
   - 沒有時區資訊的時間（例如只有 `DateTimeOriginal`），當作拍攝地的當地時間。UTC 的時間換算成拍攝地的時區。
   - 上面的標籤名稱已在 Phase 1 用真實檔案確認，去除個資後的輸出存成 fixture。
   - Live Photo 的 MOV 上，`QuickTime:CreateDate` 是匯出時間，可能比拍攝晚好幾個小時，所以 `Keys:CreationDate` 一定要排在它前面。
   - 有些編輯 App 會在時間後面加上「下午」之類的字，解析時只讀前面的時間。
3. **Live Photo ID**：HEIC 讀 `Apple:MediaGroupUUID`（exiftool 12.19 起把這個 maker note 標籤從 ContentIdentifier 改名），MOV 讀 `Keys:ContentIdentifier`，兩者的值相同。Phase 1 已用真實檔案確認。分組方式見 §4.4。
4. **HDR 判斷**：`color_transfer` 是 `smpte2084` 或 `arib-std-b67` 就是 HDR。
5. **產生衍生檔**：
   - **影片預覽檔** `preview.mp4`：
     - 目標尺寸由程式依 ffprobe 的寬高計算，短邊 720。
     - HDR 影片在第一個 `zscale` 就縮到目標尺寸，之後才轉色彩，避免在原解析度做浮點運算：`zscale=w=W:h=H:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
     - SDR 影片只縮放。
     - 轉成固定 30 fps；編碼參數 `libx264 -preset veryfast -crf 23 -g 15`、AAC 128k、`+faststart`；旋轉交給 ffmpeg 自動處理。
   - **照片** `photo.jpg`：
     - HEIC 用 `heic-decode` 解碼成未壓縮的像素（同時套用旋轉），只有最後輸出 JPEG 時壓縮一次。
     - 其他照片用 sharp 依 EXIF 轉正。
     - 再用 sharp 長邊縮到 3072、JPEG 品質 85。
   - **縮圖** `thumb.webp`：長邊 360。影片取 min(1 秒, 長度/2) 那一格。
6. 衍生檔寫入 `derived/`，狀態改成 `ready`。

### 6.3 `music.analyze`：拍點分析

1. 用 ffmpeg 把音樂解碼成 44.1 kHz 單聲道 wav。
2. 執行 `analyzer beats`，取得 beats、downbeat 索引、bpm（拍距的中位數換算）和 energy。
3. 寫回 `music_tracks`，狀態改成 `ready`。
4. 歌曲短到湊不出 20 秒，或偵測不到任何重拍時，標記 `failed` 並說明原因。

「建議段落」不存進資料庫，每次讀取時由 `packages/shared` 的純函式計算（§8.2 第 1 步）。

### 6.4 `project.draft`：產生初版

**送出時的檢查**（在 POST 當下進行，不通過就不開始）：

- 歌曲存在而且已分析完成，否則回 409
- 沒有素材停在 `uploaded` 或 `processing`，否則回 409「還有素材在處理」
- 至少有一個未排除、處理完成的素材，否則回 422

**步驟**：

1. **`analyzing`**：
   - **可以重用的條件**：最新一次 `status='done'` 的分析，供應商和模型都和這次相同，而且它分析過的素材包含這次全部的素材（未排除、處理完成、不含被 Live Photo 影片取代的照片）。這次沒有指定 `reanalyze`。
   - 可以重用時，只取這次素材的結果；`duplicateOf` 指向不在這次素材裡的，當作沒有重複。
   - 不能重用時，從預覽檔抽畫面，呼叫選定的 AI 供應商（§7）。
   - 就算每支影片只送 2 張畫面仍超過供應商的限制，就失敗並說明「素材太多」。
2. **`planning`**：執行排版程式（§8），寫入新的 `timelines`，並更新 `current_timeline_id`。排版程式回傳「素材不足」等錯誤時，draft 失敗並顯示原因。
3. 狀態改成 `done`。

**費用提示**：前端在按鈕旁邊呼叫 `GET /api/projects/:id/draft-estimate`。不能重用分析時，顯示預估費用。

### 6.5 `timeline.render`：匯出

**按下匯出時**：前端先送出還沒儲存的修改。server 驗證時間軸，有錯誤就回 422。通過後把當下的時間軸存進 `renders.snapshot`，再排入佇列。之後時間軸再改，也不影響這次匯出。

1. **`preparing`**：
   - 檢查磁碟空間（§5.3）。
   - 影片片段：用 `sliceWindow`（§3.3）算出切片範圍，從**原檔**切出這一段。
     - HDR 片段和 §6.2 一樣轉成 SDR，而且先縮小再轉色彩。
     - 轉成固定 30 fps。
     - 縮放到「9:16 裁切範圍在該 zoom 下至少 1080×1920」，但不超過原片解析度。
     - CRF 16，每秒一個關鍵格，保留音軌。
   - 照片片段：直接使用 `photo.jpg`。
   - 只有被用到的片段才轉高畫質，比每個素材都先做一份 4K 母片省很多時間和空間。
2. **`rendering`**：
   - Remotion 的 bundle 在第一次匯出時才建立，之後留在記憶體裡重用。
   - 依序呼叫 `selectComposition` 和 `renderMedia`：h264、CRF 18、yuv420p、AAC 320k。
   - 算圖程序透過 `/api/renders/:id/slices/:name` 讀取切片。
   - 用 `onProgress` 更新 `renders.progress`。
3. 成品寫入 `renders/{renderId}.mp4`，狀態改成 `done`，刪除暫存資料夾。下載時的檔名為「專案名稱.mp4」。

---

## 7. AI 分析（Anthropic／OpenAI）

### 7.1 供應商切換

- 兩家共用同一份 prompt（§7.3）和輸出 schema（§7.4）。差別只在 adapter 怎麼把畫面和指令轉成各家的 request 格式。
- 預設供應商由 `AI_PROVIDER` 設定。產生初版時可以在畫面上改選，只會列出有設定 API key 的供應商。
- 一次只用一家，不會同時呼叫兩家再合併結果。
- 每次分析都記錄供應商、實際回應的模型、token 數和費用。

```ts
// apps/server/src/ai/types.ts
interface VisionAnalyzer {
  provider: 'anthropic' | 'openai';
  model: string;
  analyze(input: AnalysisInput, signal: AbortSignal): Promise<{
    result: AnalysisResult;                          // 已通過 zod 驗證
    servedModel: string;                             // 實際回應的模型（可能是備援模型）
    usage: { inputTokens: number; outputTokens: number };
    costUsd: number;                                 // 依 servedModel 和 ai/pricing.ts 的單價計算
  }>;
}
```

| 項目 | Anthropic | OpenAI |
|---|---|---|
| SDK | `@anthropic-ai/sdk` | `openai` |
| 模型 | `claude-opus-5-5` | `OPENAI_MODEL`：Phase 4 時選定當時最新、支援影像輸入和結構化輸出的 GPT 模型 |
| 圖片 | image block（base64 JPEG） | Responses API 的圖片輸入（base64 data URL） |
| 結構化輸出 | `output_config.format` + zod，收到後再用 zod 驗證一次 | JSON Schema strict 模式，收到後再用 zod 驗證一次 |
| 思考深度 | adaptive thinking，effort `medium` | reasoning effort `medium`（模型支援的話） |
| 傳輸 | streaming，`max_tokens` 64000（思考也算在內，素材多時輸出很長） | 依 SDK 建議 |
| 備援 | server-side fallback：`fallbacks: "default"` 加上 beta header `server-side-fallback-2026-07-01`。遇到安全分類器誤擋時，自動改用其他 Claude 模型 | 無 |
| 限制 | 每個 request 最多 600 張圖；超過 20 張時每張長寬 ≤ 2000 px；request ≤ 32 MB | Phase 4 依 OpenAI 官方文件確認，由 adapter 檢查 |

兩家都是**每次分析只發一個 request，包含全部素材**，讓 AI 能跨素材比較好壞、找出重複的畫面。

### 7.2 輸入組成

素材依拍攝時間排序，每個素材用短代號（`m1`、`m2`…）指稱，降低對應錯誤。

```
[system] 角色、評分標準、輸出規則（固定文字）
[user]
  素材 m1｜影片｜12.4 秒｜2026-10-03 14:22
  t=0.8s <image>  t=2.3s <image>  …
  素材 m2｜照片｜2026-10-04 09:10
  <image>
  …
  （最後放任務說明）
```

- **影片抽幾張畫面**：張數 n = clamp(ceil(長度 / 1.5), 2, 8)，時間點 tᵢ = (i + 0.5) × 長度 / n，從 SDR 預覽檔抽出。
- **畫面規格**：長邊 640 px，JPEG 品質 80。照片只送一張。
- **送出前的保護**：先估算 token 數和 request 大小。如果超過 300k token，或超過該供應商的限制（§7.1），就降低每支影片的畫面張數再送。

### 7.3 Prompt 重點

- 角色：幫使用者剪「個人回顧」短片的剪輯師。
- 評分標準：
  - 畫面品質：清晰、曝光正常、畫面穩定
  - 內容：人物表情、互動、動作、特別的景色或事件
  - 這一刻能不能代表這段期間
- `usable=false`：明顯模糊、誤拍、全黑、手指擋到鏡頭。
- `moments`：
  - 影片挑 1–3 個最值得用的瞬間，照片挑 1 個
  - `focusX`/`focusY` 是主體在原始畫面中的位置，直式裁切會以這個點為中心
- `duplicateOf`：同一場景幾乎一樣的兩個素材，把比較差的那個標記為重複。
- `description` 用繁體中文，30 字以內。
- 不辨識、也不命名畫面中的人物。

### 7.4 輸出 schema

```ts
const MediaVerdict = z.object({
  ref: z.string(),                       // "m1"
  usable: z.boolean(),
  score: z.number().int(),               // 1–10
  description: z.string(),
  moments: z.array(z.object({
    t: z.number(),                       // 秒；照片填 0
    score: z.number().int(),
    focusX: z.number(),                  // 0–1
    focusY: z.number(),
  })),
  duplicateOf: z.string().nullable(),    // "m3"
});
const AnalysisResult = z.object({ media: z.array(MediaVerdict) });
```

收到結果後的處理：

- 把短代號對回 uuid
- 超出範圍的數值夾回合法範圍
- 某個素材沒有出現在結果裡時，給預設值：分數 5、焦點在畫面中央
- 模型拒絕回答或輸出被截斷時（Anthropic 的 `stop_reason` 為 `refusal` 或 `max_tokens`，OpenAI 則看對應的狀態），這次分析失敗並顯示原因
- 結果不符合 schema 時重試一次

### 7.5 費用估算

以下用 Anthropic 估算。OpenAI 的圖片計費方式不同，Phase 4 實測後補上。

- 每張圖的 token 數 = ⌈寬 / 28⌉ × ⌈高 / 28⌉
  - 640×360 的影片畫面 ≈ 299 token
  - 640×480 的照片 ≈ 414 token
- 以 40 支影片（每支 8 張）加 40 張照片為例：
  - 圖片約 112k token，加上文字約 122k input token，約 US$0.49
  - 輸出加上思考約 10–20k token，約 US$0.2–0.4
  - **每次分析約 US$0.7–0.9**
- 素材只減少、沒有新增時，會重用上次的分析（§6.4），不會再花錢。
- 費用依實際回應的模型計算。備援模型的價格可能不同。

### 7.6 隱私

抽出的畫面會送到選定的供應商。Anthropic 文件說明上傳的圖片不會用來訓練模型；OpenAI 的 API 資料政策以其官方條款為準。原檔不會送出。

---

## 8. 排版演算法（planner）

排版程式放在 `packages/shared/src/planner/`，是純函式 `plan(input, seed) → Timeline | PlanError`。同樣的輸入加上同樣的 seed，一定得到同樣的結果。片段的預設值由同一個資料夾的 `buildClip` 決定，編輯器也使用它。

### 8.1 常數（`packages/shared/src/constants.ts`）

```
FPS = 30, WIDTH = 1080, HEIGHT = 1920
CLIP_MIN_SEC = 0.5, CLIP_MAX_SEC = 2.0
TARGET_MIN_SEC = 20, TARGET_MAX_SEC = 25, TARGET_SEC = 22.5
ORIGINAL_DEFAULT_VOLUME = 0.35, CLIP_AUDIO_FADE_SEC = 0.05
PHOTO_END_ZOOM = 1.08
FADE_OUT_SEC = 1.5
MAX_CLIPS_PER_DAY = 3
```

### 8.2 步驟

**輸入**：處理完成、未排除的素材（已套用 Live Photo 分組）和它們的 AI 分析結果、歌曲的 beats/downbeat 索引/energy、可選的 `startBeat`、seed。

1. **決定音樂段落**
   - 每小節拍數 = 相鄰重拍索引差的眾數（通常是 4）。
   - 小節長度 = 相鄰重拍時間差的中位數。
   - 小節數 N：讓 N × 小節長度落在 20–25 秒、而且最接近 22.5 秒的整數。
   - 目標總拍數 T = N × 每小節拍數。
   - 起點候選：所有後面還剩至少 T 拍的重拍。沒有指定 `startBeat` 時，選這一段平均 energy 最高的候選。沒有任何候選時，回傳錯誤「歌曲太短」。
2. **算出允許的拍數範圍**
   - 拍長 d = 這一段拍距的中位數。
   - 每段允許 bmin = ⌈0.5 / d⌉ 到 bmax = ⌊2.0 / d⌋ 拍。
   - 基本長度 L₀ = 範圍內最接近 1.0 秒的拍數。
   - 每段實際秒數用 §3.3 依真實拍點換算，最後由驗證規則檢查。
3. **建立候選池**：`usable` 為真、而且沒有被標成重複的素材。每個素材先取分數最高的瞬間。
4. **決定片段數量並選片**
   - 可行的片段數範圍是 ⌈T / bmax⌉ 到 ⌊T / bmin⌋。目標片段數 C = round(T / L₀)，再夾進這個範圍。
   - **候選數 ≥ C**：依分數挑 C 個。每天最多 3 段；放不滿時，每天的上限一次加 1，直到放滿。同分時用 seed 決定。
   - **候選數 < C**：依序處理到能放滿為止：
     1. 從分數最高的影片補第二個瞬間，必須和第一個相隔 3 秒以上
     2. 候選數仍然 ≥ ⌈T / bmax⌉ 時，C 就等於候選數，每段會比較長
     3. 還不夠的話，一次減少 1 小節，重新計算 T。總長可能低於 20 秒，由驗證規則警告
     4. 減到 0 小節仍放不滿，回傳錯誤「素材不足」
5. **分配拍數**（`allocateBeats`，換歌時也用它）
   - 每段先給 L₀ 拍，算出差額 = T − C × L₀。
   - 差額 > 0：每次把一拍加給「還沒到 bmax 的片段中分數最高的」，直到差額為 0。
   - 差額 < 0：每次從「還高於 bmin 的片段中分數最低的」減一拍，直到差額為 0。
   - 節奏變化：用 seed 隨機挑 ⌊C / 4⌋ 對片段，從一段移一拍到另一段，前提是兩段都還在範圍內。
   - 結果保證：每段都在 [bmin, bmax]，總和等於 T。
6. **排序**：所有片段依拍攝時間排序。
7. **對齊影片長度並填入各欄位**
   - 排序後依 §3.3 換算每段的實際秒數。
   - 影片比片段短時，和相鄰片段交換拍數。還是放不下，就把這段減到放得下的最大拍數，多出來的拍給其他片段。
   - 用 `buildClip` 填入各欄位：
     - 影片的 `sourceInSec` = clamp(瞬間時間 − 片段秒數 / 2, 0, 影片長度 − 片段秒數)
     - `crop`：焦點取瞬間的位置，zoom 為 1
     - 照片：`kenBurns.endZoom` = 1.08
     - `date`：拍攝當地日期，格式 `YYYY.MM.DD`
     - `originalVolume`：0.35
8. **驗證**：跑 §3.4 的規則。有「錯誤」就回傳錯誤和原因；只有「警告」照常輸出。

---

## 9. 影片合成（`packages/composition`）

### 9.1 Props

```ts
type CompositionProps = {
  timeline: Timeline;
  music: { src: string; beats: number[] };
  sources: Record<string /* clipId */, {
    kind: 'video' | 'photo';
    src: string;
    startFromSec: number;   // 預覽：= sourceInSec；匯出：= sourceInSec − 切片起點（§3.3）
    width: number;
    height: number;
  }>;
};
```

預覽和匯出用的是同一個元件，差別只在 `sources` 指向不同的檔案：

- 預覽：720p 預覽檔
- 匯出：高畫質切片

### 9.2 畫面

- **圖層順序**（由下到上）：素材 → 左下日期。
- **裁切公式**：
  - 縮放比例 = max(1080 / w, 1920 / h) × zoom，得到縮放後的尺寸 W × H
  - 水平位移 = clamp(540 − focusX × W, 1080 − W, 0)
  - 垂直位移 = clamp(960 − focusY × H, 1920 − H, 0)
  - 因為焦點座標是 0–1 的比例，預覽檔和原檔的解析度不同也會得到一樣的結果
- **照片動態**：zoom 在片段內從 `crop.zoom` 線性變化到 `kenBurns.endZoom`，以焦點為中心放大。
- **日期**：
  - 位置：左邊 64 px，距離底部 480 px（常數，Phase 3 用 IG 實際畫面校正）
  - 字型 Noto Sans TC Medium 36 px，白色加陰影
- **字型**：字型檔隨專案打包。算圖時用 `delayRender` 確保字型載入完成再開始畫。
- **IG 介面遮罩**：只在編輯器預覽中顯示，不會出現在成品裡。用半透明圖層示意 IG 的右側按鈕欄、底部帳號名稱和文案、頂部標題。

### 9.3 聲音

- **音樂**：從歌曲的第 f0 格（§3.3）開始播放，音量為 `music.volume`。
- **影片原音**：每個影片片段的原音音量為 `originalVolume`，前後各 0.05 秒淡入淡出，避免切換時爆音。照片沒有聲音。
- **結尾淡出**：最後 `fadeOutSec` 秒，音樂和原音一起線性淡出。

---

## 10. API

### 10.1 共通約定

- 所有 API 都在 `/api` 之下。除了上傳和讀檔的路由，其他都使用 JSON，request 和 response 都用 `packages/shared` 的 zod schema 驗證。
- 不做身分驗證。server 只監聽 `127.0.0.1`，只接受 `Host` 為 `localhost` 或 `127.0.0.1` 的請求，其他回 403。
- 錯誤格式：`{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": … } }`
  - 400：格式錯誤
  - 403：Host 不允許
  - 404：找不到
  - 409：狀態衝突（處理中、重複檔案、已有初版在跑）
  - 422：驗證規則不通過
  - 507：磁碟空間不足
  - 500：伺服器錯誤
- 進度採輪詢：只要畫面上有未完成的工作，前端每 2 秒重新抓一次專案、素材列表或匯出狀態。
- 時間欄位一律使用 ISO 8601 加時區。

### 10.2 端點

| Method | Path | 說明 |
|---|---|---|
| GET | `/api/health` | 檢查 DB、ffmpeg（含 zscale）、ffprobe、exiftool、analyzer、Remotion 的瀏覽器能否啟動、各 API key 是否設定，以及剩餘空間 |
| GET | `/api/config` | 可用的 AI 供應商和模型（有設定 API key 才算可用），以及預設供應商 |
| GET | `/api/projects` | 專案列表 |
| POST | `/api/projects` | 建立專案 `{title}` |
| GET | `/api/projects/:id` | 專案詳情 |
| PATCH | `/api/projects/:id` | `{title?}`（第 3 期加上 `currentTimelineId`） |
| DELETE | `/api/projects/:id` | 刪除專案和它的所有檔案（有工作進行中回 409） |
| POST | `/api/projects/:id/media?filename=&lastModified=` | 上傳一個素材，body 就是檔案本身。回 201 Media；重複回 409；空間不足回 507 |
| GET | `/api/projects/:id/media` | 素材列表（已套用 Live Photo 分組） |
| GET | `/api/media/:id` | 素材詳情（含最新的 AI 分析） |
| GET | `/api/media/:id/preview` | 預覽檔（影片 mp4 或照片 jpg），支援 Range |
| GET | `/api/media/:id/thumb` | 縮圖 |
| PATCH | `/api/media/:id` | `{excluded?}` |
| POST | `/api/media/:id/retry` | 重跑失敗的素材處理 |
| DELETE | `/api/media/:id` | 刪除素材（Live Photo 整組一起刪；處理中回 409） |
| GET | `/api/music` | 曲庫列表 |
| POST | `/api/music?filename=` | 上傳一首歌，body 就是檔案本身，完成後自動排入拍點分析。回 201 |
| GET | `/api/music/:id` | 曲目詳情（beats、downbeat 索引、energy、建議段落） |
| GET | `/api/music/:id/audio` | 音樂檔，支援 Range |
| PATCH | `/api/music/:id` | `{title?, artist?}` |
| DELETE | `/api/music/:id` | 刪除曲目。用到它的時間軸會出現驗證錯誤「歌曲已刪除」 |
| GET | `/api/projects/:id/draft-estimate?provider=` | 這次產生初版能否重用分析，以及預估費用 |
| POST | `/api/projects/:id/draft` | 產生初版或 AI 重排 `{trackId, provider?, startBeat?, seed?, reanalyze?}`。回 202；前置條件不符回 409 或 422 |
| GET | `/api/projects/:id/timelines` | 時間軸版本列表 |
| GET | `/api/timelines/:id` | 時間軸，加上預覽所需的資產和驗證結果 |
| PUT | `/api/timelines/:id` | 儲存修改 `{data}` |
| POST | `/api/timelines/:id/renders` | 匯出。回 202 `{renderId}`；驗證錯誤回 422 |
| GET | `/api/renders/:id` | 匯出進度和下載網址 |
| GET | `/api/renders/:id/download` | 下載成品，檔名為「專案名稱.mp4」 |
| GET | `/api/renders/:id/slices/:name` | 算圖程序讀取切片用 |
| GET | `/api/projects/:id/renders` | 匯出紀錄 |

### 10.3 主要 payload

**上傳素材**

```jsonc
// POST /api/projects/:id/media?filename=IMG_1234.MOV&lastModified=1759472530000
// Content-Length: 183500000；body 就是檔案本身
// → 201 Media（status = "uploaded"）
// → 409 { "error": { "code": "DUPLICATE", "message": "與 IMG_1200.MOV 重複", "details": { "mediaId": "…" } } }
// → 507 磁碟空間不足
```

**Media**

```jsonc
{
  "id": "…", "kind": "video", "status": "ready", "error": null,
  "filename": "IMG_1234.MOV",
  "width": 1080, "height": 1920, "durationSec": 12.4, "isHdr": true, "hasAudio": true,
  "capturedAt": "2026-10-03T14:22:10+08:00",
  "lat": 25.026, "lng": 121.543,
  "excluded": false, "livePhoto": false,
  "thumbUrl": "/api/media/…/thumb", "previewUrl": "/api/media/…/preview",   // 處理完成前為 null
  "analysis": {
    "usable": true, "score": 8, "description": "朋友在餐廳吹蠟燭",
    "moments": [{ "t": 3.2, "score": 9, "focusX": 0.52, "focusY": 0.41 }],
    "duplicateOf": null
  }
}
```

**Project**

```jsonc
{
  "id": "…", "title": "2026 秋天",
  "dateRange": { "from": "2026-09-02", "to": "2026-11-28" },  // 素材拍攝日期的最早和最晚；沒有素材時為 null
  "draftState": "analyzing", "draftError": null,
  "currentTimelineId": "…",
  "mediaCounts": { "total": 32, "ready": 30, "processing": 1, "failed": 1, "excluded": 2 }
}
```

**GET /api/config**

```jsonc
{
  "aiProviders": [
    { "id": "anthropic", "model": "claude-opus-5-5", "available": true },
    { "id": "openai", "model": "…", "available": false }
  ],
  "defaultProvider": "anthropic"
}
```

**GET /api/projects/:id/draft-estimate?provider=anthropic**

```jsonc
{ "reuse": false, "estimatedUsd": 0.82, "mediaCount": 64, "imageCount": 360 }
```

**GET /api/timelines/:id**

```jsonc
{
  "id": "…", "projectId": "…", "seed": 1234, "durationSec": 22.4,
  "createdAt": "…", "updatedAt": "…",
  "data": { /* Timeline §3.2 */ },
  "assets": {
    "media": { "<mediaId>": { "kind": "video", "previewUrl": "/api/media/…/preview", "width": 1080, "height": 1920, "durationSec": 12.4 } },
    "music": { "url": "/api/music/…/audio", "beats": [0.42, 0.93], "downbeatIndices": [0, 4, 8], "durationSec": 213.4 }
  },
  "validation": {
    "errors": [],
    "warnings": [{ "code": "CLIP_TOO_LONG", "clipId": "…", "message": "片段 2.4 秒，超過 2 秒" }]
  }
}
```

`durationSec` 由時間軸和歌曲拍點即時計算，不另外儲存。

**GET /api/renders/:id**

```jsonc
{ "id": "…", "state": "rendering", "progress": 0.42, "error": null, "downloadUrl": null, "createdAt": "…", "finishedAt": null }
```

---

## 11. 前端

### 11.1 頁面

| 路徑 | 內容 |
|---|---|
| `/` | 專案列表、新增專案 |
| `/projects/:id` | 素材頁和產生初版 |
| `/projects/:id/edit` | 編輯器 |
| `/music` | 曲庫 |

### 11.2 素材頁

- **上傳區**：
  - 支援拖放。選取後先在畫面上列出檔案，每個檔案各自顯示上傳進度。
  - 失敗的檔案可以按「重傳」；重複的檔案顯示「與 IMG_xxxx 重複」。
- **素材格狀列表**：
  - 依拍攝時間排序
  - 每格顯示：縮圖、狀態、時間、排除開關
  - 處理失敗的素材顯示錯誤訊息，並提供「重試」和「刪除」
  - Live Photo 只顯示一張卡片（標示 LIVE）
- **產生初版區**：
  - 從曲庫選歌，顯示 BPM
  - 顯示建議段落，可以試聽
  - 選擇 AI 供應商，預設值來自設定
  - 需要重新分析時，按鈕旁顯示預估費用
  - 還有素材在處理時，按鈕不能按
  - 按「產生初版」後，依序顯示「AI 分析中 → 排版中」

### 11.3 編輯器

```
┌────────────────┬─────────────────────────────────────────────┐
│                │ 片段屬性（目前選取的片段）                      │
│  9:16 預覽      │  換素材｜起點｜拍數 −/+｜裁切｜日期｜原音音量      │
│  [IG 遮罩開關]  │                                             │
├────────────────┴─────────────────────────────────────────────┤
│ 時間軸：片段卡片，寬度和拍數成正比，可拖曳排序；下方是拍點尺，標出重拍   │
├──────────────────────────────────────────────────────────────┤
│ 音樂：曲目｜起始小節 ◀▶｜淡出｜音量      總長 22.4 秒｜警告 2 項   │
│                                 [版本 ▾] [AI 重排] [匯出]       │
└──────────────────────────────────────────────────────────────┘
```

**片段操作**

- **選取、拖曳排序、刪除。**
- **插入**：從素材庫挑一個素材插到指定位置，預設值由 `buildClip` 決定。
- **換素材**：
  - 彈出候選清單，依 AI 分數排序
  - 每個候選顯示 AI 描述
  - 已經用在時間軸上的素材會標示「已使用」
- **拍數 −/+**：同時顯示換算後的秒數。
- **起點**：
  - 在原片的時間軸上拖曳選擇從哪一秒開始
  - 時間軸上標出 AI 建議的瞬間
- **裁切**：在預覽畫面上直接拖曳來移動焦點，旁邊有 zoom 滑桿。
- **日期**：可修改或隱藏。
- **原音音量**：影片片段可調整原音音量（0–100%）。

**音樂操作**

- **換歌**：依 §3.5 重新換算。
- **起始小節**：一次移動一小節，一定對齊重拍。
- **淡出秒數、音量。**

**全域功能**

- **驗證面板**：列出所有警告和錯誤，點一下就選到對應的片段。
- **IG 介面遮罩開關。**
- **Undo／Redo**：保留最近 100 步，只在當次頁面有效。
- **自動儲存**：停止操作 1 秒後，直接存回目前版本。
- **版本選單**：切換不同的時間軸版本。
- **AI 重排**：用新的 seed 產生新版本，也可以改選 AI 供應商。需要重新分析時先顯示預估費用。目前的修改會留在原本的版本。
- **匯出**：
  - 按下後先送出還沒儲存的修改，再開始匯出
  - 顯示進度條
  - 完成後顯示下載連結
  - 可以查看過去的匯出紀錄
- **快捷鍵**：
  - Space：播放／暫停
  - ⌘Z／⌘⇧Z：Undo／Redo
  - Delete：刪除選取的片段
  - ←／→：選上一個／下一個片段

---

## 12. Python analyzer

```
analyzer/
├ pyproject.toml            uv 管理；依賴 beat_this、numpy、soundfile
└ src/analyzer/__main__.py
```

| 指令 | 輸入 | 輸出（stdout） |
|---|---|---|
| `doctor` | 無 | `{ok, python}`，給健康檢查用 |
| `beats --input song.wav` | 一個 wav | `{bpm, beats: [], downbeatIndices: [], energy: {hopSec: 0.5, values: []}}` |

- **beats**：重拍的時間對應到最接近的 beat，輸出成索引。
- **呼叫方式**：Node 執行 `uv run --project analyzer python -m analyzer …`。stdout 當結果解析，stderr 寫進 log；逾時或取消時結束子程序。

---

## 13. 設定（`.env`）

```
DATABASE_URL=postgres://revcut:revcut@localhost:5432/revcut
AI_PROVIDER=anthropic                 # anthropic | openai
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5-5
ANTHROPIC_EFFORT=medium
OPENAI_API_KEY=
OPENAI_MODEL=                         # Phase 4 選定
OPENAI_REASONING_EFFORT=medium
DATA_DIR=                             # 留空就是 ~/.revcut/data；要改請寫絕對路徑（.env 不會展開 ~）
HOST_DRIVE=/mnt/c                     # WSL 虛擬硬碟所在的 Windows 磁碟，用來檢查真正的剩餘空間
DEFAULT_TZ=Asia/Taipei
PORT=3000
```

`.env` 列入 `.gitignore`，repo 只提交 `.env.example`。

---

## 14. 錯誤處理與紀錄

- API：zod 驗證失敗回 400，並在 `details` 列出是哪些欄位。
- 背景工作：資料列寫入中文錯誤訊息，log 寫入完整錯誤。每筆 log 都帶有相關 id（projectId、mediaId、renderId）。
- 外部服務和環境失敗時的處理：

| 情況 | 處理 |
|---|---|
| AI 供應商失敗 | 這次產生初版失敗，顯示原因（被拒絕、輸出被截斷、格式不符、API key 無效） |
| 磁碟空間不足 | 拒絕上傳（507）；匯出前也會檢查，空間不夠就直接失敗並說明原因 |
| Remotion 的瀏覽器無法啟動 | 匯出失敗並提示安裝 README 列的系統套件；`/api/health` 事先就會顯示 |

- log 用 pino 輸出 JSON 到 stdout。

---

## 15. 測試策略

| 範圍 | 工具 | 內容 |
|---|---|---|
| `packages/shared` 時間軸 | vitest | 影格換算（100 段也不累積誤差、半格以內的對齊誤差）、`sliceWindow`（起點 0、0.2、接近結尾）、各條驗證規則、換歌、Live Photo 分組 |
| `packages/shared` planner | vitest | 性質測試：60–180 BPM 下每段都在允許範圍、總拍數等於 T、依時間排序、同一個 seed 結果相同。另外測影片比片段短、素材不足、素材過多 |
| metadata 解析 | vitest | `resolveCaptureTime`（有時區、沒有時區、UTC、只有修改時間）、HDR 判斷、副檔名判斷。fixture 是去除個資的 JSON，放在 `fixtures/metadata/`，可以 commit |
| AI adapter | vitest | 用錄好的回應測試兩家 adapter：request 格式轉換、schema 驗證、短代號對回 uuid、缺漏和超出範圍的處理、依實際模型計費。不實際呼叫 API |
| server API | vitest + 測試用資料庫 | 狀態轉換、409／422／507、重複上傳、Host 檢查、分析重用條件、啟動時的處理、刪除限制。外部 API 在模組邊界用假實作取代，檔案寫到測試用的暫存目錄 |
| analyzer | pytest | 合成的 120 BPM 節拍器音檔只驗證拍距 0.5 秒 ±20 ms，不驗證重拍。bpm 計算、重拍索引對應用固定輸入測試 |
| 媒體實際處理 | 手動驗收 | 真實樣本放在 `fixtures/private/`（列入 .gitignore）；需要樣本的測試在檔案不存在時跳過 |

---

## 16. 開發分期與驗收

| 期 | 範圍 | 驗收條件 |
|---|---|---|
| 0 骨架 | monorepo、docker Postgres、所有資料表的 migration、`/api/health`、Host 檢查、確認 Remotion 授權 | `pnpm dev` 能同時啟動兩個服務，health 全部通過（含剩餘空間和 Remotion 瀏覽器）；非 localhost 的 Host 回 403 |
| 1 素材處理 | 串流上傳和 Range 讀取、ingest、衍生檔、metadata 解析、Live Photo 分組、素材頁 | 用真實樣本測試（iPhone HDR 影片、HEIC、Live Photo、Android MP4、直拍和橫拍）：預覽顏色和方向正確；拍攝時間和「照片」App 顯示的一致；Live Photo 顯示為一張 LIVE 卡片，預覽是動態影片；重複上傳回 409。記錄一支 iPhone 4K HDR 影片產生預覽檔的時間 |
| 2 曲庫 | 音樂上傳、拍點分析、曲庫頁（可用節拍器聲試聽） | 3 首不同速度的歌，節拍器聲聽起來對齊；BPM 和已知值相差在 ±1 以內；建議段落落在 20–25 秒，而且從重拍開始 |
| 3 合成與匯出 | composition、唯讀預覽、簡易排版（依時間排序、每段固定拍數、置中裁切）、完整匯出流程、IG 遮罩 | 用 ffprobe 確認成品為 1080×1920、30 fps、h264/aac；影格換算和 `sliceWindow` 的測試通過；抽 3 個時間點比對，預覽和成品一致（包含從影片開頭附近開始的片段）；上傳到 IG 發文預覽時，左下文字沒有被擋住 |
| 4 AI 初版 | 抽畫面、AI 分析（Anthropic 和 OpenAI 兩個 adapter）、正式排版程式、原音和音樂混音 | 用你真實的素材，兩家各產出一次初版；每次費用都有記錄，Anthropic 低於 US$2；planner 和 adapter 測試全部通過 |
| 5 編輯器 | §11.3 的全部功能 | 每個操作都會即時反映在預覽；剛改完立刻匯出，成品也包含最後的修改；換歌後總長仍是整數小節；重新整理頁面後修改還在 |

每一期完成後我會停下來，請你驗收之後才進入下一期。

---

## 17. 風險

| 風險 | 對策 |
|---|---|
| Remotion Player 連續播放 20 幾段短影片可能卡頓 | 預覽檔用 720p、短 GOP、提前載入下一段；Phase 3 一開始就驗證 |
| HDR 轉 SDR 的顏色不自然 | 用真實素材比對，調整 tonemap 參數 |
| HDR 影片轉預覽檔太慢 | 先縮小再轉色彩；Phase 1 量測並記錄 |
| beat_this 依賴 PyTorch：安裝檔大，CPU 分析一首歌需要數十秒 | 如果安裝或準確度有問題，改用 librosa（沒有重拍，改用每 4 拍推算） |
| AI 給的焦點座標只是近似值 | 編輯器可以拖曳修正 |
| 兩家模型的判斷品質可能不同 | Phase 4 用同一批素材各跑一次比較，再決定預設供應商 |
| 從 iPhone 匯出到電腦時，Live Photo 可能只剩 HEIC（例如只選了照片，或用「最相容」格式匯出） | 沒有 MOV 的一律當照片；Phase 1 用你實際的匯出方式測試 |
| 保留原音後，每次切換時環境音忽大忽小，聽起來可能很雜 | 預設音量偏低（35%），每段前後淡入淡出，也可以逐段調整 |
| 素材的 metadata 和預期不同（新 iPhone、編輯 App 改過的檔案） | 解析函式只吃 fixture 測過的格式；遇到新格式先加 fixture 和測試再改 |
| IG 會再壓縮一次影片 | 用高畫質輸出；發文前先在 IG 預覽畫面確認 |
| 依賴項目的授權條款有變 | Phase 0 已確認 Remotion 4 個人使用免費；Remotion 5 的條款會改變，升級前再確認 |

---

## 18. 決策紀錄

以下是我提出、你同意或沒有異議的預設值。要改的話隨時說，大多只是改一個常數。

1. 左下角只顯示拍攝日期，每個片段都顯示，切換片段時跟著換。
2. 結尾淡出 1.5 秒，音樂和原音一起淡出。
3. 只支援桌面版 Chrome。
4. 片段依拍攝時間排序。
5. 除了硬切之外不做轉場特效。
6. 重複的檔案在上傳時就拒絕，不會建立素材。
7. 影片原音預設音量 35%，和音樂混在一起。
8. AI 供應商兩家擇一切換：每次產生初版時選一家，不會同時呼叫兩家再合併結果。
9. 不論專案涵蓋多長的期間，成品都維持 20–25 秒。
10. Live Photo 要連同同名的 MOV 一起上傳才會當影片；只有 HEIC 就當照片。
11. 被時間軸用過的歌可以刪除，用到它的版本會顯示錯誤。
12. 素材處理中、或專案有工作進行中時，不能刪除。
13. 保留逐素材的 AI 分析表（`media_analysis`）。
14. Remotion 在第一次匯出時才準備，`pnpm dev` 重啟比較快。
15. server 重啟後，免費的工作自動重跑；付費的產生初版不自動重跑。
16. 時間軸版本直接修改；要回到某個 AI 版本，用它的 seed 再排一次。
17. MVP 不做地名和字幕（v0.5）。Whisper 一起拿掉，所以也不偵測說話、不壓低音樂。
18. HEIC 用 `heic-decode` 解碼，因為系統的 libheif 1.12 讀不了 iPhone 16 Pro 的 HEIC。解碼在主執行緒上跑，每張約 1 秒，單人使用可以接受。
