# 무거운 13 — Claude Code 작업 안내

데블스 플랜 3 감옥매치 「무거운 13」을 2~7인 실시간 웹게임으로 구현한 프로젝트. 사내 팀원 4~5명이 점심시간에 쓴다.
사용자는 한국어로 소통한다. 답변·커밋 메시지·코드 주석은 한국어로 쓴다.

## 명령
- `npm run dev` → http://localhost:3000 (Redis 없이 메모리 저장소. 서버 재시작하면 방이 사라짐)
- `npm test` → 전체 테스트 (Node 20+, 설치할 패키지 없음). 수정 후 반드시 통과시킨다.
- 여러 명 테스트: 브라우저 창 여러 개(또는 시크릿 창)로 같은 방 링크에 들어가면 각각 다른 플레이어가 된다. 토큰은 localStorage `h13:t:{방코드}`에 저장되므로 같은 브라우저 프로필 탭끼리는 같은 사람이다.

## 배포
- GitHub `main`에 push → Vercel 자동 배포 (Framework Preset: Other, 빌드 없음, `public/`이 정적 폴더).
- 저장소는 Vercel Storage의 Upstash Redis. 환경변수 `KV_REST_API_URL`/`KV_REST_API_TOKEN` 또는 `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`. `.env*` 파일은 절대 커밋하지 않는다.
- 팀원이 게임 중일 수 있으니 큰 수정은 브랜치에서 작업 → Vercel Preview URL로 확인 → `main`에 합친다.

## 구조
```
api/room.js     Vercel 함수 하나. GET ?code&token&beat = 내 화면 데이터 / POST {action,...} = 행동
lib/engine.js   규칙 엔진. 순수 함수 상태머신 (입력 상태를 바꾸지 않고 새 상태 반환). 시간·화면과 무관
lib/room.js     방·로비·타이머, act()로 행동 처리, advance()로 지난 마감 처리, viewFor()로 플레이어별 화면 데이터
lib/store.js    UpstashStore(REST + Lua CAS) / MemoryStore(로컬)
public/         index.html, style.css, app.js (바닐라 JS, 빌드 없음)
dev-server.js   로컬 서버 (api/room.js 그대로 사용)
tests/          engine(규칙+방송 판 재생), api(4인 완주·유출 검사·동시 제출), redis(실제 redis-server + Upstash REST shim)
```

## 반드시 지킬 것
1. **규칙 변경 금지 기준**: `tests/engine.test.js`의 "방송 판 재생" 테스트(최종 벌점 6·8·11·11·14·17·21)가 깨지면 규칙을 잘못 바꾼 것이다. 하우스 룰을 넣고 싶으면 방 설정 옵션으로 추가하고 기본값은 방송 규칙으로 둔다.
2. **비공개 정보**: 제출 단계에서 남의 카드·칩은 서버 응답에 절대 넣지 않는다. 새 필드를 `viewFor()`에 추가할 때 `STAGE_RANK`(submit < revealChips < revealCards < placing …) 기준으로 공개 시점을 지킨다. 남의 남은 패는 `publicHand()`처럼 공개 전 제출을 되돌려서 보여 준다. 토큰은 응답에 넣지 않는다.
3. **저장은 CAS로만**: 방 상태는 `mutate()`(읽기 → 수정 → 버전 비교 저장 → 충돌 시 재시도)로만 바꾼다. 직접 덮어쓰지 않는다.
4. **타이머는 지연 처리**: 서버리스라 백그라운드 타이머가 없다. 상태의 `until`(다음 일이 일어날 시각)을 두고, 요청이 올 때 `advance()`가 지난 일을 차례로 처리한다. 연출 시간은 `TIMING`, 테스트에서는 `H13_TIME_SCALE`로 줄인다.
5. **Redis 사용량**: Upstash 무료 한도는 월 50만 명령. 폴링 1회 = 명령 2개(HMGET + HGETALL). 폴링 간격(`pollDelay()`)을 줄이거나 요청당 명령을 늘릴 때는 한 판(5명, 15~30분) 사용량을 다시 계산한다.
6. **의존성 없이**: 패키지 추가 없이 유지한다. 꼭 필요하면 이유를 먼저 설명한다.
7. 방송 로고·이미지·디자인은 쓰지 않는다(팬메이드, 비영리).

## 화면 디자인 기준
- 핵심 요소는 받침대 게이지: 바위 높이 = 무게(`--u` × w), 13 기준선 항상 표시, "여유 n"으로 남은 공간 표시.
- 색: 바탕 슬레이트 `#263036` / 분필 `#EEEAE0` / 사암 바위 `#CDBF9F` / 경고 `#F2B84B` / 받침대 빨강 `#E5574C`·초록 `#3FAE6E`·파랑 `#4C8BEA`. 플레이어 색은 `--p0`~`--p6`.
- 글꼴: 숫자·제목 Black Han Sans, 나머지 IBM Plex Sans KR. 한국어는 `word-break: keep-all`.
- 휴대폰(390px)에서 받침대와 하단 행동 패널이 함께 보여야 한다. 수정 후 좁은 화면으로도 확인한다.
- 문구는 쉬운 존댓말 문장. 버튼은 하는 일을 그대로 쓴다("이걸로 내기", "한 판 더 하기").

## 알려진 한계·다음 할 일 후보
- 게임 중 나가기·관전자 입장 후 다음 판 참가는 로비로 돌아간 뒤에만 가능.
- 효과음, 봇(빈자리 채우기), 전적 누적은 아직 없음.
