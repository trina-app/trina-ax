// 0.2.19 release review, S8: a connected service tool's step shows a short look at the AI's arguments
// (integrations/connections/tools.ts argsPreview), and a value named like a secret must show as "•••". Names such as
// "key", "pwd", "jwt", "bearer", "passcode" or "tokens" were shown in clear, and so was any value that is not a text
// ("password: 12345678"). Now a whole word of the name (or one ending in a secret's word) hides the value whatever
// its type, while harmless names and counts of tokens or keys stay readable. Fake values only.
import { describe, expect, test } from 'bun:test'
import { argsPreview, secretArg } from '../../server/src/integrations/connections/tools'

describe('tool-step argument previews hide secrets by name', () => {
  test('names the review found shown in clear, and the usual ways of writing a secret\'s name', () => {
    for (const k of [
      'key', 'keys', 'access_key', 'accessKey', 'passcode', 'pwd', 'userPwd', 'tokens', 'jwt', 'bearer', 'pass', 'passwd', 'password', 'passphrase',
      'api_key', 'apikey', 'apiKey', 'APIKey', 'x-api-key', 'Authorization', 'proxy-authorization', 'auth', 'authToken', 'oauth_token',
      'cookie', 'Set-Cookie', 'session', 'session_id', 'sessionToken', 'credential', 'credentials', 'creds', 'client_secret', 'clientSecret',
      'clientsecret', 'AWS_SECRET_ACCESS_KEY', 'private_key', 'privateKey', 'privatekey', 'refresh_token', 'id_token', 'accesstoken',
      'newPassword', 'new password', 'otp', 'user.password',
    ]) expect([k, secretArg(k)]).toEqual([k, true])
  })

  test('harmless names stay readable: the model, a prompt, words that only contain a secret\'s letters, counts and limits, flags', () => {
    for (const k of [
      'model', 'prompt', 'passage', 'bypass', 'compass', 'author', 'keyword', 'keywords', 'monkey', 'hotkey', 'secretary', 'tokenizer',
      'private', 'max_tokens', 'maxTokens', 'max_output_tokens', 'token_count', 'tokenLimit', 'num_keys', 'MaxKeys', 'session_count', 'get_cost',
    ]) expect([k, secretArg(k)]).toEqual([k, false])
  })

  test('any value under a secret\'s name is hidden, a number or an object too; the rest keeps its order and look', () => {
    expect(argsPreview({ password: 12345678, model: 'z_image', max_tokens: 5, pin: 1234 })).toBe('password: •••, max_tokens: 5, pin: 1234, model: "z_image"')
    expect(argsPreview({ key: 'notes/x', pwd: 'p', jwt: 'eyJhbGciOi.e30.sig', bearer: 'tok', passcode: 4711, tokens: ['a', 'b'], auth: { user: 'u', pass: 'p' } }))
      .toBe('passcode: •••, key: •••, pwd: •••, jwt: •••, bearer: •••, tokens: •••, auth: •••')
    expect(argsPreview({ api_key: null, private: true, prompt: 'a leaf' })).toBe('api_key: •••, private: true, prompt: "a leaf"')
    const all = argsPreview({ access_key: 'AKIAFAKEFAKEFAKE', accessKey: 'FAKE-1', session: 'fake-session', credentials: 'fake' })
    expect(all).not.toMatch(/FAKE|fake/)
  })
})
