// Рендер PWA-иконок из public/icons/icon.svg через sharp.
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICONS = resolve(__dirname, '..', 'public', 'icons')
const svg = await readFile(resolve(ICONS, 'icon.svg'))

const targets = [
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 512, name: 'icon-512-maskable.png' }, // фон полнокадровый → safe-zone соблюдён
  { size: 180, name: 'apple-touch-icon.png' },
]

for (const t of targets) {
  await sharp(svg, { density: 384 })
    .resize(t.size, t.size)
    .png()
    .toFile(resolve(ICONS, t.name))
  console.log(`✓ ${t.name} (${t.size}px)`)
}
console.log('Иконки готовы.')
