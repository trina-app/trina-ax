# Acme Desk — product spec v2.3

Acme Desk is a desk-booking app for offices.

## Limits
- A single office supports up to 500 desks.
- The public API allows 600 requests per minute per API key.
- Bookings can be made up to 30 days ahead; the default booking length is 8 hours.

## Sign-in
SSO uses SAML 2.0 and OIDC. 비밀번호 로그인은 Starter 요금제에서만 지원한다.

## Check-in
Automatic check-in works with Acme Sensor (Bluetooth). Release of an unused desk happens after 30 minutes of no check-in
(미사용 좌석은 체크인이 없으면 30분 후 자동 반환된다).
