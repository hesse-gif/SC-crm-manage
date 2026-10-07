# Mixmaxclone Chat

Flu의 Chat을 독립 실행하는 앱입니다. **Flu와 같은 Firebase 백엔드·데이터·권한을 사용합니다.** Flu에서 들어온 메일과 변경 사항을 Mixmaxclone에서도 볼 수 있고, 두 앱의 사용자 작업은 같은 서버에 반영됩니다.

원본: `supercent-io/Flu`, 릴리스 `0.6.116`, 커밋 `be5915aeb455b3ce378e022125dcc09d514b8d8d`.

Live: https://influencer-crm-296ca.web.app/chat

## 실행

Node.js 22가 필요합니다.

```sh
npm ci
npm run configure:live
npm run dev:live -- --port 3210
```

`http://localhost:3210/chat`에서 기존 Flu Google 계정으로 로그인합니다. `configure:live`는 Flu Hosting의 공개 Firebase 웹 설정만 받아 git에서 제외된 `.env.live.local`에 저장합니다. 서버 비밀키, 메일 계정 토큰, 대화 데이터는 복사하지 않습니다. 배포할 별도 도메인은 기존 Firebase Auth의 허용 도메인에 등록해야 합니다.

라이브 빌드: `npm run build:live && npm start -- --port 3210`. 라이브 빌드는 `.next-live`, 에뮬레이터 빌드는 `.next`에 저장됩니다.

## 범위와 데이터 흐름

- Chat 인박스: 사람·프로그램·메일함별 대화, 검색, 읽음, 답장, 새 메일, AI 초안, 발신 계정 선택.
- 자동응답: 케이스북, 미분류함, 저장 답신, 평가·허가 제어, 읽기 전용 리뷰 보드.
- 메시지 템플릿, 발송·수신 확인, 메일 계정·조직 권한·지식 베이스 등 지원 화면.
- 기존 서버의 인증, 조직·메일함 접근 제한, 발송 게이트, 중복 방지, 감사 기록을 유지합니다.

```text
Flu UI ───────────┐
                 ├─ 기존 Flu Auth + Cloud Functions ─ 기존 Firestore/메일 작업
Mixmaxclone UI ───┘
```

계속 갱신되는 화면은 인증된 callable 읽기를 주기적으로 수행합니다. 웹소켓 스트리밍이 아니며, 기존 Flu의 메일 수신 주기와 서버 캐시 지연도 반영됩니다. 백그라운드 탭은 갱신을 멈추고 복귀 시 다시 확인합니다. 갱신은 메일 수집·발송·AI 생성을 자동 실행하지 않습니다.

Flu의 프로그램·크리에이터·검수 업무 화면은 원래 Flu의 대응 화면으로 연결합니다. 이 저장소는 별도 생산 데이터베이스나 중복 메일 워커를 만들지 않습니다. `functions/`의 기존 결합 모듈은 에뮬레이터 검증을 위해 보존하며, 운영 백엔드 배포는 차단돼 있습니다.

## 로컬 검증

```sh
npm --prefix functions ci
npm --prefix functions run build
npm test
npm run build
npm run typecheck
npm run verify:e2e
npm run verify:migration
```

Firebase 에뮬레이터 실행에는 Java가 필요합니다. E2E는 `demo-flu`와 loopback 주소에서 합성 데이터를 사용합니다. 실메일 발송이나 운영 설정 변경을 테스트에 사용하지 않습니다.

## 배포와 Google 연결

`npm run deploy:hosting`은 정적 프런트엔드만 `influencer-crm-296ca`의 기존 Hosting 사이트에 배포합니다. Functions/Firestore는 배포하지 않습니다. 기존 Flu Auth 프로젝트에 이 Hosting 도메인을 추가했으며, Google 로그인과 공유 데이터 조회를 실제 브라우저에서 확인했습니다.

메일 연결은 `/admin/integrations`의 Google 연결을 사용합니다. 별도 동의 창에서 기존 Flu 콜백을 완료한 뒤 Mixmaxclone으로 돌아오면 공통 서버의 연결 상태를 갱신합니다. 현재 운영 서버의 메일 OAuth 정책은 `supercent.io` Workspace만 지원합니다. 개인 Gmail을 회사 로그인에 추가 연결하는 기능은 별도 서버 정책 변경이 필요하며, 이 이관으로 활성화되지 않습니다. 기존 프로젝트의 Firestore 문서나 Auth 사용자를 삭제하지 않습니다.

수동 에뮬레이터 실행: `npm run emulators`, 다른 터미널에서 `npm run dev:emu`. 테스트 하네스의 seed 스크립트는 로컬 에뮬레이터에만 사용할 수 있습니다.

이관 파일의 원본/결과 해시: [migration/source-manifest.json](migration/source-manifest.json). 실제 검증 결과와 남은 제약은 [migration/verification.md](migration/verification.md)에 기록합니다.
