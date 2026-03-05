# THE FINALS Private Watchboard (GitHub + Render + Supabase)

## 1) Supabase 준비

### 테이블 생성(SQL Editor)

```sql
create table if not exists public.watch_entries (
  playerId text primary key,
  displayName text not null,
  cheatVerdict text not null default 'suspected',
  tags text[] not null default '{}',
  createdAt timestamptz not null default now(),
  updatedAt timestamptz not null default now(),
  lastSeenAt timestamptz not null default now()
);
```

### 키 확인

- Project URL: `SUPABASE_URL`
- Service Role Key: `SUPABASE_SERVICE_ROLE_KEY`

주의: `service_role` 키는 절대 프론트에 노출 금지

## 2) GitHub 올리기

```powershell
cd C:\Users\kls93\Documents\Playground
git init
git add .
git commit -m "watchboard: render + supabase"
git branch -M main
git remote add origin https://github.com/<YOUR_ID>/<YOUR_REPO>.git
git push -u origin main
```

이미 remote가 있으면 `git remote add origin ...` 대신 `git remote set-url origin ...` 사용.

## 3) Render 배포

### 방법 A: Blueprint(render.yaml) 추천

- Render > `New` > `Blueprint`
- GitHub 저장소 선택
- `render.yaml` 읽혀서 서비스 생성됨

### 방법 B: 일반 Web Service

- Render > `New` > `Web Service`
- 저장소 연결
- Start Command: `node server.js`

### 환경변수(Render)

- `ADMIN_TOKEN=원하는_긴_토큰`
- `SUPABASE_URL=https://xxxx.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=...`
- `SUPABASE_TABLE=watch_entries` (선택)

Render가 자동으로 `PORT`를 주므로 따로 설정 안 해도 됨.

## 4) 관리자 로그인

- 사이트 접속 후 `관리자 로그인`
- `ADMIN_TOKEN` 입력

## 로컬 실행

```powershell
$env:ADMIN_TOKEN="my-admin-token"
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
$env:SUPABASE_TABLE="watch_entries"
node server.js
```

## 동작 확인

- `GET /api/health` 에서 `storage: "supabase"`면 정상
- `storage: "file"`이면 Supabase 환경변수 누락 상태
