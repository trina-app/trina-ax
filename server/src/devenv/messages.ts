// The words the dev environment routes answer with, in the person's language (en is the source). The English
// strings of shared/src/dev-env-domains.ts stay the API's `fields` detail; here each reason has a sentence of its own.
import type { Locale } from '@mycel/shared/api'
import { PRODUCT } from '@mycel/shared'

type L = Record<Locale, string>

export const DEV_ENV_MESSAGES = {
  noNetwork: { ko: '지금은 개발 환경에서 쓸 수 있는 네트워크가 없어요.', en: 'The dev environment has no network for you now.', id: 'Saat ini lingkungan dev tidak punya jaringan untuk Anda.', ja: '現在、開発環境で使えるネットワークがありません。', es: 'El entorno de desarrollo no tiene red para usted ahora.' },
  fullUnavailable: { ko: '이 서버는 전체 인터넷을 쓸 수 있게 할 수 없어요.', en: 'This server cannot run Full internet.', id: 'Server ini tidak dapat menjalankan Internet penuh.', ja: 'このサーバーでは「フルインターネット」を使えません。', es: 'Este servidor no puede ofrecer Internet completo.' },
  fullWarning: { ko: '먼저 전체 인터넷 주의 사항을 확인하고 동의해 주세요.', en: 'Accept the Full internet warning first.', id: 'Setujui dulu peringatan Internet penuh.', ja: '先に「フルインターネット」の注意事項に同意してください。', es: 'Acepte primero la advertencia de Internet completo.' },
  warning: { ko: '먼저 개발 환경 주의 사항을 확인하고 동의해 주세요.', en: 'Accept the dev environment warning first.', id: 'Setujui dulu peringatan lingkungan dev.', ja: '先に開発環境の注意事項に同意してください。', es: 'Acepte primero la advertencia del entorno de desarrollo.' },
  unavailable: { ko: '이 서버는 개발 환경을 실행할 수 없어요.', en: 'This server cannot run the dev environment.', id: 'Server ini tidak dapat menjalankan lingkungan dev.', ja: 'このサーバーでは開発環境を実行できません。', es: 'Este servidor no puede ejecutar el entorno de desarrollo.' },
  maxSites: { ko: '사이트는 최대 {n}개까지 추가할 수 있어요.', en: 'At most {n} sites.', id: 'Paling banyak {n} situs.', ja: 'サイトは最大{n}件まで追加できます。', es: 'Como máximo {n} sitios.' },
  unknownGroup: { ko: '없는 부서가 들어 있어요.', en: 'Unknown group.', id: 'Ada grup yang tidak dikenal.', ja: '存在しないグループがあります。', es: 'Hay un grupo desconocido.' },
  unknownPerson: { ko: '없는 사람이 들어 있어요.', en: 'Unknown person.', id: 'Ada orang yang tidak dikenal.', ja: '存在しないメンバーがいます。', es: 'Hay una persona desconocida.' },
  // "{site} cannot be added" and then the reason; {site} is quoted, so no word around it depends on the name
  siteProblem: { ko: "'{site}' 사이트를 추가할 수 없어요. {why}", en: "'{site}' cannot be added. {why}", id: "'{site}' tidak dapat ditambahkan. {why}", ja: "「{site}」は追加できません。{why}", es: "No se puede añadir '{site}'. {why}" },
} satisfies Record<string, L>

export type DevEnvMessageKey = keyof typeof DEV_ENV_MESSAGES
export const devEnvMsg = (key: DevEnvMessageKey, locale: Locale, vars: Record<string, string | number> = {}): string =>
  (DEV_ENV_MESSAGES[key][locale] ?? DEV_ENV_MESSAGES[key].en).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))

/** Reasons of extraDomainProblem(), keyed by its English text. */
const SITE_REASONS: Record<string, L> = {
  'use lowercase letters': { ko: '소문자로 적어 주세요.', en: 'Use lowercase letters.', id: 'Gunakan huruf kecil.', ja: '小文字で入力してください。', es: 'Use letras minúsculas.' },
  'too long': { ko: '주소가 너무 길어요.', en: 'The address is too long.', id: 'Alamat terlalu panjang.', ja: 'アドレスが長すぎます。', es: 'La dirección es demasiado larga.' },
  'a "*" is allowed only as "*." at the start': { ko: '별표(*)는 맨 앞에 "*."로만 쓸 수 있어요.', en: 'A "*" can only be used at the start, as "*.".', id: 'Tanda "*" hanya boleh di awal, sebagai "*.".', ja: '「*」は先頭に「*.」の形でのみ使えます。', es: 'El "*" solo se puede usar al principio, como "*.".' },
  'a public suffix is too wide': { ko: '.com 같은 끝부분 전체는 범위가 너무 넓어서 허용할 수 없어요.', en: 'An ending like .com covers far too many sites to allow.', id: 'Akhiran seperti .com mencakup terlalu banyak situs untuk diizinkan.', ja: '.com のような末尾だけでは範囲が広すぎるため許可できません。', es: 'Un final como .com abarca demasiados sitios para permitirlo.' },
  'a domain needs at least two parts, for example example.com': { ko: '주소는 example.com처럼 점으로 나뉜 두 부분 이상이어야 해요.', en: 'An address needs at least two parts, for example example.com.', id: 'Alamat harus punya minimal dua bagian, misalnya example.com.', ja: 'アドレスは example.com のように2つ以上の部分が必要です。', es: 'Una dirección necesita al menos dos partes, por ejemplo example.com.' },
  'not a host name': { ko: '올바른 사이트 주소가 아니에요.', en: 'This is not a valid site address.', id: 'Ini bukan alamat situs yang valid.', ja: '正しいサイトのアドレスではありません。', es: 'No es una dirección de sitio válida.' },
  'an IP address is not allowed': { ko: '숫자로 된 IP 주소는 쓸 수 없어요. 사이트 이름을 적어 주세요.', en: 'A numeric IP address cannot be used. Enter the site name instead.', id: 'Alamat IP berupa angka tidak dapat dipakai. Tulis nama situsnya.', ja: '数字のIPアドレスは使えません。サイト名を入力してください。', es: 'No se puede usar una dirección IP numérica. Escriba el nombre del sitio.' },
  'this is the host name of this Trina server': { ko: `이 ${PRODUCT.displayName} 서버 자신의 주소라서 허용할 수 없어요.`, en: `This is the address of this ${PRODUCT.displayName} server itself, so it cannot be allowed.`, id: `Ini alamat server ${PRODUCT.displayName} ini sendiri, jadi tidak dapat diizinkan.`, ja: `この${PRODUCT.displayName}サーバー自身のアドレスのため、許可できません。`, es: `Es la dirección de este servidor de ${PRODUCT.displayName}, así que no se puede permitir.` },
}

/** "'site' cannot be added. <why>" for one reason of extraDomainProblem(); an unknown reason keeps its English words. */
export function siteProblemMessage(site: string, reason: string, locale: Locale): string {
  const why = SITE_REASONS[reason]
  return devEnvMsg('siteProblem', locale, { site, why: why ? (why[locale] ?? why.en) : reason })
}
export const SITE_REASON_KEYS = Object.keys(SITE_REASONS)
