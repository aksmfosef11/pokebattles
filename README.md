# 포켓배틀즈 (PokéBattles)

[English](README.en.md) · **한국어**

백팩 배틀즈식 로그라이크 비동기 PvP 포켓몬 오토배틀러입니다. PokéRogue에서 데이터·스프라이트·다국어 이름·음악·효과음만 가져오고,
전투 규칙은 오토배틀용으로 새로 만들었습니다. 게임 규칙과 챔피언 9명의 기믹은 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

비상업 팬 프로젝트입니다. 포켓몬 IP는 Nintendo·Creatures·GAME FREAK 소유이며, 권리 고지와 삭제 요청 연락처는 [LICENSE.md](LICENSE.md),
출처와 조건은 [data/SOURCES.md](data/SOURCES.md)에 있습니다. 같은 고지가 로그인·타이틀 화면 아래에도 나옵니다(`apps/client/src/components/LegalNotice.tsx`).

## 서비스 종료와 이어서 만들기

온라인 서비스는 **2026년 11월 7일에 종료**합니다. 소스 코드는 이 저장소에 그대로 남겨 두니, 이어서 만들어 보고 싶다면 내려받아 쓰세요.
아래 "실행"대로 `git clone` → `pnpm install` → `pnpm dev`만 하면 DB나 설정 파일 없이 내 PC에서 바로 돌아갑니다(처음 계정은 내 PC 안에만 생깁니다).
고치기 전에 [docs/DESIGN.md](docs/DESIGN.md)(게임 규칙)와 아래 "구조"·"테스트" 절을 먼저 보세요.
다른 사람에게 서버를 열고 싶다면 아래 "배포 (Docker)"를 따르면 됩니다.
서비스 기간에 모은 실제 플레이 통계(챔피언·포켓몬·도구별 승률 등)는 [data/live-stats](data/live-stats/README.md)에 있으니, 밸런스 패치를 해 보고 싶다면 거기서 시작하세요.
포켓몬 관련 이미지·음악 등의 권리는 원 권리자에게 있으니, 비영리 팬 프로젝트라는 [LICENSE.md](LICENSE.md)의 조건 안에서 쓰세요.

## 실행

Node 20.19 이상, pnpm 10이 필요합니다.

```sh
pnpm install
pnpm dev          # API 서버(:8787) + 클라이언트(:5173) 동시 실행
```

브라우저에서 http://localhost:5173 을 엽니다. 처음에는 아이디·비밀번호(각 4자 이상, 다른 정보 없음)로 회원가입하고 첫 챔피언을 고릅니다.
서버에 연결할 수 없으면 클라이언트가 같은 게임 로직을 브라우저 안에서 돌리는 오프라인 모드(로그인 없음, 진행은 이 브라우저에 저장,
봇·내 이전 모험의 고스트가 상대, 랭킹전 없음)로 전환합니다.

개발 중에는 PostgreSQL을 따로 설치하지 않아도 됩니다. `DATABASE_URL`이 없으면 서버가 PGlite(WASM으로 돌아가는 진짜 PostgreSQL)를
`apps/server/data/pglite`에 두고 씁니다. 개발 PC에서도 실제 PostgreSQL로 돌리려면 `DATABASE_URL=postgres://… pnpm dev`처럼 줍니다.

## 데이터베이스

서비스용 DB는 **PostgreSQL**입니다. 이 게임이 저장하는 것이 서로 얽힌 관계형 데이터(계정·세션·모험·고스트·전투 기록·정산 결과)이고,
포인트·레이팅 정산은 트랜잭션과 행 잠금(`SELECT … FOR UPDATE`)으로 한 번만 지급되어야 하며, 매칭(라운드별 최근 고스트를 플레이어당 하나씩)과
밸런스 통계가 SQL(윈도 함수·집계)로 풀리는 일이기 때문입니다. 모험 상태·고스트 팀처럼 모양이 자주 바뀌는 게임 데이터는 JSONB 열에 둡니다.
서버 여러 대가 한 DB를 같이 쓸 수 있고, 관리형 PostgreSQL(RDS·Cloud SQL·Supabase·Neon 등)에 그대로 올릴 수 있습니다.

