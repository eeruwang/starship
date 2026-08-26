<p align="center">
  <img src="public/favicon.svg" width="80" height="80" alt="StarShip">
</p>

<h1 align="center">StarShip</h1>

<p align="center">
  <strong>Fediverse Multi-Account Dashboard</strong><br>
  Misskey &middot; Mastodon &middot; Iceshrimp &middot; CherryPick
</p>

<p align="center">
  <a href="https://starship.eeruwang.me">starship.eeruwang.me</a>
</p>

---

여러 Fediverse 계정(Misskey, Mastodon, Iceshrimp, CherryPick 등)을 하나의 대시보드에서 통합 관리하는 웹 클라이언트입니다. 계정별 타임라인을 컬럼 레이아웃으로 한눈에 볼 수 있고, 다중 계정 동시 게시·답글·인용, 대화 스레드 트리 시각화, MFM(Misskey Flavored Markdown) 렌더링, 커스텀 이모지 리액션 등 Fediverse 생태계의 다양한 기능을 프레임워크 없는 바닐라 JS SPA로 구현했으며, Cloudflare Workers + D1 기반으로 배포됩니다.

---

## Features

- **Multi-Account** - 여러 Fediverse 계정을 한 곳에서 관리
- **Multi-Platform** - Misskey, Mastodon, Iceshrimp, CherryPick 지원
- **Column Layout** - 계정별 타임라인 컬럼, 전체 통합 피드, 알림 컬럼
- **Compose** - 다중 계정 동시 게시, 답글, 인용, 미디어 첨부
- **Thread View** - 대화 스레드를 트리 구조로 시각화
- **MFM Rendering** - Misskey Flavored Markdown 전체 지원 (`$[spin]`, `$[rainbow]`, `$[fg]`, `$[ruby]` 등)
- **Reactions** - 미스키 리액션 표시 및 전송, 커스텀 이모지 지원
- **Keyword Alerts** - 계정마다 감시할 낱말을 걸어 두면, 그 낱말이 든 글이 타임라인에 뜰 때 멘션이 아니어도 알림 컬럼에 들어옴 (계정 관리 → 🔔)
- **Image Lightbox** - 이미지 확대 보기 (줌 애니메이션)
- **Drag Scroll** - 컬럼 헤더 드래그로 좌우 스크롤 (모멘텀 지원)
- **Cloud Sync** - 계정 설정 클라우드 동기화
- **Responsive** - 데스크톱, 태블릿, 모바일 대응
- **Dark Theme** - 기본 다크 테마

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com/) |
| Database | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| Auth | Session-based + [Turnstile](https://www.cloudflare.com/products/turnstile/) CAPTCHA |
| Frontend | Vanilla JS (ES Modules, no framework) |
| CSS | Custom Properties, responsive, dark theme |

## Project Structure

```
starship/
├── src/
│   └── worker.js          # Cloudflare Worker (API routes, auth, proxy)
├── public/
│   ├── index.html          # SPA entry
│   ├── favicon.svg         # App icon
│   ├── css/
│   │   └── style.css       # All styles
│   └── js/
│       ├── main.js         # App core (init, events, routing)
│       ├── accounts.js     # Account store
│       ├── auth.js         # Auth client
│       ├── keyword-alerts.js # 감시 낱말 판정·보관 (DOM 없는 순수 로직)
│       ├── api/
│       │   ├── misskey.js  # Misskey/Iceshrimp/CherryPick API client
│       │   └── mastodon.js # Mastodon API client
│       ├── mixins/
│       │   ├── post-actions.js   # Reply, boost, reaction, delete, edit
│       │   ├── compose.js        # Compose modal
│       │   ├── data-loading.js   # Timeline & notification loading
│       │   ├── auth-ui.js        # Auth UI (login, register, menu)
│       │   ├── account-setup.js  # Account add/settings
│       │   ├── thread-view.js    # Conversation thread view
│       │   ├── keyword-alerts.js # 계정별 감시 낱말 → 알림 컬럼 주입
│       │   └── profile-modal.js  # Profile modal & edit
│       └── ui/
│           ├── dashboard.js      # Post/notification/account card rendering
│           ├── emoji-picker.js   # Emoji picker (common + instance custom)
│           └── icons.js          # SVG icon exports
├── wrangler.toml           # Cloudflare Workers config
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Local dev server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy
```

## Environment Setup

1. [Cloudflare D1 데이터베이스](https://developers.cloudflare.com/d1/) 생성
2. `wrangler.toml`에 D1 database ID 설정
3. [Turnstile](https://www.cloudflare.com/products/turnstile/) 사이트 키 발급 후 `wrangler.toml`에 설정
4. Turnstile secret 설정: `wrangler secret put TURNSTILE_SECRET`

## Note

이 프로젝트는 AI를 활용하여 제작되었습니다.

## License

MIT &copy; 2025-2026 [eeruwang](https://eeruwang.me)
