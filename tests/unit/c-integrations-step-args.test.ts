// 0.2.19 release review, S8: a connected service tool's step shows a short look at the AI's arguments
// (integrations/connections/tools.ts argsPreview), and a value named like a secret must show as "•••". Names such as
// "key", "pwd", "jwt", "bearer", "passcode" or "tokens" were shown in clear, and so was any value that is not a text
// ("password: 12345678"). Now a whole word of the name (or one ending in a secret's word) hides the value, a number
// too; what a name says about a secret (its type, its address), counts of tokens or keys and plain flags stay
// readable; and a URL's password, an Authorization value, a JWT or a secret query parameter inside any text is hidden
// before the text is cut. Fake values only.
import { describe, expect, test } from 'bun:test'
import { argsPreview, hideSecretsInText, secretArg } from '../../server/src/integrations/connections/tools'

describe('tool-step argument previews hide secrets by name', () => {
  test('names the review found shown in clear, and the usual ways of writing a secret\'s name', () => {
    for (const k of [
      'key', 'keys', 'access_key', 'accessKey', 'passcode', 'pwd', 'pw', 'userPwd', 'tokens', 'jwt', 'bearer', 'pass', 'passwd', 'password', 'passphrase',
      'api_key', 'apikey', 'apiKey', 'APIKey', 'x-api-key', 'Authorization', 'proxy-authorization', 'auth', 'authToken', 'oauth_token',
      'cookie', 'Set-Cookie', 'session', 'session_id', 'sessionToken', 'credential', 'credentials', 'creds', 'client_secret', 'clientSecret',
      'clientsecret', 'AWS_SECRET_ACCESS_KEY', 'private_key', 'privateKey', 'privatekey', 'privkey', 'refresh_token', 'id_token', 'accesstoken',
      'newPassword', 'new password', 'otp', 'totp', 'mfa_code', 'verification_code', 'pin', 'user.password', 'last_used_token', 'api_key_used',
    ]) expect([k, secretArg(k, 'fake-value')]).toEqual([k, true])
    // a number under a secret's name too
    for (const k of ['password', 'pin', 'otp', 'passcode']) expect([k, secretArg(k, 12345678)]).toEqual([k, true])
  })

  test('harmless names stay readable: the model, words that only contain a secret\'s letters, what a name says about a secret, counts, flags', () => {
    for (const k of [
      'model', 'prompt', 'passage', 'bypass', 'compass', 'author', 'keyword', 'keywords', 'monkey', 'hotkey', 'secretary', 'tokenizer', 'private',
      'token_type', 'auth_type', 'authMode', 'auth_url', 'authorization_endpoint', 'session_name', 'session_ttl', 'password_hint', 'key_name',
      'sort_key', 'partition_key', 'primary_key', 'idempotency_key', 'cache_key', 'code',
    ]) expect([k, secretArg(k, 'some text')]).toEqual([k, false])
    // counts and limits of tokens or keys, when they are numbers
    for (const k of ['max_tokens', 'maxTokens', 'max_output_tokens', 'token_count', 'tokenLimit', 'num_keys', 'MaxKeys', 'session_count', 'access_token_len'])
      expect([k, secretArg(k, 4096)]).toEqual([k, false])
    expect(secretArg('access_token_len', 'fake-token')).toBe(true) // a text under such a name is still hidden
    // a flag or nothing holds no secret
    for (const v of [true, false, null]) for (const k of ['has_password', 'pass_through', 'pin', 'api_key']) expect([k, v, secretArg(k, v)]).toEqual([k, v, false])
  })

  test('any other value under a secret\'s name is hidden, a number or an object too; the rest keeps its order and look', () => {
    expect(argsPreview({ password: 12345678, model: 'z_image', max_tokens: 5, pin: 1234 })).toBe('password: •••, max_tokens: 5, pin: •••, model: "z_image"')
    expect(argsPreview({ key: 'notes/x', pwd: 'p', jwt: 'eyJhbGciOi.e30.sig', bearer: 'tok', passcode: 4711, tokens: ['a', 'b'], auth: { user: 'u', pass: 'p' } }))
      .toBe('passcode: •••, key: •••, pwd: •••, jwt: •••, bearer: •••, tokens: •••, auth: •••')
    expect(argsPreview({ api_key: null, private: true, has_password: true, prompt: 'a leaf' })).toBe('api_key: null, private: true, has_password: true, prompt: "a leaf"')
    expect(argsPreview({ token_type: 'Bearer', auth_url: 'https://id.example/auth', Bucket: 'reports' })).toBe('token_type: "Bearer", auth_url: "https://id.example/auth", Bucket: "reports"')
    const all = argsPreview({ access_key: 'AKIAFAKEFAKEFAKE', accessKey: 'FAKE-1', session: 'fake-session', credentials: 'fake' })
    expect(all).not.toMatch(/FAKE|fake/)
  })

  test('secrets inside a text are hidden whatever its name, before it is cut', () => {
    expect(hideSecretsInText('postgres://admin:hunter2fake@db.example/app')).toBe('postgres://admin:•••@db.example/app')
    expect(hideSecretsInText('Authorization: Bearer sk-fake-0123456789abcdef')).toBe('Authorization: Bearer •••')
    expect(hideSecretsInText('authorization=Basic Zm9vOmJhcg==')).toBe('authorization=Basic •••')
    expect(hideSecretsInText('send bearer fake-token-123456 along')).toBe('send bearer ••• along')
    expect(hideSecretsInText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl here')).toBe('jwt ••• here')
    expect(hideSecretsInText('https://x.example/cb?state=1&access_token=fake123&model=a')).toBe('https://x.example/cb?state=1&access_token=•••&model=a')
    expect(hideSecretsInText('Basic plan for everyone, see https://example.com/a?page=2')).toBe('Basic plan for everyone, see https://example.com/a?page=2')
    const p = argsPreview({ connection_string: 'postgres://admin:hunter2fake@db.example/app', headers: 'Authorization: Bearer sk-fake-0123456789' })
    expect(p).toBe('connection_string: "postgres://admin:•••@db.example/app", headers: "Authorization: Bearer •••"')
    expect(p).not.toContain('hunter2')
    expect(p).not.toContain('sk-fake')
  })
})
