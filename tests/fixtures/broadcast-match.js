/**
 * 방송 판 재현 데이터 — 데블스 플랜: 데드 어게인 1일차 감옥매치 「무거운 13」 (7인, 14라운드)
 *
 * 출처: HEOJUNFO/Devils_Plan (tests/unit/under-thirteen/documented.ts), MIT License,
 *       Copyright (c) 2026 Donchitos. 방송 자막의 딜러 진행 발화로 복원한 데이터이며
 *       넷플릭스 원본과 직접 대조된 것은 아니다(원 저장소 설계 문서에 명시).
 * 형식: 플레이어 번호 = 1라운드 선 플레이어부터 시계 방향 좌석.
 *   picks[p] = [카드, 칩, (레인보우면 고른 받침대)]
 *   order = 패스 전 호명 순서, passes = 패스한 순서, penalties = [받은 사람, 벌점] (부여 순)
 * 이 파일은 검증용 고정 데이터로만 쓰며 게임 코드에는 들어가지 않는다.
 */
export const MATCH = [
  {
    first: 0,
    picks: [[5, "red"], [6, "green"], [5, "blue"], [5, "green"], [6, "red"], [5, "blue"], [5, "red"]],
    order: [1, 4, 0, 2, 3, 5, 6],
    passes: [],
    penalties: [[6, 2]],
  },
  {
    first: 6,
    picks: [[2, "blue"], [1, "red"], [1, "green"], [2, "red"], [3, "blue"], [3, "green"], [6, "red"]],
    order: [6, 4, 5, 0, 3, 1, 2],
    passes: [],
    penalties: [[4, 2], [5, 2], [3, 2]],
  },
  {
    first: 3,
    picks: [[4, "red"], [5, "blue"], [6, "red"], [6, "blue"], [4, "red"], [6, "red"], [4, "rainbow", "blue"]],
    order: [6, 3, 5, 2, 1, 4, 0],
    passes: [3, 2, 1, 4],
    penalties: [[0, 3], [1, 3], [2, 2]],
  },
  {
    first: 2,
    picks: [[1, "green"], [4, "red"], [3, "green"], [3, "rainbow", "red"], [5, "green"], [4, "red"], [3, "blue"]],
    order: [3, 4, 5, 1, 2, 6, 0],
    passes: [5],
    penalties: [[1, 2], [6, 2], [0, 4]],
  },
  {
    first: 0,
    picks: [[3, "rainbow", "green"], [0, "green"], [4, "rainbow", "green"], [1, "green"], [2, "green"], [2, "green"], [2, "green"]],
    order: [2, 0, 4, 5, 6, 3, 1],
    passes: [6],
    penalties: [[3, 5]],
  },
  {
    first: 3,
    picks: [[6, "blue"], [3, "rainbow", "blue"], [2, "blue"], [4, "red"], [0, "blue"], [0, "blue"], [1, "green"]],
    order: [1, 0, 3, 2, 6, 4, 5],
    passes: [],
    penalties: [[2, 3]],
  },
  {
    first: 2,
    picks: [[0, "green"], [2, "blue"], [0, "red"], [0, "blue"], [1, "rainbow", "blue"], [1, "rainbow", "green"], [0, "blue"]],
    order: [4, 5, 1, 2, 3, 6, 0],
    passes: [],
    penalties: [],
  },
  {
    first: 2,
    picks: [[0, "blue"], [0, "red"], [6, "blue"], [6, "green"], [6, "rainbow", "blue"], [6, "red"], [6, "rainbow", "green"]],
    order: [4, 6, 2, 3, 5, 0, 1],
    passes: [],
    penalties: [[2, 8], [3, 7], [5, 4]],
  },
  {
    first: 5,
    picks: [[2, "rainbow", "green"], [6, "green"], [0, "red"], [1, "blue"], [3, "green"], [4, "green"], [5, "red"]],
    order: [0, 1, 6, 5, 4, 3, 2],
    passes: [1],
    penalties: [[4, 3]],
  },
  {
    first: 4,
    picks: [[5, "green"], [5, "rainbow", "blue"], [1, "rainbow", "red"], [3, "green"], [5, "blue"], [5, "blue"], [4, "blue"]],
    order: [1, 2, 4, 5, 0, 6, 3],
    passes: [4, 5],
    penalties: [[0, 2], [6, 4], [4, 2]],
  },
  {
    first: 4,
    picks: [[4, "blue"], [1, "blue"], [4, "green"], [2, "blue"], [4, "green"], [3, "blue"], [2, "green"]],
    order: [4, 0, 2, 5, 6, 3, 1],
    passes: [2, 3],
    penalties: [[6, 3], [1, 3]],
  },
  {
    first: 1,
    picks: [[3, "green"], [4, "blue"], [3, "blue"], [5, "rainbow", "blue"], [2, "blue"], [0, "red"], [3, "blue"]],
    order: [3, 1, 2, 6, 0, 4, 5],
    passes: [2, 6],
    penalties: [[4, 4]],
  },
  {
    first: 4,
    picks: [[6, "red"], [3, "green"], [2, "green"], [0, "red"], [0, "red"], [2, "green"], [0, "red"]],
    order: [0, 1, 5, 2, 4, 6, 3],
    passes: [5],
    penalties: [[0, 6], [2, 4]],
  },
  {
    first: 2,
    picks: [[1, "red"], [2, "red"], [5, "red"], [4, "red"], [1, "red"], [1, "rainbow", "green"], [1, "green"]],
    order: [5, 2, 3, 1, 4, 6, 0],
    passes: [3, 1],
    penalties: [[0, 6]],
  },
];

/** What each player's penalty points came to, by player. */
export const TOTALS = [21, 8, 17, 14, 11, 6, 11];