| 어떻게 돌리나 | DB |
|---|---|
| `DATABASE_URL`이 있을 때 (docker compose, 실제 서비스) | 그 PostgreSQL. 연결 풀 크기는 `PG_POOL_MAX` |
| `DATABASE_URL`이 없을 때 (`pnpm dev`, 서버 컨테이너 하나만 `docker run`) | 내장 PGlite. `POKEBATTLES_PGDATA` 폴더(기본 `apps/server/data/pglite`, Docker `/data/pglite`). 한 프로세스만 열 수 있습니다 |
| `pnpm test` | 메모리 PGlite. `TEST_DATABASE_URL=postgres://…`를 주면 실제 PostgreSQL의 임시 스키마에서 돌고 끝나면 지웁니다 |

스키마는 서버가 뜰 때 `apps/server/src/schema.ts`의 마이그레이션 목록대로 맞춥니다(`schema_migrations` 표에 적용한 번호를 기록).
열을 더하려면 목록 끝에 새 번호를 추가하고, 이미 배포된 항목은 고치지 않습니다.
예전 SQLite 파일(`apps/server/data/*.sqlite`)은 테스트 데이터뿐이라 옮기지 않았습니다. 새 DB는 빈 상태에서 시작합니다.

## 배포 (Docker)

서버(API)와 클라이언트(화면)는 따로 된 이미지입니다. 저장소 루트에서:

```sh
cp .env.example .env        # POSTGRES_PASSWORD는 꼭 바꾸고, 필요하면 ADMIN_TOKEN 등 설정
docker compose up -d --build
```

| 서비스 | 주소 | 내용 |
|---|---|---|
| `client` | http://localhost:8080 | nginx가 빌드된 화면을 제공하고 `/api`를 `server`로 넘깁니다 |
| `server` | http://localhost:8787 | API만. `db`에 `DATABASE_URL`로 붙습니다 |
| `db` | (밖으로 열지 않음) | PostgreSQL 17. 데이터는 `pokebattles-pg` 볼륨. 계정·비밀번호·DB 이름은 `.env`의 `POSTGRES_*` |

백업과 복원:

```sh
docker compose exec db pg_dump -U pokebattles -Fc pokebattles > pokebattles.dump
docker compose exec -T db pg_restore -U pokebattles -d pokebattles --clean < pokebattles.dump
```

서버 이미지만 따로 쓸 수도 있습니다: `docker build -f apps/server/Dockerfile -t pokebattles-server .` →
`docker run -d -p 8787:8787 -e DATABASE_URL=postgres://user:pass@host:5432/pokebattles pokebattles-server`
(`DATABASE_URL` 없이 `-v pokebattles-data:/data`로 띄우면 컨테이너 안의 PGlite에 저장합니다. 컨테이너 하나일 때만).
화면을 다른 곳(정적 호스팅 등)에 올린다면 클라이언트를 `VITE_API_URL=https://api.example.com`으로 빌드하고 서버에 `CORS_ORIGIN`을 줍니다.

| 서버 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 8787 | |
| `DATABASE_URL` | 없음 | PostgreSQL 주소(`postgres://user:pass@host:5432/db`). TLS는 주소 끝에 `?sslmode=require` |
| `PG_POOL_MAX` | 10 | 서버 한 대가 여는 PostgreSQL 연결 수 |
| `POKEBATTLES_PGDATA` | `apps/server/data/pglite` (Docker: `/data/pglite`) | `DATABASE_URL`이 없을 때 쓰는 PGlite 폴더 |
| `ADMIN_TOKEN` | 없음 | 있으면 `GET /api/admin/stats`(밸런스 통계)를 `Authorization: Bearer <토큰>`으로 열람 |
| `CORS_ORIGIN` | 없음 | 쉼표로 구분한 화면 주소들. 화면을 API와 다른 곳에 올릴 때만 |
| `REGISTER_PER_HOUR` | 10 | 주소(IP)당 시간당 가입 수(부계정 대량 생성 방지). 0이면 제한 없음. nginx 뒤에서는 nginx가 넘긴 실제 주소 기준 |

Docker 없이 한 프로세스로 돌릴 때는 `pnpm --filter @pokebattles/client build` 후 `pnpm --filter @pokebattles/server start`입니다.
이때는 서버가 `apps/client/dist`(또는 `CLIENT_DIST`)를 함께 제공합니다.

## 밸런스 통계 (실제 플레이)

서버는 끝난 모험(`run_results`: 챔피언·전직·승패·최종 파티·도구)과 모든 전투(`battles`: 양쪽 챔피언·전직·포켓몬·도구·결과)를 기록합니다.

