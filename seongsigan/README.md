# SeongSigan Demo

간단한 교사용 시간표 관리 데모입니다. `seongsigan.html` 을 더블클릭하여 브라우저에서 바로 실행할 수 있습니다.

## 기능
- 선생님별 주간 시간표 (월–금, 1–7교시)
- 수업 편집/이동/삭제 모달
- 채팅 패널을 통한 자연어 스케줄 변경 요청
- 로컬 `mock-gpt` 파서와 향후 LLM 연동을 위한 훅
- 실행 취소 및 샘플 데이터 초기화

## 실행 방법
1. 저장소를 클론한 뒤 `seongsigan/seongsigan.html`을 열어주세요.
2. 인터넷 연결 없이도 동작합니다.

## 사용자 정의
- `scripts/data.js` 의 `TEACHERS` 와 `initialTimetables` 를 수정하여 교사와 과목을 변경할 수 있습니다.
- 시간표 변경은 `localStorage` 에 저장됩니다. 브라우저에서 `Reset` 버튼으로 초기화하세요.

## Undo / Reset
- 모든 변경 전에 `pushHistory` 로 상태 스냅샷을 저장하며 `Undo` 버튼으로 한 단계 되돌릴 수 있습니다.
- `Reset` 버튼은 샘플 데이터로 되돌리고 저장된 상태를 초기화합니다.

## LLM 연동
`scripts/integration.js` 에서 `sendToLLM` 함수를 구현하면 실제 LLM API와 연동할 수 있습니다. 예:
```js
export async function sendToLLM(message){
  const res = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer YOUR_KEY'},
    body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:message}]})
  });
  const data = await res.json();
  // data는 { text:"...", plan:{...} } 형태로 변환해야 합니다.
  return null; // 변환 후 객체를 반환하세요.
}
```

## 접근성
- 키보드 내비게이션 및 포커스 스타일을 제공합니다.
- 채팅 로그는 `aria-live="polite"` 로 갱신됩니다.

## 한계
이 데모는 로컬 파서로 동작하며 실제 자연어 처리 능력은 제한적입니다.
