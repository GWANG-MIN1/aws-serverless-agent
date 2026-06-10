# Day 19: iCloud 캘린더 skill — 공개 ICS를 읽어 실제 일정으로 답하기

Day 18의 Discord/Web Agent Loop에 **읽기 전용 `calendar()` skill** 하나를 더한다. 아이폰 캘린더에서 발급한 공개 `webcal://` 또는 `https://*.icloud.com` 링크를 Worker 배포 설정으로 고정하고, LLM이 "이번 주 일정 뭐 있어?" 같은 질문을 받으면 샌드박스 안에서 실제 ICS를 조회한다.

> **규칙: 매일 한 가지만 더하기.** Day 19의 변화는 calendar skill뿐이다. API, DynamoDB, MQTT, Lambda@Edge, Discord, `awsCost()`는 Day 18 그대로다.

## 원본 확인

2026-06-10에 원본 [`breath103/serverless-agent`](https://github.com/breath103/serverless-agent) `main`의 `fa5f622`를 확인했다.

| 우리 구현 | 원본 구현 | 가져온 패턴 |
|---|---|---|
| `lambda/calendar.mjs` | `agent-runtime/skill-runtimes/google-calendar.ts` | 외부 캘린더를 정규화된 이벤트 목록으로 반환 |
| `calendar()`를 `vm`에 주입 | `buildSkills()` → `CodeExecutor` bindings | 서버가 허용한 skill만 샌드박스에 노출 |
| `skillCalls`에 호출 기록 | skill Proxy trace | UI/관측용 호출 내역은 저장 |
| LLM에는 `reads/error`만 반환 | `orchestrate.ts` | skill 추적 메타데이터는 모델에 비공개 |

원본은 Google OAuth와 읽기/쓰기를 모두 지원한다. Day 19는 학습 범위를 줄여 **iCloud 공개 ICS 읽기 전용**으로 만든다. Apple 로그인이나 OAuth는 필요 없다.

## 안전 경계

- LLM은 캘린더 URL을 전달할 수 없다. 배포 시 설정한 `CALENDAR_ICS_URL`만 Worker가 사용한다.
- `webcal://`은 `https://`로 바꾸고, `icloud.com` 및 하위 도메인만 허용한다.
- 생성·수정·삭제 API가 없다. 반환값은 일정 제목/시간/위치/설명뿐이다.
- 다운로드는 8초, 2MB로 제한한다.
- 공개 URL은 링크를 아는 사람이 읽을 수 있는 접근 키와 같다. 코드, README, 스크린샷에 노출하지 않는다.

## 구현

`calendar()` 입력:

```js
await calendar({
  range: "today" | "this_week" | "next_7_days",
  // 또는 from/to를 ISO 문자열로 함께 지정
  from: "2026-06-08T00:00:00+09:00",
  to: "2026-06-15T00:00:00+09:00",
  limit: 50,
});
```

반환값:

```json
{
  "timeZone": "Asia/Seoul",
  "from": "2026-06-07T15:00:00.000Z",
  "to": "2026-06-14T15:00:00.000Z",
  "count": 2,
  "events": [
    {
      "uid": "...",
      "title": "팀 회의",
      "start": "2026-06-09T05:00:00.000Z",
      "end": "2026-06-09T06:00:00.000Z",
      "allDay": false,
      "location": "회의실 A",
      "recurring": false
    }
  ]
}
```

ICS 파싱은 `node-ical`을 사용한다. `RRULE`, `EXDATE`, `RECURRENCE-ID`, IANA 시간대를 처리하고 반복 일정을 조회 구간 안의 개별 일정으로 확장한다.

## 배포

### 1. iPhone에서 공개 캘린더 링크 만들기

1. iPhone **캘린더** 앱 → 하단 **캘린더**.
2. 공유할 캘린더 오른쪽의 정보 버튼.
3. **공개 캘린더** 활성화 → **링크 공유**.
4. 받은 `webcal://...icloud.com/published/...` 링크를 안전한 곳에 보관한다.

개인정보가 많은 기본 캘린더 대신 Day 19 검증용 캘린더를 따로 만드는 편이 안전하다.

### 2. 설치·정적 검증

```powershell
cd C:\Users\박광민\aws-serverless-agent\day-19-calendar-skill
npm install
npm test
npm run build
npx cdk synth -c calendarIcsUrl="webcal://..." -c calendarTimeZone="Asia/Seoul" -c discordPublicKey="<기존 키>"
```

### 3. 배포

Day 18 스택이 아직 배포돼 있으면 고정 SSM 파라미터(`/serverless-agent/backend/url`)가 충돌하므로 먼저 정리한다.

```powershell
cd ..\day-18-discord-bot
npx cdk destroy --force -c discordPublicKey="<기존 키>"
cd ..\day-19-calendar-skill
```

그다음 Day 19를 배포한다.

```powershell
npm run deploy -- -c calendarIcsUrl="webcal://..." -c calendarTimeZone="Asia/Seoul" -c discordPublicKey="<기존 키>"
```

PowerShell 히스토리에 링크를 남기기 싫다면 먼저 환경변수에 넣고 사용한다.

```powershell
$env:CALENDAR_ICS_URL = "webcal://..."
npm run deploy -- -c calendarIcsUrl="$env:CALENDAR_ICS_URL" -c calendarTimeZone="Asia/Seoul" -c discordPublicKey="<기존 키>"
```

## 푸시 전 실배포 검증

1. 검증용 iCloud 캘린더에 이번 주 일정 2개를 만든다.
   - 시간이 있는 일정 1개
   - 종일 또는 반복 일정 1개
2. 배포된 `SiteUrl`을 열고 **유저·세션 생성 → 연결 + 구독**을 누른다.
3. `이번 주 일정 뭐 있어? 날짜와 시간 순서로 알려줘.`를 전송한다.
4. 실시간 로그에서 다음을 확인한다.
   - `tool_call` 코드에 `calendar({ range: "this_week" })` 호출
   - `tool_result`의 `skillCalls`에 `name: "calendar"`, `ok: true`
   - 최종 답에 검증용 일정 2개의 실제 제목과 시간이 포함
5. 캘린더에 없는 일정을 지어내지 않았는지 원본 iPhone 화면과 대조한다.
6. 선택 검증: Discord `/ask`로 같은 질문을 보내 같은 일정이 나오는지 확인한다.

### `등록된 일정이 없습니다`가 나올 때

공개 링크가 가리키는 캘린더와 일정을 저장한 캘린더가 같은지 먼저 확인한다.

1. iPhone 캘린더 앱에서 테스트 일정을 연다.
2. **편집**을 누른다.
3. 일정 상세의 **캘린더** 항목이 `Day 19 test`인지 확인한다.
4. 다른 캘린더라면 `Day 19 test`로 변경하고 저장한다.
5. iCloud 동기화를 위해 1~5분 기다린다.

PowerShell에서 공개 피드에 들어간 일정 수를 직접 확인할 수 있다. 실제 URL은 출력되지 않는다.

```powershell
$url = $env:CALENDAR_ICS_URL -replace '^webcal://', 'https://'
$ics = curl.exe -sS -L --max-time 20 $url
($ics | Select-String '^BEGIN:VEVENT$').Count
```

테스트 일정 2개를 만들었다면 결과가 최소 `2`여야 한다. `0`이면 에이전트나 파서 문제가 아니라 iCloud 공개 피드가 비어 있는 상태다.

계속 `0`이면:

1. `Day 19 test` 정보 화면에서 **공개 캘린더**를 껐다가 다시 켠다.
2. 새로 생성된 공유 링크를 복사한다. 기존 링크는 폐기될 수 있다.
3. `$env:CALENDAR_ICS_URL`을 새 링크로 바꾸고 Day 19를 재배포한다.

## 꼭 찍을 스크린샷

링크나 개인 일정은 가리고 아래 화면을 남긴다.

1. `images/01-icloud-lab-meeting.png` — iPhone 캘린더의 6월 18일 종일 일정
2. `images/02-icloud-workout.png` — iPhone 캘린더의 6월 19일 00:00~01:00 일정
3. `images/03-discord-calendar-answer.png` — Discord 답변이 원본 일정과 일치하는 화면

**공개 ICS URL은 어떤 스크린샷에도 나오면 안 된다.**

### 검증 결과

| 원본 iCloud 일정 | Discord 답변 | 결과 |
|---|---|---|
| 2026년 6월 18일 (목), `랩 미팅`, 종일 | 6월 18일 (목), `랩 미팅`, 종일 | 일치 |
| 2026년 6월 19일 (금), `운동`, 00:00~01:00 | 6월 19일 (금), `운동`, 00:00~01:00 | 일치 |

#### iCloud 원본: 랩 미팅

![iCloud 캘린더의 6월 18일 랩 미팅 종일 일정](images/01-icloud-lab-meeting.png)

#### iCloud 원본: 운동

![iCloud 캘린더의 6월 19일 운동 일정](images/02-icloud-workout.png)

#### Discord 최종 답변

![Discord에서 날짜와 시간이 정확히 표시된 캘린더 답변](images/03-discord-calendar-answer.png)

## 정리

```powershell
npx cdk destroy --force
```

공개 링크를 더 이상 쓰지 않으면 iPhone에서 **공개 캘린더**를 꺼 링크도 폐기한다.

## Day 18 → Day 19

| 측면 | Day 18 | Day 19 |
|---|---|---|
| Agent skill | `awsCost()` | + `calendar()` |
| 외부 데이터 | Cost Explorer | + iCloud 공개 ICS |
| 권한 | `ce:GetCostAndUsage` | 추가 IAM 없음 |
| 파서 | 없음 | `node-ical` |
| 쓰기 기능 | 비용 조회만 | 캘린더도 읽기 전용 |

## 트러블슈팅

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 59 | `calendar is not configured` | `calendarIcsUrl` 없이 배포 | deploy/synth에 context 전달 |
| 60 | `calendar URL must be an iCloud...` | 임의 호스트 또는 잘못 복사한 링크 | iPhone의 공개 `webcal://*.icloud.com` 링크 사용 |
| 61 | 일정 시간이 어긋남 | 시간대 설정 불일치 | `calendarTimeZone=Asia/Seoul` 확인 |
| 62 | 반복 일정이 빠짐 | 단순 문자열 파싱 | `node-ical`의 recurrence expansion 사용 |
| 63 | Lambda timeout | 캘린더 다운로드 지연/과대 파일 | fetch 8초, 파일 2MB, sandbox 15초 제한 확인 |
| 64 | calendar 호출은 성공했지만 `count:0` | 일정이 공개한 캘린더가 아닌 다른 캘린더에 저장됨 | 일정 편집 → **캘린더**를 공개 캘린더로 변경, 공개 ICS의 `VEVENT` 수 확인 |