```sh
pnpm stats                                        # DATABASE_URL, 없으면 apps/server/data/pglite로 Markdown 보고서 (PGlite면 dev 서버를 먼저 끄기)
pnpm stats --pgdata ../../backup/pglite           # 다른 PGlite 폴더 (경로는 apps/server 기준)
pnpm stats --since 2026-10-01 --ranked            # 기간·랭킹전만 (--normal: 일반전만)
pnpm stats --min-round 8 --min-sample 30 --out stats.md   # 8라운드 이후 전투만, 표본 30 이상만 (--out 경로는 apps/server 기준)
docker compose exec server node dist/stats.mjs --since 2026-10-01   # Docker
curl -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8787/api/admin/stats?format=md&ranked=true"
```

챔피언별 판 수·선택률·평균 승수·트로피 비율·승수 분포·전투 승률(플레이어 고스트 상대만 따로), 전직별 선택률·평균 승수,
챔피언 상성표, 포켓몬·도구별 전투 승률과 최종 파티 평균 승수를 봅니다. 봇 상대 전투의 봇 팀은 플레이어의 선택이 아니라서 포켓몬·도구 통계에서 뺍니다.
`pnpm balance`(봇 시뮬레이션)와 함께 보고 조정합니다.

## 구조

| 경로 | 내용 |
|---|---|
| `packages/game` | 순수 TypeScript 게임 규칙. 클라이언트·서버·오프라인 모드가 같은 코드를 씁니다. |
| `packages/game/src/run` | 런 상태, 상점, 가방 격자 배치, 진화·경제 진행 |
| `packages/game/src/battle` | 행동 게이지 전투 시뮬레이터, 기술 선택 AI, 메가·다이맥스·Z·테라 |
| `packages/game/src/server` | 라운드 처리(서버 권위 재생·고스트 저장·매칭), 봇 |
| `packages/game/src/meta` | 계정 진행: 포인트, 챔피언 영입, 챔피언별 포켓몬 해금, 랭킹전 레이팅 |
| `packages/game/locales` | 게임 고유 문구(ko, en). 포켓몬·기술·도구 이름은 여기 없습니다. |
| `apps/server` | Hono + PostgreSQL API (계정·모험·고스트·랭킹·통계), Docker 이미지 |
| `apps/client` | Vite + React 화면, Docker 이미지(nginx) |
| `tools/extract` | PokéRogue·PokeAPI 고정 커밋에서 데이터·로케일·스프라이트 추출 |
| `tools/content` | 추출 데이터를 게임 콘텐츠와 언어별 번들로 변환 |

## 데이터 다시 만들기

```sh
pnpm extract                                  # vendor/에 고정 커밋을 받아 data/pokerogue, data/i18n 생성
pnpm sprites                                  # apps/client/public/assets 스프라이트·아이콘·음악·효과음 복사
pnpm content                                  # packages/game/src/generated/content.json, 클라이언트 로케일 번들
```

로스터(스프라이트를 받을 종)는 `data/roster-ids.json`, 기술 효과 매핑과 크기·등급 규칙은 `tools/content/build-content.ts`에 있습니다.

음악·효과음은 PokéRogue 파일 그대로입니다(`assets/audio`, 목록과 루프 지점은 `tools/extract/lib/audio.ts` → `assets/audio/manifest.json`).
타이틀·로그인은 PokéRogue 타이틀곡(Firel, CC BY-NC-SA 4.0), 챔피언 선택은 메뉴곡, 상점은 BW/XY GTS 곡을 라운드마다 번갈아,
전투는 **상대 챔피언의 실제 챔피언전 곡**(레드=관동, 목호=성도, 성호=ORAS 호연, 난천, 노간주, 카르네, 쿠쿠이, 단델, 테사)을 틉니다.
곡을 바꾸려면 `apps/client/src/audio.ts`의 `BGM`과 위 목록을 함께 고칩니다. 음악은 필요한 곡만 재생할 때 받습니다(스트리밍).

### 포켓몬 추가

`data/pokerogue`에는 이미 전국도감 1025종 전부가 추출되어 있으므로, 로스터에 넣는 것만으로 추가됩니다.

1. `data/roster-ids.json`의 `species`에 PokéRogue 종 번호를 넣는다. 보통은 전국도감 번호이고, 지역 폼은 2000번대(알로라 나인테일 = 2038).
   진화 계열은 통째로 넣는다(로스터 밖 진화는 무시된다).
