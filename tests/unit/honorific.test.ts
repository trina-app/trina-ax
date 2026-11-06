// A name that already ends with an honorific gets no second one from a text (shared/src/honorific.ts), with or
// without a space before the text's own: review 2026-11-06 found "대표님 님에게 답장" in the app and "대표님님의 질문" in
// Slack. The web app's own texts are checked in web/test/unit/i18n.test.ts; these are the helper and the team
// server's texts with a name.
import { describe, expect, test } from 'bun:test'
import { dropDoubleHonorifics, hasHonorific } from '@mycel/shared/honorific'
import { tr } from '../../server/src/chat/i18n'
import { ct } from '../../server/src/credentials/i18n'
import { say as connectionSay } from '../../server/src/integrations/connections/text'
import { say as slackSay } from '../../server/src/integrations/slack/text'
import { st } from '../../server/src/skills/text'

const fill = (template: string, params: Record<string, string>) =>
  dropDoubleHonorifics(template, params).replace(/\{(\w+)\}/g, (all, k: string) => params[k] ?? all)

describe('dropDoubleHonorifics', () => {
  test('a name ending with 님 or 씨: no second one, with or without the space', () => {
    expect(fill('{name}님의 질문', { name: '대표님' })).toBe('대표님의 질문')
    expect(fill('{name} 님에게 답장', { name: '대표님' })).toBe('대표님에게 답장')
    expect(fill('{name} 님이 메시지를 보냈어요.', { name: '대표님' })).toBe('대표님이 메시지를 보냈어요.')
    expect(fill('{name}님, 무엇을 도와드릴까요?', { name: '김민지 씨' })).toBe('김민지 씨, 무엇을 도와드릴까요?')
  })
  test('a name with 님 inside it, or none, keeps the text\'s own', () => {
    expect(hasHonorific('김님희')).toBe(false)
    expect(fill('{name}님의 질문', { name: '김님희' })).toBe('김님희님의 질문')
    expect(fill('{name} 님에게 답장', { name: '김님희' })).toBe('김님희 님에게 답장')
    expect(fill('{name} 님이 메시지를 보냈어요.', { name: '이민준' })).toBe('이민준 님이 메시지를 보냈어요.')
    expect(fill('{name}さんの質問', { name: 'Mia' })).toBe('Miaさんの質問')
  })
  test('the Korean particle after it follows the name\'s last sound', () => {
    expect(fill('{name} 님이 들어왔어요', { name: '김민지 씨' })).toBe('김민지 씨가 들어왔어요')
    expect(fill('{name}님과 그 AI', { name: '김민지 씨' })).toBe('김민지 씨와 그 AI')
    expect(fill('{name} 님으로 시작하기', { name: '김민지 씨' })).toBe('김민지 씨로 시작하기')
    expect(fill('{name}님은 들어왔어요', { name: '김민지 씨' })).toBe('김민지 씨는 들어왔어요')
    expect(fill('{name} 님이 들어왔어요', { name: '팀장님' })).toBe('팀장님이 들어왔어요')
    expect(fill('{name} 님으로 시작하기', { name: '대표님' })).toBe('대표님으로 시작하기')
    // a word that goes on after the particle is left alone, as is a particle after a name that is not Korean
    expect(fill('{name}님이에요', { name: '김민지 씨' })).toBe('김민지 씨이에요')
    expect(fill('{name}님이 들어왔어요', { name: '田中様' })).toBe('田中様이 들어왔어요')
  })
  test('Japanese: さん, 様, 先生 and the others, with or without the space', () => {
    expect(fill('{name}さんの質問', { name: '田中様' })).toBe('田中様の質問')
    expect(fill('{name} さんが見られるフォルダー', { name: '山田さん' })).toBe('山田さんが見られるフォルダー')
    expect(fill('{name}さんに返信', { name: '佐藤先生' })).toBe('佐藤先生に返信')
  })
  test('a value not given, or another placeholder, changes nothing', () => {
    expect(dropDoubleHonorifics('{name}님의 질문', {})).toBe('{name}님의 질문')
    expect(dropDoubleHonorifics('{by}님이 {name} 연결을 요청했어요', { name: '대표님' })).toBe('{by}님이 {name} 연결을 요청했어요')
  })
})

describe('the team server\'s texts with a name', () => {
  test('Slack: who asked', () => {
    expect(slackSay('askedBy', 'ko', { name: '대표님' })).toBe('대표님의 질문')
    expect(slackSay('askedBy', 'ko', { name: '김님희' })).toBe('김님희님의 질문')
    expect(slackSay('askedBy', 'ja', { name: '田中様' })).toBe('田中様の質問')
    expect(slackSay('askedBy', 'en', { name: '대표님' })).toBe('Asked by 대표님')
  })
  test('the project instructions notice, the skill suggestion, the connection request and the duplicate key', () => {
    expect(tr('projectInstructionsChanged', 'ko', { name: '견적', by: '대표님' })).toBe("'견적' 프로젝트 지침을 대표님이 바꿨어요.")
    expect(tr('projectInstructionsChanged', 'ko', { name: '견적', by: '김님희' })).toBe("'견적' 프로젝트 지침을 김님희 님이 바꿨어요.")
    expect(st('suggested', 'ko', { who: '대표님', name: '견적서', folder: '영업/' })).toBe('대표님이 스킬을 제안했어요: 견적서 → 영업/')
    expect(st('suggested', 'ko', { who: '김민지 씨', name: '견적서', folder: '영업/' })).toBe('김민지 씨가 스킬을 제안했어요: 견적서 → 영업/')
    expect(connectionSay('requestNotice', 'ko', { by: '대표님', name: 'Notion', host: 'mcp.notion.com' })).toStartWith('대표님이 Notion 연결을 요청했어요')
    expect(connectionSay('requestNotice', 'ja', { by: '田中様', name: 'Notion', host: 'mcp.notion.com' })).toStartWith('田中様がNotion')
    expect(ct('duplicatePersonal', 'ko', { name: '대표님', label: '내 키' })).toBe("이 토큰·키는 이미 대표님의 개인 연결 '내 키'에서 쓰고 있어요.")
    expect(ct('duplicatePersonal', 'ko', { name: '김님희', label: '내 키' })).toBe("이 토큰·키는 이미 김님희님의 개인 연결 '내 키'에서 쓰고 있어요.")
  })
})
