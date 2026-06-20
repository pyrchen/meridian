// Общий клиентский замок для приватных страниц (терминал + сигналы).
// Сравнивает SHA-256 введённой фразы с хэшем. НЕ серверная защита (хэш в коде).
// Дефолт: "dawn-2026". Сменить — положи сюда sha256 своей фразы (команда в README).
// Единый ключ сессии → разблокировал одну приватную страницу = открыты обе.

const ACCESS_SHA256 =
  '830b611571100cd45d48ad528285ef0aa707ae478bf43954a02cd0d38bbc5ac7'
const UNLOCK_KEY = 'meridian-unlock'

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const $ = (id: string) => document.getElementById(id) as HTMLElement

// reveal() показывает контент конкретной страницы и запускает её логику.
export function setupGate(reveal: () => void) {
  const open = () => {
    $('gate').hidden = true
    reveal()
  }
  if (sessionStorage.getItem(UNLOCK_KEY) === '1') {
    open()
    return
  }
  const form = $('gate-form') as HTMLFormElement
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const val = ($('gate-pass') as HTMLInputElement).value
    if ((await sha256(val)) === ACCESS_SHA256) {
      try {
        sessionStorage.setItem(UNLOCK_KEY, '1')
      } catch {}
      open()
    } else {
      $('gate-err').textContent = 'Неверный код'
      ;($('gate-pass') as HTMLInputElement).value = ''
    }
  })
}