2. `pnpm sprites` → `pnpm content` → `pnpm test`.

종족값·타입·특성·28개 언어 이름·학습표·TM/알기술 후보·칸 크기·상점 등급·진화·메가/거다이맥스 폼은 자동입니다.
구현되지 않은 특성은 "효과 없음"으로 동작하고(`pnpm content` 출력과 `IMPLEMENTED_ABILITY_KEYS` 참고),
전설 등 등급을 바꾸려면 `build-content.ts`의 `TIER_OVERRIDE`, 상점 제외는 `NOT_IN_SHOP`을 고친다.
상점에는 **그 챔피언 세대의 포켓몬과 챔피언의 실제 파티(`champions.ts`의 `squad`) 계열만** 나오므로, 새 종은 세대가 맞는 챔피언의 상점에만 등장한다.

### 밸런스 점검

```bash
pnpm balance --fast --seeds ,b   # 조정 확인용: 최상 파티 탐색 없이 두 시드를 한 번에 (12코어 약 15분)
pnpm balance                     # 최종 보고서: 최상 파티 탐색 포함, 한 시드 (12코어 약 40분)
pnpm balance --quick --fast      # 2분짜리 대략 확인
```

챔피언마다 8·14라운드의 봇 런 150개(운 나쁜 p10·보통·운 좋은 p90)와 최상 파티(풀 안에서 탐색)를 만들어 108팀 기준 필드와 붙이고,
상위 10% 런끼리의 승률("운 대 운")까지 `docs/balance-report.md`에 적는다. 같은 시드면 결과가 똑같으므로, 조정 전후는 같은 시드로 비교한다.

밸런스를 바꾼 뒤에는 랭킹전 봇의 레이팅도 다시 잰다(12코어 약 8분, `--quick`은 약 2분):

```bash
pnpm bot-ratings   # 운 단계별 봇 vs 보통 봇 → packages/game/src/generated/bot-ratings.json
```

## 비동기 PvP 흐름

0. 로그인하면 서버가 세션 토큰을 주고, 모든 요청은 `Authorization: Bearer <토큰>`으로 계정을 밝힙니다.
1. 클라이언트는 상점 단계의 행동(구매·배치·판매 등)을 로컬에서 바로 적용하며 기록합니다.
   런의 시드는 서버만 압니다(클라이언트가 받는 상태의 `seed`는 빈 문자열). 그래서 시드가 필요한 행동(리롤, 몬스터볼·교환권·화석 열기, 전직 선택)은
   클라이언트가 계산할 수 없고, 그때까지의 행동과 함께 `POST /api/runs/:id/act`로 보내면 서버가 적용해 **확정**하고 결과 상태를 돌려줍니다.
   확정된 행동은 되돌릴 수 없어서 순서를 바꿔 가며 결과를 엿볼 수 없습니다. 이후 행동은 확정 지점부터 이어서 보냅니다.
2. 전투 시작 시 마지막 확정 이후의 기록을 서버로 보내면, 서버가 확정된 행동 + 새 기록을 같은 순수 함수로 재생해 판을 확정합니다.
   모든 행동은 형태부터 검사합니다(조각 id는 자기 판의 것만, 좌표는 판 안 정수, 회전 0~3, 상점 칸 0~4).
3. 서버는 그 판을 해당 라운드의 고스트로 저장하고, 같은 라운드·비슷한 승수의 다른 플레이어 고스트(없으면 봇)와 전투를 시뮬레이션합니다.
   랭킹전은 레이팅 ±300 안의 랭킹전 고스트끼리, 레이팅이 비슷할수록 자주 만납니다. 없으면 레이팅에 맞춰 운만 다른 봇이 나옵니다.
4. 클라이언트는 같은 시드로 같은 전투를 다시 돌려 연출합니다.
5. 모험이 끝나는 턴에 서버가 포인트·챔피언별 해금·레이팅을 한 번만 정산해 응답에 담습니다(`reward`).
   레이팅은 전투마다 상대 레이팅(고스트 주인의 당시 레이팅, 봇은 측정된 강함)을 상대로 한 Elo 결과를 합한 것입니다.

## 테스트

```sh
pnpm test         # 게임 규칙·전투 기믹·계정 진행·API
pnpm typecheck
```
