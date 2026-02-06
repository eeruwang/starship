# StarShip

StarShip은 Misskey, Iceshrimp, CherryPick, Mastodon 계정을 한 화면에서 관리할 수 있는 Fediverse 대시보드입니다.

## 주요 기능

- 멀티 계정 타임라인/알림 통합 조회
- 인스턴스 URL 자동 정규화 (`https://` 없이 입력 가능)
- 인스턴스 기반 플랫폼 자동 감지
- OAuth / MiAuth 로그인 지원
- 계정 메뉴 기반 계정 관리 UI
- Misskey 커스텀 이모지(`:emoji:`) 인라인 렌더링

## 기술 스택

- Frontend: Vanilla JavaScript (ES Modules)
- Runtime/Deploy: Cloudflare Workers
- Dev Tooling: Wrangler

## 로컬 실행

### 1) 의존성 설치

```bash
npm install
```

### 2) 개발 서버 실행

```bash
npm run dev
```

기본적으로 Wrangler 개발 서버가 실행되며, 브라우저에서 안내된 주소로 접속할 수 있습니다.

## 배포

```bash
npm run deploy
```

스테이징 환경 배포:

```bash
npm run deploy:staging
```

## 프로젝트 구조

```text
public/
  index.html                # 메인 UI
  callback.html             # OAuth/MiAuth 콜백 처리
  css/style.css             # 스타일
  js/main.js                # 앱 진입점
  js/accounts.js            # 계정 저장/클라이언트 생성
  js/auth.js                # OAuth/MiAuth 로직
  js/api/mastodon.js        # Mastodon API 클라이언트
  js/api/misskey.js         # Misskey 계열 API 클라이언트
  js/ui/dashboard.js        # 대시보드 렌더링
  js/utils/instance.js      # URL 정규화/플랫폼 감지
src/
  worker.js                 # Cloudflare Worker (프록시 포함)
```

## 라이선스

MIT
