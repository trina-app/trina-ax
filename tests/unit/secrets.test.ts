// The secret detector (shared/src/secrets.ts) used for chat titles: known key prefixes, values after key-like words,
// and long random-looking tokens are found and masked; normal Korean / English sentences, file paths, e-mail addresses,
// dates, UUIDs, names and short ids are not. (A pasted admin token became a chat title on screen, 2026-10-28.)
import { describe, expect, test } from 'bun:test'
import { findSecrets, hasSecret, looksRandom, maskSecrets, namedKey } from '@mycel/shared'

// made-up values in the shapes of real ones (none of them is a working key). Provider prefixes are joined at run time
// so that secret scanners (GitHub push protection) do not take this file for a leak.
const BODY = 'Ab3dEf9hIjK1mNoP2qRsT4uVwXyZ5aBcD6eF' // 36 characters, letters and digits mixed
const k = (...parts: string[]) => parts.join('')
const SECRETS: Record<string, string> = {
  'AI PM': k('aipm', '_5c6de5a19f3b4e7d8a2c0b6f1e9d3a7c'),
  'Anthropic': k('sk-', 'ant-api03-', BODY, '_xYz-', BODY),
  'OpenAI project': k('sk-', 'proj-', BODY),
  'OpenAI': k('sk-', BODY, 'gH7iJ'),
  'GitHub classic': k('gh', 'p_', BODY),
  'GitHub OAuth': k('gh', 'o_', BODY),
  'GitHub fine-grained': k('github', '_pat_', '11ABCDEFG0123456789_', BODY),
  'Slack bot': k('xo', 'xb-', '1234567890-1234567890123-', BODY),
  'Slack user': k('xo', 'xp-', '1234567890-1234567890123-abcdef0123456789'),
  'AWS key id': k('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  'AWS session id': k('AS', 'IA', '1234567890ABCDEF'),
  'Google API': k('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  'GitLab': k('gl', 'pat-', BODY.slice(0, 20)),
  'Stripe': k('sk', '_live_', '51H8abcDEF1234567890'),
  'npm': k('np', 'm_', BODY),
  'Hugging Face': k('h', 'f_', BODY),
  'JWT': k('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.', BODY),
  'JWT start': k('eyJ', 'hbGciOiJIUzI1NiIs'),
  'hex token': '5c6de5a19f3b4e7d8a2c0b6f1e9d3a7c',
  'base62 token': 'Zx8q2LmN0pRtY7vB3kWs9dFg',
  'base64 secret': 'dGhpcyBpcyBhIHNlY3JldCBrZXkgZm9yIHRlc3Rpbmc=',
  'AWS secret key': 'je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY',
}

const NORMAL = [
  '3분기 매출 보고서를 요약해 주세요',
  '이번 주 금요일까지 제출할 마케팅 캠페인 성과 분석 보고서',
  'Can you summarize the Q3 sales report for the board meeting?',
  'The API key is in the vault, please fetch it',
  'Token budget: about 2000 words',
  'tokens: 5000',
  'Bearer authentication in our API',
  'Bearer token을 헤더에 넣는 방법',
  '암호: 비트코인',
  'secret: 우리끼리 얘기',
  'shared/meetings/2026-10-28-weekly-report.md',
  'users/alice/.attachments/0192f7a8-3b4c-7def-8123-456789abcdef/report.pdf',
  'C:\\Users\\dion\\Documents\\Quarterly-Report-2026-Final.docx',
  'IMG_20261028_093015_HDR_final_v2.jpg',
  'KakaoTalk_Photo_2026-10-28-09-30-15-001.jpeg',
  'john.doe@example.com',
  'dion+newsletter-2026@potenlab.co.kr',
  'https://github.com/potenlab/team-ax/pull/123',
  '2026-10-28T09:00:00Z',
  '0192f7a8-3b4c-7def-8123-456789abcdef',
  'PRJ-1234', 'u_alice', 'a1b2c3', 'fd049df', 'ORD-20261028-ABCD-1234-XYZ9',
  '010-1234-5678',
  'getUserProfileByIdAndOrganization',
  'useEffect2DimensionalArrayHandlerV3',
  'README_FOR_THE_PROJECT_2026',
  'covid19vaccine2021report2026final',
  'state-of-the-art-machine-learning-pipeline',
  'pneumonoultramicroscopicsilicovolcanoconiosis',
  'sk-learn-tutorial-for-beginners-2026',
  'task-management-system-design-2026',
  'aipm_project_notes',
  'ASIAPACIFICCOUNTRIES',
  'React18과 Next.js14로 SSR 구현하기',
]

describe('found', () => {
  for (const [name, value] of Object.entries(SECRETS)) {
    test(name, () => {
      expect(hasSecret(value)).toBe(true)
      // also inside a sentence, and the rest of the sentence stays
      const masked = maskSecrets(`키 ${value} 연결해줘`, '•')
      expect(masked).toBe('키 • 연결해줘')
    })
  }

  test('values after key-like words: only the value goes', () => {
    expect(maskSecrets('password: hunter22', '•')).toBe('password: •')
    expect(maskSecrets('DB_PASSWORD=s3cr3t!', '•')).toBe('DB_PASSWORD=•')
    expect(maskSecrets('비밀번호: abcd1234', '•')).toBe('비밀번호: •')
    expect(maskSecrets('api_key = "abc12345"', '•')).toBe('api_key = "•')
    expect(maskSecrets('Authorization: Bearer abc123def456ghi789', '•')).toBe('Authorization: •')
  })

  test('a private key block: from BEGIN to END, or to the end of the text without END', () => {
    expect(hasSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(maskSecrets('key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\nthanks', '•')).toBe('key:\n•\nthanks')
    expect(maskSecrets('here -----BEGIN PRIVATE KEY-----\nMIIEow', '•')).toBe('here •')
  })

  test('credentials inside an address; a whole assignment of a prefixed key', () => {
    expect(maskSecrets('https://admin:pa55word@db.example.com/x', '•')).toBe('https://•@db.example.com/x')
    expect(maskSecrets(`OPENAI_API_KEY=${SECRETS['OpenAI project']}`, '•')).toBe('•')
  })

  test('spans are sorted and merged; masking removes by default', () => {
    const s = `a ${SECRETS['AI PM']} b ${SECRETS['GitHub classic']} c`
    expect(findSecrets(s).map((x) => x.kind)).toEqual(['ai-pm', 'github'])
    expect(maskSecrets(s)).toBe('a  b  c')
  })
})

describe('not found', () => {
  for (const text of NORMAL) test(text, () => expect(findSecrets(text)).toEqual([]))

  test('random-looking means letters and digits in short pieces', () => {
    expect(looksRandom('5c6de5a19f3b4e7d8a2c0b6f1e9d3a7c')).toBe(true)
    expect(looksRandom('shared/meetings/2026-10-28-weekly')).toBe(false)
    expect(looksRandom('getUserProfileByIdAndOrganization')).toBe(false)
    expect(looksRandom('a1a1a1a1a1a1a1a1a1a1a1a1')).toBe(false) // too few distinct characters
  })
})

// QA SEC-16, B-W47-3, B-W5-1: a test key written for a person to read is hidden in titles too, also when no connection
// stores it. Joined at run time like the values above.
describe('named test keys and prefixed keys', () => {
  const QA = k('QA-FAKE-', 'KEY-0000-NOT-REAL')
  const KEYS = [
    QA,
    k('XX-FAKE-', 'KEY-1234'),
    k('QA-FAKE-', 'KEY-NOT-REAL'), // words only, in capitals
    k('DUMMY_SECRET_', 'TOKEN_VALUE'),
    k('TEST-', 'PASSWORD-2026'),
    k('my_api_', 'token_a8f3k29dk3x'),
    k('KEY-', 'x9Ab3kQ72mZ'),
    k('sk-', 'FAKEKEY0000NOTREAL'),
    k('gh', 'p_', 'fake0000notreal'),
    k('xo', 'xb-', 'fake0000slack'),
  ]
  for (const key of KEYS) {
    test(key.slice(0, 12) + '…', () => {
      expect(hasSecret(key)).toBe(true)
      expect(maskSecrets(`${key} 이게 무슨 뜻이야?`, '•')).toBe('• 이게 무슨 뜻이야?')
    })
  }

  const WORDS = [
    'API key setup guide',
    'secret santa list',
    'token economy',
    'How to reset the API key',
    'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD',
    'test_api_key', 'API-TEST-PLAN', 'API_TEST_2026',
    'secret-santa-2026', 'token-economy-whitepaper', 'api-key-setup-guide',
    'key_takeaways_from_internationalization', 'KEY_PERFORMANCE_INDICATORS_2026Q3',
    'api-gpt4turbo', 'token_economy_whitepaper_20261028', 'password-reset-flow-v2',
    'sk-learn-tutorial', 'sk-learning2026', 'ghp_documentation',
  ]
  for (const text of WORDS) test(`not: ${text}`, () => expect(findSecrets(text)).toEqual([]))

  test('a named key needs a key word and a value part', () => {
    expect(namedKey(QA)).toBe(true)
    expect(namedKey(k('QA-FAKE-', 'VALUE-0000'))).toBe(false) // no key word
    expect(namedKey(k('FAKE-', 'KEY'))).toBe(false) // two parts only
    expect(namedKey(k('fake-', 'key-value'))).toBe(false) // lower case without a digit part: a slug
  })
})
