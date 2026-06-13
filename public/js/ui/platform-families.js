// =====================================================================
// StarShip — platform families (handoff snippet)
// 16개 플랫폼을 계열로 묶어 "색 = 가족 / 글자 배지 = 정확한 SW" 로 인코딩.
// 색 자체는 base.css 의 --accent-{sw} 16개를 그대로 사용(변경 없음).
// 이 맵은 (1) 계열 헤더/그룹핑 UI, (2) 색맹 모드에서 계열 아이콘 선택에 사용.
// =====================================================================

export const PLATFORM_FAMILIES = {
  misskey: {                       // Misskey 계열 (fork 다수)
    label: 'Misskey',
    members: ['misskey', 'sharkey', 'firefish', 'cherrypick', 'catodon', 'iceshrimp', 'foundkey', 'hajkey'],
  },
  mastodon: {                      // Mastodon 계열
    label: 'Mastodon',
    members: ['mastodon', 'hometown', 'glitchcafe'],
  },
  pleroma: {                       // Pleroma 계열
    label: 'Pleroma',
    members: ['pleroma', 'akkoma'],
  },
  independent: {                   // 독립 구현
    label: '독립',
    members: ['hollo', 'gotosocial'],
  },
};

// sw → family key
export const FAMILY_OF = Object.entries(PLATFORM_FAMILIES)
  .flatMap(([fam, { members }]) => members.map(m => [m, fam]))
  .reduce((acc, [m, fam]) => (acc[m] = fam, acc), {});

export function familyOf(sw) {
  return FAMILY_OF[sw] || 'independent';
}
